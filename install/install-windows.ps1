# Haptix installer (Windows / PowerShell)
# Clones (or updates) Haptix into your SillyTavern third-party extensions folder.
param([string]$SillyTavernPath)

if (-not $SillyTavernPath) {
    $SillyTavernPath = Read-Host "Path to your SillyTavern folder (the one containing server.js)"
}
$extRoot = Join-Path $SillyTavernPath "public\scripts\extensions"
if (-not (Test-Path $extRoot)) {
    Write-Error "That doesn't look like a SillyTavern folder (no public\scripts\extensions). Aborting."
    exit 1
}
$dest = Join-Path $extRoot "third-party\Haptix"

if (Test-Path $dest) {
    Write-Host "Haptix already installed — updating..."
    git -C $dest pull
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    git clone https://github.com/OlafBerserker/Haptix $dest
}

Write-Host ""
Write-Host "Done. Now:"
Write-Host "  1. Restart SillyTavern."
Write-Host "  2. Open it at http://localhost (NOT a 192.168.x.x address) in Chrome or Edge."
Write-Host "  3. Hard-reload (Ctrl+Shift+R). Click the heart button bottom-left."
