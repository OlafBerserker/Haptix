/**
 * Haptix — multi-brand BLE protocol registry (EXPERIMENTAL — UNTESTED HARDWARE).
 *
 * ⚠️  READ THIS FIRST. Only the LELO path (lelo-command-path.js) is validated on real hardware. Everything
 *     in this file is reconstructed from the Buttplug device-config database + public protocol notes. The
 *     COMMAND ENCODERS are unit-tested for output bounds (test/edge.test.mjs), but protocol *correctness*
 *     on a given device is NOT verified. The generic connector therefore PREFERS runtime characteristic
 *     discovery (scan for the writable char) over the hardcoded UUIDs below, so a stale UUID still works.
 *     Do not present any of these as "supported" — they are "best-effort, please report back" (see README).
 *
 * Provenance: github.com/buttplugio/buttplug (rust device-config) — Lovense, We-Vibe, Magic Motion,
 * Satisfyer, Kiiroo families. Each entry notes a confidence level.
 *
 * Encoder contract: encode(norm 0..1, ch 0|1) -> { kind:'bytes'|'text', data:Uint8Array|string }.
 * The generic connector wraps text in a TextEncoder before writing. stop() -> a zero-intensity command.
 */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const stepN = (norm, max) => clamp(Math.round((Number(norm) || 0) * max), 0, max);
const te = (s) => ({ kind: 'text', data: s });
const by = (arr) => ({ kind: 'bytes', data: Uint8Array.from(arr) });

export const PROTOCOLS = Object.freeze({
    // ---- Lovense (HIGH confidence — open ASCII protocol, one of the best-documented) ----------------
    // Nordic-UART-style: write ASCII "Vibrate:N;" (N 0..20) to the TX characteristic. Dual-motor models
    // accept "Vibrate1:N;" / "Vibrate2:N;". Service/char UUIDs vary per model generation -> discover at
    // runtime (every Lovense exposes exactly one writable char on its custom service).
    lovense: {
        id: 'lovense', label: 'Lovense (Max/Nora/Lush/Edge/Domi/Hush/Calor/Gush…)', confidence: 'high',
        scale: 20,
        // Known service UUID families (hints for the chooser; discovery still does the real work).
        serviceHints: [
            '5a300001-0024-4bd4-bba1-7c0978d43781',
            '6e400001-b5a3-f393-e0a9-e50e24dcca9e',   // Nordic UART (older units)
        ],
        encode: (norm, ch = 0) => te(`Vibrate${ch ? ch + 1 : ''}:${stepN(norm, 20)};`),
        stop: () => te('Vibrate:0;'),
        notes: 'ASCII over TX char; battery via "Battery;" query. Discover the writable char at runtime.',
    },

    // ---- We-Vibe (MEDIUM — well-documented 8-byte packet, but model variants exist) -----------------
    // 8-byte control packet; intensities nibble-packed (0..15). Newer firmwares accept 0..15 in byte[3].
    wevibe: {
        id: 'wevibe', label: 'We-Vibe (Sync/Chorus/Nova/Pivot/Verge/Vector/Melt/Moxie…)', confidence: 'medium',
        scale: 15,
        serviceHints: ['f000bb03-0451-4000-b000-000000000000'],
        encode: (norm, ch = 0) => {
            const i = stepN(norm, 15);
            const ext = ch === 1 ? i : 0;          // byte high-nibble = external, low = internal (best-effort)
            return by([0x0f, 0x03, 0x00, (ext << 4) | i, 0x00, 0x03, 0x00, 0x00]);
        },
        stop: () => by([0x0f, 0x03, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00]),
        notes: 'Nibble-packed dual intensity. Variant byte order across models — verify with a capture.',
    },

    // ---- Magic Motion (MEDIUM-LOW — multiple protocol generations) ----------------------------------
    magicmotion: {
        id: 'magicmotion', label: 'Magic Motion (Smart Mini Vibe/Flamingo/Dante/Krush…)', confidence: 'low',
        scale: 100,
        serviceHints: ['78667579-7b48-43db-b8c5-7928a6b0a335'],
        encode: (norm) => by([0x10, 0xff, 0x04, 0x0a, stepN(norm, 100), 0x00, 0x00, 0x00]),
        stop: () => by([0x10, 0xff, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00]),
        notes: 'Protocol differs by generation (v2/v3). LOW confidence — do not trust without a capture.',
    },

    // ---- Satisfyer (MEDIUM — needs a periodic keepalive or the motor stops) -------------------------
    satisfyer: {
        id: 'satisfyer', label: 'Satisfyer Connect (Curvy/Pro/Penguin/Double…)', confidence: 'medium',
        scale: 100, keepaliveMs: 1000,
        serviceHints: ['00001900-0000-1000-8000-00805f9b34fb'],
        encode: (norm) => { const v = stepN(norm, 100); return by([v, v, v, v]); },
        stop: () => by([0x00, 0x00, 0x00, 0x00]),
        notes: 'Requires a ~1s keepalive re-write or the device halts. Generic path must re-send on a timer.',
    },

    // ---- Kiiroo (LOW — Onyx/Pearl/Keon families differ a lot) ---------------------------------------
    kiiroo: {
        id: 'kiiroo', label: 'Kiiroo (Pearl2/Onyx+/Keon/Cliona…)', confidence: 'low',
        scale: 100,
        serviceHints: ['00001900-0000-1000-8000-00805f9b34fb'],
        encode: (norm) => by([0x01, stepN(norm, 100)]),
        stop: () => by([0x01, 0x00]),
        notes: 'Vibrators only here; the stroker (Onyx/Keon) position protocol is out of scope. LOW.',
    },
});

export const PROTOCOL_IDS = Object.freeze(Object.keys(PROTOCOLS));

export function getProtocol(id) { return PROTOCOLS[id] || null; }

/** Encode an intensity for a brand, always returning a write descriptor (or a no-op for unknown). */
export function encodeFor(id, norm, ch = 0) {
    const p = PROTOCOLS[id];
    if (!p) return null;
    return p.encode(clamp(Number(norm) || 0, 0, 1), ch);
}
