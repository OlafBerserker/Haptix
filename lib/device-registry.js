/**
 * Haptix device registry.
 *
 * LELO BLE devices (verified against Buttplug device-config). The connector auto-selects the actual command
 * format at runtime by characteristic presence (Security 0x0A10 -> classic V2 [0x01,m,v]@0xFFF1;
 * else 0xFFF2 present -> Harmony 10-byte). This table supplies the chooser NAME filters + metadata.
 *
 * Multi-brand (Lovense/We-Vibe/Kiiroo/etc.) support is layered in separately as an experimental protocol
 * registry (see protocols.js) — kept apart because that hardware is untested.
 */

export const LELO_DEVICES = Object.freeze([
    { model: 'LELO F1s',            protocol: 'classic', motors: 2, names: ['F1s'] },
    { model: 'LELO F1s V2',         protocol: 'classic', motors: 2, names: ['F1SV2A', 'F1SV2X'] },
    { model: 'LELO F1s V3',         protocol: 'auto',    motors: 2, names: ['F1SV3'] },
    { model: 'LELO Tiani Harmony',  protocol: 'harmony', motors: 2, names: ['TianiHarmony', 'Tiani Harmony'] },
    { model: 'LELO Tiani Twist',    protocol: 'harmony', motors: 1, names: ['Tiani Twist'] },
    { model: 'LELO Ida Wave',       protocol: 'harmony', motors: 2, names: ['IdaWave', 'Ida Wave'] },
    { model: 'LELO Tor 3',          protocol: 'harmony', motors: 1, names: ['TOR3'] },
    { model: 'LELO Hugo 2',         protocol: 'harmony', motors: 2, names: ['Hugo2'] },
    { model: 'LELO Enigma',         protocol: 'harmony', motors: 2, names: ['DoubleSonic'] },
    { model: 'LELO Gigi 3',         protocol: 'harmony', motors: 1, names: ['GIGI3'] },
    { model: 'LELO Liv 3',          protocol: 'harmony', motors: 1, names: ['LIV3'] },
    { model: 'LELO Sona 3 Cruise',  protocol: 'harmony', motors: 1, names: ['SONA3 Cruise'] },
    { model: 'LELO Switch',         protocol: 'harmony', motors: 2, names: ['Switch'] },
    { model: 'LELO F2s',            protocol: 'harmony', motors: 2, names: ['F2'] },
    { model: 'LELO Surfer 2',       protocol: 'harmony', motors: 1, names: ['SURFER2'] },
    { model: 'LELO Boomerang',      protocol: 'harmony', motors: 2, names: ['Boomerang'] },
]);

/** Name prefixes for the Web Bluetooth chooser filter (so any LELO model is selectable). */
export const NAME_PREFIXES = Object.freeze(
    Array.from(new Set(LELO_DEVICES.flatMap((d) => d.names).concat(['F1s', 'LELO']))),
);
