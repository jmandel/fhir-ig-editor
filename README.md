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
ProjectBuildSnapshot
      + exact PackageLock
              |
              v
           Compiler
              |
              v
        PreparedGuide
              |
              v
        open SiteBuild
              |
      ArtifactResolution batches
              |
              v
       ClosedSiteBuild
          /         \
 Cycle/LiquidJS   Publisher/Rust Liquid
          \         /
              v
      SiteOutput + receipt
              |
              v
 atomic preview generation -> preview/<ig-id>/<page-path>
```

`ProjectBuildSnapshot` freezes authored input before asynchronous work starts.
The Rust resolver selects an exact content-addressed `PackageLock`; the compiler
then produces `PreparedGuide`, the renderer-neutral resource, terminology,
navigation, config, and authored-asset model. `SiteBuild` adds a target-specific
artifact graph. Closing it proves that every render-plan root and transitive read
is ready. `SiteOutput` binds the resulting tree to both that closed input and the
exact renderer recipe.

The preferred Cycle v2 projection consists of four typed data roots (prepared FHIR
resources, terminology products, recursive navigation, and parsed config) plus
one raw CAS artifact per authored asset. The renderer receives a verified
`ClosedSiteBuild`; there is no request-time compiler or fragment callback.
The prepared model also carries the compiler-selected primary
ImplementationGuide key separately from sorted resources, so IG examples do not
become the site identity by row order.
`site.db` survives only as the explicitly readable Cycle v1/SQLite migration
path, not as the universal compiler/renderer API.

Any fresh package mount invalidates resolution. `compileProject` refuses to run
until the current config has a satisfied exact fixpoint, and Rust exposes only
those package labels to compilation and snapshot completion. Raw
`input/resources/*.json` bytes and parsed predefined objects must have identical
path sets and semantic values; invalid or one-sided inputs fail loudly.

The stock-template path may discover generated fragments while evaluating
Liquid. `openStockBuild` freezes the exact compiled/template/authored state.
Each `renderStockPage(handle, path)` crosses one typed `ArtifactResolver`,
captures exact reads, applies a `Need<ArtifactKey> -> ResolutionBatch`, and
returns an immutable successor handle. The old handle remains stable even if the
ambient worker session later changes. Cycle simply starts with a complete closed
build; both paths therefore converge on the same manifest/CAS/output model.

## Package and cache flow

The browser starts WASM without globally mounting the catalog. Rust resolution
selects only the active project's packages. Manifest roles are `compile`,
`snapshot`, and `on-demand`; template and shadowed versions are not eager work.

Cold transports are authenticated, normalized once, and converted to compact
`PreparedPackage` v2 artifacts. Each contains a canonical member directory and
independently compressed 1 MiB chunks; its key commits member digests plus the
normalization/index/engine formats. Warm reload stages checked artifacts one at
a time and commits the complete set transactionally. Mounting retains compressed
bytes and inflates a bounded, hash-checked chunk only when `PackageSource::read`
requests a member. There is no closure-sized JavaScript batch, expanded package
image, base64 decode, or derived-index rebuild. A v1, bad, or stale pointer is a
cache miss and falls back to the authenticated source transport.

Resolution locks are also fail-closed hints: their identity includes config,
resolver schema, the emitted engine recipe, package authority, registries, and proxy. Mutable
requests are refreshed, exact packages are mounted, and Rust must reproduce the
same ordered closure before the lock can authorize reuse. Compiled revisions,
closed builds, and outputs are likewise reused only under their complete input
and recipe identities.

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

Two version labels intentionally describe different seams. `cycle-site/v2`
(and render-target producer version `2`) identifies the typed input contract.
The shared `site-output/v1` manifest names renderer implementation
`cycle-site@1`, its exact recipe digest, output schema/options, an `sok1` cache
key, and an `so1` complete-tree identity.
Because v1 and v2 inputs feed the same renderer implementation, their ordinary
site files can be byte-identical while their receipt ids remain different: each
receipt also binds its exact input SiteBuild id.

## Code map and seams

| Path | Responsibility |
| --- | --- |
| `app/src/vfs/store.ts`, `demoIg.ts` | persistent authored text/binary project plus exact catalog-source identity |
| `app/src/build/projectRevision.ts` | exact host-side identity for `compileProject` inputs |
| `app/src/build/latestTaskQueue.ts` | serial mutable-engine access and latest-wins commit leases |
| `app/src/storage/contentStore.ts` | OPFS implementation of the verified immutable byte store |
| `app/src/storage/derivedArtifactCache.ts` | pointer-last exact-recipe cache for closed builds and lazy renderer outputs |
| `app/src/worker/preparedPackageCache.ts` | small package pointers plus Worker-side binary prepared-artifact reads |
| `app/src/worker/resolutionLockCache.ts` | exact, freshness-checked dependency closure hints |
| `app/src/worker/packageClosureIdentity.ts` | compile/context/support coordinates bound to their exact PreparedPackage keys |
| `vendor/sushi-rs/crates/prepared_guide` | renderer-neutral semantic preparation result |
| `vendor/sushi-rs/crates/content_store` | native filesystem implementation of the same byte-store contract |
| `vendor/sushi-rs/crates/site_build` | open/closed/successor build graph and renderer-neutral `SiteOutput` identity |
| `vendor/cycle/site-gen/core/closed-build.ts` | shared independent verification of the Rust build id, read graph, transitive ready closure, and all reachable ready-artifact bytes |
| `vendor/cycle/site-gen/core/open-site-build.ts` | generic CAS verification and exact Cycle v1/v2 contract dispatch |
| `vendor/cycle/site-gen/core/semantic-site-build.ts` | strict v2 schemas and preloaded callback-free semantic/asset view |
| `vendor/cycle/site-gen/core/json-site-build.ts` | readable v1 aggregate compatibility adapter |
| `vendor/cycle/site-gen/core/output-receipt.ts` | browser-safe shared SiteOutput derivation key and complete Cycle output identity; native publication uses the filesystem verifier beside it |
| `app/src/worker/protocol.ts` | typed request/result table for every main-thread/worker operation |
| `app/src/worker/client.ts` | package transport/cache, worker RPC, compile-revision reuse, template acquisition |
| `app/src/worker/engine.worker.ts` | sole owner of the WASM `Session`; atomically installs the current Cycle runtime |
| `app/src/adapters/` | generator integration and deterministic runtime/template/authored asset assembly |
| `app/src/preview/render.tsx` | thin browser adapter to Cycle's shared `CycleSiteRenderer` |
| `app/src/preview/previewWindow.ts` | preview URLs, HTML preparation, generation publication, hot reload |
| `app/public/preview-sw.js` | scoped page/asset cache and atomic current-generation pointer |
| `scripts/assemble-static-data.sh` | canonical data recipe shared by local builds and CI |
| `scripts/run-browser-gates.sh` | immutable artifact server plus fresh-profile Chromium certification |
| `scripts/run-uscore-benchmark.sh` | repeatable cold/warm/same-worker performance report over one persistent browser profile |

`SiteGeneratorAdapter` coordinates a selected generator with the editor; it is
not the semantic handoff. Cycle consumes a verified `ClosedSiteBuild`. The stock
adapter owns an explicit frozen handle and advances only through returned
successors. The native Fig F0-root/predecessor association remains a documented
trusted-producer edge until that compatibility host reconstructs every native
input from a closed build/CAS.

Any successful fresh mount invalidates the resolver fixpoint for the *next*
compile. It does not mutate an already compiled revision: that value retains its
exact package-closure allow-list, so unrelated later mounts cannot leak into
snapshots, prepared semantics, or stock fragments. Compile reuse keys include
that closure rather than merely the ambient mount generation.

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

Measure US Core cold start, persistent-OPFS hard reload, and same-worker reopen:

```sh
BASE_PATH=/fhir-ig-editor/ \
  bash scripts/run-uscore-benchmark.sh app/dist > uscore-benchmark.json
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
