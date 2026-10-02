#!/bin/bash
# Builds HelloElectron.app by the standard manual route: take the official macOS Electron build,
# rename it and drop the app code into Contents/Resources/app. Downloads ~100 MB (cached in build/.cache).
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-build}"
VER="${ELECTRON_VERSION:-33.2.1}"
ARCH="$(uname -m | sed 's/x86_64/x64/')"
ZIP="electron-v$VER-darwin-$ARCH.zip"
mkdir -p "$OUT/.cache"
[ -f "$OUT/.cache/$ZIP" ] || curl -fsSL -o "$OUT/.cache/$ZIP" "https://github.com/electron/electron/releases/download/v$VER/$ZIP"
rm -rf "$OUT/HelloElectron.app" "$OUT/.electron-tmp"
mkdir "$OUT/.electron-tmp"
ditto -x -k "$OUT/.cache/$ZIP" "$OUT/.electron-tmp"
mv "$OUT/.electron-tmp/Electron.app" "$OUT/HelloElectron.app"
rm -rf "$OUT/.electron-tmp"
mkdir -p "$OUT/HelloElectron.app/Contents/Resources/app"
cp src/electron-app/* "$OUT/HelloElectron.app/Contents/Resources/app/"
echo "Built: $OUT/HelloElectron.app (Electron $VER, darwin-$ARCH)"
