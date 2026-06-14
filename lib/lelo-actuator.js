/**
 * LELO F1S V3 — pattern-engine actuator (NSFW haptic feature)
 *
 * Turns the current { actType, intensity } (set by the bridge from Loop A) into a continuous, SAFE motor
 * signal. A single fixed-rate loop advances the active pattern's oscillator, ramps the intensity envelope
 * (rate-limited), enforces every SAFETY ceiling, and writes deduped motor commands via the command-path.
 *
 * Invariant: writes 0 unless connector is READY, safety is armed, and intensity > 0.
 */

import { SAFETY, ACT_PATTERNS, BLE } from './lelo-config.js';
import { getCommandPath } from './lelo-command-path.js';

const TWO_PI = Math.PI * 2;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const now = () => Date.now();
const MIN_SPIN_LIFT = 0.05;   // intended values above this get lifted to MOTOR_MIN_SPIN so the motor turns

/** Pattern waveform -> normalized 0..1 envelope at the given phase. Deterministic (no RNG). */
function waveform(name, phase, profile) {
    const s = (Math.sin(phase) + 1) / 2;            // 0..1 smooth
    const up = (1 - Math.cos(phase)) / 2;           // 0..1 full strokes
    let base;
    switch (name) {
        case 'steady':    base = 1; break;
        case 'stroke':    base = up; break;
        case 'thrust':    base = Math.pow(up, 0.7); break;            // sharper bottom, quick rise
        case 'suction':   base = 0.35 + 0.65 * Math.pow(s, 2); break; // rhythmic pull
        case 'grind':     base = 0.6 + 0.4 * s; break;               // slow undulation, never zero
        case 'crescendo': base = 0.7 + 0.3 * s; break;              // mostly high
        case 'tease':     base = s > 0.78 ? 1 : 0.08; break;         // intermittent light touches
        default:          base = up;
    }
    // humanize: blend in a second-frequency component scaled by (1 - regularity). Deterministic.
    const reg = profile?.regularity ?? 1;
    if (reg < 1) {
        const noise = (Math.sin(phase * 1.73) + 1) / 2;
        base = base * reg + (base * 0.5 + noise * 0.5) * (1 - reg);
    }
    return clamp01(base);
}

const liftSpin = (v) => (v > MIN_SPIN_LIFT && v < BLE.MOTOR_MIN_SPIN ? BLE.MOTOR_MIN_SPIN : (v <= MIN_SPIN_LIFT ? 0 : v));

/**
 * @param {object} deps
 * @param {ReturnType<import('./lelo-connector.js').createConnector>} deps.connector
 * @param {ReturnType<import('./lelo-safety.js').createSafetyGate>} deps.safety
 * @param {() => string} [deps.getCommandMode]  'v2' | 'harmony'
 * @param {(m:string)=>void} [deps.onLog]
 */
export function createActuator({ connector, safety, getCommandMode = () => 'v2', getArousal = () => 0, getPatternStyle = () => 'complex', onLog } = {}) {
    let timer = null;
    let lastTick = 0;
    let phase = 0;
    let actType = null;
    let targetIntensity = 0;     // set by bridge (Loop A)
    let manualBias = 0;          // Loop C live offset
    let current = 0;             // ramped envelope intensity
    let lastMain = -1, lastVib = -1;   // last written speeds, 0-100 (for dedupe)
    let lastWriteAt = 0;
    let sequenceFn = null;   // active autonomous sequence (overrides act-oscillator) or null
    let blipUntil = 0, blipAmp = 0;   // brief incidental/impact contact override

    const log = (m) => onLog?.(`[actuator] ${m}`);

    function setTarget(nextAct, intensity) {
        actType = nextAct;
        targetIntensity = clamp01(intensity);
        safety.recordSignal();
    }
    function setManualBias(bias) { manualBias = bias; safety.recordSignal(); }
    function clearManualBias() { manualBias = 0; }

    function writeMotor(mainNorm, vibNorm) {
        const m = Math.round(mainNorm * 100);
        const v = Math.round(vibNorm * 100);
        if (m === lastMain && v === lastVib) return;             // no change since last write
        const t = now();
        if ((m !== 0 || v !== 0) && t - lastWriteAt < 55) return; // ~18 Hz cap on non-stop writes
        lastMain = m; lastVib = v; lastWriteAt = t;
        const path = getCommandPath(getCommandMode());
        for (const w of path.writes(mainNorm, vibNorm)) {       // 1 write (v2) or 2 (harmony: main+vib)
            connector.writeChar(w.char, w.bytes, { withoutResponse: path.withoutResponse }).catch((e) => log(`write failed: ${e.message}`));
        }
        log(`motor[${getCommandMode()}] main=${m} vib=${v}`);
    }

    function tick() {
        const t = now();
        const dt = lastTick ? t - lastTick : 0;
        lastTick = t;

        const hidden = typeof document !== 'undefined' && document.hidden;
        const armed = safety.isArmed() && connector.state === 'ready' && !hidden;

        // Brief blip (incidental/impact contact) — overrides everything for a moment.
        if (armed && t < blipUntil) {
            safety.recordSignal();
            const amp = safety.clampIntensity(blipAmp);
            writeMotor(liftSpin(amp), liftSpin(amp * 0.7));
            return;
        }

        // Sequence mode: an autonomous pattern drives amplitude directly (manages its own dynamics,
        // so it bypasses the slow envelope ramp) — still clamped to the safety cap; estop/visibility apply.
        if (armed && sequenceFn) {
            safety.recordSignal();   // self-driving; keep dead-man from tripping
            let amp = 0;
            try { amp = sequenceFn(dt, { arousal: getArousal() }) ?? 0; } catch (e) { amp = 0; log(`seq: ${e.message}`); }
            current = safety.clampIntensity(amp);
            const p = actType ? ACT_PATTERNS[actType] : null;
            writeMotor(
                liftSpin(clamp01(current * Math.max(p ? p.main : 0.9, 0.85))),
                liftSpin(clamp01(current * (p ? p.vib : 0.6))),
            );
            return;
        }

        // watchdogs: dead-man / heartbeat -> relax target to 0
        if (safety.deadManTripped() || safety.heartbeatLost()) targetIntensity = 0;
        const desired = armed ? safety.clampIntensity(targetIntensity + manualBias) : 0;
        current = safety.rampStep(current, desired, dt);

        let main = 0, vib = 0;
        const profile = actType ? ACT_PATTERNS[actType] : null;
        if (armed && current > 0 && profile) {
            // oscillation rate scales with intensity (full speed -> faster), capped by safety
            const basic = getPatternStyle() === 'basic';   // Basic = flat steady vibration (no waveform texture)
            const hz = safety.clampOscHz(profile.baseRateHz * (0.5 + current));
            phase = (phase + TWO_PI * hz * (dt / 1000)) % TWO_PI;
            const env = basic ? 1 : waveform(profile.waveform, phase, profile);
            main = liftSpin(clamp01(current * profile.main * env));
            vib = liftSpin(clamp01(current * profile.vib * env));
        }
        writeMotor(main, vib);
    }

    /** Install an autonomous sequence fn (dtMs, {arousal}) -> amp01, or null to resume scene-driven. */
    function setSequence(fn) { sequenceFn = fn || null; phase = 0; }

    /** Fire a brief contact blip (amp 0..1, ms) that overrides current output momentarily. */
    function blip(amp, ms) { blipAmp = Math.max(0, Math.min(1, amp)); blipUntil = now() + (ms || 250); }

    function start() {
        if (timer) return;
        lastTick = 0;
        timer = setInterval(tick, Math.round(1000 / SAFETY.TICK_HZ));
    }
    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        current = 0; phase = 0; sequenceFn = null;
        writeMotor(0, 0);
    }

    /** Emergency stop: bypass ramp, kill loop, hard-write device stop. */
    function estop() {
        if (timer) { clearInterval(timer); timer = null; }
        current = 0; targetIntensity = 0; manualBias = 0; actType = null;
        sequenceFn = null;
        lastMain = lastVib = -1;
        connector.hardStop();
        log('ESTOP');
    }

    return { start, stop, estop, setTarget, setManualBias, clearManualBias, setSequence, blip, get intensity() { return current; } };
}
