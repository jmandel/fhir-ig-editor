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
# Stage the COMMITTED stock-template site bundles (packed publisher-staged
# trees; scripts/build-stock-site.mjs regenerates from a publisher build).
# NB: site-bundles/templates/ (the loader-produced template warm-start artifacts,
# #40) is staged SEPARATELY below, not as a *-stock.json site bundle.
mkdir -p "$REPO/app/public/data/sites"
for f in "$REPO"/site-bundles/*.json; do
  [ -e "$f" ] && cp "$f" "$REPO/app/public/data/sites/"
done
# Stage the COMMITTED loader-produced template warm-start artifacts (#40): the
# `fig packages bundle --template` output the stock adapter fetches for a warm
# start of the TEMPLATE layer (the live resolve→fetch→mount→mountTemplate path is
# the cold path; the byte gate proves they render identically). Filenames carry
# the template coord with '#' → %23 (URL-safe). Regenerate one with
# scripts/build-template-bundle.sh <id#ver>.
mkdir -p "$REPO/app/public/data/templates"
cp -r "$REPO/site-bundles/templates/." "$REPO/app/public/data/templates/" 2>/dev/null || true
# Stage the committed E2E fixtures (#40): the synthetic bad-ant template the
# live-template AntHookError gate loads to prove custom-ant → clear refusal.
mkdir -p "$REPO/app/public/data/fixtures"
cp -r "$REPO/scripts/fixtures/bad-ant-template/." "$REPO/app/public/data/fixtures/" 2>/dev/null || true
echo "[prepare-data] all static data assembled under app/public/"
