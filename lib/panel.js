/**
 * LELO F1S V3 — control panel UI (NSFW haptic feature)
 *
 * Connect/auth/consent flow, live telemetry + arousal readout, intensity cap + command-path controls, and
 * the always-visible EMERGENCY STOP. Talks only to the bridge API (no direct device access here).
 * The connect action runs inside the click handler to satisfy Web Bluetooth's user-gesture requirement.
 */

import { ConnState } from './lelo-connector.js';
import { COMMAND_PATHS } from './lelo-command-path.js';
import { ACTS } from './lelo-config.js';
import { SEQUENCES, SEQUENCE_LABELS } from './lelo-sequences.js';

let bridge = null;
let panel = null;
let estopBtn = null;
let pollTimer = null;
let consentChecked = false;
let testing = false;

function injectStyles() {
    if (document.getElementById('haptix-style')) return;
    try {
        const link = document.createElement('link');
        link.id = 'haptix-style';
        link.rel = 'stylesheet';
        link.href = new URL('../style.css', import.meta.url).href;
        document.head.appendChild(link);
    } catch { /* if import.meta.url unavailable the panel still works unstyled */ }
}

function h(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v != null) e.setAttribute(k, v);
    });
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && e.append(c));
    return e;
}

function buildEstop() {
    estopBtn = h('button', { id: 'haptix-estop', title: 'Stop all device activity (Esc)', onclick: () => bridge.estop() }, 'STOP');
    document.body.appendChild(estopBtn);
}

function buildLauncher() {
    if (document.getElementById('haptix-launch')) return;
    const b = h('button', { id: 'haptix-launch', title: 'Haptix — open/close haptics panel', onclick: toggleHapticPanel }, '💗');
    document.body.appendChild(b);
}

function buildPanel() {
    const supported = bridge.isSupported();
    panel = h('div', { id: 'haptix-panel' });

    panel.append(h('h4', {}, [
        h('span', {}, '💗 F1S V3 Haptics'),
        h('span', { id: 'haptix-launch-state' }, 'idle'),
    ]));

    if (!supported) {
        panel.append(h('div', { class: 'htx-prompt', html:
            'Web Bluetooth unavailable.<br>Use Chrome/Edge over <b>HTTPS</b> or <b>localhost</b> (e.g. the st-reach tailscale URL).' }));
        panel.classList.add('open');
        document.body.appendChild(panel);
        return;
    }

    // connect / disconnect
    panel.append(h('div', { class: 'htx-row' }, [
        h('button', { id: 'htx-connect', onclick: () => onConnectClick(false) }, 'Connect device'),
        h('button', { id: 'htx-connect-any', onclick: () => onConnectClick(true), title: 'List ALL Bluetooth devices (if the filtered scan is empty)' }, 'Any…'),
        h('button', { id: 'htx-disconnect', onclick: () => bridge.disconnect() }, 'Disconnect'),
    ]));

    // auth prompt (shown only while awaiting the power-button press)
    panel.append(h('div', { id: 'htx-auth', class: 'htx-prompt', style: 'display:none' }, [
        h('div', { html: 'Press the device <b>power button</b> now to authorize.' }),
        h('button', { onclick: () => bridge.pokeAuth(), style: 'margin-top:6px' }, 'I pressed it'),
    ]));

    // consent (per-session, required before arming)
    panel.append(h('div', { id: 'htx-consent', class: 'htx-consent', style: 'display:none' }, [
        h('label', {}, [
            h('input', { type: 'checkbox', id: 'htx-consent-cb', onchange: (e) => { consentChecked = e.target.checked; refreshConsentBtn(); } }),
            h('span', {}, 'I consent to device actuation for this session.'),
        ]),
        h('button', { id: 'htx-arm', disabled: 'true', style: 'margin-top:6px', onclick: onArm }, 'Arm'),
    ]));

    // live readout
    panel.append(h('div', { class: 'htx-row' }, [h('span', { class: 'htx-muted' }, 'Device'), h('span', { id: 'htx-dev' }, '—')]));
    panel.append(h('div', { class: 'htx-row' }, [h('span', { class: 'htx-muted' }, 'Act / pace'), h('span', { id: 'htx-act' }, '—')]));
    panel.append(h('div', { class: 'htx-row' }, [h('span', { class: 'htx-muted' }, 'Orientation'), h('span', { id: 'htx-ori' }, '—')]));
    panel.append(h('div', { class: 'htx-muted' }, 'Intensity'));
    panel.append(h('div', { class: 'htx-bar' }, h('span', { id: 'htx-int' })));
    panel.append(h('div', { class: 'htx-muted', style: 'margin-top:4px' }, 'Arousal'));
    panel.append(h('div', { class: 'htx-bar htx-arousal' }, [h('span', { id: 'htx-aro' }), h('i', { id: 'htx-aro-dot' })]));

    // controls
    panel.append(h('div', { class: 'htx-muted', style: 'margin-top:8px' }, 'Max intensity'));
    panel.append(h('input', { type: 'range', min: '0', max: '80', value: '80', id: 'htx-max',
        oninput: (e) => bridge.setUserMax(Number(e.target.value) / 100) }));
    panel.append(h('div', { class: 'htx-row', style: 'margin-top:4px' }, [
        h('span', { class: 'htx-muted' }, 'Command path'),
        h('select', { id: 'htx-path', onchange: (e) => bridge.setCommandMode(e.target.value) },
            COMMAND_PATHS.map((p) => h('option', { value: p }, p === 'harmony' ? 'Harmony / V3' : 'Classic (F1S / V2)'))),
    ]));

    panel.append(h('button', { id: 'htx-mode', style: 'margin-top:6px;width:100%',
        title: 'Intensity feel — Mild < Standard < Harsh, or AUTO (calibrated from the character\'s physique)',
        onclick: onCycleMode }, 'Intensity: Standard'));

    panel.append(h('div', { class: 'htx-row', style: 'margin-top:6px' }, [
        h('span', { class: 'htx-muted' }, 'Sequence'),
        h('select', { id: 'htx-seq', onchange: (e) => bridge.setSequence(e.target.value) },
            SEQUENCES.map((s) => h('option', { value: s }, SEQUENCE_LABELS[s] || s))),
    ]));

    // test control (validation): drive a pattern directly, no LLM needed
    panel.append(h('div', { class: 'htx-muted', style: 'margin-top:8px' }, 'Test pattern (validation)'));
    panel.append(h('div', { class: 'htx-row' }, [
        h('select', { id: 'htx-tact' }, ACTS.map((a) => h('option', { value: a }, a))),
        h('select', { id: 'htx-tpace' }, ['caress', 'slow', 'steady', 'fast', 'frantic'].map((p) => h('option', { value: p }, p))),
    ]));
    panel.append(h('div', { class: 'htx-row' }, [
        h('button', { id: 'htx-test', onclick: onTestToggle }, 'Test'),
        h('button', { id: 'htx-setfull', title: 'Mark the current arousal level as your personal "full arousal" point — places a dot on the bar', onclick: onSetFull }, 'Set Full Arousal Point'),
    ]));

    panel.append(h('button', { id: 'htx-end', style: 'margin-top:8px;width:100%;display:none',
        onclick: () => bridge.disarm() }, 'End session'));

    document.body.appendChild(panel);
}

async function onConnectClick(any) {
    try { await bridge.connect({ any: any === true }); }   // inside the click handler -> valid user gesture
    catch (e) { console.error('[lelo] connect FAILED:', e); setBadge('error', (e && e.message ? e.message : 'failed').slice(0, 48)); }
}

function onArm() {
    if (!consentChecked) return;
    bridge.arm();
}

function onTestToggle() {
    const b = document.getElementById('htx-test');
    if (testing) {
        bridge.testStop();
        testing = false;
    } else {
        const a = document.getElementById('htx-tact')?.value;
        const p = document.getElementById('htx-tpace')?.value;
        bridge.testAct(a, p);
        testing = true;
    }
    if (b) b.textContent = testing ? 'Stop' : 'Test';
}

function onSetFull() {
    bridge.setArousalFullPoint();   // captures current arousal; dot is drawn in poll()
}

function onCycleMode() {
    const order = ['mild', 'standard', 'harsh', 'auto'];
    const cur = bridge.getStatus().intensityMode || 'standard';
    bridge.setIntensityMode(order[(order.indexOf(cur) + 1) % order.length]);
}

function refreshConsentBtn() {
    const btn = document.getElementById('htx-arm');
    if (btn) btn.disabled = !consentChecked;
}

function setBadge(cls, text) {
    const b = document.getElementById('haptix-launch-state');
    if (!b) return;
    b.className = '';
    if (cls) b.classList.add(cls);
    b.textContent = text;
}

function pct(v) { return `${Math.round((v || 0) * 100)}%`; }

function poll() {
    if (!bridge || !panel) return;
    const s = bridge.getStatus();
    setBadge(s.state === ConnState.READY ? 'ready' : (s.state === ConnState.AUTH_FAILED ? 'error' : ''), s.state);

    const auth = document.getElementById('htx-auth');
    if (auth) auth.style.display = s.state === ConnState.AUTH_AWAIT_BUTTON ? 'block' : 'none';

    const consent = document.getElementById('htx-consent');
    const end = document.getElementById('htx-end');
    if (consent) consent.style.display = (s.state === ConnState.READY && !s.armed) ? 'block' : 'none';
    if (end) end.style.display = s.armed ? 'block' : 'none';

    const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt; };
    set('htx-dev', s.deviceName || '—');
    set('htx-act', s.act ? `${s.act} / ${s.pace}` : '—');
    set('htx-ori', s.orientation + (s.charBias ? `  (bias ${s.charBias > 0 ? '+' : ''}${s.charBias.toFixed(2)})` : ''));
    const intBar = document.getElementById('htx-int'); if (intBar) intBar.style.width = pct(s.intensity);
    const aroBar = document.getElementById('htx-aro'); if (aroBar) aroBar.style.width = pct(s.arousal);

    // arousal calibration dot ("Set Full Arousal Point")
    const dot = document.getElementById('htx-aro-dot');
    if (dot) {
        if (s.fullArousalPoint != null) { dot.style.display = 'block'; dot.style.left = pct(s.fullArousalPoint); }
        else dot.style.display = 'none';
    }

    // dynamic buttons
    const connected = s.state === ConnState.READY;
    const busy = [ConnState.REQUESTING, ConnState.CONNECTING, ConnState.AUTH_AWAIT_BUTTON, ConnState.AUTH_WRITE, ConnState.AUTH_VERIFY, ConnState.SUBSCRIBING].includes(s.state);
    const cBtn = document.getElementById('htx-connect');
    if (cBtn) { cBtn.disabled = connected || busy; cBtn.textContent = connected ? 'CONNECTED' : (busy ? 'Connecting…' : 'Connect device'); }
    const aBtn = document.getElementById('htx-connect-any');
    if (aBtn) aBtn.disabled = connected || busy;
    const tBtn = document.getElementById('htx-test');
    if (tBtn) tBtn.disabled = !s.armed;
    const sfBtn = document.getElementById('htx-setfull');
    if (sfBtn) sfBtn.disabled = !s.armed;
    if (!connected && testing) { testing = false; if (tBtn) tBtn.textContent = 'Test'; }
    const pathSel = document.getElementById('htx-path');
    if (pathSel && document.activeElement !== pathSel) pathSel.value = s.commandMode || 'v2';
    const modeBtn = document.getElementById('htx-mode');
    if (modeBtn) { const m = s.intensityMode || 'standard'; modeBtn.textContent = `Intensity: ${m[0].toUpperCase()}${m.slice(1)}`; }
    const seqSel = document.getElementById('htx-seq');
    if (seqSel && document.activeElement !== seqSel) seqSel.value = s.sequence || 'off';

    if (estopBtn) estopBtn.classList.toggle('show', !!s.armed);
}

function bindGlobalSafety() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && bridge?.isArmed?.()) bridge.estop();
    });
    // tab-away pause is handled inside the actuator (document.hidden); estop stays manual.
}

export function toggleHapticPanel() {
    if (panel) panel.classList.toggle('open');
}

export function initHapticPanel(bridgeApi) {
    if (panel) return { toggle: toggleHapticPanel };
    bridge = bridgeApi;
    injectStyles();
    buildEstop();
    buildLauncher();
    buildPanel();
    bindGlobalSafety();
    pollTimer = setInterval(poll, 500);
    return { toggle: toggleHapticPanel };
}
