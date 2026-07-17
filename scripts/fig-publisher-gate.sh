#!/usr/bin/env bash
# Exercise the successful native Publisher lifecycle through four independent
# Fig processes. This is package-backed integration evidence for the documented
# host API; hermetic Rust fixtures cover the lower-level executor contracts.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIG_BIN="${FIG_BIN:-$REPO/vendor/sushi-rs/target/release/fig}"
FHIR_CACHE="${FHIR_CACHE:?set FHIR_CACHE to an explicit materialized package cache}"
IG_DIR="${IG_DIR:-$REPO/demo/tiny-guide}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fig-publisher-gate.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

test -x "$FIG_BIN"
test -d "$FHIR_CACHE"
test -d "$IG_DIR"

SOURCE_DATE_EPOCH=1783555200 "$FIG_BIN" prepare "$IG_DIR" \
  --target publisher-site/v1 \
  --template hl7.fhir.template#1.0.0 \
  --cache "$FHIR_CACHE" \
  --out "$WORK/build" \
  --build-date 1783555200 \
  --json >"$WORK/prepare.json"

"$FIG_BIN" outputs "$WORK/build" --json >"$WORK/outputs.json"
"$FIG_BIN" render "$WORK/build" en/index.html \
  --out "$WORK/index.html" --json >"$WORK/render.json"
"$FIG_BIN" finalize "$WORK/build" \
  --out "$WORK/site" --json >"$WORK/finalize.json"

python3 - "$WORK" <<'PY'
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])

def result(name):
    envelope = json.loads((root / f"{name}.json").read_text())
    assert envelope.get("ok") is True, (name, envelope)
    assert envelope.get("apiVersion") == 1, (name, envelope)
    return envelope["result"]

prepared = result("prepare")
catalog = result("outputs")
rendered = result("render")
finalized = result("finalize")
build_id = prepared["buildId"]
assert build_id.startswith("sb1-sha256:")
assert catalog["buildId"] == finalized["inputBuildId"] == build_id
assert any(item["path"] == "en/index.html" for item in catalog["outputs"])
assert any(item["path"] == "en/sql-table.html" for item in catalog["outputs"])
assert any(item["path"] == "en/sql-liquid.html" for item in catalog["outputs"])

standalone = (root / "index.html").read_bytes()
published = (root / "site/en/index.html").read_bytes()
assert standalone == published
assert len(standalone) > 500
assert hashlib.sha256(standalone).hexdigest() == rendered["sha256"]
index_page = published.decode()
assert '<a data-toggle="dropdown" href="#" class="dropdown-toggle">Live queries' in index_page
assert '<a href="sql-table.html">SQL table</a>' in index_page
assert '<a href="sql-liquid.html">SQL + Liquid</a>' in index_page
assert index_page.count('href="sql-table.html"') >= 2
assert index_page.count('href="sql-liquid.html"') >= 2

receipt = json.loads((root / "site/site-output.json").read_text())
assert receipt["schemaVersion"] == "site-output/v1"
assert receipt["inputBuildId"] == build_id
assert receipt["outputId"] == finalized["outputId"]
assert receipt["outputId"].startswith("so1-sha256:")
entry = next(item for item in receipt["files"] if item["path"] == "en/index.html")
assert entry["content"] == rendered
assert len(receipt["files"]) == len(finalized["files"])

table_page = (root / "site/en/sql-table.html").read_text()
table_result = table_page.partition('<div id="editor-stages-sql-table">')[2].partition("</div>")[0]
assert table_result.count("<tr>") == 4, table_result
assert table_result.count("<td") == 12, table_result
assert (
    "<tr><td>author</td><td>Author</td><td>Edit the FSH source that defines the guide.</td></tr>"
    "<tr><td>explore</td><td>Explore</td><td>Inspect the compiled FHIR definitions.</td></tr>"
    "<tr><td>preview</td><td>Site preview</td><td>Read the pages generated from those definitions.</td></tr>"
) in table_result
assert "{%" not in table_page and "{{" not in table_page

liquid_page = (root / "site/en/sql-liquid.html").read_text()
liquid_result = liquid_page.partition('<ol id="editor-stages-from-sql">')[2].partition("</ol>")[0]
assert liquid_result.count("<li>") == 3, liquid_result
assert (
    "<li><strong>Author</strong> (<code>author</code>) — Edit the FSH source that defines the guide.</li>"
) in liquid_result
assert (
    "<li><strong>Explore</strong> (<code>explore</code>) — Inspect the compiled FHIR definitions.</li>"
) in liquid_result
assert (
    "<li><strong>Site preview</strong> (<code>preview</code>) — Read the pages generated from those definitions.</li>"
) in liquid_result
assert "3 editor views" in liquid_page
assert "{%" not in liquid_page and "{{" not in liquid_page
print(
    "FIG PUBLISHER GATE: PASS",
    build_id,
    receipt["outputId"],
    f"{len(receipt['files'])} files",
)
PY
