# fhir-ig-editor product and architecture contract

Status: canonical landed cross-repository contract, 2026-07-10. This replaces
the original M0–M2 demo plan. Historical task/branch notes are not normative;
the running seams and acceptance laws below are.

## Product boundary

The editor is a static web application for authoring and previewing FHIR
Implementation Guides. The browser must be able to:

- load a pinned catalog IG, a GitHub IG, or local project source;
- edit FSH and supporting IG files;
- resolve/mount required FHIR packages;
- compile FSH and display exact diagnostics and resource/snapshot views;
- preview the current source through either the Cycle external builder or a
  native Publisher template; and
- navigate the preview with ordinary URLs in an iframe or independent tab.

There is no application server. Registry and optional terminology HTTP calls
are host transports to external services; they are not hidden server-side build
logic. A built Pages artifact contains the app, WASM, pinned catalog source,
package/template warm starts, Cycle assets, and Publisher-runtime assets.

## Non-goals

- Reimplementing external terminology systems such as SNOMED CT in the browser.
- Executing template `ant` hooks or arbitrary server-side code.
- Treating placeholder output as semantic parity.
- Making `site.db`, React state, a renderer singleton, or an ambient global the
  universal identity of a project build.

## Build identity and data flow

One build begins by capturing an immutable `ProjectBuildSnapshot` containing
the project id, config bytes, all FSH files, predefined resources, all site
files, and a build epoch. Asynchronous code must not reread a mutating
`ProjectStore` to complete that build.

`projectCompileRevision` hashes the exact arguments accepted by
`Session.compileProject` plus the exact resolved compile/context closure.
`EngineClient.ensureCompiledProject` uses that digest to establish that the
worker contains the requested revision before an adapter reads semantic state.
Same-revision projections reuse the compile; changed authored bytes or a changed
closure do not.

A successful fresh package mount invalidates the resolver fixpoint for a future
compile, but it does not invalidate or mutate a prior compiled value whose exact
package allow-list remains captured.
`compileProject` requires a satisfied fixpoint for its exact config bytes and
compiles through a package view restricted to those selected labels. Compile
and snapshot completion use the same full dependency closure; core is a
validated distinguished member, not the only snapshot package. The worker's
mounted-label mirror is extended only after a successful transactional mount.
Every new compile re-establishes resolution for the exact config and authority;
snapshot/site work requests its declared package role before establishing the
final closure-bound compile revision.

Every `input/resources/*.json` file has the raw site-file bytes as its source
authority. Parsed predefined resources must have the identical key set and
semantic JSON values. Invalid base64, UTF-8, JSON, or one-sided entries are
transactional errors.

The authoritative build flow is:

```text
ProjectRevision + PackageLock
          -> Compiler
          -> PreparedGuide
          -> open SiteBuild
          -> ArtifactResolution batches
          -> ClosedSiteBuild
          -> Renderer
          -> SiteOutput + receipt
```

`PreparedGuide` contains renderer-neutral guide identity, resources and
publication facets, terminology products, recursive navigation, parsed config,
and exact authored assets with source provenance. It is upstream of both
`site_build` and `site_db`. The latter is an optional compatibility projection,
never the universal handoff.

The `SiteBuild` id is recursively canonicalized and content-derived. Artifact
content is separately addressed by SHA-256 and byte length. A deserialized build
must verify its id and referential integrity.

`ClosedSiteBuild` proves every artifact required by the render plan, including
transitive artifact reads, is ready. A callback-free renderer must accept a
closed build, not a collection of optimistic optional inputs.

The native Publisher-template branch may discover generated artifacts while a
page evaluates. It records exact page/data/include bytes and typed resolver
outcomes, then `SiteBuild::successor` creates a new immutable manifest plus the
new CAS objects. `collect_stock_revision` makes every advertised page and final
assembled asset a plan root. Once that successor closes, the same output can be
replayed from its CAS without a generator callback. Thus SiteBuild is the
explicit handoff in both branches, but at a different point: before execution
for a declarative external builder, and after discovery/capture for a native
template.

## Renderer contracts

### Cycle external builder

The preferred `cycle-site/v2` target has a complete, callback-free render plan:

- `cycle.semantic/v1/resources.json` contains prepared FHIR objects and the
  small set of publication facets that cannot be recovered from them;
- `terminology.json` contains actual expansion products;
- `navigation.json` contains recursive authored page and menu trees;
- `config.json` contains parsed configuration; and
- each authored asset is its own raw `Asset/Authored/<path>` CAS artifact with
  its real media type.

Numeric database keys, PascalCase columns, flattened tree ordinals,
JSON-inside-JSON, and base64 asset bodies are absent from this wire.
`cycle_semantic::close_prepared` projects v2 directly from `PreparedGuide`;
optional v1/SQLite rows are a sibling compatibility projection. The prepared
model carries the compiler/exporter-selected primary
ImplementationGuide key outside the legacy row serialization; additional IG
instances remain independently addressed resources and render as ordinary
resource pages.

`buildSiteBuildFromCompile` derives v2 from the last exact compile and returns
`site-build-cas/v1`: the closed manifest plus a digest-to-base64 transport map
of its raw artifact bodies. Base64 is only a JSON transport encoding; it is not
stored in semantic artifacts. `openCycleSiteBuildPayload` verifies the manifest,
required transitive closure, byte lengths, and SHA-256 digests, then dispatches
solely from the exact renderer version and contract. `SemanticSiteBuildView`
preloads the four JSON roots and raw assets and supplies the existing
synchronous renderer view. A malformed v2 build cannot be reinterpreted as v1
by artifact sniffing.

Cycle CLI and browser use the same page selection, React SSR, LiquidJS policy,
include handling, generated fragments, resource fragments, and Markdown
implementation. Native `fig prepare --target cycle-site/v2` emits the same
closed contract in a filesystem CAS and verifies every addressed source,
package, and artifact object. Portable browser/native modes omit SQL and fail
loudly if authored Liquid requires it.

The input-contract version and output-renderer version are separate identities.
The v2 render target uses producer version `2`; Cycle's output contract uses
renderer `cycle-site@1` plus an exact recipe digest because the output algorithm
is shared with the v1 adapter. Equal v1/v2 bytes have distinct `sok1` derivation
keys and `so1` output ids because both commit the exact input.

`cycle-site/v1` remains readable and explicitly producible during migration. It
contains the old `compat.site_db/rows.json` aggregate and is adapted by
`JsonSiteBuildView`. `SqliteSiteBuildView` and read-only Liquid SQL remain only
behind an explicitly selected `SITE_DB` legacy fallback.

### Native Publisher templates

The stock path mounts an exact template chain, produces source-derived page
shells and `_data`, overlays current authored pages/includes/data/assets, and
evaluates pages with Rust `render_liquid` and the Rust Markdown/page pipeline.

A known generated-fragment include may cross `ArtifactResolver` only after the
legacy filename is translated to a typed fragment key. The resolver validates
resource/whole-IG scope and Publisher parameters. Per-page attempted and
successful reads are recorded, and generation caching uses `ArtifactKey`.
Authored/template includes remain ordinary files.

`artifactResolution: false` must make this callback path unavailable. External
builders must not accidentally invoke native fragment generation through a
missing-file lookup.

After a complete native pass, `collect_stock_revision` consumes captured bytes
and observations rather than rereading the mutable render tree. Ready fragment
reads and exact page/data/include inputs become transitive dependencies; failed
attempts remain typed records but are not falsely reported as successful page
reads when a staged/template fallback rendered the page. CAS replay is limited
to the sealed plan and rejects missing, changed, or non-UTF-8 objects.

In the browser, `openStockBuild(templateCoord)` freezes the exact render state,
package lock, template coordinate, options, and mounted-tree digest behind a
content-derived handle. `renderStockPage(handle, path)` renders only that frozen
state, turns discovered needs into one deterministic resolution batch, applies
`SiteBuild::successor`, verifies/closes the result, and returns the successor
handle plus CAS objects. Later session mutation cannot change an older handle.

## Liquid rule

The stack has exactly two intentional Liquid implementations:

1. Rust `render_liquid` for Publisher templates, shared by native and WASM.
2. LiquidJS in Cycle `site-gen/core/liquid.ts`, shared by Cycle CLI and browser
   through `site-gen/core/content.ts`.

An editor-specific Cycle Liquid implementation is forbidden. The generic WASM
`renderLiquid` operation is part of the native content surface, not Cycle's
portable rendering architecture.

## Public seam index

These are the supported boundaries. Their repository READMEs document wire
shapes and lower-level helpers; historical plans do not supersede this list.

| Seam | Input → output and ownership law |
| --- | --- |
| `package_store::PreparedPackage` | authenticated source material + normalization/index/ABI formats → checksummed binary package and immutable indexed layer |
| `ContentStore` | `ContentRef` → bytes only after digest/length/media verification; native filesystem and browser OPFS are storage implementations, not semantic callbacks |
| `prepared_guide::PreparedGuide` | exact compiled resources/config/navigation/assets → renderer-neutral semantic value, independent of rows and render targets |
| Rust `site_build::SiteBuild::new` | exact project/package/target/plan/artifacts/diagnostics → immutable, content-derived build |
| `SiteBuild::successor_batch` | explicit predecessor + complete typed need/resolution batch → immutable successor + newly introduced digest-keyed CAS objects; no ambient “last build” |
| `SiteBuild::close` / `ClosedSiteBuild` | open build → proof that every render-plan root and transitive artifact read is ready |
| `cycle_semantic::close_prepared` | `PreparedGuide` + exact identity/target → four typed Cycle data roots, raw asset roots, and a closed v2 build |
| `cycle_semantic::prepare_from_site_db` / `close_projection` | explicit reverse compatibility adapter for migration gates; not the preferred v2 producer |
| `site_db_compat::close_projection` | migration-only v1 aggregate; it cannot invent project/package identity from rows |
| `package_store::normalize_package_material` | mounted label + registry/native entries → identity/path-checked full transport, regenerated derived index, strict dependency metadata, and canonical compiler-visible lock bytes shared by native and WASM |
| `render_page::ArtifactResolver` | typed native artifact key → generated bytes/read set or typed failure; Liquid/file lookup does not own semantic generation |
| `fig::engine::render_site_for_revision` / `collect_site_build_revision` | trusted predecessor/F0-root assertion → opaque full-payload-sealed native outcome → complete stock page/asset successor; plain `render_site` is not promotable |
| native `fig prepare` | explicit IG/cache/output/time/target → `site-build.json` plus `objects/sha256/*`; v2 preferred, v1 explicit migration option |
| WASM `Session` | one isolated mutable engine per normal instance; binary/raw mount transactions invalidate future resolution, `compileProject` uses only exact resolved labels, and projection methods consume that revision without recompiling |
| WASM `openStockBuild` / `renderStockPage` | frozen native-template predecessor → typed need/resolution successor; no ambient page render in the editor path |
| worker `EngineOps` | the single typed main-thread/worker RPC table; one worker owns one `Session` and atomically installs a Cycle runtime |
| `ProjectBuildSnapshot` + `LatestTaskQueue` | immutable host input capture + serialized latest-wins authority to publish React/Service Worker state |
| `SiteGeneratorAdapter` | host integration for prepare/list/render/assets; not semantic identity and not a replacement for `SiteBuild` |
| Cycle `ClosedBuildHandle` / `ContentStore` | verify a closed manifest/read graph and reachable ready-artifact bodies over a read-only byte transport |
| Cycle `openCycleSiteBuildPayload` | generic CAS payload → verified closed handle + exact v1/v2 view dispatch |
| Cycle `SiteBuildView` / `SemanticSiteBuildView` | synchronous callback-free queries over verified typed roots; legacy row values exist only as an in-memory renderer façade |
| `CycleSiteRenderer` + `CycleContentRenderer` | deterministic page selection/React SSR plus injected shared LiquidJS narrative policy; no filesystem/compiler/global database |
| shared `SiteOutput` / Cycle output manifest | closed input + renderer recipe/schema/options → `sok1-sha256` cache key; complete declared bytes/provenance → `so1-sha256` identity; native publication re-verifies before rename |
| `SqliteSiteBuildView` | explicitly selected native legacy adapter only; the sole path that may inject read-only SQL |
| preview generation commit | complete generation/manifest pair → atomically acknowledged Service Worker pointer scoped by IG id |

## State and concurrency

One Web Worker owns one isolated `Session`. Normal `Session` construction must
not share compiler/render state. `Session.global()` is a named legacy escape
hatch only.

All build/template operations over the mutable worker session are serialized by
`LatestTaskQueue`. A newer queued request immediately revokes the old task's
publication lease. Non-cancellable WASM work may finish, but revoked work must
not publish React state or a Service Worker generation.

The worker installs Cycle manifest, verified semantic view, and renderer as one atomic
`CycleBuildRuntime`; separate mutable globals for those pieces are forbidden.

Adapters retain host coordination state behind this queue, while semantic state
is immutable. Cycle atomically installs one closed-build/view/renderer tuple;
stock page requests carry an explicit frozen build handle and receive the next
successor handle.

## Assets

Every preview asset has an owner and provenance:

- Publisher runtime;
- mounted template;
- authored IG;
- generated; or
- named extension namespace.

The stock catalog applies deterministic runtime < template < authored
precedence. Template assets come from the exact mounted package chain. Fixed
runtime assets are generated from pinned, hash-checked upstream inputs.
Generated table backgrounds and compatibility scripts are explicit producers.
Do not modify third-party library bytes in place.

Cycle v2 names every authored asset as a raw required SiteBuild artifact. The
native full-site host additionally declares design-system, project stylesheet,
and client-bundle outputs in its final output receipt. Those are generator/host
outputs, not fabricated semantic inputs.

When present, `SiteGeneratorAdapter.assetManifest` is the complete public-path
projection for one generation and is provisioned once. The stock adapter meets
this contract. An adapter that omits it explicitly uses the slower live
`assetBytes`/static relay. Cycle's semantic handoff is complete, but its editor
adapter still needs to provision those known v2 asset roots as one Service
Worker manifest instead of using the live relay.

## Preview protocol

All previews use:

```text
<base>/preview/<ig-id>/<path>
```

`publishPreviewSource` sends one `igpreview:commitGeneration` request containing
the generation and, when the adapter implements `assetManifest`, its full asset
set. Otherwise it declares `hasAssetManifest:false` and the Service Worker uses
the slower live relay. The Service Worker must finish writing the generation
before advancing its current pointer and acknowledging the commit. React may
publish the matching page list/generation only after that ACK and while its task
lease remains current.

Hot reload is scoped by IG id and changed page bytes. A current-generation cache
hit wins over live rendering. An older cached generation is an explicitly stale
fallback after the editor is unavailable; it is not evidence that current
source rendered successfully.

The same behavior applies to embedded and independent preview windows:
cross-page links, reload, back/forward, editor-close fallback, and source edits.

## Packages and terminology

The Rust resolver decides dependency requirements; the browser supplies
transport and persistence. Engine boot mounts no global catalog. Package roles
are `compile`, `snapshot`, and `on-demand`, and resolution selects the active
project's exact closure.

Cold package transports are authenticated and normalized once into compact
`PreparedPackage` v2 objects. The key binds the canonical member-digest root,
binary/normalization/derived-index formats, and engine ABI. A canonical directory
maps every safe member to a deterministic raw-DEFLATE chunk with exact lengths
and SHA-256 values. Warm loading authenticates and stages one object at a time,
then commits the set atomically; metadata mounting inflates no bodies. Reads
bounded-inflate and verify only the requested chunk/member behind an 8 MiB
per-artifact cache. The host never constructs a closure-sized JS batch or expanded
package image. v1, corrupt, and stale objects fall back to original transport.

Persistent resolution locks are prefetch hints, never semantic authority. Their
key includes exact config, resolver schema, emitted engine-recipe digest, full baked label and
digest universe, registry order, and proxy. Mutable requests are refreshed
against the current authority; Rust then re-resolves and must reproduce the
exact ordered compile/context closure before reuse.

`fig packages prepare` and `rust_sushi packages prepare` invoke the same
implementation and produce the same `.fpp` bytes and manifest for identical
inputs. This command parity is a supported transition aid; `fig` is the primary
user-facing CLI.

Enumerable ValueSet composes over available content may expand locally.
Composes requiring unavailable external code-system semantics return an
explicit `needs terminology server` state. A configured external `$expand`
endpoint and committed warm-start cache are optional authorities; incomplete
local output must not masquerade as a complete expansion.

## Acceptance gates

A releasable editor commit must pass, as applicable:

- engine compiler/WASM/snapshot tests;
- `site_build` closure, successor, typed Cycle projection, and v1 compatibility tests;
- typed `render_page` artifact tests and `fig` watch tests;
- native/WASM Cycle compile byte parity;
- package-list drift and template live/packed parity;
- Cycle shared-renderer contract tests;
- app data/coordination/preview unit tests;
- TypeScript and Vite production build; and
- a fresh-profile Chromium run against an immutable copy of the exact Vite
  artifact under the GitHub Pages subpath.

Performance changes additionally run the repeatable US Core benchmark for cold
start, persistent-OPFS hard reload, and same-worker reopen. Its report includes
project, package transport/OPFS, Worker serialization, WASM prepare/mount,
resolution, compile, snapshot/site production, preview publication, network
bytes, and long-task measurements.

The browser gate fails on stale engine/app commits, wrong project content,
broken diagnostics, failed navigation/reload/history, cross-IG hot reload,
missing assets, HTML fallbacks served as assets, broken images, missing required
runtime globals, inactive compatibility behavior, or unexpected exceptions.

## Remaining deliberate migration edges

- Retire the v1 aggregate producer and explicit SQLite/SQL fallback only after
  downstream consumers migrate; retain the v1 reader longer.
- Remove Cycle's in-memory row-shaped renderer façade after all renderer queries
  use semantic resources/navigation/terminology/assets directly.
- Eliminate Fig's trusted ambient F0 predecessor assertion by reconstructing its
  complete native input tree from a closed build and `ContentStore`.
- Add finer per-resource artifacts only where measured invalidation or loading
  costs justify them; v2 intentionally starts with a resource aggregate.
- Provision Cycle's declared asset roots as one preview generation manifest and
  extend precise invalidation across data/include/page/asset reads.
- Represent remaining terminology/dictionary/dependency-table gaps as typed
  capability states and broaden catalog browser certification.
