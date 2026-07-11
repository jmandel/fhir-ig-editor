#!/usr/bin/env bash
# Build the cycle IG's package closure into app/public/data/bundles/ as prebuilt
# `.tgz` bundles + a manifest.json (gitignored — regenerated here / in CI).
#
# The closure comes from scripts/packages.list (single source of truth, shared
# with fetch-packages.sh — see that file for WHY each package, incl. r5.core).
# Every package is normalized into one complete `package/` transport root. This
# retains Publisher runtime inputs such as core `other/` assets and template
# layouts as well as ordinary FHIR resources.
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "FATAL: sha256sum or shasum is required" >&2
    return 2
  fi
}

LABELS=()
while IFS= read -r line; do
  l="${line%%[[:space:]]*}"
  case "$l" in ''|'#'*) continue ;; esac
  LABELS+=("$l")
done < "$HERE/packages.list"

rm -rf "$OUT"; mkdir -p "$OUT"

echo "[bundle-packages] bundling ${#LABELS[@]} complete packages from $CACHE"
for l in "${LABELS[@]}"; do
  src="$CACHE/$l"
  [ -d "$src" ] || { echo "FATAL: package $l not in cache"; exit 2; }
  stage="$(mktemp -d)"; mkdir -p "$stage/package"
  # Copy the whole native package tree under the transport root. Derived indexes
  # are rebuilt/authenticated by Rust and are never transport authority.
  ( cd "$src" && tar cf - --exclude='.index.json' --exclude='.index.db' --exclude='.derived-index.json' . ) | ( cd "$stage/package" && tar xf - )
  # Native caches store FHIR resources/metadata one level below the package
  # root. Merge that directory into the normalized root while retaining siblings
  # such as `other/`, `openapi/`, template layouts, includes, and config.json.
  if [ -d "$stage/package/package" ]; then
    mv "$stage/package/package" "$stage/nested-package"
    ( cd "$stage/nested-package" && tar cf - . ) | ( cd "$stage/package" && tar xf - )
    rm -rf "$stage/nested-package"
  fi
  ( cd "$stage" && tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -czf "$OUT/$l.tgz" package )
  rm -rf "$stage"
  echo "[bundle-packages] complete $l -> $(du -h "$OUT/$l.tgz" | cut -f1)"
done

# Emit manifest.json (labels + tgz paths + compressed SHA-256 + sizes + an
# explicit `loadPhase`) — what EngineClient.init fetches. The browser verifies the
# compressed bytes before inflation and keys its OPFS cache by this digest.
# `compile` packages are candidates selected by the project's Rust resolver;
# they are not globally eager. `snapshot` is the R5 walk-engine special.
# `on-demand` covers template-chain and supersession-shadowed packages.
#
# The rule is derived, not hand-listed. A non-template bundle is on-demand iff:
#  (1) it is an R5 core AND the IG is not itself R5 (removing it cannot change
#      compile output — r5.core is pulled only by SNAPSHOT generation); OR
#  (2) it is a SUPERSESSION-SHADOWED lower version: a package id for which a
#      strictly HIGHER version of the SAME id is also in the closure (bundle-closure).
#      The cold-start compile loads auto-deps at `latest` → the HIGHER version
#      (terminology.r4 7.2.0, extensions.r4 5.3.0); the shadowed lower pins
#      (7.1.0 / 5.2.0) are needed ONLY by the transitive context_closure of a user
#      IG that CONFIGURES the declaring package as a dep — never by cold start.
# We detect "IG is R5" from the cycle config's fhirVersion.
IG_FHIR_VERSION="$(grep -E '^fhirVersion:' "$REPO/vendor/cycle/sushi-config.yaml" 2>/dev/null | head -1 | sed 's/[^0-9.]//g')"

# Highest version seen per id across the closure (numeric-dotted compare, enough
# for the terminology/extensions pins here — same rule the engine's `latest` uses).
declare -A MAX_VER=()
ver_gt() { # ver_gt A B  → 0 (true) iff A > B
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]
}
for l in "${LABELS[@]}"; do
  id="${l%%#*}"; v="${l##*#}"
  cur="${MAX_VER[$id]:-}"
  if [ -z "$cur" ] || ver_gt "$v" "$cur"; then MAX_VER["$id"]="$v"; fi
done

is_on_demand() {
  local label="$1"
  local id="${label%%#*}" v="${label##*#}"
  case "$label" in
    hl7.fhir.r5.core#*) case "$IG_FHIR_VERSION" in 5.*) return 1 ;; *) return 0 ;; esac ;;
  esac
  # Supersession-shadowed lower version → on-demand.
  local top="${MAX_VER[$id]:-$v}"
  if [ "$top" != "$v" ] && ver_gt "$top" "$v"; then return 0; fi
  return 1
}

load_phase() {
  local label="$1"
  case "$label" in
    hl7.fhir.r5.core#*) printf 'snapshot'; return ;;
    *.template#*) printf 'on-demand'; return ;;
  esac
  if is_on_demand "$label"; then printf 'on-demand'; else printf 'compile'; fi
}

{
  echo '{'
  echo '  "bundles": ['
  for i in "${!LABELS[@]}"; do
    l="${LABELS[$i]}"
    comma=","; [ "$i" -eq $((${#LABELS[@]} - 1)) ] && comma=""
    tgz_bytes=$(stat -c%s "$OUT/$l.tgz" 2>/dev/null || echo 0)
    tgz_sha256=$(sha256_file "$OUT/$l.tgz")
    phase="$(load_phase "$l")"
    printf '    { "label": "%s", "tgz": "%s.tgz", "sha256": "%s", "bytes": %s, "loadPhase": "%s" }%s\n' \
      "$l" "$l" "$tgz_sha256" "$tgz_bytes" "$phase" "$comma"
  done
  echo '  ]'
  echo '}'
} > "$OUT/manifest.json"

echo "[bundle-packages] done: $(du -sh "$OUT" | cut -f1) at app/public/data/bundles/"
