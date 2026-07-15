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

The shared target-neutral Rust executor is `site_engine::SiteEngine`. The WASM
crate is a transport facade over that executor, not another preparation layer.
The browser's `WorkspaceRepository -> Workspace -> ProjectRevision` path keeps
one working copy per guide and captures one immutable request for `prepare`.

Package transport remains compact `PreparedPackage` v3: authenticated 1 MiB
chunks, a source-metadata-bound cache key, transactional one-artifact-at-a-time
warm mount, and bounded lazy member inflation. `SiteBuild` v2 package locks root
that exact deterministic carrier; they do not assert a second inflated package
payload. Cache records and worker/preview handles are private execution details,
not additional build representations.

Incremental preparation is likewise private and fail-closed. The engine retains
at most current+previous successful generations, revalidates per-resource
snapshot read manifests, and may share an exact-carrier-bound immutable Publisher
package catalog. It always rebuilds current own-resource state, render state,
catalog, and page outputs. Failed, unknown, or over-budget candidates fall back
to the canonical build and cannot promote partial state. The public four
operations and `PreparedGuide -> SiteBuild -> SiteOutput` handoff do not change.

## Repository shape

```text
app/                     React/Vite application
  src/editor/            Monaco and file tree
  src/vfs/               project-scoped Workspaces and package persistence
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

Measure any catalog project's exact Service-Worker-acknowledged cold build,
persistent-OPFS hard reload (including prior-page and current-ready milestones),
and same-worker reopen. The receipt includes the aligned Window/Worker/Rust
timeline, transferred bytes, cache state, and observed memory peaks. Add
`BENCH_PROFILE_EDIT=1` for the optional US Core Patient JSON edit scenario, with
the explicit debounce separated from Worker processing:

```sh
BASE_PATH=/fhir-ig-editor/ \
  BENCH_PROJECT=uscore bash scripts/run-project-benchmark.sh app/dist > uscore-benchmark.json

BASE_PATH=/fhir-ig-editor/ BENCH_PROFILE_EDIT=1 \
  BENCH_PROJECT=uscore bash scripts/run-project-benchmark.sh app/dist > uscore-profile-edit.json
```

Run the repeated general-purpose matrix (Tiny, IPS, US Core, and mCODE; desktop
and a whole-Chromium 25%-CPU mobile-class mode) and retain every raw receipt:

```sh
BASE_PATH=/fhir-ig-editor/ \
  BENCH_OUTPUT_DIR=/tmp/fhir-ig-performance \
  node scripts/benchmark-matrix.mjs app/dist > /tmp/fhir-ig-performance.json
```

The process quota is verified through a transient user systemd scope so it also
constrains the engine Worker; CDP's CPU slowdown is page-target-only. Use the
matrix environment variables shown by `node scripts/benchmark-matrix.mjs --help`
to select projects, modes, repeats, network conditions, and ports.

`scripts/benchmark-identity.mjs` is the single identity implementation used by
both the matrix and each isolated project runner. It hashes the complete frozen
artifact in one global bytewise path order and binds receipts to the benchmark
recipe. Non-regular entries fail closed, and each child hashes the frozen copy
Chromium actually serves so the matrix can prove it matches the source build.
Any artifact or recipe disagreement fails before aggregation.

Network profiles are proven per request with the exact rule ID returned by
Chromium. They cover page requests and subresource/package fetches issued by
dedicated Workers. Chromium 148 does not expose an applied rule ID for a
dedicated Worker's main-script load, so the receipt lists those entry scripts
separately as `unprofiledWorkerEntries`; it never infers coverage from elapsed
time or successful Worker attachment.

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
