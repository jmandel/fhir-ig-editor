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
#   hl7.fhir.template       — STOCK TEMPLATE CHAIN (#40 live template loader): the
#   hl7.base.template         default template + its `base` chain. NOT sushi-config
#   fhir.base.template        deps — the template loader's walk_base_chain decides
#                             the chain inside Publisher `prepare`; the host only
#                             acquires each exact missing coordinate and retries.
#                             Bundling lets that acquisition use same-origin bytes.
#                             Pins are checked at build time by gen-template-chain.sh.
#   hl7.terminology.r4#7.1.0  — CLOSURE-COMPLETENESS (bundle-closure): the EXACT dep
#   hl7.fhir.uv.extensions.r4#5.2.0  versions tools.r4#1.1.2's package.json DECLARES.
#                             The compile loads 7.2.0/5.3.0 (auto-dep `latest`); but
#                             the TRANSITIVE context_closure over a CONFIGURED
#                             tools.r4 dep demands these EXACT pins. Registry-denied
#                             live envs block without them (baked-seed E2E gate).
#                             `loadPhase:on-demand` — no project compile needs them; only a
#                             user IG that configures tools.r4 as a dep does. Derived,
#                             not hand-listed: appended from the closure's own
#                             package.json declared exact-version deps.
EOF
)"

# Resolve the project, union compile_set + context_closure, then append r5.core.
# Resolve through Cargo from the pinned checkout. A target binary can survive a
# submodule update; executing it by path allowed a schema-2 binary to make a
# local drift check disagree with schema-3 CI. `cargo run` validates the binary
# against these sources and is an incremental no-op after CI's native build.
STEP_JSON="$(cd "$ENGINE" && cargo run --quiet --release -p rust_sushi -- \
  resolve --cache "$CACHE" --project "$IG_DIR")"
LABELS="$(printf '%s' "$STEP_JSON" | python3 "$HERE/_union-closure.py")"

# The snapshot-engine special: r5.core, pinned to the cached major.
R5_LABEL="hl7.fhir.r5.core#5.0.0"
if ! grep -q "^hl7.fhir.r5.core#" <<<"$LABELS"; then
  LABELS="$LABELS
$R5_LABEL"
fi

# The STOCK TEMPLATE CHAIN (#40 live template loader): the default template
# `hl7.fhir.template#1.0.0` and its `base` chain. These are NOT sushi-config deps
# (resolve_project doesn't surface them) — the template loader's walk_base_chain
# decides the chain, and the editor fetches it on the SAME resolve→fetch→mount
# path as regular packages and retries `prepare`; no host template-tree assembly
# occurs. Bundling here lets acquisition use same-origin bytes (registry is the
# fallback). The pinned default chain is checked by scripts/gen-template-chain.sh
# (fig): hl7.fhir.template#1.0.0 → hl7.base.template#1.0.0 → fhir.base.template#1.0.0.
TEMPLATE_CHAIN="$("$HERE/gen-template-chain.sh" "hl7.fhir.template#1.0.0" 2>/dev/null || printf 'hl7.fhir.template#1.0.0\nhl7.base.template#1.0.0\nfhir.base.template#1.0.0')"
while IFS= read -r tl; do
  [ -z "$tl" ] && continue
  grep -q "^${tl%%#*}#" <<<"$LABELS" || LABELS="$LABELS
$tl"
done <<<"$TEMPLATE_CHAIN"

# CLOSURE-COMPLETENESS: transitively-declared EXACT dep versions (bundle-closure).
# The compile load is NON-TRANSITIVE (stock SUSHI parity): auto-deps resolve at
# `latest` → highest cached (terminology.r4 → 7.2.0, extensions.r4 → 5.3.0), and
# cycle declares no `dependencies`, so its resolver closure never walks a package's
# package.json. But the engine's TRANSITIVE context_closure (resolve.rs, ported
# from package-deps.cjs) DOES walk a CONFIGURED dep's package.json and demands its
# declared deps at their EXACT pinned version. Any user IG (or the baked-seed E2E
# probe) that configures e.g. `hl7.fhir.uv.tools.r4: latest` therefore needs
# tools.r4#1.1.2's declared `hl7.terminology.r4#7.1.0` AND
# `hl7.fhir.uv.extensions.r4#5.2.0` — DIFFERENT versions than the `latest`-picked
# 7.2.0/5.3.0 the compile uses. Both versions can be mounted at once (the engine's
# by_name index is multi-version). Without these, a registry-denied live env blocks
# (the failing baked-seed gate). We DERIVE them from the closure's own package.json
# files: every declared `id#exactVersion` not already present is appended.
scan_labels() { printf '%s\n' "$LABELS"; }
declare -A HAVE_ID_VER=()
while IFS= read -r l; do [ -z "$l" ] && continue; HAVE_ID_VER["$l"]=1; done < <(scan_labels)
EXTRA=""
while IFS= read -r l; do
  [ -z "$l" ] && continue
  pj="$CACHE/$l/package/package.json"
  [ -f "$pj" ] || continue
  # Emit each declared dependency as id#version, EXACT versions only (skip
  # latest/current/dev/x/* — those the resolver picks, they are not extra bundles).
  while IFS= read -r dep; do
    [ -z "$dep" ] && continue
    dv="${dep##*#}"
    case "$dv" in latest|current|dev|*x*|*'*'*) continue ;; esac
    if [ -z "${HAVE_ID_VER[$dep]:-}" ]; then
      grep -q "^$dep$" <<<"$EXTRA" || EXTRA="$EXTRA$dep
"
    fi
  done < <(python3 -c "import json,sys; d=json.load(open('$pj')); [print(f'{k}#{v}') for k,v in (d.get('dependencies') or {}).items()]" 2>/dev/null)
done < <(scan_labels)
if [ -n "$EXTRA" ]; then
  LABELS="$LABELS
$(printf '%s' "$EXTRA" | sed '/^$/d')"
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
