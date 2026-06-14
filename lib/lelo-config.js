/**
 * LELO F1S V3 — data-driven configuration (NSFW haptic feature)
 *
 * The "magic is in the numbers" file: every tunable for the connector/actuator lives here so the logic
 * modules stay generic. All tables are frozen (immutable per coding-style.md). No logic in this file.
 *
 * Protocol facts reimplemented from the official spec (CC BY-NC-ND 4.0, functional facts only):
 *   https://github.com/LELO-Devs/F1S-SDK/blob/master/F1S-V2-SPEC.md
 * Original implementation — NOT derived from LELO SDK source.
 */

// ============================================================================
// BLE protocol (UUIDs + command bytes) — from F1S-V2-SPEC.md
// ============================================================================

// Web Bluetooth normalizes 16-bit UUIDs to the 128-bit base form; use full strings for getCharacteristic.
const base = (short) => `0000${short}-0000-1000-8000-00805f9b34fb`;

export const BLE = Object.freeze({
    SERVICE: base('fff0'),            // LELO Custom Service (motor on V2; layout differs on V3)
    BATTERY_SERVICE: base('180f'),
    // The V3 places custom chars (Security 0x0A10, sensors, buttons) OUTSIDE 0xFFF0 — observed services
    // also include 0x181C (User Data) + 0x180A (Device Info). We must allow + scan all of these.
    OPTIONAL_SERVICES: [base('fff0'), base('180f'), base('180a'), base('181c')],
    CHARS: Object.freeze({
        MOTOR: base('fff1'),          // R/W 3B: 0x01 yy zz (main, vibrator; 0x00-0x64)
        ADV_MOTOR: base('0a1a'),      // built-in patterns (unused — we drive MOTOR directly)
        SECURITY: base('0a10'),       // R/W/N 8B: auth handshake (V2)
        SECURITY_ALT: base('0a11'),   // observed on this V3 in 0xFFF0 — likely the relocated security char
        MOTOR2: base('fff2'),         // V3 second motor char (vibrator?) alongside 0xFFF1
        WAKEUP: base('0aa1'),
        HALL: base('0aa3'),           // R/N 2B u16 rotations/sec
        DEPTH: base('0a0b'),          // R/N 2B u16 0x0000-0x0008 deepest cap sensor
        ACCEL: base('0a0c'),          // R/N 7B int16 x,y,z + ww orientation/direction byte
        PRESS_TEMP: base('0a0a'),     // R/N 8B: temp(u32) FF pressure(u32), each /100
        BUTTONS: base('0aa4'),        // R/N 1B: 00=power 01=+ 02=- 03=released
        USE_LOG: base('0a04'),
        BATTERY: base('2a19'),        // R/N 1B 0-100
    }),
    // Motor command bytes (written to CHARS.MOTOR)
    CMD: Object.freeze({
        STOP: [0x01, 0xff],           // stop motors + unlock physical buttons
        SHUTDOWN: [0x01, 0xfa],       // power off device
        CALIBRATE_ACCEL: [0xff, 0xff, 0xff],
    }),
    SECURITY_CONFIRMED: '0100000000000000',   // SECURITY read value when auth complete
    SECURITY_LOCKED: '0000000000000000',      // SECURITY read value before auth
    MOTOR_MAX: 0x64,                  // 100% == 0x64
    MOTOR_MIN_SPIN: 0.30,             // spec: below ~30% the motor may not rotate
});

// ============================================================================
// SAFETY — non-negotiable ceilings (lelo-safety.js enforces these)
// ============================================================================

export const SAFETY = Object.freeze({
    MAX_INTENSITY: 1.0,         // absolute ceiling (device's own 0-100 is the real limit; ramp+estop+deadman remain)
    USER_MAX_DEFAULT: 0.95,     // default user-facing cap (<= MAX_INTENSITY)
    MAX_RATE_PER_SEC: 0.35,     // envelope ramp: intensity units/sec (no raw step writes)
    MAX_OSC_HZ: 4.0,            // hard cap on pattern oscillation frequency, even at full pace
    DEAD_MAN_MS: 90_000,        // no narrative signal for this long -> relax to 0
    HEARTBEAT_MS: 8_000,        // expected-notify watchdog while armed -> force stop if silent
    TICK_HZ: 20,                // actuator loop rate
});

// ============================================================================
// LOOP A — act classification + pattern library + pace->intensity
// ============================================================================

export const ACTS = Object.freeze([
    'teasing', 'handjob', 'blowjob', 'titjob', 'footjob', 'vaginal', 'anal', 'climax',
]);

// Per-act base intensity (before pace multiplier). Pace is the PRIMARY driver (see PACE_MULT).
export const ACT_BASELINE = Object.freeze({
    teasing: 0.15, handjob: 0.30, blowjob: 0.42, titjob: 0.30,
    footjob: 0.28, vaginal: 0.50, anal: 0.50, climax: 0.85,
});

// Pattern oscillator profiles. waveform is implemented by lelo-actuator.js.
// mainVibBalance: relative weight of main motor vs vibrator (each scaled by final intensity).
// baseRateHz: oscillation cycles/sec at steady pace (clamped to SAFETY.MAX_OSC_HZ).
// regularity: 0..1 (1 = metronomic; lower = humanized jitter).
export const ACT_PATTERNS = Object.freeze({
    teasing: { waveform: 'tease',     main: 0.5, vib: 0.6, baseRateHz: 0.5, regularity: 0.4, floor: 0.05, ceil: 0.35 },
    handjob: { waveform: 'stroke',    main: 0.9, vib: 0.2, baseRateHz: 1.4, regularity: 0.55, floor: 0.10, ceil: 0.80 },
    blowjob: { waveform: 'suction',   main: 0.8, vib: 0.6, baseRateHz: 1.6, regularity: 0.7, floor: 0.15, ceil: 0.80 },
    titjob:  { waveform: 'grind',     main: 0.8, vib: 0.3, baseRateHz: 0.9, regularity: 0.6, floor: 0.10, ceil: 0.65 },
    footjob: { waveform: 'grind',     main: 0.85, vib: 0.2, baseRateHz: 1.0, regularity: 0.5, floor: 0.10, ceil: 0.65 },
    vaginal: { waveform: 'thrust',    main: 0.95, vib: 0.3, baseRateHz: 1.8, regularity: 0.8, floor: 0.20, ceil: 0.95 },
    anal:    { waveform: 'thrust',    main: 0.95, vib: 0.45, baseRateHz: 1.7, regularity: 0.85, floor: 0.20, ceil: 0.95 },
    climax:  { waveform: 'crescendo', main: 1.0, vib: 0.9, baseRateHz: 2.6, regularity: 0.9, floor: 0.60, ceil: 1.0 },
});

// Keyword tables for the regex classifier. Longest/most-specific match wins (classifier sorts).
export const ACT_KEYWORDS = Object.freeze({
    climax:  ['cum', 'cumming', 'climax', 'orgasm', 'finish', 'over the edge', 'spill', 'release inside'],
    blowjob: ['blowjob', 'blow job', 'suck', 'sucking', 'fellatio', 'deepthroat', 'deep throat', 'mouth around', 'lips around', 'oral', 'tongue along', 'head bob'],
    anal:    ['anal', 'in the ass', 'in their ass', 'asshole', 'from behind into', 'buggery', 'sodom'],
    vaginal: ['pussy', 'vagina', 'inside her', 'inside them', 'thrust into', 'sheathe', 'cunt', 'her wet', 'rides you', 'sinks down on'],
    titjob:  ['titjob', 'titfuck', 'paizuri', 'between her breasts', 'between their breasts', 'cleavage', 'tits around'],
    footjob: ['footjob', 'feet', 'toes', 'soles', 'arches', 'foot job'],
    handjob: ['handjob', 'hand job', 'stroke', 'stroking', 'jerk', 'jerking', 'grip your', 'fist', 'pump', 'palm', 'hand around', 'wank'],
    teasing: ['tease', 'teasing', 'graze', 'caress', 'lick the tip', 'flick', 'trace', 'feather', 'brush against', 'toy with'],
});

export const PACE_KEYWORDS = Object.freeze({
    caress: ['gently', 'softly', 'slowly', 'languid', 'tender', 'feather', 'barely', 'lightly', 'tease', 'delicate'],
    slow:   ['slow', 'unhurried', 'leisurely', 'easy', 'gradual'],
    fast:   ['fast', 'faster', 'quick', 'quickly', 'hard', 'harder', 'rough', 'roughly', 'pound', 'pounding', 'frantic', 'frantically', 'full speed', 'deep', 'deeper', 'relentless', 'hammer', 'desperate'],
});

// Pace multiplier on ACT_BASELINE. 'steady' is the unstated default. (legacy; superseded by INTENSITY_PROFILES)
export const PACE_MULT = Object.freeze({
    caress: 0.40, slow: 0.60, steady: 1.0, fast: 1.55, frantic: 2.0,
});

// Intensity modes — single-button cycle. Perceptually-spaced pace->intensity curves (0..1).
// Floor ~0.30 = motor dead-zone; 'fast' is clearly strong; fast->frantic step is modest (not jarring).
// 'auto' derives the curve per-character (physique) by blending mild<->harsh from charBias.
export const INTENSITY_MODES = Object.freeze(['mild', 'standard', 'harsh', 'auto']);
export const INTENSITY_PROFILES = Object.freeze({
    mild:     { caress: 0.25, slow: 0.36, steady: 0.48, fast: 0.62, frantic: 0.72 },
    standard: { caress: 0.30, slow: 0.45, steady: 0.60, fast: 0.78, frantic: 0.90 },
    harsh:    { caress: 0.38, slow: 0.55, steady: 0.72, fast: 0.88, frantic: 1.00 },
});
// Per-act flavor multiplier on the pace level (act mainly drives the PATTERN, not the raw level).
export const ACT_SCALE = Object.freeze({
    teasing: 0.70, handjob: 0.90, blowjob: 1.0, titjob: 0.85, footjob: 0.85,
    vaginal: 1.05, anal: 1.05, climax: 1.15,
});

// Secondary tension nudge (from WW TENSION_CHANGED). Small by design — never dominates pace.
export const TENSION_NUDGE = 0.15;     // intensity += (tension-0.5)*2 * TENSION_NUDGE

// ============================================================================
// LOOP A.5 — first-message character calibration (charBias)
// ============================================================================

export const CALIBRATION = Object.freeze({
    TIER_STEP: 0.15,         // each net tier shifts the whole baseline by this
    MAX_TIERS: 2,            // net clamp: charBias in [-0.30, +0.30]
    PHYS_UP:   ['large', 'muscular', 'huge', 'tall', 'powerful', 'hung', 'broad', 'big', 'strong', 'massive', 'towering', 'burly', 'thick', 'giant', 'hulking', 'stocky'],
    PHYS_DOWN: ['petite', 'slender', 'small', 'delicate', 'slight', 'tiny', 'lithe', 'frail', 'waifish', 'diminutive'],
    PSYCH_UP:  ['dominant', 'rough', 'aggressive', 'commanding', 'sadistic', 'forceful', 'intense', 'brutish', 'possessive', 'feral', 'ravenous', 'merciless', 'demanding', 'predatory'],
    PSYCH_DOWN:['gentle', 'tender', 'shy', 'submissive', 'careful', 'timid', 'soft', 'sweet', 'nurturing', 'hesitant', 'meek'],
});

// ============================================================================
// LOOP B — arousal model (interaction-derived ESTIMATE; no physiological sensor)
// ============================================================================

export const AROUSAL = Object.freeze({
    RISE_PER_SEC: 0.6,         // climb rate at full stimulation
    DECAY_PER_SEC: 0.10,       // relaxation rate when fully idle (decay scales with LACK of stim)
    W_MOTION: 0.85,            // motion (accel) is the reliable V3 arousal signal
    W_PRESSURE: 0.15,
    W_DEPTH: 0.0,              // depth char (0x0A0B) absent on V3
    CLIMAX_MOTION: 0.85,       // sustained motion+pressure spike => climax heuristic
    CLIMAX_PRESSURE: 0.80,
    THRESHOLDS: Object.freeze({ rising: 0.30, high: 0.60, edge: 0.85 }),
    EMIT_HZ: 2,                // throttle for HAPTIC_AROUSAL/FEEDBACK emits
});

// Escalating, terse, non-graphic prompt lines for the ww_player_arousal lore category.
export const AROUSAL_LORE = Object.freeze([
    { min: 0.00, text: '{{user}} is composed, just beginning to warm.' },
    { min: 0.30, text: '{{user}} is becoming aroused — it is starting to show.' },
    { min: 0.60, text: '{{user}} is highly aroused, breathing harder; {{char}} can clearly see it.' },
    { min: 0.85, text: '{{user}} is on the very edge, about to climax — plainly, unmistakably. {{char}} can tell.' },
]);

// ============================================================================
// LOOP C — manual +/- buttons -> transcription
// ============================================================================

// Adverb chosen by press cadence (ms between presses): soft single tap vs rapid mashing.
export const MANUAL_CADENCE = Object.freeze({
    GENTLE_MAX_PRESSES: 1,         // 1 press => gentle
    URGENT_MIN_PRESSES: 4,         // >=4 presses (or rapid) => urgent
    RAPID_INTERVAL_MS: 400,        // presses faster than this count as urgent
    ADVERB: Object.freeze({ gentle: 'gently', normal: '', urgent: 'urgently' }),
});

export const MANUAL_BIAS_STEP = 0.08;   // intensity offset applied per net press (Loop C live feel)

// Phrasing keyed by act -> direction. <adv> filled from cadence; {{user}}/{{char}} from ST context.
export const MANUAL_ADJUST_PHRASING = Object.freeze({
    handjob: { slower: "{{user}} <adv> slows {{char}}'s hand, easing the stroke", faster: "{{user}} <adv> urges {{char}}'s hand faster, gripping harder" },
    blowjob: { slower: "{{user}} <adv> eases {{char}} off, slowing their mouth", faster: "{{user}} <adv> urges {{char}} to take them faster and deeper" },
    titjob:  { slower: "{{user}} <adv> slows the grind of {{char}}'s breasts", faster: "{{user}} <adv> presses {{char}} to work faster" },
    footjob: { slower: "{{user}} <adv> slows {{char}}'s feet", faster: "{{user}} <adv> urges {{char}}'s feet faster" },
    vaginal: { slower: "{{user}} <adv> stills {{char}}'s hips, slowing the pace", faster: "{{user}} <adv> drives {{char}} faster, deeper" },
    anal:    { slower: "{{user}} <adv> stills {{char}}'s hips, slowing the pace", faster: "{{user}} <adv> drives {{char}} harder, faster" },
    teasing: { slower: "{{user}} <adv> slows {{char}}'s teasing touch", faster: "{{user}} <adv> presses {{char}} for more" },
    _generic:{ slower: "{{user}} <adv> guides {{char}} to go slower", faster: "{{user}} <adv> guides {{char}} to go faster" },
});

// ============================================================================
// LOOP D — orientation -> presence hint (gated by contact)
// ============================================================================

export const ORIENTATION = Object.freeze({
    // Accel z (upright ~ +1024 per spec). Held up = pointing toward crotch = z strongly positive.
    UP_Z_ENTER: 600,          // z above this (with x,y modest) => 'up'
    UP_Z_EXIT: 350,           // hysteresis: must fall below this to leave 'up' (anti-flicker)
    DEBOUNCE_MS: 1500,        // orientation must hold this long before state change commits
    PHRASE: '{{user}} is holding their crotch',
});

// Loop D suppresses while ANY of these acts is active (character is engaging the crotch).
export const CROTCH_CONTACT_ACTS = Object.freeze(ACTS.slice());   // every device-driven act

// ============================================================================
// localStorage keys (read by lore-bridge, matching the other categories' pattern)
// ============================================================================

export const STORAGE = Object.freeze({
    HAPTIC: 'haptix_state',          // telemetry + arousal + act/orientation snapshot
    SETTINGS: 'haptix_cfg',    // user caps / phrasing prefs (non-secret)
});
