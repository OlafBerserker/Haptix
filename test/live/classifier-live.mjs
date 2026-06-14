/**
 * Haptix — LIVE classifier test (needs a running OpenAI-compatible LLM). NOT in CI.
 *
 * Feeds the EXACT production prompt (buildClassifierPrompt) to a real model and runs the EXACT production
 * parser (parseClassifierReply), over adversarial roleplay messages. Hunts the two failure modes that
 * matter: unparseable replies, and the cardinal sin — contact=true on atmosphere/metaphor/dialogue.
 *
 *   node test/live/classifier-live.mjs [baseUrl]
 *   e.g. node test/live/classifier-live.mjs http://127.0.0.1:5001     (KoboldCpp / LM Studio / any OpenAI API)
 */

import { buildClassifierPrompt, parseClassifierReply } from '../../lib/core.js';

const BASE = (process.argv[2] || process.env.HAPTIX_LLM || 'http://127.0.0.1:5001').replace(/\/$/, '');

const CASES = [
    ['atmosphere: traces in the air', 'A figure materializes from shadow and smoke. Her finger traces a pattern in the air, leaving trails of purple fire.', false],
    ['weather', 'The wind howls and lightning splits the sky as she laughs from the cliff edge.', false],
    ['dialogue only', '"You will never be bored with me, darling," she purrs from across the room.', false],
    ['reaching, not yet contact', 'She steps closer and reaches out toward you, her fingers hovering just shy of your skin.', false],
    ['hypothetical / past intent', 'She wanted nothing more than to touch you, but she held herself back.', false],
    ['METAPHOR (stroking your ego)', 'Her honeyed words wrapped around you like a warm hand, stroking your ego just right.', false],
    ['handjob/slow', 'She wraps her hand around your cock and strokes you slowly.', true],
    ['blowjob', 'She takes your length deep into her mouth, sucking with enthusiasm.', true],
    ['anal/fast', 'He grips your hips and slams into your ass, pounding hard and fast.', true],
    ['vaginal/frantic', 'She sinks down onto your cock and rides you at a frantic pace.', true],
    ['titjob', 'She squeezes your shaft between her breasts and starts to move.', true],
    ['footjob', 'Her soft soles press against your cock, toes stroking the tip.', true],
    ['teasing thigh', 'She gently traces a single fingertip down your inner thigh.', true],
    ['user climax (act implies fire)', 'You feel the pressure build until you finally spill over the edge, gasping.', true],
    ['impact slap', 'She gives your bare ass a sharp, playful slap.', true],
    ['incidental brush', 'A stranger brushes against your crotch in the packed subway car.', true],
    ['multi-char (Bella acts)', 'Aria kisses your neck while Bella wraps her fingers around your shaft and pumps.', true],
    ['broken grammar', 'she slow stroke you the cock gentle and you feel it', true],
];

async function modelId() {
    try { const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(5000) }); const j = await r.json(); return j?.data?.[0]?.id || 'local'; }
    catch { return 'local'; }
}

async function ask(model, text) {
    const r = await fetch(`${BASE}/v1/chat/completions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: buildClassifierPrompt(text) }], temperature: 0.2, max_tokens: 200, stream: false }),
        signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 120)}`);
    const j = await r.json();
    return j?.choices?.[0]?.message?.content ?? '';
}

(async () => {
    const model = await modelId();
    console.log(`LLM: ${BASE}  model: ${model}\n`);
    let parseFail = 0, misfire = 0, missed = 0, ok = 0;
    for (const [label, text, expectContact] of CASES) {
        let raw = '', parsed = null, err = '';
        try { raw = await ask(model, text); parsed = parseClassifierReply(raw); }
        catch (e) { err = e.message; }
        if (err) { console.log(`  ERR   ${label.padEnd(38)} ${err.replace(/\s+/g, ' ').slice(0, 80)}`); parseFail++; continue; }
        if (!parsed) { console.log(`  PARSE✗ ${label.padEnd(38)} raw="${raw.replace(/\s+/g, ' ').slice(0, 70)}"`); parseFail++; continue; }
        const c = parsed.contact;
        let tag;
        if (c === expectContact) { tag = 'OK   '; ok++; }
        else if (c && !expectContact) { tag = 'MISFIRE'; misfire++; }   // the dangerous one
        else { tag = 'missed'; missed++; }
        console.log(`  ${tag} ${label.padEnd(38)} contact=${c} act=${parsed.act} pace=${parsed.pace} invol=${parsed.involuntary}`);
    }
    console.log(`\n${ok} correct · ${misfire} MISFIRES (false contact) · ${missed} missed · ${parseFail} parse/err  (of ${CASES.length})`);
    console.log(misfire ? 'MISFIRES are the cardinal sin — atmosphere must not actuate.' : 'No misfires — atmosphere stayed quiet.');
})();
