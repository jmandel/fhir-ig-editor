# fhir-ig-editor

`fhir-ig-editor` is a fully static, in-browser FHIR Implementation Guide editor
and site preview. It edits FSH and IG source, compiles through the Rust/WASM
engine, and renders navigable Publisher-style sites without an application
server. The same static artifact runs locally and on GitHub Pages.

Live site: <https://joshuamandel.com/fhir-ig-editor/>

## What works

- Monaco editing for multi-file FSH and IG source, with exact diagnostic spans.
- In-browser FSH compilation, snapshot generation, resource JSON/differential/
  snapshot views, and tier-1 local ValueSet expansion.
- Runtime package resolution and acquisition, plus a pinned same-origin catalog
  of real IGs.
- Two site generators over the same compiled project revision:
  - the external Cycle React/LiquidJS renderer over a verified closed
    `SiteBuild`; and
  - the native Rust Publisher-template renderer, including arbitrary resolvable
    template versions and typed on-demand fragment generation.
- One preview URL scheme for the embedded iframe and independent tabs, with
  normal links, reload, back/forward, scoped hot reload, and cached fallback.
- A complete, provenanced Publisher runtime asset pack. The browser gate checks
  missing assets, decoded images, required runtime globals, compatibility-shim
  activation, and uncaught exceptions.

The editor vendors exact engine and Cycle commits as Git submodules. The WASM
module carries the engine commit; startup compares it with the commit expected
by the app bundle and rejects a stale mix.

## Runtime flow

```text
ProjectStore -> immutable ProjectBuildSnapshot
     -> LatestTaskQueue (serialized, latest-wins publication)
     -> EngineClient -> Web Worker -> isolated WASM Session
     -> compileProject (one exact source revision)
          |                              |
          v                              v
   Closed Cycle SiteBuild        native template site tree
   + addressed site.db rows      + typed fragment resolver
          |                              |
   shared Cycle renderer          Rust Liquid/page renderer
          +---------------+--------------+
                          v
                  pages + complete assets
                          v
             atomic Service Worker generation
                          v
              preview/<ig-id>/<page-path>
```

`site.db` is an explicit compatibility artifact and the complete semantic-data
handoff for the Cycle v1 render target. Generator code/configuration, design
assets, and final output identity remain separate explicit inputs/outputs. The
row projection is not the universal compiler/renderer API. The stock template
path may discover generated fragments while evaluating Liquid; that path
crosses one typed `ArtifactResolver` boundary and records semantic artifact
reads.

See the engine contract in
[`vendor/sushi-rs/crates/site_build/README.md`](vendor/sushi-rs/crates/site_build/README.md)
and the shared Cycle renderer in
[`vendor/cycle/site-gen/README.md`](vendor/cycle/site-gen/README.md).

## Liquid implementations

There are two intentional Liquid implementations, one for each renderer
architecture:

| Renderer | Liquid engine | Browser/native sharing |
| --- | --- | --- |
| Publisher templates | Rust `render_liquid` in `vendor/sushi-rs` | the same Rust implementation is used natively and in WASM |
| Cycle external builder | LiquidJS behind `vendor/cycle/site-gen/core/content.ts` | the CLI and browser import the same Cycle renderer/content policy |

The browser no longer has a separate Cycle Liquid implementation. Portable
browser and native builds read the same closed `SiteBuildView`. Only the
explicit `SITE_DB` migration fallback injects the legacy read-only SQL
capability.

## Code map and seams

| Path | Responsibility |
| --- | --- |
| `app/src/build/projectRevision.ts` | exact host-side identity for `compileProject` inputs |
| `app/src/build/latestTaskQueue.ts` | serial mutable-engine access and latest-wins commit leases |
| `vendor/cycle/site-gen/core/closed-build.ts` | shared independent verification of the Rust build id, read graph, transitive ready closure, and all reachable ready-artifact bytes |
| `vendor/cycle/site-gen/core/json-site-build.ts` | shared portable `SiteBuildView` over the verified canonical Cycle rows |
| `app/src/worker/protocol.ts` | typed request/result table for every main-thread/worker operation |
| `app/src/worker/client.ts` | package transport/cache, worker RPC, compile-revision reuse, template acquisition |
| `app/src/worker/engine.worker.ts` | sole owner of the WASM `Session`; atomically installs the current Cycle runtime |
| `app/src/adapters/` | generator integration and deterministic runtime/template/authored asset assembly |
| `app/src/preview/render.tsx` | thin browser adapter to Cycle's shared `CycleSiteRenderer` |
| `app/src/preview/previewWindow.ts` | preview URLs, HTML preparation, generation publication, hot reload |
| `app/public/preview-sw.js` | scoped page/asset cache and atomic current-generation pointer |
| `scripts/assemble-static-data.sh` | canonical data recipe shared by local builds and CI |
| `scripts/run-browser-gates.sh` | immutable artifact server plus fresh-profile Chromium certification |

`SiteGeneratorAdapter` is a host integration seam; it is not the semantic
handoff. The semantic value is `SiteBuild`. The adapters currently retain
per-generator mutable state behind the serialized build queue. Moving stock
render state to immutable per-build handles is the next isolation step.

## Repository shape

```text
app/                     React/Vite application
  src/editor/            Monaco and file tree
  src/vfs/               OPFS/in-memory project and package persistence
  src/worker/            typed worker protocol and engine host
  src/build/             project/build identity and coordination
  src/adapters/          Cycle and stock generator integrations
  src/preview/           shared Cycle adapter and Service Worker host protocol
scripts/                 WASM, package, catalog, runtime-asset, and gate recipes
expansions/              deliberately refreshed terminology warm-start data
vendor/sushi-rs/         pinned engine submodule
vendor/cycle/            pinned default IG and external renderer submodule
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
SITE_GEN_USE_FIXTURE=1 bun site-gen/ingest.ts
bun test
```

Certify the exact Vite artifact under the deployment subpath with a fresh
Chromium profile:

```sh
cd ../..
BASE_PATH=/fhir-ig-editor/ bash scripts/run-browser-gates.sh app/dist
```

The lower-level CDP harness can target an already running browser:

```sh
node scripts/verify-e2e.mjs http://127.0.0.1:4173/fhir-ig-editor/
```

The full Pages workflow additionally runs engine contract tests, native/WASM
Cycle compile parity, package-list drift, live-versus-packed template parity,
terminology consistency, complete catalog/runtime assembly, and artifact
presence checks.

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
[`SPEC.md`](SPEC.md) for the current product/architecture contract.
