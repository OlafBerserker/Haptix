/**
 * Haptix — SillyTavern extension entry point.
 *
 * A standalone add-on that drives a LELO Bluetooth device from the story: the scene's act + pace shape the
 * motor pattern, the device's sensors feed an arousal estimate back into the LLM, and manual nudges get
 * transcribed. Auto-loads (no slash command needed); a 💗 launcher button opens the panel.
 *
 * No build step, no dependencies — pure ES modules loaded by SillyTavern.
 */

import { initCore } from './lib/core.js';
import { initHapticPanel, toggleHapticPanel } from './lib/panel.js';

function boot() {
    let core;
    try {
        core = initCore();
        initHapticPanel(core);
    } catch (e) {
        console.error('[Haptix] init failed:', e);
        try { if (typeof toastr !== 'undefined') toastr.error(`init failed: ${e.message}`, 'Haptix'); } catch { /* ignore */ }
        return;
    }
    // Optional /haptix slash command (panel toggle) — best-effort; the launcher button is the main entry.
    try {
        const c = SillyTavern.getContext();
        if (c?.SlashCommandParser?.addCommandObject && c?.SlashCommand?.fromProps) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'haptix',
                callback: () => { toggleHapticPanel(); return 'Haptix panel toggled.'; },
                helpString: 'Toggle the Haptix haptic control panel.',
            }));
        }
    } catch { /* slash command optional */ }
    console.log('[Haptix] ready');
}

// Wait for the SillyTavern context to exist, then boot.
if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
    boot();
} else {
    let tries = 0;
    const iv = setInterval(() => {
        if ((typeof SillyTavern !== 'undefined' && SillyTavern.getContext) || ++tries > 50) {
            clearInterval(iv);
            boot();
        }
    }, 200);
}
