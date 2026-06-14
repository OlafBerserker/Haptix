/**
 * Haptix — core controller (self-contained; no external extension dependencies).
 *
 * Bridges SillyTavern narrative <-> a LELO Bluetooth device:
 *   A  scene -> device : classify each AI message (act + pace) -> motor pattern; per-character calibration.
 *   B  device -> char  : SenseMotion sensors -> estimated arousal -> injected into the LLM context.
 *   C  manual +/-      : capture device button nudges -> transcribe a directed action on the next message.
 *   D  orientation     : held-up -> "holding their crotch" hint (gated by active contact).
 * Plus: 4 intensity modes (mild/standard/harsh/auto), autonomous sequences, persisted settings.
 *
 * Everything is gated behind a per-session consent token. All SillyTavern access is via the stable
 * `SillyTavern.getContext()` global, so install location does not matter.
 */

import {
    ACT_SCALE, INTENSITY_PROFILES, TENSION_NUDGE, MANUAL_ADJUST_PHRASING, MANUAL_CADENCE,
    MANUAL_BIAS_STEP, ORIENTATION, CROTCH_CONTACT_ACTS, STORAGE, BLIP,
} from './lelo-config.js';
import { createSafetyGate } from './lelo-safety.js';
import { createConnector, ConnState } from './lelo-connector.js';
import { createActuator } from './lelo-actuator.js';
import { createSensors } from './lelo-sensors.js';
import { classifyMessage, classifyIncidental, calibrateCharacter } from './lelo-scene-classifier.js';
import { createSequence, SEQUENCES } from './lelo-sequences.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const AROUSAL_KEY = 'HTX_AROUSAL';
const STATE_KEY = 'HTX_STATE';
const TURN_KEY = 'HTX_TURN';

let safety, connector, actuator, sensors, initialized = false;

let currentAct = null, currentPace = 'steady';
let charBias = 0, charProfiles = {}, activeCharName = null;
let tension = 0.5, liveManualBias = 0;
let commandMode = 'v2', intensityMode = 'auto', sequenceName = 'off', fullArousalPoint = null;
let patternStyle = 'complex';   // 'complex' (rich act waveforms — default) | 'basic' (flat vibration)
let metaStatus = true;          // per-turn "Haptix — act — pace" status toast so the user can verify detection
let useLLMClassifier = true;    // a 2nd quiet LLM pass answers "is a body part on the user?" (regex is fallback)
let stateListeners = [];
let loreTimer = null;
const _notified = {};
const _notifyLogAt = {};

// ---- ST helpers ------------------------------------------------------------

function ctx() { try { return SillyTavern.getContext(); } catch { return null; } }
function substitute(text) {
    const c = ctx();
    if (c?.substituteParams) { try { return c.substituteParams(text); } catch { /* fall through */ } }
    const user = c?.name1 || 'You';
    const char = c?.name2 || 'they';
    return String(text).replace(/\{\{user\}\}/g, user).replace(/\{\{char\}\}/g, char);
}
function notify(level, msg, id) {
    const key = id || msg;
    const t = Date.now();
    if (_notified[key] && t - _notified[key] < 8000) return;
    _notified[key] = t;
    try { if (typeof toastr !== 'undefined' && toastr[level]) { toastr[level](msg, 'Haptix'); return; } } catch { /* ignore */ }
    console.log(`[Haptix] ${msg}`);
}

// Per-cycle meta status line ("Haptix — teasing — slow"); bypasses notify() dedupe so the user always sees it.
function statusMeta(s) {
    if (!metaStatus) return;
    try { if (typeof toastr !== 'undefined' && toastr.info) { toastr.info(`Haptix — ${s}`, '', { timeOut: 2500 }); return; } } catch { /* ignore */ }
    console.log(`[Haptix] ${s}`);
}

// ---- persistence -----------------------------------------------------------

function savePrefs() {
    try {
        localStorage.setItem(STORAGE.SETTINGS, JSON.stringify({
            intensityMode, patternStyle, userMax: safety?.getUserMax?.() ?? null, fullArousalPoint, charProfiles,
        }));
    } catch { /* ignore */ }
}
function loadPrefs() {
    try {
        const p = JSON.parse(localStorage.getItem(STORAGE.SETTINGS) || 'null');
        if (!p) return;
        if (p.intensityMode) intensityMode = p.intensityMode;
        if (p.patternStyle) patternStyle = p.patternStyle;
        if (typeof p.userMax === 'number' && safety) safety.setUserMax(p.userMax);
        if (typeof p.fullArousalPoint === 'number') fullArousalPoint = p.fullArousalPoint;
        if (p.charProfiles && typeof p.charProfiles === 'object') charProfiles = p.charProfiles;
    } catch { /* ignore */ }
}

// ---- intensity model -------------------------------------------------------

function profileLevel(pace) {
    if (intensityMode === 'auto') {
        const t = clamp01((charBias + 0.3) / 0.6);
        const lo = INTENSITY_PROFILES.mild[pace] ?? INTENSITY_PROFILES.mild.steady;
        const hi = INTENSITY_PROFILES.harsh[pace] ?? INTENSITY_PROFILES.harsh.steady;
        return lo + (hi - lo) * t;
    }
    const prof = INTENSITY_PROFILES[intensityMode] || INTENSITY_PROFILES.standard;
    return prof[pace] ?? prof.steady;
}
function computeIntensity(act, pace) {
    if (!act) return 0;
    const level = profileLevel(pace);
    const actScale = ACT_SCALE[act] ?? 1;
    const tNudge = (tension - 0.5) * 2 * TENSION_NUDGE;
    const bias = intensityMode === 'auto' ? 0 : charBias;
    return clamp01(level * actScale + tNudge + bias);
}
function applyActuation() { actuator.setTarget(currentAct, computeIntensity(currentAct, currentPace)); scheduleLore(); }
function isContactActive() { return !!currentAct && CROTCH_CONTACT_ACTS.includes(currentAct); }

// ---- lore injection (replaces an external lorebook bridge) -----------------

function arousalText(a) {
    const tiers = [
        [0.85, '{{user}} is on the very edge, about to climax — plainly, unmistakably. {{char}} can tell.'],
        [0.60, '{{user}} is highly aroused, breathing harder; {{char}} can clearly see it.'],
        [0.30, '{{user}} is becoming aroused — it is starting to show.'],
    ];
    return (tiers.find(([m]) => a >= m) || tiers[tiers.length - 1])[1];
}
function updateLore() {
    const c = ctx();
    if (!c?.setExtensionPrompt || !safety.isArmed()) return;
    try {
        const a = sensors.arousal;
        c.setExtensionPrompt(AROUSAL_KEY, a >= 0.30 ? `[Player Arousal]\n${substitute(arousalText(a))}` : '', 1, 0);
        c.setExtensionPrompt(STATE_KEY, currentAct ? `[Physical Sensation]\n${currentAct} underway (${currentPace} pace).` : '', 1, 0);
    } catch { /* ignore */ }
}
function scheduleLore() { clearTimeout(loreTimer); loreTimer = setTimeout(updateLore, 1500); }

// ---- per-character calibration ---------------------------------------------

function ensureCharProfile(c, name) {
    if (charProfiles[name] != null) return charProfiles[name];
    let text = '';
    try {
        const card = (c?.characters || []).find?.((ch) => ch && ch.name === name) || c?.characters?.[c?.characterId];
        text = [card?.description, card?.personality, card?.scenario].filter(Boolean).join(' ');
    } catch { /* ignore */ }
    const bias = calibrateCharacter(text);
    charProfiles[name] = bias;
    savePrefs();
    if (intensityMode === 'auto') {
        const word = bias > 0.07 ? 'physically stronger' : bias < -0.07 ? 'physically weaker' : 'average build';
        notify('info', `AUTO mode — ${name} assessed as ${word}; stimulation calibrated accordingly (change settings manually at any moment).`, `auto-${name}`);
    }
    return bias;
}

// ---- ST event handlers -----------------------------------------------------

// Robust contact detection: a 2nd quiet LLM pass answers "is a character's body on the user?" Returns
// null when unavailable/failed so the regex classifier (with its contact gate) takes over.
async function classifyViaLLM(text) {
    const c = ctx();
    if (!useLLMClassifier || !c?.generateQuietPrompt) return null;
    const prompt = `You are a strict physical-contact classifier for a haptic device. Read the ROLEPLAY MESSAGE and reply with ONE compact JSON object and nothing else.
Decide: is a part of a character's body (or an object they wield) physically touching the USER's body in THIS message — actual contact, not implied, not in the air, not mere dialogue or atmosphere?
Fields:
 "contact": true|false — true ONLY for real physical contact ON the user right now.
 "act": teasing|handjob|blowjob|titjob|footjob|vaginal|anal|climax|none — sexual act performed ON the user, else "none".
 "pace": caress|slow|steady|fast|frantic.
 "involuntary": none|incidental|impact — brief NON-sexual touch: "incidental"=brush/bump, "impact"=hit/slap; else "none".
ROLEPLAY MESSAGE:
"""${(text || '').slice(0, 1200)}"""
JSON:`;
    try {
        const raw = await c.generateQuietPrompt(prompt, false, true);
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (!m) return null;
        const o = JSON.parse(m[0]);
        return {
            contact: !!o.contact,
            act: (o.act && o.act !== 'none') ? String(o.act).toLowerCase().trim() : null,
            pace: o.pace || 'steady',
            involuntary: (o.involuntary && o.involuntary !== 'none') ? String(o.involuntary).toLowerCase().trim() : null,
        };
    } catch { return null; }
}

function applyClassification(c, charName, act, pace, involuntary) {
    if (act) {
        if (charName !== activeCharName) { activeCharName = charName; charBias = ensureCharProfile(c, charName); }
        if (act !== currentAct || pace !== currentPace) {
            currentAct = act; currentPace = pace; liveManualBias = 0; actuator.clearManualBias();
        }
        applyActuation();
        statusMeta(`${act} — ${pace}`);
        return;
    }
    if (currentAct) { currentAct = null; applyActuation(); }
    if (involuntary && BLIP[involuntary] && actuator.blip) {
        actuator.blip(BLIP[involuntary].amp, BLIP[involuntary].ms);
        statusMeta(involuntary === 'impact' ? 'impact' : 'brush');
    } else {
        statusMeta('no contact');
    }
}

async function onAiMessage(id) {
    if (!safety.isArmed()) return;
    const c = ctx();
    const chat = c?.chat;
    const msg = chat ? (chat[id] ?? chat[chat.length - 1]) : null;
    if (!msg || msg.is_user) return;
    try { c.setExtensionPrompt(TURN_KEY, '', 1, 0); } catch { /* ignore */ }
    const text = msg.mes || '';
    const charName = msg.name || c?.name2 || 'partner';

    let act = null, pace = 'steady', involuntary = null;
    const llm = await classifyViaLLM(text);
    if (llm) {
        act = llm.contact ? llm.act : null;
        pace = llm.pace || 'steady';
        if (!act) involuntary = llm.involuntary;
    } else {
        const r = classifyMessage(text);
        act = r.actType; pace = r.pace;
        if (!act) involuntary = classifyIncidental(text);
    }
    applyClassification(c, charName, act, pace, involuntary);
}

function onUserMessage(id) {
    if (!safety.isArmed()) return;
    const c = ctx();
    const lines = [];
    const adj = sensors.takeManualAdjust();
    if (adj) {
        const dirKey = adj.dir < 0 ? 'slower' : 'faster';
        const table = MANUAL_ADJUST_PHRASING[currentAct] || MANUAL_ADJUST_PHRASING._generic;
        const adverb = MANUAL_CADENCE.ADVERB[adj.cadence] ?? '';
        lines.push(substitute(table[dirKey].replace('<adv>', adverb).replace(/\s+/g, ' ').trim()));
    }
    if (sensors.orientation === 'up' && !isContactActive()) lines.push(substitute(ORIENTATION.PHRASE));
    if (lines.length) injectTurn(c, id, lines);
}

function injectTurn(c, id, lines) {
    const wrapped = `*${lines.join(' ')}*`;
    try {
        const chat = c?.chat;
        const idx = (typeof id === 'number') ? id : (chat ? chat.length - 1 : -1);
        const msg = chat?.[idx];
        if (msg && msg.is_user) {
            msg.mes = `${wrapped}\n\n${msg.mes}`;
            if (typeof c.updateMessageBlock === 'function') c.updateMessageBlock(idx, msg);
            return;
        }
    } catch { /* fall through */ }
    try { c?.setExtensionPrompt?.(TURN_KEY, `[${lines.join(' ')}]`, 1, 0); } catch { /* ignore */ }
}

function onChatChanged() {
    currentAct = null; currentPace = 'steady'; liveManualBias = 0; activeCharName = null;
    if (safety.isArmed()) applyActuation();
}

// ---- device callbacks ------------------------------------------------------

function onConnState(state) {
    stateListeners.forEach((fn) => { try { fn(state); } catch { /* ignore */ } });
    if (state === ConnState.CONNECTING) notify('info', 'Device paired — connecting…', 'paired');
    else if (state === ConnState.AUTH_AWAIT_BUTTON) notify('info', 'Press the device’s power button to authorize.', 'authbtn');
    if (state === ConnState.READY) {
        commandMode = connector.detectedMode || commandMode;
        sensors.start(); actuator.start();
        notify('success', `Device connected (${commandMode === 'harmony' ? 'Harmony / V3' : 'Classic'}).`, 'connected');
        if (!safety.isArmed()) notify('info', 'Tick consent and press Arm to begin.', 'consent');
    } else if (state === ConnState.DISCONNECTED || state === ConnState.IDLE) {
        actuator.stop(); sensors.stop();
        if (state === ConnState.DISCONNECTED) notify('warning', 'Device disconnected.', 'disconnected');
    }
}

function onDeviceNotify(kind, dv) {
    safety.recordNotify();
    const t = Date.now();
    if (!_notifyLogAt[kind] || t - _notifyLogAt[kind] > 1500) {
        _notifyLogAt[kind] = t;
        try { console.log(`[lelo] notify ${kind}: ${Array.from(new Uint8Array(dv.buffer)).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`); } catch { /* ignore */ }
    }
    sensors.handleNotify(kind, dv);
}

// ---- public API ------------------------------------------------------------

export function initCore() {
    if (initialized) return api;
    safety = createSafetyGate();
    loadPrefs();
    connector = createConnector({ onState: onConnState, onNotify: onDeviceNotify, onLog: (m) => console.log(m) });
    actuator = createActuator({ connector, safety, getCommandMode: () => commandMode, getArousal: () => sensors?.arousal ?? 0, getPatternStyle: () => patternStyle, onLog: (m) => console.log(m) });
    sensors = createSensors({
        onArousal: () => scheduleLore(),
        onManualAdjust: (adj) => { liveManualBias = Math.max(-0.3, Math.min(0.3, liveManualBias + adj.dir * MANUAL_BIAS_STEP)); actuator.setManualBias(liveManualBias); },
        onLog: (m) => console.log(m),
    });
    try {
        const c = ctx();
        const es = c?.eventSource, et = c?.eventTypes || c?.event_types;
        if (es && et) {
            if (et.MESSAGE_RECEIVED) es.on(et.MESSAGE_RECEIVED, onAiMessage);
            if (et.MESSAGE_SENT) es.on(et.MESSAGE_SENT, onUserMessage);
            if (et.CHAT_CHANGED) es.on(et.CHAT_CHANGED, onChatChanged);
        }
    } catch { /* ST events unavailable */ }
    initialized = true;
    return api;
}

const api = {
    isSupported: () => connector?.supported?.() ?? false,
    connect: (opts) => connector.requestAndConnect(opts),
    reconnect: () => connector.reconnect(),
    pokeAuth: () => connector.pokeAuth(),
    disconnect: () => connector.disconnect(),
    arm: (token) => { safety.arm(token || `consent-${Date.now()}`); notify('success', 'Session armed.', 'armed'); statusMeta('armed'); notify('info', 'To calibrate arousal: wear the device, reach full arousal, then press “Set Full Arousal Point”.', 'howcal'); },
    disarm: () => { safety.disarm(); actuator.estop(); notify('info', 'Session ended.', 'ended'); },
    isArmed: () => safety?.isArmed?.() ?? false,
    estop: () => { actuator?.estop(); notify('warning', 'EMERGENCY STOP.', 'estop'); },
    testAct: (actType, pace) => { currentAct = actType; currentPace = pace || 'steady'; liveManualBias = 0; actuator.clearManualBias(); if (safety.isArmed()) applyActuation(); notify('info', `Testing: ${actType} / ${pace || 'steady'}…`, 'testing'); },
    testStop: () => { currentAct = null; if (safety.isArmed()) applyActuation(); },
    setCommandMode: (m) => { commandMode = m === 'harmony' ? 'harmony' : 'v2'; },
    setIntensityMode: (m) => { intensityMode = ['mild', 'standard', 'harsh', 'auto'].includes(m) ? m : 'standard'; if (safety.isArmed()) applyActuation(); savePrefs(); },
    setSequence: (name) => { sequenceName = SEQUENCES.includes(name) ? name : 'off'; actuator.setSequence(sequenceName === 'off' ? null : createSequence(sequenceName)); notify('info', sequenceName === 'off' ? 'Sequence off (scene-driven).' : `Sequence: ${sequenceName}.`, 'seq'); },
    setPatternStyle: (s) => { patternStyle = s === 'basic' ? 'basic' : 'complex'; savePrefs(); notify('info', patternStyle === 'basic' ? 'Patterns: Basic (flat vibration).' : 'Patterns: Complex (rich).', 'pstyle'); },
    setMeta: (on) => { metaStatus = !!on; notify('info', `Status line: ${metaStatus ? 'On' : 'Off'}.`, 'metatoggle'); },
    setLLMClassifier: (on) => { useLLMClassifier = !!on; notify('info', `Contact detection: ${useLLMClassifier ? 'LLM + regex' : 'regex only'}.`, 'llmtoggle'); },
    setUserMax: (v) => { safety.setUserMax(v); savePrefs(); },
    setArousalFullPoint: (level) => { fullArousalPoint = (typeof level === 'number' ? level : (sensors?.arousal ?? 0)); savePrefs(); return fullArousalPoint; },
    notify: (level, msg, id) => notify(level, msg, id),
    getStatus: () => ({
        supported: connector?.supported?.() ?? false,
        state: connector?.state ?? ConnState.IDLE,
        armed: safety?.isArmed?.() ?? false,
        intensity: actuator?.intensity ?? 0,
        arousal: sensors?.arousal ?? 0,
        orientation: sensors?.orientation ?? 'natural',
        act: currentAct, pace: currentPace, charBias, commandMode, intensityMode, sequence: sequenceName, patternStyle,
        metaStatus, llm: useLLMClassifier,
        detectedMode: connector?.detectedMode ?? 'v2',
        fullArousalPoint,
        telemetry: sensors?.getTelemetry?.() ?? {},
        deviceName: connector?.deviceName ?? null,
    }),
    onState: (fn) => { stateListeners.push(fn); return () => { stateListeners = stateListeners.filter((f) => f !== fn); }; },
};
