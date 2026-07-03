#!/usr/bin/env bash
# One-shot: assemble everything the static app needs into app/public/ (all
# gitignored). Run before `bun run build` (or `vite dev`).
#   1. build-wasm.sh          -> app/public/pkg/
#   2. bundle-packages.sh     -> app/public/data/bundles/
#   3. export-ig-manifest.mjs -> app/public/data/cycle/manifest.json
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/build-wasm.sh"
bash "$HERE/bundle-packages.sh"
node "$HERE/export-ig-manifest.mjs"
node "$HERE/copy-site-assets.mjs"   # M2: design CSS/fonts for the preview iframe
echo "[prepare-data] all static data assembled under app/public/"
