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
find "$REPO/app/public/data" -mindepth 2 -maxdepth 2 -name source.tgz -delete 2>/dev/null || true
node "$HERE/bake-catalog.mjs"
node "$HERE/copy-site-assets.mjs"

# Warm-start expansion authority.
mkdir -p "$REPO/app/public/data/expansions"
rm -rf "$REPO/app/public/data/expansions"/*
cp -r "$REPO/expansions/." "$REPO/app/public/data/expansions/" 2>/dev/null || true

# Packed IG sites at the site-bundles root. Template artifacts are a separate
# namespace staged below.
mkdir -p "$REPO/app/public/data/sites"
rm -f "$REPO/app/public/data/sites"/*.json
for file in "$REPO"/site-bundles/*.json; do
  [ -e "$file" ] && cp "$file" "$REPO/app/public/data/sites/"
done

# Loader-produced template warm starts and controlled browser fixtures.
mkdir -p "$REPO/app/public/data/templates" "$REPO/app/public/data/fixtures"
rm -rf "$REPO/app/public/data/templates"/* "$REPO/app/public/data/fixtures"/*
cp -r "$REPO/site-bundles/templates/." "$REPO/app/public/data/templates/" 2>/dev/null || true
cp -r "$REPO/scripts/fixtures/bad-ant-template/." "$REPO/app/public/data/fixtures/" 2>/dev/null || true

# Versioned Publisher-runtime closure (FHIR icons/fixed joins/backgrounds and
# pinned runtime CSS/JS/images). The adapter generates dynamically discovered
# table backgrounds; the pack builder validates every fetched third-party byte
# against its committed SHA-256.
node "$HERE/build-publisher-runtime-pack.mjs"

test -f "$REPO/app/public/data/cycle/manifest.json"
test -f "$REPO/app/public/data/uscore/source.tgz"
test -f "$REPO/app/public/data/publisher-runtime/1.0.0.json"
echo "[assemble-static-data] complete app/public/data assembled"
