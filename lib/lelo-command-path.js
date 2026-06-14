/**
 * LELO F1S — motor command encoder (swappable strategy)
 *
 * Isolates the firmware-byte-format-dependent code. The actuator calls path.writes(main, vib) → a list of
 * {char, bytes} writes, and path.stopWrites(). The connector auto-detects which path the device needs.
 *
 * Two real formats (from Buttplug's lelof1sv2.rs / lelo_harmony.rs, verified against a live V3):
 *  - 'v2'      : classic F1S / F1S-V2 — 3 bytes [0x01, main, vib] to 0xFFF1, write WITH response.
 *  - 'harmony' : Harmony-style F1S V3 (no 0x0A10, has 0xFFF2) — 10 bytes per motor channel to 0xFFF2,
 *                write WITHOUT response: [0x0a,0x12, ch, 0x08,0,0,0,0, speed, 0]  ch=1 main / 2 vib.
 *   Refs: github.com/buttplugio/buttplug PR #675 / issue #679; lelo_harmony.rs.
 */

import { BLE } from './lelo-config.js';

const speedByte = (norm) => Math.max(0, Math.min(0x64, Math.round((Number(norm) || 0) * 0x64)));
const harmonyCmd = (ch, norm) => Uint8Array.of(0x0a, 0x12, ch, 0x08, 0x00, 0x00, 0x00, 0x00, speedByte(norm), 0x00);

const PATHS = {
    v2: {
        id: 'v2',
        withoutResponse: false,
        writes: (main, vib) => [{ char: BLE.CHARS.MOTOR, bytes: Uint8Array.of(0x01, speedByte(main), speedByte(vib)) }],
        stopWrites: () => [{ char: BLE.CHARS.MOTOR, bytes: Uint8Array.from(BLE.CMD.STOP) }],
    },
    harmony: {
        id: 'harmony',
        withoutResponse: true,
        writes: (main, vib) => [
            { char: BLE.CHARS.MOTOR2, bytes: harmonyCmd(1, main) },
            { char: BLE.CHARS.MOTOR2, bytes: harmonyCmd(2, vib) },
        ],
        stopWrites: () => [
            { char: BLE.CHARS.MOTOR2, bytes: harmonyCmd(1, 0) },
            { char: BLE.CHARS.MOTOR2, bytes: harmonyCmd(2, 0) },
        ],
    },
};

export const COMMAND_PATHS = Object.freeze(Object.keys(PATHS));

export function getCommandPath(mode = 'v2') {
    return PATHS[mode] || PATHS.v2;
}
