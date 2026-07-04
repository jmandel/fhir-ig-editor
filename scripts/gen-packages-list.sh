#!/usr/bin/env bash
# GENERATE scripts/packages.list from the baked IG's config, using the native Rust
# resolver (task #32 gate v: lockfile un-handing). The closure is no longer
# hand-maintained — it is the UNION of the engine's compile_set + context_closure
# for the demo IG (vendor/cycle), PLUS the ONE snapshot-engine special (r5.core for
# an R4 IG: the walk engine is R5-internal, so R4 profile bases resolve against
# r5.core during snapshot generation — not derivable from package.json deps).
#
#   FHIR_CACHE=<packages-dir> scripts/gen-packages-list.sh          # write the file
#   CHECK=1 FHIR_CACHE=<dir>  scripts/gen-packages-list.sh          # drift gate only
#
# The drift gate (CHECK=1) fails if the committed scripts/packages.list differs
# from the freshly generated closure — so a dependency change in cycle's config,
# or an engine resolution change, forces a deliberate regeneration.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
ENGINE="$REPO/vendor/sushi-rs"
IG_DIR="$REPO/vendor/cycle"
LIST="$HERE/packages.list"
CACHE="${FHIR_CACHE:?set FHIR_CACHE to a populated packages dir (scripts/fetch-packages.sh)}"
BIN="${RUST_SUSHI_BIN:-$ENGINE/target/release/rust_sushi}"

if [ ! -x "$BIN" ]; then
  echo "[gen-packages-list] building rust_sushi --release"
  ( cd "$ENGINE" && cargo build --release -p rust_sushi >/dev/null )
fi

# The header (documentation) is preserved verbatim; only the label lines are
# regenerated from the resolver.
HEADER="$(cat <<'EOF'
# GENERATED — do not edit by hand. Regenerate with:
#   FHIR_CACHE=<packages-dir> scripts/gen-packages-list.sh
# A CI drift gate (CHECK=1) fails if this file diverges from the resolver output.
#
# The demo IG's package closure = the native resolver's compile_set ∪
# context_closure for vendor/cycle, PLUS the snapshot-engine special r5.core.
# Consumed by fetch-packages.sh (download) and bundle-packages.sh (bundle).
#
# Why each package:
#   hl7.fhir.r4.core        — cycle is an R4 IG; the compile fishes R4 bases.
#   hl7.fhir.uv.tools.r4    — cycle automatic dependency (R4).
#   hl7.terminology.r4      — cycle automatic dependency (R4).
#   hl7.fhir.uv.extensions.r4 — cycle automatic dependency (R4).
#   hl7.fhir.r5.core        — SNAPSHOT-ENGINE SPECIAL (not a package.json dep):
#                             the walk engine is R5-internal, so R4 profile bases
#                             resolve against r5.core during snapshot generation.
#                             Removing it kills the snapshot-tree view.
EOF
)"

# Resolve the project, union compile_set + context_closure, then append r5.core.
STEP_JSON="$("$BIN" resolve --cache "$CACHE" --project "$IG_DIR")"
LABELS="$(printf '%s' "$STEP_JSON" | python3 "$HERE/_union-closure.py")"

# The snapshot-engine special: r5.core, pinned to the cached major.
R5_LABEL="hl7.fhir.r5.core#5.0.0"
if ! grep -q "^hl7.fhir.r5.core#" <<<"$LABELS"; then
  LABELS="$LABELS
$R5_LABEL"
fi

GENERATED="$HEADER
$LABELS"

if [ "${CHECK:-0}" = "1" ]; then
  if diff <(printf '%s\n' "$GENERATED") "$LIST" >/dev/null 2>&1; then
    echo "[gen-packages-list] DRIFT GATE PASS — packages.list matches the resolver."
    exit 0
  fi
  echo "[gen-packages-list] DRIFT GATE FAIL — packages.list is stale. Diff (committed vs generated):"
  diff "$LIST" <(printf '%s\n' "$GENERATED") || true
  echo "Regenerate: FHIR_CACHE=$CACHE scripts/gen-packages-list.sh"
  exit 1
fi

printf '%s\n' "$GENERATED" > "$LIST"
echo "[gen-packages-list] wrote $LIST ($(grep -c '^[^#]' "$LIST") packages)"
