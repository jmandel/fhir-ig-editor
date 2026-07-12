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
fragment requests, resolution batches, cache records, preview sequence numbers,
and opaque handles are inputs or private execution details. They may contribute
to an identity, but they must not become alternative handoffs.

## The only host API

```text
prepare(project, generatorSpec) -> BuildHandle
outputs(handle)                 -> OutputCatalog
render(handle, path)            -> Output
finalize(handle)                -> SiteOutput
```

`BuildHandle`, `OutputCatalog`, and `Output` are scoped API views, not stored
domain values. A handle names one immutable `SiteBuild`; it is never authority
independent of that value. `Output` returns a path, media type, and `ContentRef`
whose bytes are already in the host's `ContentStore`.

Inputs cross the host boundary once. `prepare` captures them and owns package
resolution, compilation, semantic preparation, template materialization, and
target projection. Later operations accept only the returned handle. They never
accept raw FSH/config/site files again and never consult ambient "last build"
state.

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

## Renderer implementations

Cycle and Publisher templates share the host contract, not an implementation.

Cycle receives a callback-free, eagerly closed `cycle-site/v2` `SiteBuild` and
renders through the one shared LiquidJS/React implementation used by browser
and CLI. `cycle-site/v1`, `site.db`, row projections, SQL capabilities, and
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

A native external builder may probe `SiteOutputCache` from the verified closed
`SiteBuild`, exact renderer implementation/recipe, output schema, and options;
on a miss it publishes the ordinary canonical `SiteOutput` and addressed bytes
after rendering. Materialization is into the host's existing private atomic
publication transaction and is re-verified there. A staged mutable tree without
a closed `SiteBuild` (including legacy `fig render`) has no truthful pre-render
key and is not covered by this seam.

## Ownership

- Rust owns source capture, package resolution, compilation, `PreparedGuide`,
  target projection, Publisher need resolution, and canonical contract
  validation.
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
| `StockAssetCatalog`, `assetBytes`, optional `assetManifest`, `baseHref`, and base64 asset maps | assets declared by `outputs` and stored as ordinary `ContentRef`s |
| editor-only HTML patches and dynamically supplied table backgrounds/runtime shims | renderer-owned outputs/transforms included in recipe and `SiteOutput` |
| Cycle `cycle-site/v1`, `compat.site_db/rows.json`, `JsonSiteBuildView`, `SqliteSiteBuildView`, `SITE_DB`, SQL Liquid capability, and v1/v2 dispatch | one strict `cycle-site/v2` closed `SiteBuild` view |
| reverse `site.db -> PreparedGuide` and v1 SiteBuild projections/features | direct `PreparedGuide -> cycle-site/v2 SiteBuild` only |
| duplicate Rust/TypeScript receipt authority | one canonical contract implementation plus independent conformance fixtures |
| generation-specific HTML cache identity and regex normalization | canonical renderer bytes plus response-time preview control injection |
| overlapping normative architecture prose in root/subproject READMEs and `SPEC.md` | this document; other docs orient, operate, or explain one implementation |

## Reduction rules and completion evidence

Every newly public symbol must remove an older public symbol in the same
change. Compatibility wrappers do not count as deletion. No new serialized
manifest may be added unless an old serialized representation is removed.

Completion requires evidence that:

- the public host table contains only `prepare`, `outputs`, `render`, and
  `finalize` for site generation;
- Cycle v1/`site.db` symbols, features, fixtures, commands, environment
  variables, branches, and documentation have zero callers and are deleted;
- raw project inputs cross the worker boundary once per preparation;
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
