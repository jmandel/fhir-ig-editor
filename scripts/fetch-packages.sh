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

package_is_complete() {
  local label="$1" dest="$2"
  [ -f "$dest/package/package.json" ] || return 1
  case "${label%%#*}" in
    *.core)
      local asset
      for asset in fhir.css icon_element.gif tbl_spacer.png; do
        [ -f "$dest/other/$asset" ] || [ -f "$dest/package/other/$asset" ] || return 1
      done
      ;;
  esac
}

while IFS= read -r line; do
  label="${line%%[[:space:]]*}"
  case "$label" in ''|'#'*) continue ;; esac
  id="${label%%#*}"; ver="${label##*#}"
  dest="$CACHE/$label"
  if package_is_complete "$label" "$dest"; then
    echo "[fetch-packages] $label already cached — skip"
    continue
  fi
  if [ -e "$dest" ]; then
    echo "[fetch-packages] $label cache entry is incomplete — reacquire"
  fi
  tmp="$(mktemp)"
  ok=0
  for reg in "${REGISTRIES[@]}"; do
    url="$reg/$id/$ver"
    echo "[fetch-packages] GET $url"
    if curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
      rm -rf "$dest"; mkdir -p "$dest"
      if tar -xzf "$tmp" -C "$dest" && package_is_complete "$label" "$dest"; then
        ok=1
        break
      fi
      rm -rf "$dest"
      echo "[fetch-packages]   incomplete package from $reg — trying next"
    else
      echo "[fetch-packages]   failed from $reg — trying next"
    fi
  done
  [ "$ok" = 1 ] || { echo "FATAL: could not download $label from any registry"; rm -f "$tmp"; exit 2; }
  rm -f "$tmp"
  echo "[fetch-packages] $label -> $(du -sh "$dest" | cut -f1)"
done < "$LIST"

echo "[fetch-packages] cache ready at $CACHE"
