#!/usr/bin/env bash
# Build the cycle IG's package closure into app/public/data/bundles/ as prebuilt
# `.tgz` bundles + a manifest.json (gitignored — regenerated here / in CI).
#
# The 5-package closure (spec §8 step 4): r4.core (build) + tools + terminology +
# uv.extensions, plus r5.core (needed for R4→R5 base resolution during snapshot
# generation). Built with the pinned engine's `rust_sushi bundle` CLI so the
# bundle format matches what the wasm BundleSource mounts.
#
# Requires a populated FHIR package cache. Point FHIR_CACHE at it; default is the
# engine submodule's isolated repo cache.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/vendor/sushi-rs"
OUT="$REPO/app/public/data/bundles"
CACHE="${FHIR_CACHE:-$ENGINE/temp/fhir-home/.fhir/packages}"

[ -d "$CACHE" ] || { echo "FATAL: FHIR cache not found at $CACHE (set FHIR_CACHE)"; exit 2; }

# Optional scratch cargo/toolchain env (same knobs as build-wasm.sh).
if [ -n "${WASM_CARGO_HOME:-}" ]; then export CARGO_HOME="$WASM_CARGO_HOME"; export PATH="$CARGO_HOME/bin:$PATH"; fi

LABELS=(
  "hl7.fhir.r4.core#4.0.1"
  "hl7.fhir.uv.tools.r4#1.1.2"
  "hl7.terminology.r4#7.2.0"
  "hl7.fhir.uv.extensions.r4#5.3.0"
  "hl7.fhir.r5.core#5.0.0"
)

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
