# FHIR IG editor architecture

Status: normative target and migration ledger. This is the only document that
defines the cross-repository domain model and host API. Package, renderer, and
publication READMEs may document their implementations but must not introduce a
second build flow.

## The whole model

```text
PreparedGuide -> SiteBuild -> SiteOutput
                      |
                 ContentStore
```

There are exactly three domain values:

- `PreparedGuide` is the complete renderer-neutral guide semantics: guide
  identity, prepared FHIR resources and publication facets, terminology
  products, navigation, parsed configuration, and authored content references.
- `SiteBuild` is the immutable target-specific renderer input. Whether its
  required closure is ready is a verified state of this value, not another
  domain layer.
- `SiteOutput` is the authenticated complete mapping of safe output paths to
  content, media type, producer, ownership, and exact renderer/input identity.

`ContentStore` owns immutable bytes addressed by digest and length. It is
storage plumbing shared by all three values, not a semantic database or a
fourth build representation.

Project snapshots, package locks, compiled state, template file trees,
fragment requests, cache records, preview sequence numbers,
and opaque handles are inputs or private execution details. They may contribute
to an identity, but they must not become alternative handoffs.

The browser keeps one mutable `Workspace` per project. Source transports install
a complete workspace generation transactionally and are then discarded; they
are not project caches or build authority. Each preparation captures that
workspace once as an immutable `ProjectRevision`. Switching projects selects a
different workspace instead of replacing a global working tree, so authored
edits survive A -> B -> A and reload. `ProjectRevision` crosses the worker only
through `prepare`; Rust derives the canonical content-addressed source revision.

The target-neutral Rust executor is `site_engine::SiteEngine`. Its preparation
state owns semantic compilation reuse, complete `PreparedGuide` construction,
generator projection, Publisher assembly, and bounded immutable runtimes. A
host supplies an explicit resolver-scoped `PackageEnvironment`; `wasm_api`
only parses and serializes transport and has no parallel preparation path.
Publisher `SiteBuild` artifacts root semantic documents, all authored roles,
the materialized template tree, assembled runtime tree, exact source revision,
and package lock. SiteBuild v2 makes each locked package's `content` the exact
deterministic PreparedPackage carrier mounted by execution. The carrier is the
single package handoff: its directory is validated without expansion, member
bytes remain compressed until read, and no normalized-payload or renderer-input
side artifact exists beside it. `SiteEngine::restore(ClosedSiteBuild,
ContentStore)` strictly reconstructs either target's ordinary bounded runtime
in a fresh process. This is lifecycle admission, not a fifth host operation or
another value.

## The only host API

```text
prepare(project, generatorSpec) -> Build
build.outputs()                 -> OutputCatalog
build.render(path)              -> ContentRef
build.finalize()                -> SiteOutput
```

`Build` is one immutable host facade over a retained `SiteBuild`, not a stored
domain value or serialized handoff. It does not expose a handle or generator
field. A handle may exist inside a worker/process registry strictly for
open/restore/release lifecycle routing; `OutputCatalog.buildId` names the exact
closed input when preview publication needs that routing value. It is never
authority independent of `ClosedSiteBuild + ContentStore`. `OutputCatalog`
declares path and media type; `render(path)` returns only the resulting
`ContentRef`, whose bytes are already in the host's `ContentStore`.

The complete immutable `ProjectRevision` crosses the site-execution boundary
once, through `prepare`. Browser package acquisition has a private config-only
handshake before that call: Rust computes the resolver fixpoint and template
chain, while the host fetches and transactionally mounts any missing exact
coordinates. This is package transport, not a second site operation. FSH,
predefined resources, and authored site bytes cross only in `prepare`; later
site operations are methods of that build and never consult ambient "last
build" state.

`outputs` is complete and collision-checked before rendering begins. Pages,
CSS, JavaScript, images, fonts, machine-readable resources, and auxiliary text
are all ordinary outputs. There is no separate asset API, base URL fallback, or
whole-generation base64 asset manifest.

`render` is independent by path. Rendering one output must not make the next
output depend on navigation order or an affine chain containing every prior
page. Implementations may memoize private work by exact identity.

`finalize` succeeds only when every declared output is materialized and
verified. It returns the one canonical `SiteOutput`; publication writes its
content first and advances a pointer only after complete verification.

Compilation outcome and diagnostics are immutable inspection metadata returned
with `prepare`; they are not another build lifecycle or renderer handoff. The
editor may expose them through its `Build` view so Author/Explore can become
useful before site publication finishes.

## Platform adapters and transport seams

Only three storage/platform capabilities sit below the host API:

| Seam | Native | Browser | What remains in Rust |
| --- | --- | --- | --- |
| `ProjectSource` | captures one regular, non-symlink filesystem tree | captures one transactional `Workspace` generation | source validation and canonical `ProjectRevision` |
| `PackageProvider` | reads exact selected coordinates from an explicit package cache | fetches/mounts authenticated prepared packages | dependency/version/template selection and exact closure |
| `ContentStore` | filesystem SHA-256 object directory | OPFS-backed verified CAS | every `ContentRef`, closure check, and `SiteOutput` |

These are capabilities, not domain layers. Concrete filesystem and Workspace
implementations stay inside their host. Package transport is a private
missing-coordinate handshake driven by Rust; it never becomes a functional
result of `prepare`.

Rust generates the cross-language TypeScript declarations and Draft 2020-12
schema from the canonical serialization types. TypeScript may define UI-only
views and operation tables, but it may not copy a Rust payload structure by
hand. Independent digest and runtime validation deliberately remain separate
implementations. All operation observations use `BuildEvent`; all four
operations fail with typed `BuildError`.

## Renderer implementations

Cycle and Publisher templates share the host contract, not an implementation.

Cycle receives a callback-free, eagerly closed `cycle-site/v2` `SiteBuild` and
renders through the one shared LiquidJS/React implementation used by browser
and CLI. Its private renderer port is `open(ClosedSiteBuild, ContentStore)`,
`outputs()`, and `render(path) -> ContentRef`. The host binds that immutable
output path set to the retained Rust runtime once and admits each completed,
verified `SiteOutputFile` as it renders. The ordinary no-argument `finalize()`
then checks exact set equality and constructs `SiteOutput`; there is no public
bulk external-finalization plan. The native Bun/Rust process boundary carries
the same completed references through one hidden IPC command, not a Fig user
operation. TypeScript independently validates closed inputs, receipts, and
digests. A staging tree is permitted only as a final receipt-driven atomic
publication adapter, never as a renderer/finalizer handoff or source of output
identity. `cycle-site/v1`, `site.db`, row projections, SQL capabilities, and
dual v1/v2 dispatch are removed.

Publisher templates render with the Rust Liquid implementation. Registered
generated-fragment names resolve synchronously through the immutable typed
artifact resolver captured during preparation; a missing value is a typed
terminal observation for that handle. Neither the editor nor the template calls
the compiler or an ambient session, and there is no callback/retry or affine
successor-handle protocol. A successful `render` exposes only the resulting
output reference; fragment observations are not host API layers.

Post-render compatibility transforms, generated table backgrounds, and runtime
assets are renderer work with explicit recipe identity. They may not be patched
or supplied later by an editor-only side channel.

The two intentional Liquid engines are therefore:

1. Rust Liquid for Publisher templates, native and WASM; and
2. LiquidJS for Cycle, CLI and browser.

## Identity and caching

Each domain value has one canonical identity derived from its complete inputs,
implementation recipe, options, and addressed content. Cache keys are private
indexes for those identities. A cache hit reconstructs and verifies the same
domain value; it never authorizes a parallel cached representation.

Within one `SiteEngine`, derivation reuse is bounded to the current and previous
successful semantic generations. It remains behind `prepare`; it is not another
host operation or handoff value. Reusable StructureDefinition snapshots carry
opaque manifests of every positive, negative, precedence, provenance, body, and
recursive package/local read and are accepted only after revalidation against
the new exact package context. Publisher rendering may share only an immutable,
carrier-keyed package metadata catalog; current PreparedGuide resources, own
resource maps, terminology state, mixed lookup caches, render state, output
catalog, and page bodies are rebuilt for the new generation.

Candidates are staged off-side to their complete authority boundary. Snapshot
derivations promote only after the new `PreparedGuide` succeeds; Publisher
package catalogs promote only after the complete target runtime installs. A
failure before either boundary promotes nothing at that boundary. Empty,
incomplete, unknown, or over-budget evidence takes the canonical full path and
installs a bounded tombstone so older facts still age out. Snapshot and render-
catalog evidence is limited by explicit resource/fact/byte ceilings.
Declaration-level compiler reuse and cross-build page replay remain disabled
until they can supply complete read manifests; elapsed time, filenames, or a
prior successful output are never reuse authority.

Warm preview may expose the prior immutable publication pointer/catalog and its
individually verified `ContentRef`s before the compiler is ready for the current
inputs. The UI must identify that presentation as previous/stale until current
`prepare` and publication succeed. This is scheduling over the existing
`SiteBuild`/output references, not a derivation cache hit and not a
`PreviewManifest` domain layer. The lazy publication need not be a complete
site; a complete authenticated inventory becomes `SiteOutput` only via
`finalize`.

Numeric UI generations order commits but never identify semantic content. The
Service Worker serves immutable output content and atomically follows a small
current-output pointer. Its in-memory state is an optimization, not authority.

A native host may privately derive a lookup pointer from the verified closed
`SiteBuild`, exact renderer recipe, output schema, and options. The pointer and
its filesystem implementation are not public types, operations, or fields of
`SiteOutput`. A hit is accepted only after independently parsing the canonical
receipt and verifying every referenced ContentStore object. On a miss, ordinary
no-argument `finalize` constructs the receipt and the host advances the private
pointer last. Materialization happens once, from that receipt, inside the
existing atomic publication transaction. A staged mutable tree has no truthful
pre-render identity and is never cache authority.

## Ownership

- Rust owns source validation/capture, package-resolution decisions, compilation, `PreparedGuide`,
  target projection, Publisher need resolution, runtime construction, and
  canonical `SiteOutput` construction/validation through `SiteEngine`.
- The host acquires and mounts exact package bytes requested by Rust; it does
  not interpret dependency or template semantics.
- A renderer owns its declared output namespace and all output bytes.
- The host owns `ContentStore`, scheduling, private caches, handle lifetimes,
  and atomic publication.
- React owns presentation only. It never assembles semantic/template trees or
  carries renderer identity.
- The Service Worker serves committed output paths. It never asks a mutable UI
  adapter what an asset means.

## Deletion ledger

The migration is complete only when the old surface is gone, not deprecated in
place.

| Delete | Replacement |
| --- | --- |
| raw-input `buildSite(config, files, predefined, siteFiles, ...)` after compile | `prepare(project, generatorSpec)` captures inputs once; all later calls use its handle |
| public `mountSite -> mountTemplate -> produceStockSite -> openStockBuild` choreography | one Rust-owned Publisher preparation behind `prepare` |
| ambient `renderPage`, `renderFragment`, `listSitePages`, and mutable worker renderer globals | handle-scoped `outputs`, `render`, and `finalize` |
| mutable singleton `SiteGeneratorAdapter` registry | immutable opened build handles selected by generator specification |
| stock affine successor containing all previously rendered pages | independent path rendering against one immutable build |
| `SiteBuildSuccessor`, `ResolutionBatch`, and public artifact-promotion protocol | one immutable closed SiteBuild plus private per-handle output memoization |
| `StockAssetCatalog`, `assetBytes`, optional `assetManifest`, `baseHref`, and base64 asset maps | assets declared by `outputs` and stored as ordinary `ContentRef`s |
| editor-only HTML patches and dynamically supplied table backgrounds/runtime shims | renderer-owned outputs/transforms included in recipe and `SiteOutput` |
| Cycle `cycle-site/v1`, `compat.site_db/rows.json`, `JsonSiteBuildView`, `SqliteSiteBuildView`, `SITE_DB`, SQL Liquid capability, and v1/v2 dispatch | one strict `cycle-site/v2` closed `SiteBuild` view |
| reverse `site.db -> PreparedGuide` and v1 SiteBuild projections/features | direct `PreparedGuide -> cycle-site/v2 SiteBuild` only |
| TypeScript receipt sealing/creation and public `fig output-cache publish` | Rust `finalize` constructs/publishes the receipt; TypeScript independently validates it |
| public `OutputCacheKey`, `SiteOutputCache`, and `FileSiteOutputCache` | private host lookup pointer derived from functional receipt inputs |
| optional `finalize(handle, RendererOutput)` and public external-finalization flags | private renderer bind/admit transport followed by the same no-argument `finalize()` |
| native Fig staged `engine`, `fragment(s)`, `produce`, build-root `render`, template-dir materialization, and `watch` | closed-bundle `fig prepare/outputs/render/finalize` over SiteEngine |
| generation-specific HTML cache identity and regex normalization | canonical renderer bytes plus response-time preview control injection |
| overlapping normative architecture prose in root/subproject READMEs and `SPEC.md` | this document; other docs orient, operate, or explain one implementation |
| singleton project VFS plus global whole-tree replacement on every guide switch | project-scoped `WorkspaceRepository -> Workspace -> ProjectRevision` capture |

## Reduction rules and completion evidence

Every newly public symbol must remove an older public symbol in the same
change. Compatibility wrappers do not count as deletion. No new serialized
manifest may be added unless an old serialized representation is removed.

Completion requires evidence that:

- the public host table contains only `prepare`, `outputs`, `render`, and
  `finalize` for site generation;
- Cycle v1/`site.db` symbols, features, fixtures, commands, environment
  variables, branches, and documentation have zero callers and are deleted;
- FSH, predefined-resource, and authored-site bytes cross the worker boundary
  once per preparation; the private preflight carries config/template identity
  only for package acquisition;
- both generators use immutable handles and return content references;
- no site asset is transferred through base64 or a separate asset API;
- independent page renders are order-independent;
- both generators produce canonical `SiteOutput` values verified against the
  same contract fixtures;
- the preview publishes only verified output content and preserves navigation,
  hot reload, and scroll;
- Rust, Cycle, app, WASM, browser, deployed-origin, and performance gates pass;
  and
- the final API/type/serialization inventory is materially smaller than the
  starting inventory recorded by this ledger.
