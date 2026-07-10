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

BIN="$ENGINE/target/release/rust_sushi"
if [ ! -x "$BIN" ]; then
  echo "[bundle-packages] building rust_sushi --release"
  ( cd "$ENGINE" && cargo build --release -p rust_sushi >/dev/null )
fi

# Split FHIR-resource packages from TEMPLATE packages (#40). `rust_sushi bundle`
# reads only `<label>/package/**` (the FHIR-resource convention) — correct for
# resource packages, but a TEMPLATE package's content (includes/, layouts/, liquid/,
# config.json) lives at the Publisher-NATIVE top level (`<label>/**`, alongside the
# `package/` metadata dir), so `rust_sushi bundle` would strip it (a 700-byte
# index-only tgz). Detect template packages by a top-level content marker and
# repack them so ALL content sits under `package/` in the tgz: the editor's untar
# strips `package/` and BundleSource re-adds it, landing content at
# `<label>/package/**` — exactly where TemplatePaths.content_root's fallback finds
# it (top-level absent → `package/`), so mountTemplate reads a complete tree.
FHIR_LABELS=(); TEMPLATE_LABELS=()
for l in "${LABELS[@]}"; do
  d="$CACHE/$l"
  if [ -d "$d/includes" ] || [ -f "$d/config.json" ] || [ -d "$d/layouts" ] || [ -d "$d/liquid" ]; then
    TEMPLATE_LABELS+=("$l")
  else
    FHIR_LABELS+=("$l")
  fi
done

echo "[bundle-packages] bundling ${#FHIR_LABELS[@]} FHIR packages from $CACHE"
"$BIN" bundle --cache "$CACHE" --out "$OUT" "${FHIR_LABELS[@]}" >/dev/null

# Repack each template package: everything under `package/` (excluding the engine
# index sidecars the loader ignores anyway). The result mounts as a full template
# tree; the fig-materialized warm-start artifact is the fast path, this baked
# bundle the LIVE (resolve→fetch→mount→mountTemplate) fallback source (a).
for l in "${TEMPLATE_LABELS[@]}"; do
  src="$CACHE/$l"
  [ -d "$src" ] || { echo "FATAL: template package $l not in cache"; exit 2; }
  stage="$(mktemp -d)"; mkdir -p "$stage/package"
  # Copy the whole publisher-native tree under package/, dropping .index.* sidecars.
  ( cd "$src" && tar cf - --exclude='.index.json' --exclude='.index.db' --exclude='.derived-index.json' . ) | ( cd "$stage/package" && tar xf - )
  # The tarball's package.json already lives at <label>/package/package.json in the
  # cache; the copy above nested it at package/package/package.json — flatten it.
  if [ -f "$stage/package/package/package.json" ]; then
    cp "$stage/package/package/package.json" "$stage/package/package.json"
    rm -rf "$stage/package/package"
  fi
  ( cd "$stage" && tar czf "$OUT/$l.tgz" package )
  rm -rf "$stage"
  echo "[bundle-packages] template $l repacked -> $(du -h "$OUT/$l.tgz" | cut -f1)"
done

# Emit manifest.json (labels + tgz paths + compressed SHA-256 + sizes + a
# `defer` flag) — what EngineClient.init fetches. The browser verifies the
# compressed bytes before inflation and keys its OPFS cache by this digest.
# `defer:true` marks a bundle the FIRST COMPILE does
# not need, so cold start can skip fetching it until the engine first needs it
# (spec §1 lazy loading). Today that is ONLY the R5 core: cycle is an R4 IG, so
# the compile fishes R4 bases; r5.core is pulled solely by SNAPSHOT generation
# (the walk engine is R5-internal — see scripts/packages.list). Deferring its
# ~6.8 MB tgz off the cold-start critical path is the bulk of the speedup, and it
# is fetched + mounted lazily on the first snapshot / site-preview build.
#
# The rule is derived, not hand-listed. A bundle is deferrable iff EITHER:
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

is_deferrable() {
  local label="$1"
  local id="${label%%#*}" v="${label##*#}"
  case "$label" in
    hl7.fhir.r5.core#*) case "$IG_FHIR_VERSION" in 5.*) return 1 ;; *) return 0 ;; esac ;;
  esac
  # Supersession-shadowed lower version → deferrable.
  local top="${MAX_VER[$id]:-$v}"
  if [ "$top" != "$v" ] && ver_gt "$top" "$v"; then return 0; fi
  return 1
}

{
  echo '{'
  echo '  "bundles": ['
  for i in "${!LABELS[@]}"; do
    l="${LABELS[$i]}"
    comma=","; [ "$i" -eq $((${#LABELS[@]} - 1)) ] && comma=""
    tgz_bytes=$(stat -c%s "$OUT/$l.tgz" 2>/dev/null || echo 0)
    tgz_sha256=$(sha256_file "$OUT/$l.tgz")
    defer=false; is_deferrable "$l" && defer=true
    printf '    { "label": "%s", "tgz": "%s.tgz", "sha256": "%s", "bytes": %s, "defer": %s }%s\n' \
      "$l" "$l" "$tgz_sha256" "$tgz_bytes" "$defer" "$comma"
  done
  echo '  ]'
  echo '}'
} > "$OUT/manifest.json"

echo "[bundle-packages] done: $(du -sh "$OUT" | cut -f1) at app/public/data/bundles/"
