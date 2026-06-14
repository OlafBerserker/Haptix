/**
 * Haptix — Gamepad rumble output (Gamepad API: DualSense / Xbox / most XInput pads).
 *
 * Mainstream haptics, top confidence: navigator.getGamepads()[i].vibrationActuator.playEffect('dual-rumble',…).
 * No BLE pairing, no permission prompt — the pad is already connected. Effects are DURATION-BOUNDED, so to
 * sustain a level we re-issue on a short cadence (overlapping windows -> no gaps). All output is clamped.
 *
 * This is a self-contained alternate OUTPUT device (same setTarget/stop/estop shape as the LELO actuator),
 * so multi-output routing (a controller buzzing alongside a toy) can use it without core changes.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

/**
 * Pure mapping: normalized intensity -> { strong, weak } rumble magnitudes (0..1).
 * strong = low-frequency (big motor), weak = high-frequency (small motor). A light gamma (0.8) keeps the
 * low end perceptible (ERM motors have a dead-zone), matching the toy intensity curve's intent.
 */
export function rumbleMagnitudes(norm) {
    const g = Math.pow(clamp01(norm), 0.8);
    return { strong: g, weak: clamp01(g * 0.65) };
}

export function listGamepads() {
    try { return Array.from(navigator.getGamepads?.() || []).filter(Boolean); } catch { return []; }
}
function canRumble(gp) {
    return !!(gp && gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function');
}

export function createGamepadActuator({ getCap = () => 1, onLog } = {}) {
    let timer = null, target = 0, idx = null;
    const PERIOD = 150, DUR = 250;   // re-issue every 150ms with 250ms effects -> overlap, no gaps
    const log = (m) => onLog?.(`[gamepad] ${m}`);

    function pick() {
        const pads = listGamepads().filter(canRumble);
        if (!pads.length) return null;
        if (idx != null) { const f = pads.find((p) => p.index === idx); if (f) return f; }
        idx = pads[0].index;
        return pads[0];
    }
    function pulse() {
        const gp = pick();
        if (!gp) return;
        const lvl = clamp01(target * clamp01(getCap()));
        const { strong, weak } = rumbleMagnitudes(lvl);
        try {
            gp.vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: DUR, strongMagnitude: strong, weakMagnitude: weak });
        } catch (e) { log(e.message); }
    }

    return {
        supported: () => listGamepads().some(canRumble),
        list: () => listGamepads().filter(canRumble).map((p) => ({ index: p.index, id: p.id })),
        selectIndex(i) { idx = i; },
        get index() { return idx; },
        setTarget(n) { target = clamp01(n); if (!timer) timer = setInterval(pulse, PERIOD); pulse(); },
        start() { if (!timer) timer = setInterval(pulse, PERIOD); },
        stop() {
            if (timer) { clearInterval(timer); timer = null; }
            target = 0;
            try { pick()?.vibrationActuator?.reset?.(); } catch { /* ignore */ }
        },
        estop() {
            target = 0;
            if (timer) { clearInterval(timer); timer = null; }
            try {
                const gp = pick();
                gp?.vibrationActuator?.playEffect?.('dual-rumble', { duration: 0, strongMagnitude: 0, weakMagnitude: 0 });
                gp?.vibrationActuator?.reset?.();
            } catch { /* ignore */ }
        },
    };
}
