# Haptix 🖐️⚡

### *"Reach out and touch someone." — your GPU, apparently.*

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that lets your roleplay **physically reach through the fourth wall** and into a Bluetooth haptic device. The AI writes "she runs her hand down your thigh," and — by the unholy union of Web Bluetooth and questionable life choices — *something actually happens.*

It's a bridge between **what the character does** and **what your hardware does about it.** Puns intended. All of them.

> **Status:** ✅ tested end-to-end on a LELO F1S V3. Everything else is flagged **experimental** because the author has a finite number of devices and an infinite number of bad ideas.

---

## What it actually does (the four-ish loops of destiny)

- **Scene → device.** Haptix reads each AI message, figures out *what's happening* and *how fast*, and drives the motor to match. A slow caress is a slow caress. "Full speed" is your problem now.
- **Device → character.** SenseMotion-style sensors estimate your arousal and quietly whisper it into the LLM's context, so the character *notices*. There is no hiding from a Bluetooth narc.
- **Manual override → narrative.** Nudge the device's +/− buttons and Haptix transcribes it into the story ("*you gently slow their hand*"). The toy is now a co-author. It will not be credited.
- **Held up?** It can tell when you're, ahem, *holding it ready* and mentions it to the character. Discretion is dead. Long live immersion.

Plus: **4 intensity modes** (Mild / Standard / Harsh / **Auto** — which sizes you up based on the character's physique, because a dainty elf and a 9-foot barbarian should *not* hit the same), **autonomous pattern sequences** (build-up, edging, throb, wave, pulse, organic, fireworks, and an **arousal-reactive auto-edge** that backs off right when you'd rather it didn't), **per-character calibration that's remembered**, and settings that **persist** so you're not re-configuring your feelings every session.

---

## Supported devices

| Device | Status |
|---|---|
| **LELO F1S V3** (Harmony-protocol) | ✅ Confirmed working |
| **LELO F1S / F1S V2** (classic) | 🟢 Should work (same family, protocol auto-detected) |
| **LELO Harmony line** (Tiani, Ida, Hugo 2, Gigi 3, Tor 3, F2s, Switch, Sona 3 Cruise, …) | 🟡 Auto-detected, **untested** |
| Other Bluetooth toys & rumble devices | 🧪 Experimental presets, **untested** — PRs/bug reports welcome |

Haptix auto-detects the right command protocol when you connect. If your device does something weird, the panel has a manual override and a very large red button.

---

## Install

**The easy way (SillyTavern UI):**
1. SillyTavern → **Extensions** → **Install Extension**.
2. Paste: `https://github.com/OlafBerserker/Haptix`
3. Reload. A 💗 button appears bottom-left.

**The script way:** run the installer for your OS from [`install/`](install/) — it drops Haptix into your SillyTavern `third-party` extensions folder. (Details inside; it asks where ST lives and does the rest.)

**Browser & secure-context note:** Web Bluetooth needs **Chrome or Edge** and a **secure context** — i.e. open SillyTavern at `http://localhost` / `http://127.0.0.1` (loopback counts as secure) or over HTTPS. A `192.168.x.x` LAN address will *not* work. This is a browser rule, not us being difficult.

---

## Using it

1. Click the 💗 launcher → **Connect device** → pick your toy → press its **power button** when asked.
2. Tick the **consent** box → **Arm**. (Off by default. We are aggressively consent-forward.)
3. Play. Or hit **Test** with an act + pace to feel a pattern, **Set Full Arousal Point** to calibrate the meter, and cycle **Intensity** / **Sequence** to taste.
4. **STOP** is always one click (or the **Esc** key) away. Tab away and it relaxes to zero automatically.

---

## Safety & consent (the one section we're not joking in)

- **Off by default.** Nothing actuates until you connect *and* tick consent *and* press Arm, every session.
- **Always-visible emergency STOP**, an `Esc` hotkey, an inactivity dead-man auto-stop, a hard intensity cap, and ramp-rate limiting so nothing lurches.
- **It's a motor on your body.** Start low. You can always go up. Listen to your body over the software.
- Your call, your comfort, your big red button.

## Privacy

100% local. **No cloud, no telemetry, no analytics, no accounts.** Haptix talks to your browser and your toy and *nobody else*. What happens in your pants stays in your pants — we genuinely cannot see it and have built nothing that could.

---

## Disclaimer

Not affiliated with, endorsed by, or blessed by LELO or any device maker. Device protocol details are interoperability facts re-implemented from public sources. Use at your own risk, and possibly your own delight. No warranty, express or implied, including but not limited to fitness for *that* particular purpose.

## License

[MIT](LICENSE) — do whatever, just don't blame us.

*Made with caffeine, Web Bluetooth, and a complete absence of shame.*
