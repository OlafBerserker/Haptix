/**
 * Haptix — control panel UI (v0.2 "Priapistic Gooner")
 *
 * Hot-pink sticker-art floating panel for SillyTavern. Walks the user through a
 * five-phase flow — IDLE → SCANNING → AUTH (press power) → CONNECTED (consent +
 * arm) → LIVE (intensity flame, arousal meter, sequences, calibration, two-toy
 * settings, STOP) — talking only to the bridge API (no direct device access).
 *
 * Design driver: claude.ai/design `Haptix Panel.dc.html` handoff. The DC
 * prototype was state-based; this is the production imperative port. All
 * keyframes, color tokens, and copy come straight from the design.
 *
 * The connect action runs inside the click handler to satisfy Web Bluetooth's
 * user-gesture requirement. ALL bridge state is read via poll(); we never
 * shadow it locally.
 */

import { ConnState } from './lelo-connector.js';
import { COMMAND_PATHS } from './lelo-command-path.js';
import { ACTS } from './lelo-config.js';
import { SEQUENCES, SEQUENCE_LABELS } from './lelo-sequences.js';

let bridge = null;
let panel = null;
let launchBtn = null;
let estopBtn = null;
let pollTimer = null;
let consentChecked = false;
let testing = false;
let theme = 'dark';
let assetUrl = null;          // resolved asset directory URL
let phaseDoms = {};           // { idle, scanning, auth, connected, live } -> root <div>

// ──────────────────────────────────────────────────────────────────────────
//   small helpers
// ──────────────────────────────────────────────────────────────────────────

function h(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
        else if (v != null) e.setAttribute(k, v);
    });
    (Array.isArray(kids) ? kids : [kids]).forEach((c) => c != null && e.append(c));
    return e;
}

function asset(name) {
    if (!assetUrl) {
        try { assetUrl = new URL('../assets/', import.meta.url).href; }
        catch { assetUrl = ''; }
    }
    return assetUrl + name;
}

function pct(v) { return `${Math.round((v || 0) * 100)}%`; }

function getPhase(s) {
    if (!s) return 'idle';
    if (s.state === ConnState.AUTH_AWAIT_BUTTON) return 'auth';
    if (s.armed) return 'live';
    if (s.state === ConnState.READY) return 'connected';
    if ([ConnState.REQUESTING, ConnState.CONNECTING,
         ConnState.AUTH_WRITE, ConnState.AUTH_VERIFY,
         ConnState.SUBSCRIBING].includes(s.state)) return 'scanning';
    return 'idle';
}

// ──────────────────────────────────────────────────────────────────────────
//   styles (kept inline so the design tokens travel with the JS)
// ──────────────────────────────────────────────────────────────────────────

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

.htx-root {
    --bg:#0f0a17; --pnl:#1a1326; --card:#221733; --cardHi:#2b1d40;
    --ink:#f4ecf6; --mut:#a892bd; --line:rgba(255,90,170,.18); --lineS:rgba(255,90,170,.5);
    --pink:#ff3d84; --pinkD:#ec2f6e; --yellow:#ffcf3f; --green:#5ccb8b; --red:#ff4d4d;
    --teal:#3fd0c0; --purple:#a979ff; --orange:#ff7a2f;
    --chatBub:#241a33; --userBub:#2e2140;
    --shadow:0 26px 64px rgba(0,0,0,.6);
}
.htx-root[data-theme="light"] {
    --bg:#ffe7f1; --pnl:#fffdff; --card:#fff3f9; --cardHi:#ffeaf3;
    --ink:#33203c; --mut:#9b7a98; --line:rgba(236,47,110,.16); --lineS:rgba(236,47,110,.45);
    --chatBub:#ffffff; --userBub:#ffe2ee;
    --shadow:0 26px 54px rgba(214,118,160,.4);
}
@keyframes htxBob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
@keyframes htxBeat { 0%,100%{transform:scale(1)} 12%{transform:scale(1.18)} 24%{transform:scale(1)} 36%{transform:scale(1.1)} 48%{transform:scale(1)} }
@keyframes htxSpin { to{transform:rotate(360deg)} }
@keyframes htxStop { 0%,100%{box-shadow:0 10px 26px rgba(255,40,60,.5),0 0 0 0 rgba(255,60,80,.5)} 50%{box-shadow:0 10px 26px rgba(255,40,60,.6),0 0 0 12px rgba(255,60,80,0)} }
@keyframes htxShimmer { 0%{background-position:0% 0} 100%{background-position:200% 0} }
@keyframes htxRing { 0%{transform:scale(.6);opacity:.7} 100%{transform:scale(1.8);opacity:0} }
@keyframes htxGlow { 0%,100%{filter:drop-shadow(0 0 6px rgba(255,61,132,.5))} 50%{filter:drop-shadow(0 0 16px rgba(255,61,132,.9))} }

#haptix-launch {
    position:fixed; left:18px; bottom:18px; z-index:10009;
    width:62px; height:62px; border-radius:50%; border:none; padding:0; cursor:pointer;
    background:transparent; transition:transform .25s ease;
    /* v0.2.3: bob animation removed. The Claude-Design mockup had a
       slow 2.8s bob, but the loop reads as visual noise in ST's
       crowded chrome — every animation in the page competes for
       attention. Now: static at rest, breathes only on hover. */
}
#haptix-launch:hover { transform:scale(1.08); }
#haptix-launch img { width:62px; height:62px; filter:drop-shadow(0 8px 18px rgba(236,47,110,.6)); user-select:none; pointer-events:none; }

#haptix-estop {
    position:fixed; right:18px; bottom:18px; z-index:10011;
    display:none; align-items:center; gap:10px; border:none; cursor:pointer;
    padding:12px 20px 12px 12px; border-radius:18px;
    background:linear-gradient(135deg,#ff5757,#d51f2f); color:#fff;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:18px; letter-spacing:1px;
    animation:htxStop 1.4s ease-in-out infinite;
}
#haptix-estop.show { display:flex; }
#haptix-estop img { width:40px; height:40px; pointer-events:none; }

.htx-root {
    position:fixed; right:18px; bottom:18px; z-index:10010;
    width:374px; max-width:calc(100vw - 36px); max-height:min(88vh, 760px);
    overflow-y:auto;
    background:var(--pnl); border:1px solid var(--lineS); border-radius:24px;
    box-shadow:var(--shadow);
    font-family:Nunito, system-ui, sans-serif; color:var(--ink); font-size:14px;
    display:none;
}
.htx-root.open { display:block; }
.htx-root::-webkit-scrollbar { width:8px; }
.htx-root::-webkit-scrollbar-thumb { background:var(--line); border-radius:8px; }

.htx-head {
    position:sticky; top:0; z-index:5;
    display:flex; align-items:center; gap:11px; padding:14px 16px;
    background:color-mix(in srgb, var(--pnl) 88%, transparent);
    backdrop-filter:blur(10px); border-bottom:1px solid var(--line);
}
.htx-head img.brand { width:30px; height:30px; filter:drop-shadow(0 3px 6px rgba(236,47,110,.5)); }
.htx-head .title {
    font-family:Fredoka, sans-serif; font-weight:700; font-size:20px;
    background:linear-gradient(100deg, var(--pink), var(--yellow));
    -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
    letter-spacing:.3px; line-height:1.05;
}
.htx-head .subtitle { font-size:10px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:var(--mut); line-height:1.05; }
.htx-badge {
    margin-left:auto; font-family:Fredoka, sans-serif; font-weight:700;
    font-size:10px; letter-spacing:1.2px; padding:5px 10px; border-radius:999px;
    color:var(--mut); background:color-mix(in srgb, var(--ink) 8%, transparent);
}
.htx-badge.scanning, .htx-badge.auth { color:#1a0e00; background:var(--yellow); }
.htx-badge.connected { color:#06301c; background:var(--green); }
.htx-badge.live { color:#fff; background:linear-gradient(135deg, var(--pink), var(--pinkD)); }
.htx-head button.icon {
    width:32px; height:32px; border-radius:10px; border:1px solid var(--line);
    background:var(--card); color:var(--ink); cursor:pointer; font-size:14px;
    display:grid; place-items:center;
}
.htx-head button.icon:hover { border-color:var(--lineS); color:var(--ink); }

.htx-body { padding:16px; display:flex; flex-direction:column; gap:13px; }
.htx-phase { display:flex; flex-direction:column; gap:14px; }
.htx-phase.hidden { display:none; }

/* IDLE */
.htx-idle-hero { text-align:center; padding:8px 4px 2px; }
.htx-idle-hero img { width:104px; height:104px; animation:htxBob 3.4s ease-in-out infinite; }
.htx-idle-hero .lead { font-family:Fredoka, sans-serif; font-weight:700; font-size:19px; margin-top:6px; }
.htx-idle-hero .sub  { font-size:13px; color:var(--mut); margin-top:3px; line-height:1.5; }
.htx-row { display:flex; gap:9px; }
.htx-row > button { flex:1; }
.htx-btn-primary {
    border:none; cursor:pointer; border-radius:14px; padding:13px;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:15px; color:#fff;
    background:linear-gradient(135deg, var(--pink), var(--pinkD));
    box-shadow:0 10px 24px rgba(255,61,132,.4);
}
.htx-btn-primary:hover { transform:translateY(-1px); }
.htx-btn-primary:active { transform:translateY(0); }
.htx-btn-secondary {
    border:1px solid var(--lineS); cursor:pointer; border-radius:14px; padding:13px 16px;
    font-family:Fredoka, sans-serif; font-weight:600; font-size:15px;
    color:var(--ink); background:var(--card);
}
.htx-btn-secondary:hover { background:var(--cardHi); }
.htx-section-label { font-size:10px; font-weight:700; letter-spacing:1.4px; text-transform:uppercase; color:var(--mut); margin-top:2px; }
.htx-chips { display:flex; flex-wrap:wrap; gap:7px; }
.htx-chip {
    border:1px solid var(--line); cursor:pointer; border-radius:999px;
    padding:7px 13px; font-size:12.5px; font-weight:700;
    color:var(--ink); background:var(--card);
}
.htx-chip:hover { border-color:var(--lineS); background:var(--cardHi); }

/* SCANNING */
.htx-scan { text-align:center; padding:26px 8px; }
.htx-scan .ring { position:relative; width:96px; height:96px; margin:0 auto; }
.htx-scan .ring .static { position:absolute; inset:0; border-radius:50%; border:3px solid var(--line); }
.htx-scan .ring .spin { position:absolute; inset:0; border-radius:50%; border:3px solid transparent; border-top-color:var(--pink); animation:htxSpin .9s linear infinite; }
.htx-scan .ring img { position:absolute; inset:18px; width:60px; height:60px; animation:htxGlow 1.6s ease-in-out infinite; }
.htx-scan .lead { font-family:Fredoka, sans-serif; font-weight:700; font-size:18px; margin-top:16px; }
.htx-scan .sub  { font-size:12.5px; color:var(--mut); margin-top:4px; }
.htx-scan .cancel {
    margin-top:16px; border:1px solid var(--line); cursor:pointer; border-radius:12px;
    padding:9px 18px; font-weight:700; font-size:13px; color:var(--mut); background:var(--card);
}
.htx-scan .cancel:hover { color:var(--ink); }

/* AUTH (press power) */
.htx-auth { text-align:center; padding:14px 8px; }
.htx-auth .halo { position:relative; width:120px; height:120px; margin:0 auto; }
.htx-auth .halo .pulse {
    position:absolute; inset:0; border-radius:50%;
    background:radial-gradient(circle, color-mix(in srgb, var(--pink) 26%, transparent), transparent 70%);
    animation:htxRing 1.6s ease-out infinite;
}
.htx-auth .halo .core {
    position:absolute; inset:14px; border-radius:50%;
    background:var(--card); border:1px solid var(--lineS);
    display:grid; place-items:center;
}
.htx-auth .halo .core img { width:74px; height:74px; animation:htxBeat 1.4s ease-in-out infinite; }
.htx-auth .lead { font-family:Fredoka, sans-serif; font-weight:700; font-size:19px; margin-top:14px; }
.htx-auth .sub  { font-size:13px; color:var(--mut); margin-top:4px; line-height:1.5; }
.htx-auth .sub b { color:var(--ink); }
.htx-auth .confirm {
    margin-top:16px; width:100%; border:none; cursor:pointer; border-radius:14px; padding:13px;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:15px; color:#fff;
    background:linear-gradient(135deg, var(--teal), #2bb3a3);
    box-shadow:0 10px 24px rgba(63,208,192,.35);
}
.htx-auth .confirm:hover { transform:translateY(-1px); }

/* CONNECTED (device card + consent + arm) */
.htx-dev-card {
    display:flex; align-items:center; gap:12px;
    background:var(--card); border:1px solid var(--line); border-radius:16px; padding:13px 14px;
}
.htx-dev-card .icon-wrap {
    width:46px; height:46px; border-radius:13px;
    background:color-mix(in srgb, var(--green) 18%, transparent);
    border:1px solid color-mix(in srgb, var(--green) 40%, transparent);
    display:grid; place-items:center;
}
.htx-dev-card .icon-wrap img { width:34px; height:34px; }
.htx-dev-card .dev-name { font-family:Fredoka, sans-serif; font-weight:700; font-size:15px; }
.htx-dev-card .dev-proto { font-size:11.5px; color:var(--green); font-weight:700; }
.htx-dev-card .battery .pct { font-family:'JetBrains Mono', monospace; font-size:14px; font-weight:600; text-align:right; }
.htx-dev-card .battery .label { font-size:10px; color:var(--mut); font-weight:700; letter-spacing:.5px; text-align:right; }
.htx-consent-card {
    background:var(--card); border:1px solid var(--lineS); border-radius:16px; padding:14px;
}
.htx-consent-card .lede { display:flex; align-items:flex-start; gap:11px; }
.htx-consent-card .lede img { width:48px; height:48px; flex:none; margin-top:1px; }
.htx-consent-card .lede img.glow { animation:htxGlow 1.6s ease-in-out infinite; }
.htx-consent-card .lede .title { font-family:Fredoka, sans-serif; font-weight:700; font-size:15px; }
.htx-consent-card .lede .body  { font-size:12.5px; color:var(--mut); margin-top:2px; line-height:1.5; }
.htx-consent-card .consent-row {
    display:flex; gap:10px; align-items:center; cursor:pointer; margin-top:13px;
    background:var(--cardHi); border:1px solid var(--line); border-radius:12px; padding:11px 12px;
}
.htx-consent-card .consent-row:hover { border-color:var(--lineS); }
.htx-consent-card .consent-row input { width:18px; height:18px; accent-color:var(--pink); cursor:pointer; }
.htx-consent-card .consent-row span { font-size:13px; font-weight:700; }
.htx-arm-btn {
    width:100%; margin-top:11px; border:none; border-radius:13px; padding:13px;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:15px;
    transition:all .2s;
}
.htx-arm-btn[disabled] {
    cursor:not-allowed; color:var(--mut);
    background:color-mix(in srgb, var(--ink) 8%, transparent); opacity:.6;
}
.htx-arm-btn:not([disabled]) {
    cursor:pointer; color:#06301c;
    background:linear-gradient(135deg, var(--green), #34a86a);
    box-shadow:0 10px 24px rgba(92,203,139,.36);
}
.htx-arm-btn:not([disabled]):hover { transform:translateY(-1px); }
.htx-disconnect-btn {
    border:1px solid var(--line); cursor:pointer; border-radius:12px;
    padding:10px; font-weight:700; font-size:13px; color:var(--mut); background:transparent;
}
.htx-disconnect-btn:hover { color:var(--ink); border-color:var(--lineS); }

/* LIVE deck */
.htx-now {
    background:linear-gradient(160deg, var(--cardHi), var(--card));
    border:1px solid var(--lineS); border-radius:18px; padding:14px;
}
.htx-now .head { display:flex; align-items:center; gap:8px; margin-bottom:11px; }
.htx-now .head .label { font-family:Fredoka, sans-serif; font-weight:700; font-size:10px; letter-spacing:1.5px; text-transform:uppercase; color:var(--mut); }
.htx-now .head .sim {
    margin-left:auto; display:flex; align-items:center; gap:6px;
    border:1px solid var(--line); cursor:pointer; border-radius:999px;
    padding:5px 11px; font-weight:700; font-size:11.5px; color:var(--ink); background:var(--pnl);
}
.htx-now .head .sim:hover { border-color:var(--lineS); }
.htx-now .scene { display:flex; align-items:center; gap:13px; }
.htx-now .scene img { width:48px; height:54px; flex:none; opacity:.6; }
.htx-now .scene img.active { opacity:1; animation:htxBeat 1s ease-in-out infinite; }
.htx-now .scene .line { font-family:Fredoka, sans-serif; font-weight:700; font-size:16px; line-height:1.3; }
.htx-now .scene .tool { font-family:'JetBrains Mono', monospace; font-size:11.5px; color:var(--pink); margin-top:4px; }

.htx-meter-label { display:flex; justify-content:space-between; align-items:baseline; margin-top:14px; margin-bottom:5px; }
.htx-meter-label .name { font-size:11px; font-weight:700; letter-spacing:.8px; text-transform:uppercase; color:var(--mut); }
.htx-meter-label .val  { font-family:'JetBrains Mono', monospace; font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
.htx-meter {
    position:relative; height:12px; border-radius:999px;
    background:color-mix(in srgb, var(--ink) 10%, transparent); overflow:hidden;
}
.htx-meter .fill {
    height:100%; border-radius:999px; background-size:200% 100%;
    animation:htxShimmer 1.5s linear infinite; transition:width .12s linear;
    width:0%;
}
.htx-meter .fill.int { background:linear-gradient(90deg,#ffb031,#ff4d4d,#ff2d78); }
.htx-meter .fill.aro { background:linear-gradient(90deg,#a979ff,#ff3d84); }
.htx-meter.aro { overflow:visible; }
.htx-meter.aro .fill-wrap { position:absolute; inset:0; border-radius:999px; overflow:hidden; }
.htx-meter .dot {
    position:absolute; top:-3px; width:3px; height:18px; border-radius:2px;
    background:var(--ink); box-shadow:0 0 0 2px var(--pnl); z-index:2; display:none;
}

.htx-card {
    background:var(--card); border:1px solid var(--line);
    border-radius:16px; padding:13px;
}
.htx-card-row { display:flex; align-items:center; gap:10px; }
.htx-card-row img.icon { width:30px; height:34px; flex:none; }
.htx-card-row .info { flex:1; min-width:0; }
.htx-card-row .info .label { font-family:Fredoka, sans-serif; font-weight:700; font-size:13.5px; }
.htx-card-row .info .desc  { font-size:11.5px; color:var(--mut); }
.htx-mode-btn {
    border:none; cursor:pointer; border-radius:11px; padding:9px 15px;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:13.5px; color:#fff; min-width:96px;
    background:linear-gradient(135deg, var(--orange), var(--pinkD));
    box-shadow:0 6px 16px rgba(255,122,47,.32);
}
.htx-mode-btn:hover { transform:translateY(-1px); }
.htx-max-row { display:flex; align-items:center; gap:11px; margin-top:12px; }
.htx-max-row .label { font-size:11px; font-weight:700; letter-spacing:.6px; text-transform:uppercase; color:var(--mut); white-space:nowrap; }
.htx-max-row input { flex:1; accent-color:var(--pink); cursor:pointer; }
.htx-max-row .val { font-family:'JetBrains Mono', monospace; font-size:12.5px; font-weight:600; width:38px; text-align:right; font-variant-numeric:tabular-nums; }

.htx-pair { display:flex; gap:11px; }
.htx-pair > div { flex:1; }
.htx-pair .pair-head { display:flex; align-items:center; gap:8px; margin-bottom:9px; }
.htx-pair .pair-head img { width:28px; height:28px; }
.htx-pair .pair-head img.pat { width:30px; height:30px; }
.htx-pair .pair-head .title { font-family:Fredoka, sans-serif; font-weight:700; font-size:13px; }
.htx-select, .htx-pat-btn {
    width:100%; appearance:none; cursor:pointer;
    border:1px solid var(--line); background:var(--cardHi); color:var(--ink);
    border-radius:10px; padding:9px 11px;
    font-family:Nunito, sans-serif; font-weight:700; font-size:12.5px;
}
.htx-pat-btn { border:1px solid var(--line); }
.htx-pat-btn:hover { border-color:var(--lineS); }

.htx-test .head { display:flex; align-items:center; gap:8px; margin-bottom:11px; }
.htx-test .head img { width:30px; height:30px; }
.htx-test .head .title { font-family:Fredoka, sans-serif; font-weight:700; font-size:13px; }
.htx-test .head .meta { font-size:11px; color:var(--mut); margin-left:auto; }
.htx-test .selects { display:flex; gap:9px; }
.htx-test .selects select { flex:1; }
.htx-test .actions { display:flex; gap:9px; margin-top:9px; }
.htx-test-btn {
    flex:1; cursor:pointer; border:none; border-radius:11px; padding:10px;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:13px; color:#fff;
    background:linear-gradient(135deg, var(--purple), #7c4ddb);
    box-shadow:0 6px 16px rgba(124,77,219,.3);
}
.htx-test-btn.testing { background:linear-gradient(135deg, #ff5757, #d51f2f); box-shadow:0 6px 16px rgba(213,31,47,.32); }
.htx-setfull {
    flex:1; display:flex; align-items:center; justify-content:center; gap:7px;
    cursor:pointer; border:1px solid var(--lineS); background:var(--cardHi); color:var(--ink);
    border-radius:11px; padding:10px; font-weight:700; font-size:12.5px;
}
.htx-setfull:hover { border-color:var(--pink); }
.htx-setfull img { width:22px; height:22px; }

.htx-settings { display:flex; flex-direction:column; gap:11px; }
.htx-settings .head { display:flex; align-items:center; gap:8px; }
.htx-settings .head img { width:26px; height:26px; }
.htx-settings .head .title { font-family:Fredoka, sans-serif; font-weight:700; font-size:13px; }
.htx-settings .row { display:flex; align-items:center; gap:10px; }
.htx-settings .row .lab { flex:1; }
.htx-settings .row .lab .name { font-weight:700; font-size:13px; }
.htx-settings .row .lab .desc { font-size:11px; color:var(--mut); }
.htx-toggle {
    width:44px; height:26px; border-radius:999px; border:none; cursor:pointer; padding:3px;
    display:flex; justify-content:flex-start; transition:background .2s, justify-content .2s;
    background:color-mix(in srgb, var(--ink) 18%, transparent);
}
.htx-toggle.on { background:var(--pink); justify-content:flex-end; }
.htx-toggle .knob { width:20px; height:20px; border-radius:50%; background:#fff; display:block; box-shadow:0 1px 3px rgba(0,0,0,.3); }

.htx-stop {
    display:flex; align-items:center; justify-content:center; gap:11px;
    border:none; cursor:pointer; width:100%; padding:13px; border-radius:16px;
    background:linear-gradient(135deg, #ff5757, #d51f2f); color:#fff;
    font-family:Fredoka, sans-serif; font-weight:700; font-size:19px; letter-spacing:1.5px;
    box-shadow:0 12px 28px rgba(213,31,47,.42); animation:htxStop 1.6s ease-in-out infinite;
}
.htx-stop img { width:38px; height:38px; }
.htx-stop .key { font-family:Nunito, sans-serif; font-weight:700; font-size:11px; opacity:.8; letter-spacing:.5px; margin-left:2px; }
.htx-stop:hover { transform:translateY(-1px); }

.htx-end {
    border:1px solid var(--line); cursor:pointer; border-radius:12px;
    padding:9px; font-weight:700; font-size:12.5px; color:var(--mut); background:transparent;
}
.htx-end:hover { color:var(--ink); border-color:var(--lineS); }

.htx-prompt {
    margin:8px 0; padding:12px; border-radius:12px;
    background:color-mix(in srgb, var(--yellow) 18%, transparent);
    border:1px solid color-mix(in srgb, var(--yellow) 45%, transparent);
    text-align:center; font-size:13px; line-height:1.5;
}

@media (max-width:540px) {
    .htx-root { right:8px !important; left:8px !important; bottom:8px !important; width:auto !important; max-height:92vh !important; }
    #haptix-launch { bottom:auto !important; top:12px !important; }
}
`;

function injectStyles() {
    if (document.getElementById('haptix-style-inline')) return;
    const s = document.createElement('style');
    s.id = 'haptix-style-inline';
    s.textContent = CSS;
    document.head.appendChild(s);
    // v0.2.2: we used to also <link> style.css here as a back-compat
    // hook for user overrides, but ST already loads style.css via the
    // manifest "css" field — so the link was a duplicate. Worse, the
    // legacy style.css contained the v0.1 #haptix-launch rules that
    // overrode the new launcher's position/size (specificity tie,
    // <link> loaded later, legacy won). style.css is now an empty
    // file in the repo so that conflict is gone.
}

// ──────────────────────────────────────────────────────────────────────────
//   theme persistence
// ──────────────────────────────────────────────────────────────────────────

function loadTheme() {
    try { const t = localStorage.getItem('htx-theme'); if (t === 'light' || t === 'dark') theme = t; } catch {}
}
function saveTheme() { try { localStorage.setItem('htx-theme', theme); } catch {} }
function applyTheme() { if (panel) panel.setAttribute('data-theme', theme); }

// ──────────────────────────────────────────────────────────────────────────
//   builders — one per phase
// ──────────────────────────────────────────────────────────────────────────

function buildLauncher() {
    if (document.getElementById('haptix-launch')) return;
    launchBtn = h('button', { id: 'haptix-launch', title: 'Haptix', onclick: toggleHapticPanel }, [
        h('img', { src: asset('launcher-heart.png'), alt: 'Haptix', draggable: 'false' }),
    ]);
    document.body.appendChild(launchBtn);
}

function buildFloatStop() {
    if (document.getElementById('haptix-estop')) return;
    estopBtn = h('button', { id: 'haptix-estop', title: 'Stop everything (Esc)', onclick: () => bridge?.estop() }, [
        h('img', { src: asset('icon-estop.png'), draggable: 'false' }), 'STOP',
    ]);
    document.body.appendChild(estopBtn);
}

function buildPhaseIdle() {
    const quickPickRow = h('div', { class: 'htx-chips' });
    ['LELO F1S V3', 'LELO F1S V2', 'We-Vibe', 'DualSense pad'].forEach((name) => {
        quickPickRow.append(h('button', {
            class: 'htx-chip',
            onclick: () => onConnectClick(false),     // ST bridge currently filters by registry; chip just triggers the same dialog
            title: `Try ${name}`,
        }, name));
    });
    return h('div', { class: 'htx-phase htx-idle' }, [
        h('div', { class: 'htx-idle-hero' }, [
            h('img', { src: asset('icon-connect.png'), draggable: 'false' }),
            h('div', { class: 'lead' }, "Let's find your little friend"),
            h('div', { class: 'sub' }, 'Bluetooth toy or a rumble pad — Haptix sniffs out the protocol on connect.'),
        ]),
        h('div', { class: 'htx-row' }, [
            h('button', { class: 'htx-btn-primary', onclick: () => onConnectClick(false) }, 'Connect device'),
            h('button', { class: 'htx-btn-secondary', onclick: () => onConnectClick(true), title: 'List ALL Bluetooth devices' }, 'Any…'),
        ]),
        h('div', { class: 'htx-section-label' }, 'Quick pick'),
        quickPickRow,
    ]);
}

function buildPhaseScanning() {
    return h('div', { class: 'htx-phase htx-scan' }, [
        h('div', { class: 'ring' }, [
            h('div', { class: 'static' }),
            h('div', { class: 'spin' }),
            h('img', { src: asset('icon-connect.png'), draggable: 'false' }),
        ]),
        h('div', { class: 'lead' }, 'Sniffing out your toy…'),
        h('div', { class: 'sub' }, '(this is the least weird part, promise)'),
        h('button', { class: 'cancel', onclick: () => bridge?.disconnect() }, 'Cancel'),
    ]);
}

function buildPhaseAuth() {
    return h('div', { class: 'htx-phase htx-auth' }, [
        h('div', { class: 'halo' }, [
            h('div', { class: 'pulse' }),
            h('div', { class: 'core' }, h('img', { src: asset('icon-device.png'), draggable: 'false' })),
        ]),
        h('div', { class: 'lead' }, 'Boop the power button'),
        h('div', { class: 'sub', html: 'Press the button on your <b id="htx-auth-name">device</b> now so it knows you mean it.' }),
        h('button', { class: 'confirm', onclick: () => bridge?.pokeAuth() }, 'I pressed it'),
    ]);
}

function buildPhaseConnected() {
    return h('div', { class: 'htx-phase htx-connected' }, [
        h('div', { class: 'htx-dev-card' }, [
            h('div', { class: 'icon-wrap' }, h('img', { src: asset('icon-device.png'), draggable: 'false' })),
            h('div', { style: 'flex:1;min-width:0' }, [
                h('div', { class: 'dev-name', id: 'htx-dev-name' }, '—'),
                h('div', { class: 'dev-proto', id: 'htx-dev-proto' }, '● connected · Harmony protocol'),
            ]),
            h('div', { class: 'battery' }, [
                h('div', { class: 'pct', id: 'htx-battery' }, '—'),
                h('div', { class: 'label' }, 'BATTERY'),
            ]),
        ]),
        h('div', { class: 'htx-consent-card' }, [
            h('div', { class: 'lede' }, [
                h('img', { src: asset('icon-arm.png'), id: 'htx-arm-icon', draggable: 'false' }),
                h('div', {}, [
                    h('div', { class: 'title' }, 'Off by default. Always.'),
                    h('div', { class: 'body' }, 'Nothing moves until you tick consent and arm — every session.'),
                ]),
            ]),
            h('label', { class: 'consent-row' }, [
                h('input', { type: 'checkbox', id: 'htx-consent-cb', onchange: (e) => {
                    consentChecked = e.target.checked;
                    refreshConsentBtn();
                }}),
                h('span', {}, 'I consent to device actuation this session.'),
            ]),
            h('button', { class: 'htx-arm-btn', id: 'htx-arm', disabled: 'true', onclick: onArm }, 'Arm it ⚡'),
        ]),
        h('button', { class: 'htx-disconnect-btn', onclick: () => bridge?.disconnect() }, 'Disconnect device'),
    ]);
}

function buildPhaseLive() {
    return h('div', { class: 'htx-phase htx-live' }, [
        // NOW PLAYING
        h('div', { class: 'htx-now' }, [
            h('div', { class: 'head' }, [
                h('span', { class: 'label' }, 'Now playing'),
                h('button', { class: 'sim', id: 'htx-sim', onclick: onToggleSim, title: 'Play/pause' }, '❚❚ Pause'),
            ]),
            h('div', { class: 'scene' }, [
                h('img', { src: asset('icon-intensity.png'), id: 'htx-flame', class: 'active', draggable: 'false' }),
                h('div', { style: 'min-width:0' }, [
                    h('div', { class: 'line', id: 'htx-scene' }, 'Waiting for the scene to begin…'),
                    h('div', { class: 'tool', id: 'htx-tool' }, 'scene.idle · idle'),
                ]),
            ]),
            h('div', { class: 'htx-meter-label' }, [
                h('span', { class: 'name' }, 'Intensity'),
                h('span', { class: 'val', id: 'htx-int-val' }, '0%'),
            ]),
            h('div', { class: 'htx-meter' }, h('div', { class: 'fill int', id: 'htx-int-fill' })),
            h('div', { class: 'htx-meter-label' }, [
                h('span', { class: 'name' }, 'Arousal'),
                h('span', { class: 'val', id: 'htx-aro-val' }, '0%'),
            ]),
            h('div', { class: 'htx-meter aro' }, [
                h('div', { class: 'fill-wrap' }, h('div', { class: 'fill aro', id: 'htx-aro-fill' })),
                h('i', { class: 'dot', id: 'htx-aro-dot' }),
            ]),
        ]),

        // INTENSITY MODE + MAX
        h('div', { class: 'htx-card' }, [
            h('div', { class: 'htx-card-row' }, [
                h('img', { class: 'icon', src: asset('icon-intensity.png'), draggable: 'false' }),
                h('div', { class: 'info' }, [
                    h('div', { class: 'label' }, 'Intensity mode'),
                    h('div', { class: 'desc', id: 'htx-mode-desc' }, 'sized to the character'),
                ]),
                h('button', { class: 'htx-mode-btn', id: 'htx-mode', onclick: onCycleMode }, 'Auto'),
            ]),
            h('div', { class: 'htx-max-row' }, [
                h('span', { class: 'label' }, 'Max cap'),
                h('input', { type: 'range', min: '0', max: '100', value: '80', id: 'htx-max',
                    oninput: (e) => bridge?.setUserMax(Number(e.target.value) / 100) }),
                h('span', { class: 'val', id: 'htx-max-val' }, '80%'),
            ]),
        ]),

        // SEQUENCE + PATTERN
        h('div', { class: 'htx-pair' }, [
            h('div', { class: 'htx-card' }, [
                h('div', { class: 'pair-head' }, [
                    h('img', { src: asset('icon-sequence.png'), draggable: 'false' }),
                    h('span', { class: 'title' }, 'Sequence'),
                ]),
                h('select', { class: 'htx-select', id: 'htx-seq', onchange: (e) => bridge?.setSequence(e.target.value) },
                    SEQUENCES.map((s) => h('option', { value: s }, SEQUENCE_LABELS[s] || s))),
            ]),
            h('div', { class: 'htx-card' }, [
                h('div', { class: 'pair-head' }, [
                    h('img', { class: 'pat', src: asset('icon-pattern.png'), draggable: 'false' }),
                    h('span', { class: 'title' }, 'Patterns'),
                ]),
                h('button', { class: 'htx-pat-btn', id: 'htx-pat', onclick: onCyclePatternStyle }, 'Complex'),
            ]),
        ]),

        // TEST + CALIBRATE
        h('div', { class: 'htx-card htx-test' }, [
            h('div', { class: 'head' }, [
                h('img', { src: asset('icon-test.png'), draggable: 'false' }),
                h('span', { class: 'title' }, 'Test & calibrate'),
                h('span', { class: 'meta' }, 'no LLM needed'),
            ]),
            h('div', { class: 'selects' }, [
                h('select', { class: 'htx-select', id: 'htx-tact' },
                    ACTS.map((a) => h('option', { value: a }, a))),
                h('select', { class: 'htx-select', id: 'htx-tpace' },
                    ['caress', 'slow', 'steady', 'fast', 'frantic'].map((p) => h('option', { value: p }, p))),
            ]),
            h('div', { class: 'actions' }, [
                h('button', { class: 'htx-test-btn', id: 'htx-test', onclick: onTestToggle }, 'Test'),
                h('button', { class: 'htx-setfull', onclick: onSetFull,
                    title: 'Mark current arousal as your full-arousal point' }, [
                    h('img', { src: asset('icon-calibrate.png'), draggable: 'false' }), 'Set full point',
                ]),
            ]),
        ]),

        // SETTINGS
        h('div', { class: 'htx-card htx-settings' }, [
            h('div', { class: 'head' }, [
                h('img', { src: asset('icon-device.png'), draggable: 'false' }),
                h('span', { class: 'title' }, 'Settings'),
            ]),
            h('div', { class: 'row' }, [
                h('div', { class: 'lab' }, [
                    h('div', { class: 'name' }, 'Two-toy mode'),
                    h('div', { class: 'desc', id: 'htx-2toy-desc' }, 'one scene, two devices'),
                ]),
                h('button', { class: 'htx-toggle', id: 'htx-2toy', onclick: onToggleTwoToy },
                    h('i', { class: 'knob' })),
            ]),
            h('div', { class: 'row' }, [
                h('div', { class: 'lab' }, [
                    h('div', { class: 'name' }, 'Status line each turn'),
                    h('div', { class: 'desc' }, 'show detected act + pace in chat'),
                ]),
                h('button', { class: 'htx-toggle', id: 'htx-meta', onclick: onToggleMeta },
                    h('i', { class: 'knob' })),
            ]),
            h('div', { class: 'row' }, [
                h('span', { class: 'lab', style: 'font-weight:700;font-size:13px' }, 'Command path'),
                h('select', { class: 'htx-select', id: 'htx-path', style: 'flex:0 0 auto;width:auto',
                    onchange: (e) => bridge?.setCommandMode(e.target.value) },
                    COMMAND_PATHS.map((p) => h('option', { value: p }, p === 'harmony' ? 'Harmony / V3' : 'Classic (F1S / V2)'))),
            ]),
        ]),

        // STOP + END
        h('button', { class: 'htx-stop', onclick: () => bridge?.estop() }, [
            h('img', { src: asset('icon-estop.png'), draggable: 'false' }), 'STOP',
            h('span', { class: 'key' }, 'or Esc'),
        ]),
        h('button', { class: 'htx-end', onclick: () => bridge?.disarm() }, 'End session'),
    ]);
}

function buildPanel() {
    panel = h('div', { class: 'htx-root', 'data-theme': theme });

    const supported = bridge.isSupported();
    if (!supported) {
        // unsupported browsers get the friendly prompt only
        panel.append(h('div', { class: 'htx-head' }, [
            h('img', { class: 'brand', src: asset('launcher-heart.png'), draggable: 'false' }),
            h('div', { style: 'line-height:1.05' }, [
                h('div', { class: 'title' }, 'Haptix'),
                h('div', { class: 'subtitle' }, 'real-time haptics'),
            ]),
            h('span', { class: 'htx-badge' }, 'UNSUPPORTED'),
            h('button', { class: 'icon', onclick: toggleHapticPanel, title: 'Close' }, '×'),
        ]));
        panel.append(h('div', { class: 'htx-body' },
            h('div', { class: 'htx-prompt', html:
                'Web Bluetooth unavailable.<br>Use Chrome/Edge over <b>HTTPS</b> or <b>localhost</b> (e.g. the st-reach tailscale URL).' })));
        panel.classList.add('open');
        document.body.appendChild(panel);
        return;
    }

    // header
    panel.append(h('div', { class: 'htx-head' }, [
        h('img', { class: 'brand', src: asset('launcher-heart.png'), draggable: 'false' }),
        h('div', { style: 'line-height:1.05' }, [
            h('div', { class: 'title' }, 'Haptix'),
            h('div', { class: 'subtitle' }, 'real-time haptics'),
        ]),
        h('span', { class: 'htx-badge', id: 'htx-badge' }, 'OFFLINE'),
        h('button', { class: 'icon', id: 'htx-theme', onclick: onToggleTheme,
            title: 'Toggle theme' }, theme === 'dark' ? '☀' : '☾'),
        h('button', { class: 'icon', onclick: toggleHapticPanel, title: 'Close' }, '×'),
    ]));

    // body: one container per phase + an always-hidden auth-name fallback
    const body = h('div', { class: 'htx-body' });
    phaseDoms.idle      = buildPhaseIdle();
    phaseDoms.scanning  = buildPhaseScanning();
    phaseDoms.auth      = buildPhaseAuth();
    phaseDoms.connected = buildPhaseConnected();
    phaseDoms.live      = buildPhaseLive();
    Object.values(phaseDoms).forEach((node) => body.append(node));
    panel.append(body);
    document.body.appendChild(panel);
}

// ──────────────────────────────────────────────────────────────────────────
//   action handlers
// ──────────────────────────────────────────────────────────────────────────

async function onConnectClick(any) {
    try { await bridge.connect({ any: any === true }); }
    catch (e) { console.error('[Haptix] connect FAILED:', e); }
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
    if (b) {
        b.textContent = testing ? 'Stop' : 'Test';
        b.classList.toggle('testing', testing);
    }
}

function onSetFull() { bridge.setArousalFullPoint(); }

function onCycleMode() {
    const order = ['mild', 'standard', 'harsh', 'auto'];
    const cur = bridge.getStatus().intensityMode || 'auto';
    bridge.setIntensityMode(order[(order.indexOf(cur) + 1) % order.length]);
}

function onCyclePatternStyle() {
    const cur = bridge.getStatus().patternStyle || 'complex';
    bridge.setPatternStyle(cur === 'complex' ? 'basic' : 'complex');
}

function onToggleMeta() { bridge.setMeta(bridge.getStatus().metaStatus === false); }

function onToggleSim() {
    // Sim is design-only; in production the scene is driven by chat. Tile the
    // button as a manual disarm shortcut that doesn't actually drop connection.
    const armed = bridge.isArmed && bridge.isArmed();
    if (armed) {
        // pause-via-estop returns to connected state per bridge contract
        bridge.estop();
    }
}

function onToggleTwoToy() {
    // Two-toy mode toggle. The bridge currently exposes connectSecondary() /
    // disconnectSecondary() rather than a single bool, so we just connect or
    // drop based on the current state.
    const s = bridge.getStatus();
    if (s.secondaryConnected) bridge.disconnectSecondary?.();
    else onConnectSecondary(false);
}

async function onConnectSecondary(any) {
    try { await bridge.connectSecondary({ any: any === true }); }
    catch (e) { console.error('[Haptix] 2nd connect FAILED:', e); }
}

function onToggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    saveTheme();
    applyTheme();
    const btn = document.getElementById('htx-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀' : '☾';
}

function refreshConsentBtn() {
    const btn = document.getElementById('htx-arm');
    if (!btn) return;
    if (consentChecked) btn.removeAttribute('disabled');
    else btn.setAttribute('disabled', 'true');
    const armIcon = document.getElementById('htx-arm-icon');
    if (armIcon) armIcon.classList.toggle('glow', consentChecked);
}

// ──────────────────────────────────────────────────────────────────────────
//   poll: drives all phase + meter + badge updates from bridge state
// ──────────────────────────────────────────────────────────────────────────

function set(id, val) { const e = document.getElementById(id); if (e) e.textContent = val; }
function setHtml(id, html) { const e = document.getElementById(id); if (e) e.innerHTML = html; }
function setStyle(id, style) { const e = document.getElementById(id); if (e) Object.assign(e.style, style); }

function poll() {
    if (!bridge || !panel) return;
    const s = bridge.getStatus();
    const phase = getPhase(s);

    // show only the current phase
    Object.entries(phaseDoms).forEach(([k, node]) => node && (node.style.display = k === phase ? '' : 'none'));

    // badge
    const badge = document.getElementById('htx-badge');
    if (badge) {
        const map = {
            idle:      'OFFLINE',
            scanning:  'SCANNING',
            auth:      'PRESS POWER',
            connected: 'READY',
            live:      'ARMED',
        };
        badge.className = 'htx-badge ' + phase;
        badge.textContent = map[phase] || phase.toUpperCase();
    }

    // floating STOP visibility (when armed + panel closed)
    if (estopBtn) {
        const showFloat = phase === 'live' && !panel.classList.contains('open');
        estopBtn.classList.toggle('show', showFloat);
    }

    // AUTH device name
    set('htx-auth-name', s.deviceName || 'device');

    // CONNECTED card
    set('htx-dev-name', s.deviceName || '—');
    set('htx-battery', s.battery != null ? `${Math.round(s.battery * 100)}%` : '—');
    const proto = (s.commandMode === 'harmony') ? 'Harmony protocol' : 'Classic protocol';
    set('htx-dev-proto', `● connected · ${proto}`);
    // Sync consent UI when phase changes
    const consentCB = document.getElementById('htx-consent-cb');
    if (consentCB && phase !== 'connected') {
        consentCB.checked = false;
        consentChecked = false;
        refreshConsentBtn();
    } else if (consentCB) {
        // keep DOM in sync if the bridge re-armed externally
        consentCB.checked = consentChecked;
    }

    // LIVE deck
    if (phase === 'live') {
        set('htx-scene', s.sceneLine || s.act || '—');
        set('htx-tool', `scene.${s.act || '—'} · ${s.pace || '—'}`);
        set('htx-int-val', pct(s.intensity));
        set('htx-aro-val', pct(s.arousal));
        setStyle('htx-int-fill', { width: pct(s.intensity) });
        setStyle('htx-aro-fill', { width: pct(s.arousal) });
        // flame breath
        const flame = document.getElementById('htx-flame');
        if (flame) flame.classList.toggle('active', (s.intensity || 0) > 0.04);
        // calibration dot
        const dot = document.getElementById('htx-aro-dot');
        if (dot) {
            if (s.fullArousalPoint != null) {
                dot.style.display = 'block';
                dot.style.left = `calc(${pct(s.fullArousalPoint)} - 1px)`;
            } else {
                dot.style.display = 'none';
            }
        }
        // controls
        const modeBtn = document.getElementById('htx-mode');
        const modeDesc = document.getElementById('htx-mode-desc');
        const MODE_DESC = { mild:'gentle ceiling', standard:'balanced feel', harsh:'no holding back', auto:'sized to the character' };
        const m = s.intensityMode || 'auto';
        if (modeBtn) modeBtn.textContent = m[0].toUpperCase() + m.slice(1);
        if (modeDesc) modeDesc.textContent = MODE_DESC[m] || '';
        const seqSel = document.getElementById('htx-seq');
        if (seqSel && document.activeElement !== seqSel) seqSel.value = s.sequence || 'off';
        const patBtn = document.getElementById('htx-pat');
        if (patBtn) patBtn.textContent = (s.patternStyle || 'complex') === 'basic' ? 'Basic' : 'Complex';
        const pathSel = document.getElementById('htx-path');
        if (pathSel && document.activeElement !== pathSel) pathSel.value = s.commandMode || 'harmony';
        const maxIn = document.getElementById('htx-max');
        const maxVal = document.getElementById('htx-max-val');
        if (maxIn && document.activeElement !== maxIn) {
            const mc = Math.round((s.userMax ?? 0.8) * 100);
            maxIn.value = mc;
            if (maxVal) maxVal.textContent = `${mc}%`;
        }
        const twoToyBtn = document.getElementById('htx-2toy');
        const twoToyDesc = document.getElementById('htx-2toy-desc');
        if (twoToyBtn) twoToyBtn.classList.toggle('on', !!s.secondaryConnected);
        if (twoToyDesc) twoToyDesc.textContent = s.secondaryConnected ? 'on · 2nd device mirrors the scene' : 'one scene, two devices';
        const metaBtn = document.getElementById('htx-meta');
        if (metaBtn) metaBtn.classList.toggle('on', s.metaStatus !== false);
        if (!s.armed && testing) {
            testing = false;
            const t = document.getElementById('htx-test');
            if (t) { t.textContent = 'Test'; t.classList.remove('testing'); }
        }
    }
}

function bindGlobalSafety() {
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && bridge?.isArmed?.()) bridge.estop();
    });
}

// ──────────────────────────────────────────────────────────────────────────
//   public API
// ──────────────────────────────────────────────────────────────────────────

export function toggleHapticPanel() {
    if (panel) panel.classList.toggle('open');
    // immediately recompute the floating-STOP visibility
    if (estopBtn && bridge) {
        const s = bridge.getStatus();
        const show = getPhase(s) === 'live' && !panel.classList.contains('open');
        estopBtn.classList.toggle('show', show);
    }
}

export function initHapticPanel(bridgeApi) {
    if (panel) return { toggle: toggleHapticPanel };
    bridge = bridgeApi;
    loadTheme();
    injectStyles();
    buildFloatStop();
    buildLauncher();
    buildPanel();
    bindGlobalSafety();
    pollTimer = setInterval(poll, 250);
    return { toggle: toggleHapticPanel };
}
