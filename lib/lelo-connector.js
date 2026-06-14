/**
 * LELO F1S V3 — BLE connector + auth state machine (NSFW haptic feature)
 *
 * Web Bluetooth transport. Original implementation from the documented protocol in
 * https://github.com/LELO-Devs/F1S-SDK/blob/master/F1S-V2-SPEC.md (CC BY-NC-ND 4.0 — functional facts
 * only; NOT derived from LELO SDK source).
 *
 * Auth flow (spec "Security"): connect -> read/notify Security 0x0A10 (initially 0x00..) -> prompt the user
 * to press the device power button -> the device publishes its password on 0x0A10 -> we write that password
 * back -> the device sets 0x0A10 to 0x0100000000000000 (confirmed) -> only then are other chars accessible.
 */

import { BLE } from './lelo-config.js';
import { NAME_PREFIXES } from './device-registry.js';

export const ConnState = Object.freeze({
    IDLE: 'idle',
    REQUESTING: 'requesting',
    CONNECTING: 'connecting',
    AUTH_AWAIT_BUTTON: 'auth_await_button',
    AUTH_WRITE: 'auth_write',
    AUTH_VERIFY: 'auth_verify',
    SUBSCRIBING: 'subscribing',
    READY: 'ready',
    AUTH_FAILED: 'auth_failed',
    DISCONNECTED: 'disconnected',
});

const AUTH_TIMEOUT_MS = 30_000;

const toHex = (dv) => Array.from(new Uint8Array(dv.buffer ?? dv))
    .map((b) => b.toString(16).padStart(2, '0')).join('');

// 128-bit standard-base UUID -> short 16-bit form for readable logs (e.g. "0a10").
const shortUuid = (u) => (typeof u === 'string' && u.length >= 8 ? u.slice(4, 8) : String(u));

/** Map of notify characteristic UUID -> decode "kind" handed to onNotify. */
const NOTIFY_CHARS = [
    [BLE.CHARS.DEPTH, 'depth'],
    [BLE.CHARS.PRESS_TEMP, 'pressTemp'],
    [BLE.CHARS.ACCEL, 'accel'],
    [BLE.CHARS.HALL, 'hall'],
    [BLE.CHARS.BUTTONS, 'buttons'],
];

/**
 * @param {object} cb
 * @param {(state:string, detail?:any)=>void} [cb.onState]
 * @param {(kind:string, dataView:DataView)=>void} [cb.onNotify]
 * @param {(msg:string)=>void} [cb.onLog]
 */
export function createConnector({ onState, onNotify, onLog } = {}) {
    let device = null;
    let server = null;
    let service = null;
    const chars = new Map();
    let state = ConnState.IDLE;
    let authTimer = null;
    let resolveAuth = null;
    let authChar = null;
    let authConfirmed = false;
    let detectedMode = 'v2';   // 'v2' (0x0A10 + 0xFFF1) or 'harmony' (0x0A11 + 0xFFF2, the V3)

    const log = (m) => onLog?.(`[lelo] ${m}`);
    const setState = (s, detail) => { state = s; onState?.(s, detail); };

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const withTimeout = (p, ms, msg) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
    ]);
    async function connectGattWithRetry(dev, attempts) {
        let lastErr;
        for (let i = 0; i < attempts; i++) {
            try { return await withTimeout(dev.gatt.connect(), 12000, 'gatt.connect timed out'); }
            catch (e) {
                lastErr = e;
                log(`connect attempt ${i + 1}/${attempts} failed: ${e.message}`);
                try { dev.gatt.disconnect(); } catch { /* ignore */ }
                await sleep(800);
            }
        }
        throw lastErr;
    }

    function supported() {
        return typeof navigator !== 'undefined' && !!navigator.bluetooth;
    }

    function getChar(uuid) {
        const c = chars.get(uuid);
        if (!c) throw new Error(`characteristic ${shortUuid(uuid)} not found on this device`);
        return c;
    }

    /** Scan ALL primary services, log their characteristics, and index every char by UUID. */
    async function discoverChars() {
        chars.clear();
        const services = await withTimeout(server.getPrimaryServices(), 10000, 'service discovery timed out');
        for (const svc of services) {
            let cs = [];
            try { cs = await svc.getCharacteristics(); }
            catch (e) { log(`service ${shortUuid(svc.uuid)} chars unavailable: ${e.message}`); continue; }
            log(`service ${shortUuid(svc.uuid)} chars: ${cs.map((c) => shortUuid(c.uuid)).join(', ') || '(none)'}`);
            for (const c of cs) chars.set(c.uuid, c);
        }
        if (!chars.has(BLE.CHARS.SECURITY)) log('WARNING: Security 0x0A10 not found in ANY service');
        if (!chars.has(BLE.CHARS.MOTOR)) log('WARNING: Motor 0xFFF1 not found in ANY service');
        detectedMode = (!chars.has(BLE.CHARS.SECURITY) && chars.has(BLE.CHARS.MOTOR2)) ? 'harmony' : 'v2';
        log(`detected command path: ${detectedMode} (0x0A10 ${chars.has(BLE.CHARS.SECURITY) ? 'present' : 'absent'}, 0xFFF2 ${chars.has(BLE.CHARS.MOTOR2) ? 'present' : 'absent'})`);
    }

    // ---- auth ----------------------------------------------------------------

    function handleSecurity(dv) {
        if (authConfirmed) return;                  // V3's 0x0A11 spams 0100… forever — handle once
        const hex = toHex(dv);
        log(`auth: security value = ${hex}`);
        if (hex === BLE.SECURITY_CONFIRMED) {
            authConfirmed = true;
            log('auth confirmed');
            try { authChar?.stopNotifications(); } catch { /* ignore */ }
            finishAuth();
            return;
        }
        if (hex === BLE.SECURITY_LOCKED) return;            // still waiting for the button press
        // a password was published -> write it straight back to confirm
        setState(ConnState.AUTH_WRITE);
        authChar?.writeValue(new Uint8Array(dv.buffer.slice(0)))
            .then(() => setState(ConnState.AUTH_VERIFY))
            .catch((e) => log(`auth write-back failed: ${e.message}`));
    }

    function finishAuth() {
        clearTimeout(authTimer);
        authTimer = null;
        const r = resolveAuth;
        resolveAuth = null;
        r?.();
    }

    async function authenticate() {
        authConfirmed = false;
        // V2 uses 0x0A10; this V3 exposes 0x0A11 instead. Pick whichever exists; if neither, skip.
        const secUuid = [BLE.CHARS.SECURITY, BLE.CHARS.SECURITY_ALT].find((u) => chars.has(u));
        setState(ConnState.AUTH_AWAIT_BUTTON);   // panel prompts: "press the power button now"
        if (!secUuid) {
            log('no 0x0A10/0x0A11 security char — skipping handshake; press the power button to enable control.');
            await sleep(2500);
            return;   // proceed to subscribe + READY regardless
        }
        authChar = getChar(secUuid);
        log(`AUTH: security char ${shortUuid(secUuid)} — press the device power button NOW...`);
        try {
            await authChar.startNotifications();
            authChar.addEventListener('characteristicvaluechanged', (e) => handleSecurity(e.target.value));
            try { handleSecurity(await authChar.readValue()); } catch { /* not readable until button */ }
        } catch (e) { log(`auth notify/read failed on ${shortUuid(secUuid)}: ${e.message}`); }
        // Wait for confirm, but DON'T hard-fail — proceed to READY on timeout so the motor can be tested.
        await new Promise((resolve) => {
            resolveAuth = resolve;
            authTimer = setTimeout(() => { log('auth not confirmed in 30s — proceeding to READY anyway (motor may be gated).'); finishAuth(); }, AUTH_TIMEOUT_MS);
        });
    }

    /** Manual re-trigger of the verify read (panel "I pressed it" button) — notify can miss the window. */
    async function pokeAuth() {
        try {
            if (authChar) handleSecurity(await authChar.readValue());
        } catch (e) { log(`pokeAuth: ${e.message}`); }
    }

    // ---- subscribe -----------------------------------------------------------

    async function subscribe() {
        setState(ConnState.SUBSCRIBING);
        // sensor + button notifies (best-effort: a missing char shouldn't abort the whole session)
        for (const [uuid, kind] of NOTIFY_CHARS) {
            try {
                const c = await getChar(uuid);
                await c.startNotifications();
                c.addEventListener('characteristicvaluechanged', (e) => onNotify?.(kind, e.target.value));
            } catch (e) { log(`subscribe ${kind} skipped: ${e.message}`); }
        }
        // battery (0x2A19, discovered from whichever service holds it)
        try {
            const bat = getChar(BLE.CHARS.BATTERY);
            await bat.startNotifications();
            bat.addEventListener('characteristicvaluechanged', (e) => onNotify?.('battery', e.target.value));
            onNotify?.('battery', await bat.readValue());
        } catch (e) { log(`battery skipped: ${e.message}`); }
        setState(ConnState.READY);
    }

    // ---- lifecycle -----------------------------------------------------------

    function onGattDisconnected() {
        log('gatt disconnected');
        chars.clear();
        server = null;
        service = null;
        authConfirmed = false;
        setState(ConnState.DISCONNECTED);
    }

    /** MUST be called synchronously from a user-gesture handler (Web Bluetooth requirement). */
    async function requestAndConnect({ any = false } = {}) {
        if (!supported()) {
            throw new Error('Web Bluetooth unavailable — needs Chrome/Edge over HTTPS (or localhost).');
        }
        setState(ConnState.REQUESTING);
        // The F1S often does NOT advertise its 0xFFF0 service in the advertisement packet, so a
        // services-only filter won't list it. Match by advertised name; `any` lists every device.
        const options = any
            ? { acceptAllDevices: true, optionalServices: BLE.OPTIONAL_SERVICES }
            : {
                filters: [
                    ...NAME_PREFIXES.map((p) => ({ namePrefix: p })),
                    { services: [BLE.SERVICE] },
                ],
                optionalServices: BLE.OPTIONAL_SERVICES,
            };
        device = await navigator.bluetooth.requestDevice(options);
        device.addEventListener('gattserverdisconnected', onGattDisconnected);
        setState(ConnState.CONNECTING);
        log(`selected "${device.name || device.id}"; connecting GATT...`);
        server = await connectGattWithRetry(device, 3);
        log('GATT connected; discovering services + characteristics...');
        await discoverChars();
        log('discovery done; starting auth...');
        await authenticate();
        await subscribe();
    }

    /** Reconnect to an already-chosen device (no new chooser). Re-auth still needs a button press. */
    async function reconnect() {
        if (!device) throw new Error('no device to reconnect');
        setState(ConnState.CONNECTING);
        server = await connectGattWithRetry(device, 3);
        await discoverChars();
        await authenticate();
        await subscribe();
    }

    async function writeChar(uuid, bytes, { withoutResponse = false } = {}) {
        if (state !== ConnState.READY) return false;       // never write unless fully ready
        const c = getChar(uuid);
        if (withoutResponse && c.writeValueWithoutResponse) {
            try { await c.writeValueWithoutResponse(bytes); return true; }
            catch (e) { log(`WWR failed on ${shortUuid(uuid)} (${e.message}); retrying with-response`); }
        }
        if (c.writeValueWithResponse) await c.writeValueWithResponse(bytes);
        else await c.writeValue(bytes);
        return true;
    }

    /** Best-effort immediate stop — used by estop; bypasses the READY guard. */
    async function hardStop() {
        // Stop BOTH motor paths regardless of detected mode (defense for estop).
        try {
            const m1 = chars.get(BLE.CHARS.MOTOR);
            if (m1) await m1.writeValue(Uint8Array.from(BLE.CMD.STOP)).catch(() => {});
        } catch { /* ignore */ }
        try {
            const m2 = chars.get(BLE.CHARS.MOTOR2);
            if (m2) {
                await m2.writeValue(Uint8Array.of(0x0a, 0x12, 1, 0x08, 0, 0, 0, 0, 0, 0)).catch(() => {});
                await m2.writeValue(Uint8Array.of(0x0a, 0x12, 2, 0x08, 0, 0, 0, 0, 0, 0)).catch(() => {});
            }
        } catch (e) { log(`hardStop: ${e.message}`); }
    }

    function disconnect() {
        try { device?.gatt?.connected && device.gatt.disconnect(); } catch { /* ignore */ }
        setState(ConnState.IDLE);
    }

    return {
        supported,
        requestAndConnect,
        reconnect,
        pokeAuth,
        writeChar,
        hardStop,
        disconnect,
        get state() { return state; },
        get deviceName() { return device?.name || null; },
        get detectedMode() { return detectedMode; },
    };
}
