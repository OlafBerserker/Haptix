#!/usr/bin/env bash
#
# Haptix release helper.
#
# Bumps the version in BOTH manifest.json (the only one ST reads) and
# package.json (kept in sync for tooling), verifies auto_update is
# still in the manifest, commits, tags, and pushes — all the steps a
# SillyTavern auto-update needs you not to forget.
#
# Usage:   bash tools/release.sh <new-version> [notes...]
# Example: bash tools/release.sh 0.2.2 "fix scanning ring blur"
#
# Why this exists:
#   v0.2.0 shipped without "auto_update": true and got stuck on every
#   v0.1 install forever. This script bakes the post-mortem fix into
#   the workflow so future releases can't silently break the same way.

set -euo pipefail

NEW="${1:-}"
NOTES="${*:2}"

if [[ -z "$NEW" ]]; then
    echo "usage: bash tools/release.sh <new-version> [notes...]" >&2
    exit 1
fi
if [[ ! "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "version must be semver (X.Y.Z), got: $NEW" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/manifest.json"
PKG="$ROOT/package.json"

if [[ ! -f "$MANIFEST" ]]; then echo "no $MANIFEST" >&2; exit 1; fi
if [[ ! -f "$PKG"      ]]; then echo "no $PKG" >&2; exit 1; fi

# 1. Refuse to release without auto_update — that's the field ST needs
#    on the SHIPPED version for the user's next update tick to fire.
if ! grep -q '"auto_update"[[:space:]]*:[[:space:]]*true' "$MANIFEST"; then
    cat >&2 <<'EOF'
manifest.json is missing "auto_update": true.

SillyTavern's autoUpdateExtensions() skips every third-party
extension whose currently-installed manifest doesn't opt in. If
this release ships without the field, users on the previous
version will silently never get the next one.

Re-add the field and try again.
EOF
    exit 1
fi

# 2. Branch sanity: ST git-pulls main; refuse to release from elsewhere.
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
    echo "release must happen on main (you're on $BRANCH)" >&2
    exit 1
fi

# 3. Working tree must be clean.
if [[ -n "$(git -C "$ROOT" status --porcelain)" ]]; then
    echo "working tree dirty — commit or stash first" >&2
    git -C "$ROOT" status -s
    exit 1
fi

OLD="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$MANIFEST" | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
echo "==> bumping $OLD -> $NEW"

# 4. Bump version in both files.
# Use Python for portable JSON-safe in-place edit (won't trash
# whitespace or comments — though strict JSON has neither).
python -c "
import json, sys, pathlib
for p in ['$MANIFEST', '$PKG']:
    pth = pathlib.Path(p)
    obj = json.loads(pth.read_text())
    obj['version'] = '$NEW'
    pth.write_text(json.dumps(obj, indent=4) + '\n')
"

# 5. Stage + commit.
git -C "$ROOT" add manifest.json package.json
MSG="v$NEW"
if [[ -n "$NOTES" ]]; then MSG="$MSG — $NOTES"; fi
git -C "$ROOT" commit -m "$MSG"

# 6. Tag.
git -C "$ROOT" tag -a "v$NEW" -m "v$NEW"

# 7. Push commit + tag.
# The PAT lives in Prometheus's secret-broker as haptix_github_pat.
# This step is best-effort — if the secret-broker isn't reachable
# (e.g. you're off-tailnet), it falls back to a regular git push using
# whatever credentials the user's git config provides.
PAT=""
if command -v ssh >/dev/null 2>&1; then
    PAT="$(ssh -o BatchMode=yes admin2@100.106.57.37 \
        'sudo /opt/prometheus/bin/secret-broker get haptix_github_pat notes /dev/stdout' \
        2>/dev/null | head -1 | tr -d '\r\n' || true)"
fi
if [[ "${PAT:0:4}" == "ghp_" ]]; then
    git -C "$ROOT" push "https://x-access-token:${PAT}@github.com/OlafBerserker/Haptix.git" main
    git -C "$ROOT" push "https://x-access-token:${PAT}@github.com/OlafBerserker/Haptix.git" "v$NEW"
else
    echo "==> secret-broker PAT not available; falling back to plain git push"
    git -C "$ROOT" push origin main
    git -C "$ROOT" push origin "v$NEW"
fi

echo "==> done · v$NEW pushed · existing installs will auto-pull on next ST startup"
