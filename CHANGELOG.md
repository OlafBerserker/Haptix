# Haptix changelog

## 0.2.0 — Priapistic Gooner (2026-06-14)

Total panel redesign. The dark-purple admin grid is gone; in its place is a
sticker-art floating control panel built from the repo's own icon set, with a
proper phase-based flow.

### New
- **Five-phase flow**: `IDLE` (find your toy) → `SCANNING` (animated ring +
  glowing connect icon) → `AUTH` (pulsing "boop the power button" prompt) →
  `CONNECTED` (device card, battery, consent gate, big green "Arm it ⚡") →
  `LIVE` (the dispatch deck).
- **Live deck**: a "Now playing" card with an animated intensity flame and
  scene line; shimmering intensity + arousal meters with a calibration dot;
  intensity-mode cycler (Mild / Standard / Harsh / **Auto** — Auto is the new
  default); max-cap slider; sequence + pattern picker; test/calibrate row
  with the proper act list (`teasing, handjob, blowjob, titjob, footjob,
  vaginal, anal, climax`); two-toy mode toggle; status-line toggle (off by
  default); command-path picker; floating-when-closed STOP that always pulses.
- **Theme toggle** in the header (☀ / ☾), persisted in `localStorage`.
- **Heart-sticker launcher** with a 2.8s bob — `assets/launcher-heart.png`.
- **Responsive bottom-sheet** layout at ≤540px width.
- **Custom CSS tooltips** removed in favour of legible inline copy
  (less mystery, more discoverability).

### Internal
- New `lib/panel.js` (full rewrite, ~700 lines, no extra deps). One imperative
  `poll()` loop drives every visible signal from `bridge.getStatus()`.
- Assets resolved via `new URL('../assets/...', import.meta.url).href` so the
  extension travels cleanly inside `extensions/third-party/Haptix/`.
- The connect action still runs inside the click handler to keep Web
  Bluetooth's user-gesture requirement intact.
- Legacy `style.css` is still loaded for any user-side overrides (the new
  visual rules are inline in `panel.js` for tight token coupling).

### Design source
- `claude.ai/design` handoff `Haptix Panel.dc.html` (see project history).

### SillyTavern auto-update
- `manifest.json` version field bumped to `0.2.0` — SillyTavern's third-party
  extension updater will detect this on the next refresh and offer the update.

## 0.1.0
- Initial release.
