#!/usr/bin/env bash
# Build the cycle IG's package closure into app/public/data/bundles/ as prebuilt
# `.tgz` bundles + a manifest.json (gitignored — regenerated here / in CI).
#
# The closure comes from scripts/packages.list (single source of truth, shared
# with fetch-packages.sh — see that file for WHY each package, incl. r5.core).
# Built with the pinned engine's `rust_sushi bundle` CLI so the bundle format
# matches what the wasm BundleSource mounts.
#
# Requires a populated FHIR package cache (scripts/fetch-packages.sh populates
# one from the registry). Point FHIR_CACHE at it; default is the engine
# submodule's isolated repo cache.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/vendor/sushi-rs"
OUT="$REPO/app/public/data/bundles"
CACHE="${FHIR_CACHE:-$ENGINE/temp/fhir-home/.fhir/packages}"

[ -d "$CACHE" ] || { echo "FATAL: FHIR cache not found at $CACHE (set FHIR_CACHE)"; exit 2; }

# Optional scratch cargo/toolchain env (same knobs as build-wasm.sh).
if [ -n "${WASM_CARGO_HOME:-}" ]; then export CARGO_HOME="$WASM_CARGO_HOME"; export PATH="$CARGO_HOME/bin:$PATH"; fi

LABELS=()
while IFS= read -r line; do
  l="${line%%[[:space:]]*}"
  case "$l" in ''|'#'*) continue ;; esac
  LABELS+=("$l")
done < "$HERE/packages.list"

rm -rf "$OUT"; mkdir -p "$OUT"

BIN="$ENGINE/target/release/rust_sushi"
if [ ! -x "$BIN" ]; then
  echo "[bundle-packages] building rust_sushi --release"
  ( cd "$ENGINE" && cargo build --release -p rust_sushi >/dev/null )
fi

echo "[bundle-packages] bundling ${#LABELS[@]} packages from $CACHE"
"$BIN" bundle --cache "$CACHE" --out "$OUT" "${LABELS[@]}" >/dev/null

# Emit manifest.json (labels + tgz paths) — what EngineClient.init fetches.
{
  echo '{'
  echo '  "bundles": ['
  for i in "${!LABELS[@]}"; do
    l="${LABELS[$i]}"
    comma=","; [ "$i" -eq $((${#LABELS[@]} - 1)) ] && comma=""
    printf '    { "label": "%s", "tgz": "%s.tgz" }%s\n' "$l" "$l" "$comma"
  done
  echo '  ]'
  echo '}'
} > "$OUT/manifest.json"

echo "[bundle-packages] done: $(du -sh "$OUT" | cut -f1) at app/public/data/bundles/"
