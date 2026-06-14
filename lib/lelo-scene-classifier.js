/**
 * LELO F1S V3 — scene act/pace classifier + character calibration (NSFW haptic feature)
 *
 * Pure functions (no state, no side effects). The bridge owns debounce/hysteresis and applies the results.
 *   - classifyMessage(text)  -> { actType: string|null, pace: 'caress'|'slow'|'steady'|'fast'|'frantic' }  (Loop A)
 *   - calibrateCharacter(text) -> charBias number in [-0.30, +0.30]                                          (Loop A.5)
 *
 * Keyword tables live in lelo-config.js (data-driven, tunable). A structured act tag from the LLM
 * (e.g. GAME_STATE_EXTRACTED) should be preferred by the caller over this regex fallback when available.
 */

import {
    ACT_KEYWORDS, PACE_KEYWORDS, CALIBRATION, INCIDENTAL_KEYWORDS, IMPACT_KEYWORDS,
    CONTACT_TOKENS, CONTACT_WINDOW,
} from './lelo-config.js';

const FRANTIC = ['frantic', 'frantically', 'full speed', 'pound', 'pounding', 'relentless', 'hammer', 'desperate'];

function countHits(haystack, words) {
    let n = 0;
    for (const w of words) if (haystack.includes(w)) n += 1;
    return n;
}

// True if a user/body contact token sits within CONTACT_WINDOW chars of position idx.
function nearContact(t, idx) {
    const win = t.slice(Math.max(0, idx - CONTACT_WINDOW), Math.min(t.length, idx + CONTACT_WINDOW));
    return CONTACT_TOKENS.some((tok) => win.includes(tok));
}
// True if any keyword occurs AND has a contact token nearby (not just present in atmospheric text).
function hitNearContact(t, words) {
    for (const w of words) { const i = t.indexOf(w); if (i >= 0 && nearContact(t, i)) return true; }
    return false;
}

/**
 * Classify the current intimate act + pace from a scene message.
 * actType is null when no contact keywords are present (no device-driven act).
 */
export function classifyMessage(text) {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return { actType: null, pace: 'steady' };

    // act: score each, climax weighted up (culmination). ACT_KEYWORDS iteration order is the tie-break priority.
    let bestAct = null, bestScore = 0;
    for (const [act, words] of Object.entries(ACT_KEYWORDS)) {
        let score = countHits(t, words);
        if (act === 'climax' && score > 0) score += 1;   // climax dominates when present
        if (score > bestScore) { bestScore = score; bestAct = act; }
    }

    // Contact gate: the act keyword must sit NEAR a user/body token, else it's atmospheric — don't fire.
    if (bestAct) {
        let kwIdx = -1;
        for (const w of ACT_KEYWORDS[bestAct]) { const i = t.indexOf(w); if (i >= 0 && (kwIdx < 0 || i < kwIdx)) kwIdx = i; }
        if (kwIdx < 0 || !nearContact(t, kwIdx)) bestAct = null;
    }

    // pace: frantic > fast > caress > slow > steady
    let pace = 'steady';
    if (countHits(t, FRANTIC) > 0) pace = 'frantic';
    else if (countHits(t, PACE_KEYWORDS.fast) > 0) pace = 'fast';
    else if (countHits(t, PACE_KEYWORDS.caress) > 0) pace = 'caress';
    else if (countHits(t, PACE_KEYWORDS.slow) > 0) pace = 'slow';

    return { actType: bestAct, pace };
}

/**
 * Loop E — broad catch-all for brief, INVOLUNTARY contact. Returns 'impact' | 'incidental' | null.
 * The caller only uses this when classifyMessage found NO voluntary sexual act (so consensual sex
 * never registers as "bad touch"). Impact (hits) beats incidental (brushes).
 */
export function classifyIncidental(text) {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return null;
    if (hitNearContact(t, IMPACT_KEYWORDS)) return 'impact';
    if (hitNearContact(t, INCIDENTAL_KEYWORDS)) return 'incidental';
    return null;
}

/**
 * Derive a per-character intensity baseline offset from physical + psychological description.
 * Big/muscular/dominant -> up; petite/gentle -> down. Net clamped to +/- MAX_TIERS * TIER_STEP.
 */
export function calibrateCharacter(text) {
    const t = (text || '').toLowerCase();
    if (!t.trim()) return 0;
    const up = countHits(t, CALIBRATION.PHYS_UP) + countHits(t, CALIBRATION.PSYCH_UP);
    const down = countHits(t, CALIBRATION.PHYS_DOWN) + countHits(t, CALIBRATION.PSYCH_DOWN);
    let tiers = up - down;
    tiers = Math.max(-CALIBRATION.MAX_TIERS, Math.min(CALIBRATION.MAX_TIERS, tiers));
    return tiers * CALIBRATION.TIER_STEP;
}
