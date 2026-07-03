#!/usr/bin/env bash
# One-shot: assemble everything the static app needs into app/public/ (all
# gitignored). Run before `bun run build` (or `vite dev`).
#   1. build-wasm.sh          -> app/public/pkg/
#   2. bundle-packages.sh     -> app/public/data/bundles/
#   3. export-ig-manifest.mjs -> app/public/data/cycle/manifest.json
#   4. stage the committed expansion cache -> app/public/data/expansions/
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
bash "$HERE/build-wasm.sh"
bash "$HERE/bundle-packages.sh"
node "$HERE/export-ig-manifest.mjs"
node "$HERE/copy-site-assets.mjs"   # M2: design CSS/fonts for the preview iframe
# Stage the COMMITTED expansion cache (spec §6 tier 3 warm-start authority) into
# the gitignored public dir the browser fetches. `expansions/` is tracked; its
# staged copy is not.
mkdir -p "$REPO/app/public/data/expansions"
cp -r "$REPO/expansions/." "$REPO/app/public/data/expansions/" 2>/dev/null || true
echo "[prepare-data] all static data assembled under app/public/"
