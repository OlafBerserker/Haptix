/**
 * LELO F1S V3 — safety policy (NSFW haptic feature)
 *
 * Pure, dependency-light enforcement of the non-negotiable ceilings. The actuator routes EVERY motor write
 * through this gate. Invariant: any uncertainty resolves to motor-off.
 *
 *   1. hard max-intensity cap (absolute, user can lower not raise)
 *   2. envelope rate-limit (no raw step writes)
 *   3. oscillation-frequency cap
 *   4. dead-man (no narrative signal) + heartbeat (no BLE notify) watchdogs
 *   5. arming requires a per-session consent token (no token -> no write, no emission)
 */

import { SAFETY } from './lelo-config.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {object} [opts]
 * @param {() => number} [opts.now] injectable clock (testability)
 */
export function createSafetyGate({ now = () => Date.now() } = {}) {
    let armed = false;
    let consentToken = null;
    let userMax = SAFETY.USER_MAX_DEFAULT;
    let lastSignalAt = 0;   // last narrative/manual activity
    let lastNotifyAt = 0;   // last BLE notify while armed

    const effectiveMax = () => Math.min(userMax, SAFETY.MAX_INTENSITY);

    return {
        // ---- consent / arming (rule 5) ----
        arm(token) {
            if (!token) throw new Error('[lelo-safety] arm() requires a per-session consent token');
            armed = true;
            consentToken = token;
            const t = now();
            lastSignalAt = t;
            lastNotifyAt = t;
        },
        disarm() { armed = false; consentToken = null; },
        isArmed() { return armed && !!consentToken; },
        get token() { return consentToken; },

        // ---- user-lowerable cap (rule 1) ----
        setUserMax(v) { userMax = clamp(Number(v) || 0, 0, SAFETY.MAX_INTENSITY); },
        getUserMax() { return userMax; },
        getEffectiveMax: effectiveMax,

        /** Clamp a final normalized intensity to the effective ceiling. Never returns > MAX_INTENSITY. */
        clampIntensity(v) {
            if (!this.isArmed()) return 0;            // disarmed -> off, always
            if (!Number.isFinite(v)) return 0;        // NaN/Infinity -> off (fail-safe)
            return clamp(v, 0, effectiveMax());
        },

        // ---- envelope rate-limit (rule 2) ----
        /** Move `current` toward `target` by at most MAX_RATE_PER_SEC * dt. */
        rampStep(current, target, dtMs) {
            const maxDelta = SAFETY.MAX_RATE_PER_SEC * (Math.max(0, dtMs) / 1000);
            const diff = target - current;
            if (Math.abs(diff) <= maxDelta) return target;
            return current + Math.sign(diff) * maxDelta;
        },

        // ---- oscillation cap (rule 3) ----
        clampOscHz(hz) { return clamp(Number(hz) || 0, 0, SAFETY.MAX_OSC_HZ); },

        // ---- watchdogs (rule 4) ----
        recordSignal() { lastSignalAt = now(); },   // call on any narrative/manual activity
        recordNotify() { lastNotifyAt = now(); },   // call on any BLE notify while armed
        deadManTripped() { return armed && (now() - lastSignalAt) > SAFETY.DEAD_MAN_MS; },
        heartbeatLost() { return armed && (now() - lastNotifyAt) > SAFETY.HEARTBEAT_MS; },
    };
}
