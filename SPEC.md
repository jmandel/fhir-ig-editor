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
`Session.compileProject`. `EngineClient.ensureCompiledProject` uses that digest
to establish that the worker session contains the requested revision before an
adapter reads session state. Same-revision projections reuse the compile;
package acquisition or changed bytes invalidate it.

A successful fresh package mount invalidates the prior resolver fixpoint.
`compileProject` requires a satisfied fixpoint for its exact config bytes and
compiles through a package view restricted to those selected labels. Compile
and snapshot completion use the same full dependency closure; core is a
validated distinguished member, not the only snapshot package. The worker's
mounted-label mirror is replaced after `init` and extended only after a
successful `mount`. `EngineClient` mirrors a package-mount generation: any
fresh deferred, dependency, or template mount invalidates its resolution,
compile, and snapshot caches. Every compile re-establishes resolution for the
exact config/generation, and a Cycle site build mounts deferred data before it
ensures the final compile revision.

Every `input/resources/*.json` file has the raw site-file bytes as its source
authority. Parsed predefined resources must have the identical key set and
semantic JSON values. Invalid base64, UTF-8, JSON, or one-sided entries are
transactional errors.

For callback-free external builders, the Rust engine owns the authoritative
immutable handoff:

```text
ProjectRevision + exact PackageLock + RenderTarget
      + ArtifactCatalog + RenderPlan + diagnostics
                         = SiteBuild
```

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
JSON-inside-JSON, and base64 asset bodies are absent from this wire. The current
Rust projector is deliberately transitional: it reads the already-prepared
`SiteDb` model, but `site.db` is neither the public handoff nor semantic
identity. The next internal cleanup is to project both v2 and optional SQLite
from one renderer-neutral prepared-site model.
The current prepared model carries the compiler/exporter-selected primary
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
The v2 render target uses producer version `2`; Cycle's current output receipt
uses renderer `cycle-site@1` because the output algorithm is shared with the v1
adapter. Equal v1/v2 output bytes therefore have distinct `cob1` ids: the
receipt also commits the exact input SiteBuild id.

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
| Rust `site_build::SiteBuild::new` | exact project/package/target/plan/artifacts/diagnostics → immutable, content-derived build |
| `SiteBuild::successor` | explicit predecessor + deterministic resolution batch → immutable successor + newly introduced digest-keyed CAS objects; no ambient “last build” |
| `SiteBuild::close` / `ClosedSiteBuild` | open build → proof that every render-plan root and transitive artifact read is ready |
| `cycle_semantic::close_projection` | already-derived exact identity + current prepared model → four typed Cycle data roots, raw asset roots, and a closed v2 build |
| `site_db_compat::close_projection` | migration-only v1 aggregate; it cannot invent project/package identity from rows |
| `package_store::normalize_package_material` | mounted label + registry/native entries → identity/path-checked full transport, regenerated derived index, strict dependency metadata, and canonical compiler-visible lock bytes shared by native and WASM |
| `render_page::ArtifactResolver` | typed native artifact key → generated bytes/read set or typed failure; Liquid/file lookup does not own semantic generation |
| `fig::engine::render_site_for_revision` / `collect_site_build_revision` | trusted predecessor/F0-root assertion → opaque full-payload-sealed native outcome → complete stock page/asset successor; plain `render_site` is not promotable |
| native `fig prepare` | explicit IG/cache/output/time/target → `site-build.json` plus `objects/sha256/*`; v2 preferred, v1 explicit migration option |
| WASM `Session` | one isolated mutable engine per normal instance; mount invalidates resolution, `compileProject` uses only its exact resolved labels, and projection methods consume that revision without recompiling |
| worker `EngineOps` | the single typed main-thread/worker RPC table; one worker owns one `Session` and atomically installs a Cycle runtime |
| `ProjectBuildSnapshot` + `LatestTaskQueue` | immutable host input capture + serialized latest-wins authority to publish React/Service Worker state |
| `SiteGeneratorAdapter` | temporary host integration for prepare/list/render/assets; not semantic identity and not a replacement for `SiteBuild` |
| Cycle `ClosedBuildHandle` / `ContentStore` | verify a closed manifest/read graph and reachable ready-artifact bodies over a read-only byte transport |
| Cycle `openCycleSiteBuildPayload` | generic CAS payload → verified closed handle + exact v1/v2 view dispatch |
| Cycle `SiteBuildView` / `SemanticSiteBuildView` | synchronous callback-free queries over verified typed roots; legacy row values exist only as an in-memory renderer façade |
| `CycleSiteRenderer` + `CycleContentRenderer` | deterministic page selection/React SSR plus injected shared LiquidJS narrative policy; no filesystem/compiler/global database |
| Cycle output receipt | complete declared output bytes + producer metadata + input build id → `cob1-sha256` identity; native publication re-verifies before rename |
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

The current adapter API retains generator state behind this queue. The target
API is an immutable per-build handle. Until that migration, uncached live stock
navigation during a new stock build is a documented isolation limitation and
must not be represented as fully solved by the queue alone.

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
transport and persistence. Registry bytes are mounted into the worker and exact
resolved packages are recorded in the build contract. Before mount, the shared
Rust package-material boundary verifies `package.json` identity against the
exact label, validates dependency metadata, retains safe nested registry
transport, regenerates the derived index, and computes the same canonical
compiler-visible top-level bytes used by native Fig. Nested members are excluded
from that semantic lock payload but remain mounted because Publisher template packages consume their
`content/`, `includes/`, `layouts/`, `liquid/`, and asset trees; they are not
part of the current Cycle semantic package lock and must become explicit target
artifacts before the native-template branch can be closed. Package
acquisition invalidates any host-side compile-revision cache.

Same-origin baked bundles have an additional transport lock: `manifest.json`
requires the SHA-256 and byte length of each compressed `.tgz`; the client checks
those bytes before inflation and keys the inflated OPFS entry by package label
plus digest. Label-only cache entries from older formats are never migrated into
that trusted lane. Registry results may be cached under a digest of their
inflated map, but that identity is a cache key rather than registry authority.

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

The browser gate fails on stale engine/app commits, wrong project content,
broken diagnostics, failed navigation/reload/history, cross-IG hot reload,
missing assets, HTML fallbacks served as assets, broken images, missing required
runtime globals, inactive compatibility behavior, or unexpected exceptions.

## Current convergence work

- Extract a renderer-neutral `PreparedSite` before row derivation; make typed
  Cycle artifacts and optional `site.db` compatibility outputs consume it.
- Rewrite Cycle's renderer-facing query API around semantic resources,
  navigation, terminology, and assets, then remove the in-memory row façade.
- Retire the v1 aggregate producer and explicit SQLite/SQL fallback after
  downstream workflows migrate; retain the v1 reader for a longer window.
- Replace remaining adapter/session singletons with immutable build handles and
  expose/persist native stock successor revisions in the browser host.
- Add finer per-resource artifacts only where measured invalidation or loading
  costs justify them; v2 intentionally starts with a resource aggregate.
- Provision Cycle's already-declared v2 asset roots to the preview Service
  Worker in one generation commit instead of using the live asset responder.
- Extend precise invalidation across source, package, data/include, fragment,
  page, and asset reads.
- Represent remaining terminology/dictionary/dependency-table gaps as typed
  capability states and broaden catalog browser certification.
