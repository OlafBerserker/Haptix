/**
 * LELO haptic SEQUENCES — autonomous, time-evolving intensity patterns (NSFW haptic feature).
 *
 * Each sequence is a stateful closure: tick(dtMs, ctx) -> amplitude 0..1, where ctx = { arousal }.
 * The actuator runs the active sequence in place of the act-oscillator (still clamped by the safety cap;
 * estop/dead-man unaffected). 'off' returns null (normal act-driven behavior resumes).
 *
 * Pattern parameters synthesized from haptic-design research (Lovense/DRV2605/Core Haptics/funscript +
 * Stevens' law); all timings are tunable defaults. Auto-edge uses Schmitt-trigger hysteresis on arousal.
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (u) => { const t = clamp01(u); return t * t * (3 - 2 * t); };

export const SEQUENCES = Object.freeze([
    'off', 'buildup', 'wave', 'pulse', 'throb', 'edging', 'organic', 'fireworks', 'autoedge',
]);

export const SEQUENCE_LABELS = Object.freeze({
    off: 'Off (scene-driven)', buildup: 'Build-up', wave: 'Wave', pulse: 'Pulse', throb: 'Throb',
    edging: 'Edging', organic: 'Organic', fireworks: 'Fireworks', autoedge: 'Auto-edge (arousal)',
});

/** Build a stateful sequence runner by name. Returns null for 'off'. */
export function createSequence(name) {
    let t = 0;             // elapsed ms
    const adv = (dt) => { t += Math.max(0, dt); };

    switch (name) {
        case 'buildup': {            // 30s smooth ramp 0.15 -> 1.0, then hold
            const RAMP = 30000;
            return (dt) => { adv(dt); return 0.15 + 0.85 * smoothstep(t / RAMP); };
        }
        case 'wave': {               // slow sine 0.15..0.95, 4s period
            const P = 4000;
            return (dt) => { adv(dt); return 0.15 + 0.80 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / P)); };
        }
        case 'pulse': {              // square 0.9/0.05, 0.7s period, 50% duty
            const P = 700;
            return (dt) => { adv(dt); return ((t % P) / P) < 0.5 ? 0.9 : 0.05; };
        }
        case 'throb': {              // sine 0.25..0.85, 0.9s period
            const P = 900;
            return (dt) => { adv(dt); return 0.25 + 0.60 * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / P)); };
        }
        case 'edging': {             // rise -> back off near peak -> refractory -> repeat
            let phase = 'rise', pt = 0, amp = 0.2;
            const RISE = 20000, PEAK = 0.85, BACKOFF = 1500, FLOOR = 0.34, REFRACTORY = 4000;
            return (dt) => {
                adv(dt); pt += dt;
                if (phase === 'rise') {
                    amp = 0.2 + (PEAK - 0.2) * clamp01(pt / RISE);
                    if (amp >= PEAK) { phase = 'backoff'; pt = 0; }
                } else if (phase === 'backoff') {
                    amp = PEAK - (PEAK - FLOOR) * clamp01(pt / BACKOFF);
                    if (pt >= BACKOFF) { phase = 'refractory'; pt = 0; }
                } else { amp = FLOOR; if (pt >= REFRACTORY) { phase = 'rise'; pt = 0; } }
                return amp;
            };
        }
        case 'organic': {            // mean-reverting random walk (humanized)
            let level = 0.5; let acc = 0;
            const BASE = 0.5, VOL = 0.10, STEP = 250, DECAY = 0.9;
            return (dt) => {
                adv(dt); acc += dt;
                while (acc >= STEP) { acc -= STEP; level = BASE + (level - BASE) * DECAY + (Math.random() * 2 - 1) * VOL; }
                return clamp01(Math.min(0.85, Math.max(0.2, level)));
            };
        }
        case 'fireworks': {          // random decaying bursts, amplitude = max of active bursts
            let bursts = []; let acc = 0;
            const SPAWN = 800, TAU = 350, FLOOR = 0.05;
            return (dt) => {
                adv(dt); acc += dt;
                if (acc >= SPAWN) { acc = 0; if (Math.random() < 0.9) bursts.push({ a0: 0.7 + Math.random() * 0.3, age: 0 }); }
                bursts.forEach((b) => { b.age += dt; });
                bursts = bursts.filter((b) => b.a0 * Math.exp(-b.age / TAU) > 0.04);
                const amp = bursts.reduce((m, b) => Math.max(m, b.a0 * Math.exp(-b.age / TAU)), 0);
                return Math.max(FLOOR, amp);
            };
        }
        case 'autoedge': {           // arousal-reactive with hysteresis (Schmitt trigger)
            let state = 'drive', pt = 0, amp = 0.1;
            const T_HIGH = 0.80, T_LOW = 0.55, RAMP_DOWN = 1200, FLOOR = 0.15, MIN_COOL = 5000;
            return (dt, ctx) => {
                adv(dt); pt += dt;
                const a = clamp01(ctx?.arousal ?? 0);
                if (state === 'drive') {
                    amp = 0.10 + 0.90 * Math.pow(a, 0.8);
                    if (a >= T_HIGH) { state = 'holdoff'; pt = 0; }
                } else if (state === 'holdoff') {
                    amp = (0.10 + 0.90 * Math.pow(a, 0.8)) - ((0.10 + 0.90 * Math.pow(T_HIGH, 0.8)) - FLOOR) * clamp01(pt / RAMP_DOWN);
                    amp = Math.max(FLOOR, amp);
                    if (pt >= RAMP_DOWN) { state = 'cooldown'; pt = 0; }
                } else { amp = FLOOR; if (a <= T_LOW && pt >= MIN_COOL) { state = 'drive'; pt = 0; } }
                return clamp01(amp);
            };
        }
        default: return null;        // 'off' / unknown -> scene-driven
    }
}
