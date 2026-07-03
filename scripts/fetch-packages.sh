#!/usr/bin/env bash
# Populate a FHIR package cache by downloading the demo closure from the FHIR
# package registry (packages.fhir.org, fallback packages2.fhir.org). Used by CI
# before scripts/bundle-packages.sh; safe to run locally too.
#
#   FHIR_CACHE=<dir> scripts/fetch-packages.sh
#
# Layout produced (what `rust_sushi bundle` + `rust_sushi build` read):
#   $FHIR_CACHE/<id>#<ver>/package/**   (top-level package files; the engine
#   derives its .derived-index.json sidecar itself when absent)
#
# Idempotent: a package with an existing package/package.json is skipped, so an
# actions/cache restore of $FHIR_CACHE makes this a no-op.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${FHIR_CACHE:?set FHIR_CACHE to the cache dir to populate}"
LIST="$HERE/packages.list"

REGISTRIES=(
  "https://packages.fhir.org"
  "https://packages2.fhir.org/packages"
)

mkdir -p "$CACHE"

while IFS= read -r line; do
  label="${line%%[[:space:]]*}"
  case "$label" in ''|'#'*) continue ;; esac
  id="${label%%#*}"; ver="${label##*#}"
  dest="$CACHE/$label"
  if [ -f "$dest/package/package.json" ]; then
    echo "[fetch-packages] $label already cached — skip"
    continue
  fi
  tmp="$(mktemp)"
  ok=0
  for reg in "${REGISTRIES[@]}"; do
    url="$reg/$id/$ver"
    echo "[fetch-packages] GET $url"
    if curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then ok=1; break; fi
    echo "[fetch-packages]   failed from $reg — trying next"
  done
  [ "$ok" = 1 ] || { echo "FATAL: could not download $label from any registry"; rm -f "$tmp"; exit 2; }
  rm -rf "$dest"; mkdir -p "$dest"
  # Registry tarballs root their files under package/ — extract as-is.
  tar -xzf "$tmp" -C "$dest"
  rm -f "$tmp"
  [ -f "$dest/package/package.json" ] || { echo "FATAL: $label tarball had no package/package.json"; exit 2; }
  echo "[fetch-packages] $label -> $(du -sh "$dest" | cut -f1)"
done < "$LIST"

echo "[fetch-packages] cache ready at $CACHE"
