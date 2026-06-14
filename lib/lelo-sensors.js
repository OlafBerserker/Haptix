/**
 * LELO F1S V3 — sensor decode + derived signals (NSFW haptic feature)
 *
 * Consumes raw notify DataViews from the connector and produces:
 *   - telemetry: { depthPct, pressure, motion, strokeRateHz, tempC, battery, seated }   (Loop B inputs)
 *   - playerArousal (0..1) interaction-derived estimate                                   (Loop B)
 *   - manual +/- accumulation since last turn                                              (Loop C)
 *   - orientation 'natural' | 'up' with hysteresis+debounce                                (Loop D)
 *
 * !!! BYTE-LAYOUT ASSUMPTIONS BELOW ARE FROM F1S-V2-SPEC.md AND MUST BE VALIDATED ON LIVE HW.
 *     Wrong endianness/scale produces plausible-but-wrong values (silent failure) — Phase 6 validates these.
 */

import { AROUSAL, ORIENTATION, BLE } from './lelo-config.js';

const now = () => Date.now();
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// tunables (validate/tune on HW)
const ACCEL_DELTA_SCALE = 45;      // V3 accel values are small (~0-150), not ±1024
const PRESSURE_LO = 95000;         // adaptive fallback range for pressure normalization (raw units)
const PRESSURE_HI = 110000;

/**
 * @param {object} cb
 * @param {(telemetry:object)=>void} [cb.onTelemetry]   throttled
 * @param {(level:number)=>void} [cb.onArousal]
 * @param {(kind:string,value:number)=>void} [cb.onThreshold]  kind: rising|peak|climax|afterglow
 * @param {(adj:{dir:number,count:number,cadence:string})=>void} [cb.onManualAdjust]  live, per press
 * @param {(orientation:string)=>void} [cb.onOrientation]
 * @param {(m:string)=>void} [cb.onLog]
 */
export function createSensors(cb = {}) {
    const { onTelemetry, onArousal, onThreshold, onManualAdjust, onOrientation, onLog } = cb;
    const log = (m) => onLog?.(`[sensors] ${m}`);

    const tele = { depthPct: 0, pressure: 0, motion: 0, strokeRateHz: 0, tempC: 0, battery: null, seated: false };
    let prevAccelMag = null;
    let motionEMA = 0;
    let pAdaptMin = Infinity, pAdaptMax = -Infinity;   // adaptive normalization for the V3 2-byte 0x0A0A
    let arousal = 0;
    let lastArousalTick = 0;
    let lastEmit = 0;
    let lastThresholdBand = -1;
    let lastNotifyAt = 0;   // for staleness: if sensors go quiet, stimulation -> 0 so arousal decays

    // depth-oscillation stroke-rate estimate
    let lastDepthDir = 0, lastDepthVal = 0, lastStrokeAt = 0, strokeEMA = 0;

    // Loop C: manual +/- accumulation since last turn
    let manual = { dir: 0, count: 0, presses: [] };

    // Loop D: orientation hysteresis/debounce
    let orientation = 'natural';
    let candidate = 'natural';
    let candidateSince = 0;

    let arousalTimer = null;

    // ---- decoders ----------------------------------------------------------

    function onDepth(dv) {
        const raw = dv.getUint16(0, true);              // LE u16, expect 0..8
        const val = Math.min(raw, 8);
        tele.depthPct = val / 8;
        tele.seated = val > 0;
        // stroke-rate from depth direction changes
        const dir = Math.sign(val - lastDepthVal);
        if (dir !== 0 && dir !== lastDepthDir) {
            const t = now();
            if (lastStrokeAt) {
                const hz = 1000 / Math.max(1, t - lastStrokeAt);
                strokeEMA = strokeEMA * 0.6 + Math.min(hz, 5) * 0.4;
                tele.strokeRateHz = strokeEMA;
            }
            lastStrokeAt = t;
            lastDepthDir = dir;
        }
        lastDepthVal = val;
    }

    function onHall(dv) {
        // motor rotations/sec (our own motor) — informational, not a user signal
        tele.hallRps = dv.getUint16(0, true);
    }

    function onAccel(dv) {
        // V3: 7 bytes, BIG-ENDIAN int16 x,y,z (~0-150) + 1 orientation/direction byte.
        const x = dv.getInt16(0, false);
        const y = dv.getInt16(2, false);
        const z = dv.getInt16(4, false);
        // motion = smoothed magnitude delta (stroking/thrusting activity)
        const mag = Math.sqrt(x * x + y * y + z * z);
        if (prevAccelMag != null) {
            const d = Math.abs(mag - prevAccelMag);
            motionEMA = motionEMA * 0.55 + clamp01(d / ACCEL_DELTA_SCALE) * 0.45;
            tele.motion = motionEMA;
        }
        prevAccelMag = mag;
        updateOrientation(z);
    }

    function onPressTemp(dv) {
        try {
            if (dv.byteLength >= 8) {                       // V2 layout: temp(24b) FF pressure(32b)
                const b = new Uint8Array(dv.buffer);
                tele.tempC = ((b[0] << 16) | (b[1] << 8) | b[2]) / 100;
                const pressRaw = (b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7];
                tele.pressure = clamp01((pressRaw - PRESSURE_LO) / (PRESSURE_HI - PRESSURE_LO));
            } else if (dv.byteLength >= 2) {                // V3: single big-endian u16, adaptively normalized
                const v = dv.getUint16(0, false);
                pAdaptMin = Math.min(pAdaptMin, v);
                pAdaptMax = Math.max(pAdaptMax, v);
                tele.pressure = clamp01((v - pAdaptMin) / Math.max(1, pAdaptMax - pAdaptMin));
            }
        } catch (e) { log(`pressTemp decode: ${e.message}`); }
    }

    function onButton(dv) {
        const code = dv.getUint8(0);
        // 0x00 power, 0x01 +, 0x02 -, 0x03 released. NOTE: device locks buttons while motors run — these
        // notifies may only arrive when the motor is idle (HW-validated). Power/released are ignored here.
        if (code !== 0x01 && code !== 0x02) return;
        const dir = code === 0x01 ? +1 : -1;
        const t = now();
        manual.dir += dir;
        manual.count += 1;
        manual.presses.push(t);
        onManualAdjust?.({ dir, count: manual.count, cadence: cadenceOf(manual.presses) });
    }

    function onBattery(dv) { tele.battery = dv.getUint8(0); }

    function handleNotify(kind, dv) {
        lastNotifyAt = now();
        switch (kind) {
            case 'depth': onDepth(dv); break;
            case 'accel': onAccel(dv); break;
            case 'pressTemp': onPressTemp(dv); break;
            case 'hall': onHall(dv); break;
            case 'buttons': onButton(dv); break;
            case 'battery': onBattery(dv); break;
            default: return;
        }
    }

    // ---- Loop D: orientation ----------------------------------------------

    function updateOrientation(z) {
        // upright/held-up -> z strongly positive (spec: upright z ~ +1024). flat/down -> 'natural'.
        let next = orientation;
        if (orientation === 'natural' && z > ORIENTATION.UP_Z_ENTER) next = 'up';
        else if (orientation === 'up' && z < ORIENTATION.UP_Z_EXIT) next = 'natural';
        if (next !== orientation) {
            const t = now();
            if (candidate !== next) { candidate = next; candidateSince = t; }
            else if (t - candidateSince >= ORIENTATION.DEBOUNCE_MS) {
                orientation = next;
                onOrientation?.(orientation);
            }
        } else {
            candidate = orientation;
        }
    }

    // ---- Loop B: arousal integrator ---------------------------------------

    function tickArousal() {
        const t = now();
        const dt = lastArousalTick ? (t - lastArousalTick) / 1000 : 0;
        lastArousalTick = t;
        const stale = !lastNotifyAt || (t - lastNotifyAt > 2500);   // sensors quiet -> no stimulation
        const stim = stale ? 0 : clamp01(
            AROUSAL.W_MOTION * tele.motion +
            AROUSAL.W_PRESSURE * tele.pressure +
            AROUSAL.W_DEPTH * tele.depthPct,
        );
        // rise when stimulated, decay scaled by LACK of stimulation (so active touch always climbs)
        arousal = clamp01(arousal + dt * (stim * AROUSAL.RISE_PER_SEC - (1 - stim) * AROUSAL.DECAY_PER_SEC));

        // climax heuristic: sustained high motion + pressure
        if (tele.motion > AROUSAL.CLIMAX_MOTION && tele.pressure > AROUSAL.CLIMAX_PRESSURE) {
            arousal = 1;
        }

        if (t - lastEmit >= 1000 / AROUSAL.EMIT_HZ) {
            lastEmit = t;
            onArousal?.(arousal);
            onTelemetry?.({ ...tele });
            emitThresholdIfCrossed();
        }
    }

    function emitThresholdIfCrossed() {
        const { rising, high, edge } = AROUSAL.THRESHOLDS;
        const band = arousal >= edge ? 3 : arousal >= high ? 2 : arousal >= rising ? 1 : 0;
        if (band !== lastThresholdBand) {
            const kinds = ['afterglow', 'rising', 'peak', 'climax'];
            if (band > 0 || lastThresholdBand > 0) onThreshold?.(kinds[band], arousal);
            lastThresholdBand = band;
        }
    }

    // ---- helpers / API -----------------------------------------------------

    function cadenceOf(presses) {
        const n = presses.length;
        if (n <= 1) return 'gentle';
        const span = presses[n - 1] - presses[0];
        const avg = span / (n - 1);
        if (n >= 4 || avg < 400) return 'urgent';
        return 'normal';
    }

    /** Loop C: bridge calls at message-send; returns the net adjust and resets. */
    function takeManualAdjust() {
        if (manual.dir === 0 || manual.count === 0) { manual = { dir: 0, count: 0, presses: [] }; return null; }
        const out = { dir: Math.sign(manual.dir), count: manual.count, cadence: cadenceOf(manual.presses) };
        manual = { dir: 0, count: 0, presses: [] };
        return out;
    }

    function start() {
        if (arousalTimer) return;
        lastArousalTick = 0;
        arousalTimer = setInterval(tickArousal, Math.round(1000 / Math.max(1, AROUSAL.EMIT_HZ)));
    }
    function stop() {
        if (arousalTimer) { clearInterval(arousalTimer); arousalTimer = null; }
    }
    function reset() {
        arousal = 0; motionEMA = 0; prevAccelMag = null; lastThresholdBand = -1;
        manual = { dir: 0, count: 0, presses: [] };
        orientation = 'natural'; candidate = 'natural';
        Object.assign(tele, { depthPct: 0, pressure: 0, motion: 0, strokeRateHz: 0, seated: false });
    }

    return {
        handleNotify,
        takeManualAdjust,
        start, stop, reset,
        get arousal() { return arousal; },
        get orientation() { return orientation; },
        getTelemetry() { return { ...tele }; },
    };
}
