#!/usr/bin/env bash
# Build the LOADER-PRODUCED warm-start template artifact (#40) for the stock
# adapter: `fig packages bundle --template <id#ver>` materializes the template's
# base chain (walk + union-copy + config deep-merge, byte-exact, no ant) and emits
# it as a mountSite/mountTemplate files-JSON. This REPLACES the reliance on a
# Java-materialized `temp/pages/_includes` template layer (task #39): the packed
# template layer the editor consumes is now emitted by the engine's own loader —
# the SAME bytes `Session.mountTemplate` produces at runtime (the byte gate proves
# live-mounted == packed).
#
#   scripts/build-template-bundle.sh <id#ver> [out.json]
#   scripts/build-template-bundle.sh hl7.fhir.template#1.0.0 \
#       app/public/data/templates/hl7.fhir.template%231.0.0.json
#
# Build-time dependency: the engine repo's `fig` binary (built from the pinned
# vendor/sushi-rs submodule). CI builds fig from the submodule; locally we build
# it into vendor/sushi-rs/target/release/fig on first use.
#
# The fig artifact roots template files at their NATIVE tree paths (`includes/*`,
# `config.json`, `content/`, `layouts/`, `liquid/`). The editor applies the SAME
# `includes/*`→`_includes/*` mapping `mountTemplate` applies when it stages the
# tree (see stockAdapter.mapTemplateTree), so the packed and live paths converge.
set -euo pipefail

COORD="${1:?usage: build-template-bundle.sh <id#ver> [out.json]}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/vendor/sushi-rs"

# OPFS/URL-safe filename: '#' → %23 (the P0 fragment-delimiter gotcha). Default
# lands under the committed templates dir, staged into app/public by prepare-data.
DEFAULT_OUT="$REPO/site-bundles/templates/$(printf '%s' "$COORD" | sed 's/#/%23/g').json"
OUT="${2:-$DEFAULT_OUT}"

# Optional scratch cargo/toolchain env (same knobs as build-wasm.sh).
if [ -n "${WASM_CARGO_HOME:-}" ]; then export CARGO_HOME="$WASM_CARGO_HOME"; export PATH="$CARGO_HOME/bin:$PATH"; fi

FIG="${FIG_BIN:-$ENGINE/target/release/fig}"
if [ ! -x "$FIG" ]; then
  echo "[build-template-bundle] building fig --release from vendor/sushi-rs"
  ( cd "$ENGINE" && cargo build --release -p fig >/dev/null )
fi

# `--offline` uses the CAS only; online (default) fetches the chain from the FHIR
# registry (packages.fhir.org). The template cache is a throwaway work dir.
TCACHE="${TEMPLATE_CACHE:-$REPO/.template-cache}"
mkdir -p "$(dirname "$OUT")"

echo "[build-template-bundle] fig packages bundle --template $COORD -> $OUT"
"$FIG" packages bundle --template "$COORD" --template-cache "$TCACHE" -o "$OUT" ${OFFLINE:+--offline}
echo "[build-template-bundle] done: $(du -h "$OUT" | cut -f1)"
