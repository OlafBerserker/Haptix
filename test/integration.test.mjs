/**
 * Haptix — headless integration test (end-to-end of the "brain", no BLE / no real LLM).
 *
 * Mocks the browser + SillyTavern globals, boots core.js for real, and drives full message→classify→
 * actuate flows: the LLM contact path, the regex fallback, the no-misfire guard, and the consent gate.
 * This is the closest to E2E we can run without a physical device + a Chromium Web-Bluetooth session.
 * Run:  node test/integration.test.mjs
 */

// ---- mock environment ------------------------------------------------------
class Emitter {
    constructor() { this.h = {}; }
    on(t, f) { (this.h[t] = this.h[t] || []).push(f); }
    async emit(t, ...a) { for (const f of (this.h[t] || [])) await f(...a); }
}
const es = new Emitter();
const eventTypes = { MESSAGE_RECEIVED: 'mr', MESSAGE_SENT: 'ms', CHAT_CHANGED: 'cc' };
const chat = [];
let llmReply = null;   // per-case override of generateQuietPrompt
const ext = {};
const ctxObj = {
    chat, name1: 'You', name2: 'Aelora',
    characters: [{ name: 'Aelora', description: 'a mischievous sorceress', personality: 'playful, teasing' }],
    characterId: 0,
    substituteParams: (s) => String(s).replace(/\{\{user\}\}/g, 'You').replace(/\{\{char\}\}/g, 'Aelora'),
    setExtensionPrompt: (k, v) => { ext[k] = v; },
    eventSource: es, eventTypes,
    generateQuietPrompt: async () => llmReply,
};
globalThis.SillyTavern = { getContext: () => ctxObj };
globalThis.toastr = { info() {}, success() {}, warning() {}, error() {} };
// Node 24 provides a read-only `navigator` with no `.bluetooth` -> connector.supported() returns false, as wanted.
globalThis.document = { hidden: false };
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k),
};

// ---- assert framework ------------------------------------------------------
let pass = 0, fail = 0; const fails = [];
const t = (n, f) => { try { f(); pass++; } catch (e) { fail++; fails.push(`${n}: ${e.message}`); } };
const ok = (c, m) => { if (!c) throw new Error(m || 'falsy'); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'eq'}: ${a} !== ${b}`); };

const { initCore } = await import('../lib/core.js');
const api = initCore();

async function ai(text) { chat.push({ mes: text, name: 'Aelora', is_user: false }); await es.emit(eventTypes.MESSAGE_RECEIVED, chat.length - 1); }

t('initCore -> api, starts disarmed', () => { ok(api, 'api'); eq(api.getStatus().armed, false, 'armed'); });
t('supported() false without navigator.bluetooth', () => eq(api.isSupported(), false));

// disarmed: a clear contact message must NOT classify (consent gate)
llmReply = JSON.stringify({ contact: true, act: 'handjob', pace: 'slow' });
await ai('She wraps her hand around your cock and strokes you slowly');
t('disarmed ignores messages (no actuation without consent)', () => eq(api.getStatus().act, null));

api.arm('test-token');
t('arm() sets armed', () => eq(api.getStatus().armed, true));

// LLM contact path
llmReply = JSON.stringify({ contact: true, act: 'handjob', pace: 'slow', involuntary: 'none' });
await ai('She wraps her hand around your cock and strokes you slowly');
t('LLM path: classifies handjob', () => eq(api.getStatus().act, 'handjob'));

// LLM says no contact -> act clears (the Aelora misfire fix)
llmReply = JSON.stringify({ contact: false, act: 'none', pace: 'steady', involuntary: 'none' });
await ai('Her finger traces a pattern in the air, leaving trails of purple fire.');
t('LLM no-contact: clears act (no misfire)', () => eq(api.getStatus().act, null));

// regex fallback (LLM unavailable) still classifies real contact
llmReply = null;
await ai('She takes your cock in her mouth and sucks eagerly');
t('regex fallback: classifies blowjob', () => eq(api.getStatus().act, 'blowjob'));

// regex fallback no misfire on atmosphere
llmReply = null;
await ai('The wind howls and lightning splits the sky as she laughs.');
t('regex fallback: atmosphere does not fire', () => eq(api.getStatus().act, null));

// climax (the bug the harness caught) via regex
llmReply = null;
await ai('you cum hard, spilling over the edge');
t('regex: climax fires on "cum"', () => eq(api.getStatus().act, 'climax'));

// estop + disarm
t('estop() no throw', () => { api.estop(); });
api.disarm();
t('disarm() clears armed', () => eq(api.getStatus().armed, false));
t('getStatus exposes the new fields', () => {
    const s = api.getStatus();
    ok('metaStatus' in s && 'llm' in s && 'secondary' in s, 'status fields present');
});

console.log(`\nHaptix integration: ${pass} passed, ${fail} failed`);
if (fails.length) { console.log('FAILURES:'); fails.forEach((f) => console.log('  - ' + f)); }
process.exit(fail ? 1 : 0);
