#!/usr/bin/env bash
# Walk a template's `base` chain the SAME way the engine loader's walk_base_chain
# does (#40): read each package's package.json `base` + `dependencies[base]`,
# follow to the root (no `base`). Emits one `id#version` per line, LEAF→ROOT.
#
#   scripts/gen-template-chain.sh hl7.fhir.template#1.0.0
#     -> hl7.fhir.template#1.0.0
#        hl7.base.template#1.0.0
#        fhir.base.template#1.0.0
#
# This is a build-time pin/drift helper for the baked default template packages.
# Runtime template traversal belongs to Rust Publisher `prepare`; the host only
# acquires the exact coordinate reported by its private resolution handshake.
# Reads from the flat FHIR cache (FHIR_CACHE, populated by fetch-packages.sh).
set -euo pipefail

COORD="${1:?usage: gen-template-chain.sh <id#ver>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
CACHE="${FHIR_CACHE:-$REPO/vendor/sushi-rs/temp/fhir-home/.fhir/packages}"

cur="$COORD"
declare -A visited=()
while :; do
  id="${cur%%#*}"
  pj="$CACHE/$cur/package/package.json"
  [ -f "$pj" ] || { echo "gen-template-chain: $cur not in cache ($pj)" >&2; exit 2; }
  [ -n "${visited[$id]:-}" ] && { echo "gen-template-chain: recurse at $id" >&2; exit 2; }
  visited[$id]=1
  echo "$cur"
  # base + dependencies[base]; stop at the root (no base).
  read -r base ver < <(python3 - "$pj" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
base=d.get("base")
if not base:
    print("")
else:
    ver=(d.get("dependencies") or {}).get(base,"")
    print(base, ver)
PY
)
  [ -z "$base" ] && break
  [ -z "$ver" ] && { echo "gen-template-chain: $cur declares base '$base' with no version" >&2; exit 2; }
  cur="$base#$ver"
done
