# Haptix — Claude orientation

SillyTavern third-party extension that drives Bluetooth haptic devices from AI roleplay. Visual design lives in `lib/panel.js::injectStyles()` (inline CSS), NOT in `style.css`.

## Cross-cutting context (load on hit, not pre-loaded)

This repo's release workflow + the ST auto-update gotchas live in a single memory:
- `~/.claude/projects/d--/memory/project_haptix_release_workflow.md`

That memory is the source of truth for `tools/release.sh`, the `auto_update: true` requirement, the `style.css` must-stay-empty rule, and the Playwright diagnostic loop. **Read it before bumping a version or touching `panel.js`.**

The PAT for pushes is **`haptix_github_pat`** in Vaultwarden's `Prometheus-Fleet` folder, NOT `github_pat` (that one's for `laboratoiresonore/*`). Fetch via secret-broker per `~/.claude/projects/d--/memory/reference_prometheus_password_storage.md`.

## Repo-specific rules (only-here knowledge)

1. **Releases via `bash tools/release.sh <version> "<notes>"`.** The script refuses to push if `manifest.json` is missing `"auto_update": true`, if you're not on `main`, or if the tree is dirty. Don't bypass it — those three guards exist because each has bitten the user.
2. **`style.css` stays empty.** The full visual system is inline in `panel.js`. Adding rules to `style.css` re-creates the v0.2.1 launcher-frame regression (same-specificity selectors with `<link>` loaded after `<style>`).
3. **Asset paths via `new URL('../assets/<name>.png', import.meta.url).href`** so the extension travels regardless of install location (user-data vs global).
4. **Bridge state is the single source of truth.** `poll()` reads `bridge.getStatus()` every 250ms and updates the DOM. Never shadow bridge values in local closures. Phase detection lives in `getPhase(s)` so the UI is purely a function of bridge state.
5. **Web Bluetooth user-gesture rule.** The connect call must run inside a click handler (`onConnectClick`). Calling `bridge.connect()` from a timer or async chain will fail silently in Chrome/Edge.
6. **No animation loops faster than 4s.** v0.2.3 removed the 2.8s launcher bob after the user flagged it as visual noise. Casting / armed states still animate (those signal real work); ornamental loops don't.
7. **Don't change `homePage` in `manifest.json`** — existing installs follow their local `origin` remote, but a rename would brick fresh installs and confuse SillyTavern's `git pull origin main`.

## Commit + push conventions

- Trailers: none (Co-Authored-By is fine when committing via the release script — the user has it configured)
- Branch: `main` only. SillyTavern's updater does `git pull origin main` server-side; any other branch is invisible.
- Tags: annotated, `v<MAJOR>.<MINOR>.<PATCH>`. `tools/release.sh` does this for you.
- Force-push: never. Existing installs would fail to fast-forward.

## Code quality conventions

- No emoji in commit messages or product UI (the `✓` star is OK in the Haptix panel — it's the AI-action ornament per the design system).
- Variable hygiene: don't re-introduce per-handler state mirrors. All UI state derives from `bridge.getStatus()`. The current bridge has ~15 fields — read them in `poll()`, project to DOM, never cache.
- No backward-compat hacks for v0.1 internals. `style.css` is empty because legacy compat-loading it was the bug.

## Verifying changes with Playwright

ST runs on `http://localhost:8100/` (basic auth `77 / lafleursemeurt`). The probe script template lives in the Haptix release memory; run it whenever the user says "still buggy" — it's faster + more honest than reading console logs.

## See also

- `~/.claude/projects/d--/memory/reference_prometheus_fleet_deploy.md` — for the larger pattern Haptix is a variant of
- `~/.claude/projects/d--/memory/feedback_session_orientation_protocol.md` — for what NOT to pre-load
- `CHANGELOG.md` — for the v0.2.x lineage and lessons embedded in each fix
