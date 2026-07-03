#!/usr/bin/env bash
# Build the engine wasm module from the pinned sushi-rs submodule into
# app/public/pkg/ (gitignored — regenerated here / in CI).
#
# Produces:
#   app/public/pkg/wasm_api.js         (wasm-bindgen web-target ES module)
#   app/public/pkg/wasm_api_bg.wasm    (the engine: rust_sushi + snapshot walk)
#
# The editor repo NEVER patches the engine: everything is built from
# vendor/sushi-rs at its pinned commit (the submodule SHA is the engine version).
#
# Toolchain: needs a wasm32-unknown-unknown Rust toolchain + a wasm-bindgen CLI
# matching the crate's wasm-bindgen version. On a networked box:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version <ver-from-Cargo.lock>
# Offline / scratch toolchain: point these at it (see PUBLISH.md / P0 README):
#   WASM_RUSTUP_HOME, WASM_CARGO_HOME, WASM_BINDGEN, WASM_TOOLCHAIN_BIN
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/vendor/sushi-rs"
OUT="$REPO/app/public/pkg"

[ -d "$ENGINE/crates/wasm_api" ] || {
  echo "FATAL: vendor/sushi-rs not checked out (run: git submodule update --init)"; exit 2; }

# Optional scratch-toolchain env (keeps a system rustup untouched).
if [ -n "${WASM_RUSTUP_HOME:-}" ]; then export RUSTUP_HOME="$WASM_RUSTUP_HOME"; fi
if [ -n "${WASM_CARGO_HOME:-}" ]; then export CARGO_HOME="$WASM_CARGO_HOME"; export PATH="$CARGO_HOME/bin:$PATH"; fi
if [ -n "${WASM_TOOLCHAIN_BIN:-}" ]; then export PATH="$WASM_TOOLCHAIN_BIN:$PATH"; fi
WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
command -v "$WASM_BINDGEN" >/dev/null || { echo "FATAL: wasm-bindgen not found (set WASM_BINDGEN)"; exit 2; }

COMMIT="$(git -C "$ENGINE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "[build-wasm] engine sushi-rs @ $COMMIT"

rm -rf "$OUT"; mkdir -p "$OUT"

echo "[build-wasm] cargo build -p wasm_api --target wasm32-unknown-unknown --release"
( cd "$ENGINE" && WASM_API_GIT_COMMIT="$COMMIT" \
    cargo build -p wasm_api --target wasm32-unknown-unknown --release )

WASM="$ENGINE/target/wasm32-unknown-unknown/release/wasm_api.wasm"
echo "[build-wasm] wasm-bindgen --target web"
"$WASM_BINDGEN" --target web --out-dir "$OUT" --out-name wasm_api "$WASM"

if command -v wasm-opt >/dev/null; then
  echo "[build-wasm] wasm-opt -Oz"
  wasm-opt -Oz "$OUT/wasm_api_bg.wasm" -o "$OUT/wasm_api_bg.wasm.opt" \
    && mv "$OUT/wasm_api_bg.wasm.opt" "$OUT/wasm_api_bg.wasm"
else
  echo "[build-wasm] (wasm-opt not found — skipping size optimization)"
fi

echo "[build-wasm] done: $(du -h "$OUT/wasm_api_bg.wasm" | cut -f1) at app/public/pkg/"
