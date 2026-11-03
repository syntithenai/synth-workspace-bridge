#!/usr/bin/env bash
# Pack extension-mv3/ so manifest.json sits at the archive root. Chrome's
# "Load unpacked" and the Web Store upload both expect that layout.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p dist
rm -f dist/synth-workspace-bridge.zip
zip -j -X dist/synth-workspace-bridge.zip \
  extension-mv3/manifest.json \
  extension-mv3/background.js \
  extension-mv3/offscreen.html \
  extension-mv3/offscreen.js \
  extension-mv3/options.html \
  extension-mv3/options.js
echo "wrote dist/synth-workspace-bridge.zip"
