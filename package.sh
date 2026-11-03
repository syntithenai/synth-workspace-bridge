#!/usr/bin/env bash
# Pack extension-mv3/ so manifest.json sits at the archive root, including the
# icons/ subdirectory. Chrome's "Load unpacked" and the Web Store upload both
# expect that layout.
set -euo pipefail
cd "$(dirname "$0")"
out="$(pwd)/dist/synth-workspace-bridge.zip"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R extension-mv3/. "$stage"/
rm -f "$stage/README.md"
mkdir -p dist
rm -f "$out"
(cd "$stage" && zip -X -r -q "$out" .)
echo "wrote dist/synth-workspace-bridge.zip"
