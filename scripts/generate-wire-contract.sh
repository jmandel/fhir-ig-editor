#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$root/app/src/site/contract.generated.ts"
cycle_output="$root/vendor/cycle/site-gen/core/site-contract.generated.ts"
schema="$root/contracts/site-wire.schema.json"
temporary="$(mktemp)"
schema_temporary="$(mktemp)"
trap 'rm -f "$temporary" "$schema_temporary"' EXIT

RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-Awarnings" cargo run --quiet \
  --manifest-path "$root/vendor/sushi-rs/Cargo.toml" \
  -p site_engine \
  --features wire-contract \
  --bin export_typescript > "$temporary"

RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-Awarnings" cargo run --quiet \
  --manifest-path "$root/vendor/sushi-rs/Cargo.toml" \
  -p site_engine \
  --features wire-contract \
  --bin export_typescript -- --schema > "$schema_temporary"

if [[ "${1:-}" == "--check" ]]; then
  if ! cmp --silent "$temporary" "$output"; then
    diff -u "$output" "$temporary" || true
    echo "generated wire contract is stale; run scripts/generate-wire-contract.sh" >&2
    exit 1
  fi
  if ! cmp --silent "$temporary" "$cycle_output"; then
    diff -u "$cycle_output" "$temporary" || true
    echo "generated Cycle wire contract is stale; run scripts/generate-wire-contract.sh" >&2
    exit 1
  fi
  if ! cmp --silent "$schema_temporary" "$schema"; then
    diff -u "$schema" "$schema_temporary" || true
    echo "generated wire schemas are stale; run scripts/generate-wire-contract.sh" >&2
    exit 1
  fi
else
  install -m 0644 "$temporary" "$output"
  install -m 0644 "$temporary" "$cycle_output"
  install -D -m 0644 "$schema_temporary" "$schema"
fi
