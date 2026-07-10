#!/usr/bin/env bash
# Canonical one-shot recipe for everything the static app needs in app/public/
# (all gitignored). Run before `bun run build` or `vite dev`.
#   1. build-wasm.sh              -> app/public/pkg/
#   2. assemble-static-data.sh    -> complete app/public/data/ including every
#                                    catalog source, package/template/site bundle,
#                                    expansion cache, fixture, and Cycle asset.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$HERE/build-wasm.sh"
bash "$HERE/assemble-static-data.sh"
echo "[prepare-data] all static data assembled under app/public/"
