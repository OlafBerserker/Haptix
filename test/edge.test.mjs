/**
 * Haptix — edge-case test harness (no hardware, no network, deterministic).
 *
 * Covers the safety-critical and easy-to-break logic: config integrity, the safety gate's clamps/ramp/
 * watchdogs, motor-command byte encoding bounds, sequence amplitude bounds, the scene classifier's contact
 * gate (the "no-misfire" guarantee), and sensor decode. Run:  node test/edge.test.mjs   (or `npm test`).
 *
 * Why this exists: a haptic device strapped to a person is the one place "looks right" is not good enough.
 * Every output that can reach a motor is bounded here, in code, so a refactor can't silently unbound it.
 */

import { SAFETY, BLE, ACTS, ACT_BASELINE, ACT_PATTERNS, ACT_SCALE, INTENSITY_MODES,
    INTENSITY_PROFILES, AROUSAL, AROUSAL_LORE, ORIENTATION, BLIP, CALIBRATION } from '../lib/lelo-config.js';
import { createSafetyGate } from '../lib/lelo-safety.js';
import { getCommandPath, COMMAND_PATHS } from '../lib/lelo-command-path.js';
import { SEQUENCES, createSequence } from '../lib/lelo-sequences.js';
import { classifyMessage, classifyIncidental, calibrateCharacter } from '../lib/lelo-scene-classifier.js';
import { createSensors } from '../lib/lelo-sensors.js';
import { PROTOCOLS, PROTOCOL_IDS, encodeFor } from '../lib/protocols.js';
import { rumbleMagnitudes } from '../lib/gamepad.js';

// ---- tiny assert framework -------------------------------------------------
let pass = 0, fail = 0; const fails = [];
function t(name, fn) { try { fn(); pass++; } catch (e) { fail++; fails.push(`${name}: ${e.message}`); } }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); }
function near(a, b, eps, m) { if (Math.abs(a - b) > (eps ?? 1e-9)) throw new Error(`${m || 'near'}: ${a} !~ ${b}`); }
function inRange(v, lo, hi, m) { if (!(v >= lo && v <= hi)) throw new Error(`${m || 'range'}: ${v} not in [${lo},${hi}]`); }

// ---- DataView builders (mirror the device wire formats) --------------------
const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
const u8 = (v) => dv([v & 0xff]);
const u16be = (v) => dv([(v >> 8) & 0xff, v & 0xff]);
const u16le = (v) => dv([v & 0xff, (v >> 8) & 0xff]);
const i16be = (v) => [(v >> 8) & 0xff, v & 0xff];
const accel = (x, y, z, o = 0) => dv([...i16be(x), ...i16be(y), ...i16be(z), o & 0xff]);

// ============================================================================
// 1. CONFIG INTEGRITY — the "magic numbers" must be internally consistent
// ============================================================================

t('every ACT has baseline/pattern/scale', () => {
    for (const a of ACTS) {
        ok(ACT_BASELINE[a] != null, `baseline ${a}`);
        ok(ACT_PATTERNS[a] != null, `pattern ${a}`);
        ok(ACT_SCALE[a] != null, `scale ${a}`);
        inRange(ACT_BASELINE[a], 0, 1, `baseline ${a}`);
    }
});

t('ACT_PATTERNS floor<=ceil, all in [0,1], rate under MAX_OSC_HZ', () => {
    for (const [a, p] of Object.entries(ACT_PATTERNS)) {
        inRange(p.floor, 0, 1, `floor ${a}`);
        inRange(p.ceil, 0, 1, `ceil ${a}`);
        ok(p.floor <= p.ceil, `floor<=ceil ${a}`);
        inRange(p.main, 0, 1, `main ${a}`);
        inRange(p.vib, 0, 1, `vib ${a}`);
        inRange(p.regularity, 0, 1, `regularity ${a}`);
        ok(p.baseRateHz <= SAFETY.MAX_OSC_HZ, `baseRateHz ${a} (${p.baseRateHz}) exceeds MAX_OSC_HZ`);
    }
});

t('INTENSITY_PROFILES monotonic non-decreasing + in [0,1]', () => {
    for (const mode of ['mild', 'standard', 'harsh']) {
        const p = INTENSITY_PROFILES[mode];
        ok(p, `profile ${mode} exists`);
        const order = [p.caress, p.slow, p.steady, p.fast, p.frantic];
        for (let i = 0; i < order.length; i++) inRange(order[i], 0, 1, `${mode}[${i}]`);
        for (let i = 1; i < order.length; i++) ok(order[i] >= order[i - 1], `${mode} not monotonic at ${i}`);
    }
});

t('mild <= standard <= harsh at every pace', () => {
    for (const pace of ['caress', 'slow', 'steady', 'fast', 'frantic']) {
        ok(INTENSITY_PROFILES.mild[pace] <= INTENSITY_PROFILES.standard[pace], `mild<=standard ${pace}`);
        ok(INTENSITY_PROFILES.standard[pace] <= INTENSITY_PROFILES.harsh[pace], `standard<=harsh ${pace}`);
    }
});

t('INTENSITY_MODES includes auto + the three curves', () => {
    for (const m of ['mild', 'standard', 'harsh', 'auto']) ok(INTENSITY_MODES.includes(m), `mode ${m}`);
});

t('AROUSAL weights sum to 1 + thresholds ordered in [0,1]', () => {
    near(AROUSAL.W_MOTION + AROUSAL.W_PRESSURE + AROUSAL.W_DEPTH, 1, 1e-6, 'weights sum');
    const { rising, high, edge } = AROUSAL.THRESHOLDS;
    ok(0 < rising && rising < high && high < edge && edge <= 1, 'thresholds order');
});

t('AROUSAL_LORE sorted ascending by min, all in [0,1]', () => {
    for (let i = 0; i < AROUSAL_LORE.length; i++) inRange(AROUSAL_LORE[i].min, 0, 1, `lore ${i}`);
    for (let i = 1; i < AROUSAL_LORE.length; i++) ok(AROUSAL_LORE[i].min > AROUSAL_LORE[i - 1].min, `lore order ${i}`);
});

t('SAFETY ceilings sane', () => {
    ok(SAFETY.USER_MAX_DEFAULT <= SAFETY.MAX_INTENSITY, 'user max <= absolute');
    ok(SAFETY.MAX_RATE_PER_SEC > 0, 'rate > 0');
    ok(SAFETY.MAX_OSC_HZ > 0, 'osc > 0');
    ok(SAFETY.DEAD_MAN_MS > 0 && SAFETY.HEARTBEAT_MS > 0, 'watchdogs > 0');
});

t('ORIENTATION hysteresis sane (exit < enter), BLIP amps in [0,1]', () => {
    ok(ORIENTATION.UP_Z_EXIT < ORIENTATION.UP_Z_ENTER, 'exit<enter');
    inRange(BLIP.incidental.amp, 0, 1, 'incidental amp');
    inRange(BLIP.impact.amp, 0, 1, 'impact amp');
    ok(BLIP.impact.amp > BLIP.incidental.amp, 'impact sharper than incidental');
});

t('CALIBRATION net clamp = MAX_TIERS*TIER_STEP', () => {
    near(CALIBRATION.MAX_TIERS * CALIBRATION.TIER_STEP, 0.30, 1e-9, 'calib clamp');
});

// ============================================================================
// 2. SAFETY GATE — every motor-reaching value passes through here
// ============================================================================

t('arm() requires a consent token', () => {
    const g = createSafetyGate();
    let threw = false;
    try { g.arm(null); } catch { threw = true; }
    ok(threw, 'arm(null) must throw');
    ok(!g.isArmed(), 'still disarmed');
});

t('disarmed -> clampIntensity always 0', () => {
    const g = createSafetyGate();
    eq(g.clampIntensity(1.0), 0, 'disarmed full');
    eq(g.clampIntensity(0.5), 0, 'disarmed half');
});

t('armed clampIntensity: NaN/Infinity/negative -> 0, over-max -> capped', () => {
    const g = createSafetyGate(); g.arm('tok');
    eq(g.clampIntensity(NaN), 0, 'NaN');
    eq(g.clampIntensity(Infinity), 0, 'Infinity');
    eq(g.clampIntensity(-5), 0, 'negative');
    eq(g.clampIntensity(99), g.getEffectiveMax(), 'over-max capped');
    ok(g.clampIntensity(99) <= SAFETY.MAX_INTENSITY, 'never exceeds absolute');
});

t('setUserMax cannot raise above absolute ceiling', () => {
    const g = createSafetyGate(); g.arm('tok');
    g.setUserMax(5);
    ok(g.getUserMax() <= SAFETY.MAX_INTENSITY, 'clamped to absolute');
    g.setUserMax(-1);
    eq(g.getUserMax(), 0, 'clamped to 0');
});

t('rampStep never steps more than MAX_RATE_PER_SEC*dt', () => {
    const g = createSafetyGate();
    const dtMs = 100;
    const maxDelta = SAFETY.MAX_RATE_PER_SEC * dtMs / 1000;
    const stepped = g.rampStep(0, 1, dtMs);
    near(stepped, maxDelta, 1e-9, 'one step = maxDelta');
    eq(g.rampStep(0.5, 0.5 + maxDelta / 2, dtMs), 0.5 + maxDelta / 2, 'small diff snaps to target');
    // negative dt -> maxDelta 0 -> cannot move away from current
    eq(g.rampStep(0.4, 1, -50), 0.4, 'negative dt no move');
});

t('clampOscHz bounds + NaN -> 0', () => {
    const g = createSafetyGate();
    eq(g.clampOscHz(999), SAFETY.MAX_OSC_HZ, 'over');
    eq(g.clampOscHz(-1), 0, 'under');
    eq(g.clampOscHz(NaN), 0, 'NaN');
});

t('dead-man + heartbeat trip after their windows (injected clock)', () => {
    let clock = 1_000_000;
    const g = createSafetyGate({ now: () => clock });
    g.arm('tok');
    ok(!g.deadManTripped(), 'fresh: no deadman');
    ok(!g.heartbeatLost(), 'fresh: no heartbeat loss');
    clock += SAFETY.HEARTBEAT_MS + 1;
    ok(g.heartbeatLost(), 'heartbeat lost after window');
    g.recordNotify();
    ok(!g.heartbeatLost(), 'recordNotify resets heartbeat');
    clock += SAFETY.DEAD_MAN_MS + 1;
    ok(g.deadManTripped(), 'deadman after window');
    g.recordSignal();
    ok(!g.deadManTripped(), 'recordSignal resets deadman');
});

t('disarmed watchdogs never trip', () => {
    let clock = 0;
    const g = createSafetyGate({ now: () => clock });
    clock += SAFETY.DEAD_MAN_MS * 10;
    ok(!g.deadManTripped(), 'no deadman when disarmed');
    ok(!g.heartbeatLost(), 'no heartbeat loss when disarmed');
});

// ============================================================================
// 3. COMMAND PATH — motor byte encoding bounds (the last mile to the motor)
// ============================================================================

t('v2 encode: [0x01, main, vib] clamped to 0..0x64', () => {
    const p = getCommandPath('v2');
    const w = p.writes(0.5, 1.0);
    eq(w.length, 1, 'one write');
    eq(w[0].char, BLE.CHARS.MOTOR, 'to MOTOR');
    eq(w[0].bytes[0], 0x01, 'header');
    eq(w[0].bytes[1], 0x32, '0.5 -> 50');
    eq(w[0].bytes[2], 0x64, '1.0 -> 100');
});

t('v2 encode: out-of-range main/vib clamp (no overflow, no negative)', () => {
    const p = getCommandPath('v2');
    const hi = p.writes(99, 99); eq(hi[0].bytes[1], 0x64, 'over -> 100');
    const lo = p.writes(-5, -5); eq(lo[0].bytes[1], 0x00, 'under -> 0');
    const nan = p.writes(NaN, NaN); eq(nan[0].bytes[1], 0x00, 'NaN -> 0');
    for (const w of [hi, lo, nan]) for (const b of w[0].bytes) inRange(b, 0, 255, 'byte');
});

t('harmony encode: 2 writes to MOTOR2, speed in byte[8], ch 1 & 2', () => {
    const p = getCommandPath('harmony');
    const w = p.writes(1.0, 0.0);
    eq(w.length, 2, 'two writes');
    eq(w[0].char, BLE.CHARS.MOTOR2, 'ch1 -> MOTOR2');
    eq(w[0].bytes[2], 1, 'ch1');
    eq(w[0].bytes[8], 0x64, 'main 1.0 -> 100');
    eq(w[1].bytes[2], 2, 'ch2');
    eq(w[1].bytes[8], 0x00, 'vib 0.0 -> 0');
    eq(w[0].bytes.length, 10, '10-byte harmony cmd');
});

t('stopWrites are zero-speed for both paths', () => {
    const h = getCommandPath('harmony').stopWrites();
    for (const wr of h) eq(wr.bytes[8], 0x00, 'harmony stop speed 0');
    const v = getCommandPath('v2').stopWrites();
    ok(v.length >= 1, 'v2 stop has a write');
});

t('unknown command path falls back to v2', () => {
    eq(getCommandPath('bogus').id, 'v2', 'fallback');
    eq(getCommandPath().id, 'v2', 'default');
    ok(COMMAND_PATHS.includes('v2') && COMMAND_PATHS.includes('harmony'), 'paths listed');
});

// ============================================================================
// 4. SEQUENCES — amplitude must ALWAYS stay in [0,1] (drives the motor)
// ============================================================================

t('every sequence stays in [0,1] for 120s of ticks (incl. random ones)', () => {
    for (const name of SEQUENCES) {
        if (name === 'off') { eq(createSequence(name), null, 'off -> null'); continue; }
        const seq = createSequence(name);
        ok(typeof seq === 'function', `${name} is a runner`);
        for (let i = 0; i < 2400; i++) {           // 2400 * 50ms = 120s
            const a = seq(50, { arousal: (i % 200) / 200 });   // sweep arousal 0..1 repeatedly
            ok(Number.isFinite(a), `${name} finite @${i}`);
            inRange(a, 0, 1, `${name} amp @${i}`);
        }
    }
});

t('buildup ramps up over its window', () => {
    const seq = createSequence('buildup');
    const start = seq(0, {});
    let last = start;
    for (let i = 0; i < 700; i++) last = seq(50, {});   // 35s
    ok(last > start, 'ends higher than it starts');
    ok(last <= 1, 'capped');
});

t('pulse is effectively two-state', () => {
    const seq = createSequence('pulse');
    const seen = new Set();
    for (let i = 0; i < 200; i++) seen.add(Math.round(seq(50, {}) * 100));
    ok(seen.size <= 4, `pulse near-binary (saw ${seen.size} levels)`);
});

t('unknown sequence -> null (scene-driven)', () => { eq(createSequence('nope'), null, 'unknown'); });

// ============================================================================
// 5. SCENE CLASSIFIER — the no-misfire contact gate (Loops A + E)
// ============================================================================

t('atmospheric text does NOT fire (the Aelora bug)', () => {
    const aelora = 'A figure materializes from shadow and smoke. Her finger traces a pattern in the air, '
        + 'leaving trails of purple fire. What boundaries shall we shatter today?';
    eq(classifyMessage(aelora).actType, null, 'aelora no act');
    eq(classifyIncidental(aelora), null, 'aelora no incidental');
    eq(classifyMessage('Her finger traces a pattern in the air').actType, null, 'air trace');
    eq(classifyMessage('The wind howls and lightning splits the sky').actType, null, 'weather');
});

t('empty / null / undefined input is safe', () => {
    eq(classifyMessage('').actType, null, 'empty');
    eq(classifyMessage(null).actType, null, 'null');
    eq(classifyMessage(undefined).actType, null, 'undefined');
    eq(classifyIncidental(''), null, 'incidental empty');
    eq(calibrateCharacter(''), 0, 'calib empty');
});

t('real contact fires the right act', () => {
    eq(classifyMessage('She wraps her hand around your cock and strokes you slowly').actType, 'handjob', 'handjob');
    eq(classifyMessage('She takes your cock in her mouth and sucks').actType, 'blowjob', 'blowjob');
    eq(classifyMessage('you cum hard, spilling over the edge').actType, 'climax', 'climax dominates');
});

t('pace detection', () => {
    eq(classifyMessage('She strokes your cock slowly').pace, 'slow', 'slow');
    eq(classifyMessage('She pumps your cock fast and hard').pace, 'fast', 'fast');
    eq(classifyMessage('She frantically pounds onto your cock').pace, 'frantic', 'frantic');
});

t('incidental vs impact, only when no voluntary act', () => {
    eq(classifyIncidental('A stranger brushes against your crotch in the crowd'), 'incidental', 'brush');
    eq(classifyIncidental('She slaps your ass sharply'), 'impact', 'slap');
    eq(classifyIncidental('The rain falls on the empty street'), null, 'no contact');
});

t('character calibration: big/dominant up, petite/gentle down, clamped', () => {
    const big = calibrateCharacter('A huge, muscular, dominant, powerful barbarian');
    const small = calibrateCharacter('A petite, slender, gentle, shy elf');
    ok(big > 0, 'big positive');
    ok(small < 0, 'small negative');
    inRange(big, -0.30, 0.30, 'big clamp');
    inRange(small, -0.30, 0.30, 'small clamp');
    // stacking many keywords still clamps
    const huge = calibrateCharacter('huge massive towering burly giant hulking dominant aggressive forceful brutish');
    near(huge, 0.30, 1e-9, 'max clamp');
});

// ============================================================================
// 6. SENSOR DECODE — wrong scale/endianness fails silently, so pin it
// ============================================================================

t('battery decode', () => {
    let bat = null;
    const s = createSensors({ onTelemetry: () => {} });
    s.handleNotify('battery', u8(87));
    eq(s.getTelemetry().battery, 87, 'battery 87');
});

t('accel motion in [0,1], rises with magnitude delta', () => {
    const s = createSensors();
    s.handleNotify('accel', accel(0, 0, 0));       // primes prevAccelMag (motion stays 0)
    eq(s.getTelemetry().motion, 0, 'first reading no motion');
    s.handleNotify('accel', accel(100, 0, 0));     // big delta
    inRange(s.getTelemetry().motion, 0, 1, 'motion bounded');
    ok(s.getTelemetry().motion > 0, 'motion registered');
});

t('pressTemp V3 (2-byte) adaptive normalization in [0,1]', () => {
    const s = createSensors();
    s.handleNotify('pressTemp', u16be(1000));      // min=max -> 0
    eq(s.getTelemetry().pressure, 0, 'first -> 0');
    s.handleNotify('pressTemp', u16be(2000));      // new max -> 1
    near(s.getTelemetry().pressure, 1, 1e-9, 'max -> 1');
    s.handleNotify('pressTemp', u16be(1500));      // midpoint -> 0.5
    near(s.getTelemetry().pressure, 0.5, 1e-9, 'mid -> 0.5');
});

t('depth decode (LE u16, capped at 8) + seated flag', () => {
    const s = createSensors();
    s.handleNotify('depth', u16le(4));
    near(s.getTelemetry().depthPct, 0.5, 1e-9, 'depth 4/8');
    ok(s.getTelemetry().seated, 'seated');
    s.handleNotify('depth', u16le(999));           // clamp
    near(s.getTelemetry().depthPct, 1, 1e-9, 'depth capped at 8/8');
});

t('manual +/- accumulation: net-zero -> null, net positive -> dir +1', () => {
    const s = createSensors();
    s.handleNotify('buttons', u8(0x01));           // +
    s.handleNotify('buttons', u8(0x02));           // -
    eq(s.takeManualAdjust(), null, 'net zero -> null');
    s.handleNotify('buttons', u8(0x01));
    s.handleNotify('buttons', u8(0x01));
    s.handleNotify('buttons', u8(0x01));
    s.handleNotify('buttons', u8(0x01));
    const adj = s.takeManualAdjust();
    ok(adj && adj.dir === 1, 'dir +1');
    eq(adj.cadence, 'urgent', '4 presses -> urgent');
    eq(s.takeManualAdjust(), null, 'reset after take');
});

t('power/released button codes are ignored', () => {
    const s = createSensors();
    s.handleNotify('buttons', u8(0x00));           // power
    s.handleNotify('buttons', u8(0x03));           // released
    eq(s.takeManualAdjust(), null, 'no adjust from power/released');
});

t('unknown notify kind does not throw', () => {
    const s = createSensors();
    s.handleNotify('bogus', u8(1));
    ok(true, 'no throw');
});

// ============================================================================
// 7. MULTI-BRAND PROTOCOLS (EXPERIMENTAL) — encoders must stay bounded for ANY input
// ============================================================================

t('every brand encoder produces bounded output for extreme inputs', () => {
    for (const id of PROTOCOL_IDS) {
        const p = PROTOCOLS[id];
        for (const norm of [-5, 0, 0.5, 1, 99, NaN, Infinity]) {
            const out = encodeFor(id, norm);
            ok(out && (out.kind === 'text' || out.kind === 'bytes'), `${id} returns descriptor`);
            if (out.kind === 'bytes') { for (const b of out.data) inRange(b, 0, 255, `${id} byte`); }
            else { ok(typeof out.data === 'string' && out.data.length < 40, `${id} text sane`); }
        }
        const stop = p.stop();
        if (stop.kind === 'bytes') ok(Array.from(stop.data).some((b) => b === 0), `${id} stop has zero`);
        else ok(stop.data.includes('0'), `${id} stop text zero`);
    }
});

t('lovense ASCII clamps 0..20 + dual-channel suffix', () => {
    eq(encodeFor('lovense', 1).data, 'Vibrate:20;', 'full');
    eq(encodeFor('lovense', 0).data, 'Vibrate:0;', 'zero');
    eq(encodeFor('lovense', 99).data, 'Vibrate:20;', 'over clamps');
    eq(encodeFor('lovense', -5).data, 'Vibrate:0;', 'under clamps');
    eq(encodeFor('lovense', 0.5).data, 'Vibrate:10;', 'half');
    eq(encodeFor('lovense', 0.5, 1).data, 'Vibrate2:10;', 'channel 2');
});

t('wevibe packs into 8 bytes', () => {
    const out = encodeFor('wevibe', 1, 1);
    eq(out.data.length, 8, '8-byte packet');
    inRange(out.data[3], 0, 255, 'packed nibble byte');
});

t('unknown protocol -> null', () => { eq(encodeFor('nope', 0.5), null, 'unknown'); });

// ============================================================================
// 8. GAMEPAD RUMBLE — magnitude mapping bounded + monotonic
// ============================================================================

t('rumbleMagnitudes bounded for any input, strong>=weak, monotonic', () => {
    for (const n of [-5, 0, 0.25, 0.5, 1, 99, NaN, Infinity]) {
        const { strong, weak } = rumbleMagnitudes(n);
        inRange(strong, 0, 1, 'strong');
        inRange(weak, 0, 1, 'weak');
        ok(strong >= weak, 'strong>=weak');
    }
    ok(rumbleMagnitudes(1).strong > rumbleMagnitudes(0.5).strong, 'monotonic');
    eq(rumbleMagnitudes(0).strong, 0, 'zero -> zero');
    eq(rumbleMagnitudes(NaN).strong, 0, 'NaN -> zero');
});

// ---- report ----------------------------------------------------------------
console.log(`\nHaptix edge-case harness: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('\nFAILURES:'); for (const f of fails) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
