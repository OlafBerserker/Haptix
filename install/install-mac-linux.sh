#!/usr/bin/env bash
# Haptix installer (macOS / Linux)
# Clones (or updates) Haptix into your SillyTavern third-party extensions folder.
set -e

ST="${1:-}"
[ -z "$ST" ] && read -rp "Path to your SillyTavern folder (the one containing server.js): " ST

EXT_ROOT="$ST/public/scripts/extensions"
if [ ! -d "$EXT_ROOT" ]; then
    echo "That doesn't look like a SillyTavern folder (no public/scripts/extensions). Aborting." >&2
    exit 1
fi
DEST="$EXT_ROOT/third-party/Haptix"

if [ -d "$DEST" ]; then
    echo "Haptix already installed — updating..."
    git -C "$DEST" pull
else
    mkdir -p "$(dirname "$DEST")"
    git clone https://github.com/OlafBerserker/Haptix "$DEST"
fi

echo
echo "Done. Now:"
echo "  1. Restart SillyTavern."
echo "  2. Open it at http://localhost (NOT a 192.168.x.x address) in Chrome or Edge."
echo "  3. Hard-reload (Ctrl+Shift+R). Click the heart button bottom-left."
