#!/usr/bin/env bash
# Assemble every generated/static input Vite copies from app/public/data/.
#
# This is the shared lower-level recipe used by prepare-data.sh and Pages CI.
# It deliberately does not build wasm: CI has already built and gated that
# artifact, while prepare-data.sh performs the wasm build immediately before
# calling this script.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

bash "$HERE/bundle-packages.sh"
node "$HERE/export-ig-manifest.mjs"

# Catalog projects are pinned in igCatalog.json and baked as same-origin source
# archives. Passing IDs to this script is intentionally unsupported: a complete
# app assembly must never silently omit projects visible in the selector.
find "$REPO/app/public/data" -mindepth 2 -maxdepth 2 \( -name source.tgz -o -name source.json \) -delete 2>/dev/null || true
node "$HERE/bake-catalog.mjs"
# Cycle's renderer-owned browser inputs are baked through Cycle's own package
# builder/canonicalizer. The worker will ingest this authenticated package
# privately during `prepare`; it is not a public asset API or a second SiteBuild.
bun "$HERE/bake-cycle-renderer-package.ts"

# Warm-start expansion authority.
mkdir -p "$REPO/app/public/data/expansions"
rm -rf "$REPO/app/public/data/expansions"/*
cp -r "$REPO/expansions/." "$REPO/app/public/data/expansions/" 2>/dev/null || true

# Controlled browser fixtures exercise arbitrary live template refusal.
mkdir -p "$REPO/app/public/data/fixtures"
rm -rf "$REPO/app/public/data/fixtures"/*
cp -r "$REPO/scripts/fixtures/bad-ant-template/." "$REPO/app/public/data/fixtures/" 2>/dev/null || true

test -f "$REPO/app/public/data/cycle/manifest.json"
test -f "$REPO/app/public/data/uscore/source.tgz"
test -f "$REPO/app/public/data/uscore/source.json"
test -f "$REPO/app/public/data/cycle/renderer-package/manifest.json"
echo "[assemble-static-data] complete app/public/data assembled"
