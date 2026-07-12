# fhir-ig-editor

`fhir-ig-editor` is a fully static, in-browser FHIR Implementation Guide editor
and site preview. It edits FSH and IG source, compiles through the Rust/WASM
engine, and renders navigable Publisher-style sites without an application
server. The same static artifact runs locally and on GitHub Pages.

Live site: <https://joshuamandel.com/fhir-ig-editor/>

## What works

- Two direct entry paths—edit a tiny FSH guide or explore a published guide—
  followed by one focused Author, Explore, or Site preview surface. An exact
  renderer/compiler-owned artifact trail connects an authored declaration to
  its compiled FHIR definition and published page without filename guessing.
- Monaco editing for multi-file FSH and IG source, with exact diagnostic spans.
- In-browser FSH compilation, snapshot generation, resource JSON/differential/
  snapshot views, and tier-1 local ValueSet expansion.
- Runtime package resolution and acquisition, plus a pinned same-origin catalog
  of real IGs.
- Two site generators over the same compiled project revision:
  - the external Cycle React/LiquidJS renderer over a verified closed
    `SiteBuild`; and
  - the native Rust Publisher-template renderer, including arbitrary resolvable
    package-template versions and typed on-demand fragment generation.
- One preview URL scheme for the embedded iframe and independent tabs, with
  normal links, reload, back/forward, scoped hot reload, and cached fallback.
  A hard reload can show the prior digest-verified page immediately while the
  current exact build runs; the UI labels it as previous until current
  publication succeeds.
- Complete, provenanced Publisher-owned runtime outputs. The browser gate checks
  missing assets, decoded images, required runtime globals, compatibility-shim
  activation, and uncaught exceptions.

The editor vendors exact engine and Cycle commits as Git submodules. The WASM
module carries the engine commit; startup compares it with the commit expected
by the app bundle and rejects a stale mix.

## Architecture

The complete cross-repository model and deletion ledger live in
[`ARCHITECTURE.md`](ARCHITECTURE.md). It is the only normative architecture
document. In brief:

```text
PreparedGuide -> SiteBuild -> SiteOutput
                      |
                 ContentStore
```

The site-generation host surface is `prepare`, `outputs`, `render`, and
`finalize`. Cycle consumes one callback-free `cycle-site/v2` build and renders
with shared LiquidJS/React. Publisher templates render with Rust Liquid; typed
fragment discovery is resolved internally by Rust and never becomes an editor
callback API. Assets are ordinary outputs, and final publication is one verified
`SiteOutput`.

Package transport remains compact `PreparedPackage` v2: authenticated 1 MiB
chunks, transactional one-artifact-at-a-time warm mount, and bounded lazy member
inflation. Cache records and worker/preview handles are private execution
details, not additional build representations.

## Repository shape

```text
app/                     React/Vite application
  src/editor/            Monaco and file tree
  src/vfs/               OPFS/in-memory project and package persistence
  src/worker/            typed worker protocol and engine host
  src/build/             project/build identity and coordination
  src/site/              four-operation site contract and catalog invariants
  src/preview/           ContentStore-backed Service Worker publication
scripts/                 WASM, package, catalog, renderer-package, and gate recipes
demo/tiny-guide/         self-referential first-run FSH + Publisher guide
expansions/              deliberately refreshed terminology warm-start data
vendor/sushi-rs/         pinned engine submodule
vendor/cycle/            pinned external-builder fixture and renderer submodule
.github/workflows/       Pages build, certification, and deployment
```

Generated data under `app/public/` is assembled locally/CI and is not a second
source of truth.

## Develop

Prerequisites: Bun, Rust with `wasm32-unknown-unknown`, a version-matched
`wasm-bindgen-cli`, `wasm-opt` 116 or newer, and a FHIR package cache.

```sh
git submodule update --init --recursive

export FHIR_CACHE="$PWD/.fhir-cache"
bash scripts/fetch-packages.sh
bash scripts/prepare-data.sh

cd app
bun install --frozen-lockfile
bun run dev
```

`scripts/prepare-data.sh` is the one-shot local recipe: it builds WASM and then
calls `scripts/assemble-static-data.sh`. Pages CI calls that same assembly script
after its separately gated WASM build.

Useful tool overrides are documented in script headers and
[`PUBLISH.md`](PUBLISH.md). In particular, `SUSHI_RS_DIR` can point
`scripts/build-wasm.sh` at an engine working tree during dependency development.

## Verify

Fast app and shared-renderer checks:

```sh
cd app
bun test tests
bun run build

cd ../vendor/cycle
bun install --frozen-lockfile
bun run typecheck:renderer
bun test
```

Certify the exact Vite artifact under the deployment subpath with a fresh
Chromium profile:

```sh
cd ../..
BASE_PATH=/fhir-ig-editor/ bash scripts/run-browser-gates.sh app/dist
```

Measure US Core cold start, persistent-OPFS hard reload (including prior-page
and current-ready milestones), and same-worker reopen:

```sh
BASE_PATH=/fhir-ig-editor/ \
  bash scripts/run-uscore-benchmark.sh app/dist > uscore-benchmark.json
```

The lower-level CDP harness can target an already running browser:

```sh
node scripts/verify-e2e.mjs http://127.0.0.1:4173/fhir-ig-editor/
```

The full Pages workflow additionally runs engine contract tests, native/WASM
Cycle compile parity, package-list drift, terminology consistency, complete
package/catalog assembly, and artifact-presence checks.

## Deploy and dependency landing

A push to `main` runs [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
and deploys only after its gates pass. Cross-repository work lands in dependency
order:

1. Commit/push the engine.
2. Commit/push Cycle when its renderer changed.
3. Update the two submodule pins here.
4. Rebuild WASM from the pinned engine commit so the stamp is exact.
5. Run the app, Cycle, engine, and Pages-subpath Chromium gates.
6. Commit/push editor `main`.

See [`PUBLISH.md`](PUBLISH.md) for the concise release runbook and
[`ARCHITECTURE.md`](ARCHITECTURE.md) for the domain and host contract.
Current fidelity boundaries, including external template preprocessing, are
listed explicitly in the release runbook.
