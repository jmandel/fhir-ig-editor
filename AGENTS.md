# Session handoff

## Authoritative worktree

Work only in:

```text
/home/jmandel/hobby/fhir-publisher-rs/fhir-ig-editor
```

`/home/jmandel/hobby/fhir-ig-editor` is the clean published checkout, not this
session's worktree. Preserve the intentional dirty trees. Do not commit or push
unless the user explicitly asks. The engine has additional operating guidance
in `vendor/sushi-rs/AGENTS.md`.

## Current objective

Complete and certify the deletion-first architecture overhaul. The only domain
values are:

```text
PreparedGuide -> SiteBuild -> SiteOutput
                      |
                 ContentStore
```

The site host surface is exactly:

```text
prepare(project, generatorSpec) -> handle
outputs(handle)                  -> catalog
render(handle, path)             -> output ContentRef
finalize(handle)                 -> SiteOutput
```

`ARCHITECTURE.md` is the one normative cross-repository contract and deletion
ledger. Do not restore compatibility wrappers, v1 values, mutable adapters,
asset side channels, host callbacks, or parallel serialized build formats.

## Landing-ready architecture receipt (2026-07-12)

The deletion-first overhaul is locally complete. The exact current browser
receipt is `/tmp/fhir-architecture-overhaul-browser-final18.log` (`E2E GATE:
PASS`). It proves Tiny, Cycle, US Core (212 resources, 1,535/1,535 images,
85/85 assets, one-shell CarePlan), real mCODE with no fallback, mCODE -> Cycle
reopening, terminology refusal, persistence, scroll, and mobile geometry.

Browser hardening is part of the architecture: cold raw packages are prepared
one at a time into authenticated `.fpp` artifacts and staged into one atomic
Rust mount transaction; long decode/normalize work never holds the Session
borrow; and the Worker owner recycles before a third distinct project (or after
a package-only generation), while OPFS and the Service Worker retain authority.
Publisher prose edits reuse exact keyed RenderSemantics/package artifacts and
layer an `Rc` site map without copying the mounted tree. Measured edit: 1.64s
end to end, Rust prepare ~0.85s, render-model 2ms (from ~3.0s / 1.35s).

Focused gates: app 78/78 (422 assertions), Cycle 236/236 (651 assertions),
SiteEngine 17 pass/1 fixture ignored, WASM 3+5+8, Fig 17+4, Pages build 1,135
modules, and renderer/entrypoint type+bundle checks. Engine `43f56b99` is pushed
identically to `snapshot-gen` and `main`; Cycle `0837fcc` is pushed to `main`.
Editor `13f5c60` pins both and is pushed to `main`; Pages run `29187917106`
passed the complete build, fresh-profile Chromium gate, and deployment. The
public origin was then verified to serve asset `index-CWF8U-Ne.js`, worker
`engine.worker-CQqy9kW6.js`, preview Service Worker protocol 5, and the
`43f56b9`-stamped engine.

## Architecture convergence checkpoint (2026-07-11)

**NATIVE FIG FOUR-OP MIGRATION ACTIVE (2026-07-12):** uncommitted engine work
now provides atomic `SiteEngine::prepare_project`, fresh-process Publisher
restoration from only `ClosedSiteBuild + ContentStore`, and native Fig
`prepare/outputs/render/finalize`. The old Fig staged engine, fragment(s),
produce, template materializer, watch server/benchmark, CLI routes, and direct
dependencies are deleted. A real Tiny guide gate against the complete baked
R4 core produced a 1,799-file canonical SiteOutput from a fresh restored
process; receipt `so1-sha256:5409669b...`, 36,752,344 output bytes. Captured
predefined JSON/XML now has disk-parity ordering and rejects unsafe entry
paths; four focused tests pass. Generic strict restoration now admits Cycle v2;
LiquidJS still owns outputs/render while Rust `finalize` alone constructs and
caches SiteOutput for both the ordinary Cycle site and its outer QA/viewer
publication. The public `output-cache publish`, TypeScript receipt constructors
and sealing, site-producer filesystem seam, and unused SiteBuild successor/
resolution protocol are deleted. A real two-pass native run produced the same
91-file receipt and skipped Liquid rendering on its verified cache hit. Full
current-WASM Chromium certification is still running. This checkpoint is not
committed or pushed.

Native Cycle external finalization now carries the exact renderer-opened
`inputBuildId`; Fig rejects a different independently restored build before
staged-tree authentication, and Cycle validates the build id Fig returns. The
outer wrapper propagates the inherited receipt's input id.

Cycle's independent regression floor now mutates the known Rust receipt across
unsafe/reserved/duplicate/unordered/owner-open/content-reference cases and
exercises adoption against missing, extra, symlinked, and post-adoption changed
trees. Atomic publication requires an adopted Rust receipt. Native renderer
recipe inputs are re-hashed around fresh finalization and immediately before a
cache-hit rename; drift aborts. Cycle's complete current gate is 236/236 tests
(651 assertions), configured renderer typecheck, and both native entrypoint
bundles.

## Historical checkpoints (superseded by the current block above)

The next deletion pass is active in the engine worktree. Publisher
`ClosedSiteBuild + ContentStore` can now reconstruct a fresh SiteEngine handle
and runs through the same runtime/model/render/catalog helpers as live prepare;
the focused parity fixture compares complete catalogs, reverse-order page bytes,
and canonical SiteOutput. The closure now explicitly roots each compile
package's optional `other/spec.internals`, including proof of absence, and live
rendering uses the same narrowed package view instead of ambient nested package
bytes. This state is uncommitted and not yet a completion claim: migrate native
Fig prepare/outputs/render/finalize next, then delete its staged engine/watch/
fragment/materialization surface and update docs/gates.

The target-neutral `crates/site_engine` crate now owns resolver-scoped package
views, exact semantic compilation, complete PreparedGuide construction, Cycle
projection, Publisher template/runtime/model/render/catalog preparation,
bounded current+previous runtime retention, independent rendering, verified
content reads, Publisher finalization, and typed Cycle external finalization.
Runtime installation and PublisherRuntime construction are crate-private.
`wasm_api` is a thin parse/transport facade (1,537 lines) over one typed
`SiteEngine::prepare`; its duplicate preparation implementation is deleted.

Publisher's closed SiteBuild now has a nonempty rooted artifact closure over
the four semantic documents, six authored roles, materialized template tree,
assembled runtime files with provenance/reads, exact source revision, and every
locked package; every addressed byte is verified before handle installation.
Fresh-process RenderState reconstruction from that closed build + ContentStore
remains the next executor step and is not claimed by the current live handle.
Independent gates: SiteEngine 13 pass/1 ignored, WASM 5+8, site-build 29,
site-producer 16, Fig 17+4, render-page 8, workspace check, and wasm32 check.

The fresh Pages-subpath browser receipt is
`/tmp/fhir-site-engine-workspace-full-final.log` (`E2E GATE: PASS`) against
engine `1fc84f51`. It caught and fixed two target/transport regressions before
landing: Rust `Instant` is unsupported on this WASM target, so metrics now use a
host-supplied monotonic clock; and parsed predefined JSON plus its exact raw
authored bytes are one source channel. Authenticated immutable package/object
bytes are shared and admitted once rather than re-hashed on every closure walk.
Stock warm edit is 1,443 ms with 590 ms Rust prepare; the same run proves Tiny,
Cycle, US Core 1,535/1,535 images + 85/85 assets, one-shell CarePlan, real mCODE,
restart persistence, scroll 640 -> 640, and mobile geometry.

The first deletion pass is complete: Fig's unused predecessor-bound revision
promotion path, the orphaned `render_page::stock` collector, and the closed-CAS
replay adapter were deleted (1,349 lines). Direct legacy staged-tree Fig
render/watch still exist and must not be wrapped; migrate them to the completed
`SiteEngine` four-operation flow, then delete `fig::engine`, `WatchState`,
`watch_bench`, fragment/materialization commands, and their docs. Focused
`site_engine` + `wasm_api` tests are green (2+39+5+8), as are the deletion
pass's Fig 17/17 + envelope 4/4, render_page 8/8, and site_build 29/29 gates.

The editor singleton project store is replaced by per-project `Workspace`
ownership: mutable Workspace -> immutable captured ProjectRevision -> prepare.
Transactional source generations, stale-replacement guards, one mutable owner,
crash-readable edits, latest-open leases, and dirty offline reopen preserve
A -> B -> A edits and avoid the measured 376.7 ms archive unpack plus 359.5 ms
global-store rewrite. App gates are 77/77 (411 assertions), TypeScript, and the
1,135-module production build. Cross-editor-tab mutation synchronization is not
yet claimed; one editor instance is the workspace owner.

## Current performance slice (locally complete; dependency commits landed)

Editor `6236511a` is pushed and deployed. Pages run `29175980426` passed the
complete build, browser gate, artifact upload, and deploy jobs. The live origin
served the new asset at 02:14 UTC and its application bundle contains the new
self-referential guide.

Dependency landing for the completed performance slice:

- engine `ef8e77ac` is pushed identically to `snapshot-gen` and `main`;
- Cycle `9246180` is pushed to `main`; and
- editor `31466c4c` pins both dependency commits and is pushed to `main`;
  Pages run `29179195857` passed build, Chromium closure, artifact upload, and
  deploy, and the live WASM carried engine stamp `ef8e77a`.

The performance work composes existing contracts only:

- the browser may restore the Service Worker's already-validated immutable
  preview pointer before engine initialization, but it must remain visibly
  previous/stale until the current `prepare` and publication succeed;
- native Cycle may look up and publish only canonical `SiteOutput` through
  `FileSiteOutputCache`, keyed from the verified closed `SiteBuild` and exact
  renderer recipe/options; and
- prose-only rebuilds may privately reuse snapshot-completed local resources
  only under compiled-resource, exact-package-closure, resolver-order, and
  snapshot-recipe identity. Current authored inputs must still construct a new
  complete `PreparedGuide`.

Do not add a raw-project cache authority, eagerly finalize all Publisher pages
in the browser, or wrap legacy staged-tree `fig render` in a path-derived cache
identity.

Current measurements (fresh disposable Chrome profile, rebuilt
WASM/app) are in `/tmp/uscore-perf-recent-compile.json`:

- persistent US Core hard reload exposes the previous verified preview at
  798 ms and serves `en/index.html` from the Service Worker at 913 ms; the exact
  current build becomes Ready at 6.889 s (7.160 s benchmark tail). This is an
  explicitly stale presentation fast path, not current-build authority;
- US Core -> Cycle -> US Core is 1.820 s, down from the prior 5.348 s. The
  one-previous exact semantic compilation makes `compileProject` 116 ms, and the
  retained Publisher runtime hit reports the existing `siteBuildCacheHit=1`,
  keeps the same handle/render memoization, and makes Rust preparation 182 ms.
  The remaining floor is principally 376.7 ms catalog-project unpack, 359.5 ms
  project persistence, 161.5 ms output-catalog transport, and UI scheduling;
  and
- native Cycle's exact complete-output cache receipt is
  `/tmp/cycle-output-cache-final.log`: first render/import 1.588 s, unchanged
  verified rebuild 0.487 s wall (153.2 ms Fig lookup/materialization), identical
  91-file `SiteOutput`, and Liquid rendering skipped.

The focused prose-successor proof is
`/tmp/fhir-snapshot-local-warm-edit.log`: `snapshotCompletedLocalCacheHit=1`, a
new complete PreparedGuide/SiteBuild, 37 ms PreparedGuide work, 295 ms Rust
prepare, and 1.078 s edit-to-preview for the small first-run guide. Do not
extrapolate that small-guide phase to US Core.

The dependency-landed exact artifact passed the full fresh-profile Pages-subpath
gate at `/tmp/fhir-perf-landed-full-gate.log` (`E2E GATE: PASS`): stock warm
edit 1.067 s
with a real snapshot-local hit; US Core 1,535/1,535 images, 85/85 assets, and the
CarePlan one-shell invariant; real mCODE with no fallback/error; protocol-5
restart and editor-close persistence; scroll 640 -> 640; and 390px Author 329,
Explore 329, Preview 490 with no occlusion. App 66/66 (376 assertions), current
WASM build, Pages-base production build (1,135 modules), Fig 18/18 + 4/4
envelope, Cycle 239/239, typecheck, and focused native cache gates are green.
The final US Core benchmark is `/tmp/uscore-perf-recent-compile.json`. The
performance slice is complete, pushed, deployed, and live-verified.

## Current UX round

The user asked to replace the odd Cycle first-run experience, make the mobile
preview usable, and replace simultaneous indefinite loaders with truthful
transport progress. That round is implemented and locally certified.

- `demo/tiny-guide` is now the purpose-built first-run project, titled “The
  Guide That Describes Its Editor.” It is a four-resource R4 FSH guide rendered
  with exactly `hl7.fhir.template#1.0.0`. Its intended teaching path is
  `00-EditorUser.fsh -> StructureDefinition/editor-user ->
  StructureDefinition-editor-user.html`; the example already satisfies the
  suggested `name.given 1..* -> 2..*` edit. Cycle remains available and is
  clearly labelled as the external-builder fixture.
- One `ProgressEvent` semantic now flows end to end: `bytes` means response-body
  bytes actually consumed and `totalBytes` is an expected transport size. Only
  known-total downloads show a determinate bar; unknown-total downloads show a
  byte counter; verify/unpack/compile/mount/build are text-only work phases.
  The duplicate status line, tab spinner, and indefinite project-open bar are
  removed. Baked packages, registry packages, catalog archives, baked project
  manifests, and live GitHub files report real streaming progress.
- The 390px layout keeps Author/Explore as single surfaces, makes Problems a
  fixed overlay with reserved closed-handle space, and removes redundant
  overview/trail chrome in Preview. Do not
  use `display:none` for the opened-project status-line grid item: the app has
  explicitly placed grid rows, and removing that node shifts the workspace out
  of its `1fr` row. It must remain in flow at zero height.
- The exact reviewed Pages-subpath fresh-profile receipt is
  `/tmp/fhir-tiny-progress-mobile-reviewed-final3.log` (`E2E GATE: PASS`). At
  390x667 it measured Author 329px, Explore 329px, Preview 490px, no overflow,
  no closed Problems-handle overlap, and no preview shrink when Problems opened.
  The same run proved the tiny guide's causal source/definition/page path and
  exact active template while preserving a different global user preference,
  no duplicate or indefinite loaders, measured MB labels, explicit unpack
  phases, US Core 212 resources plus 1,535/1,535 images and 85/85 assets,
  one-shell CarePlan, real mCODE, lazy R5, protocol-4 restart, and scroll 640 ->
  640 after hot reload. Stock warm edit was 1,189 ms.
- App tests are 65/65 (369 assertions); the Pages-base TypeScript/Vite build is
  green at 1,135 modules; the native tiny guide build is green; package-list
  resolver drift and `git diff --check` are green. The focused mobile gate now
  asserts instead of merely printing; its receipt is
  `/tmp/fhir-mobile-layout-reload-final2.log` (`MOBILE LAYOUT GATE: PASS`); it
  additionally proves a persisted Tiny reload displays/builds 1.0.0 while
  preserving a different global template preference.

## Implemented state

- The UX/performance round is implemented and locally certified. The app now opens with two outcome-
  oriented choices, then presents a compact project overview and one focused
  Author/Explore/Site preview workspace instead of three permanently visible
  panes. Generator/template/package/terminology controls live in one advanced
  Build settings disclosure; Problems is a collapsed drawer; 720px and 390px
  layouts use single-surface selectors. Unit/type/build checks are green. The
  real browser gate exposed a stale generated-WASM mismatch (the client expected
  new prepare metrics that the old browser artifact did not emit); rebuilding
  `app/public/pkg` fixed it and the focused browser shows 16 Cycle resources and
  a 48-row snapshot. Generated WASM is gitignored, so always rebuild it after a
  dirty engine wire change before trusting an app/browser result.
- Hidden UI is not allowed to perform hidden engine work. `ResourceInspector`
  is now mounted only in Explore, and `prepare` no longer fetches the deferred
  R5 snapshot bundle. The first explicit snapshot inspection owns that lazy
  mount. The browser gate records and rejects any R5 fetch before the inspector.
- The next performance pass has a metrics-only sidecar on the existing
  `prepare` result. It measures compiler boundary, Rust/host preparation, source
  manifest/project revision, package lock, PreparedGuide key/build/cache hit,
  template materialization, Publisher runtime/model, render model, catalog, and
  total time. It adds no operation, cache, or domain value. Publisher now keeps
  and consumes that one PreparedGuide through `ProducerInputs::from_prepared`,
  typed authored-file staging, and a direct per-handle RenderSemantics/
  RenderState; the same phase names measure the simplified path without
  restoring the removed reconstruction or ambient render surface.
- Browser `input/examples/*.json` now enters the same parsed local-resource map
  as `input/resources`, never a second semantic channel. Compiler-owned stock
  directory order keeps resources before examples, render-set paths preserve
  the exact source root (so equal basenames cannot collide), and the generated
  IG's example metadata carries through PreparedGuide to exact output subjects.

Dependency landing receipts for this overhaul:

- `jmandel/sushi-rs` `86d34573` is pushed to `snapshot-gen` and `main`.
- `jmandel/cycle` `5883663` is pushed to `main`.
- The editor pins those commits and rebuilds WASM from `86d34573`; its local
  gate is necessary but the GitHub Pages workflow remains the deployment
  authority.

- Rust owns source capture, exact package resolution, compilation,
  `PreparedGuide`, target preparation, Publisher template/runtime/fragment work,
  canonical `SiteOutput`, and bounded current+previous immutable handles.
- Cycle consumes one callback-free `cycle-site/v2` build. `cycle-site/v1`,
  `site.db`, SQLite/row views, dual dispatch, ingest, and the outdated Cycle
  builder are deleted. Its one shared LiquidJS renderer has a complete
  collision-checked output catalog plus authenticated renderer package.
- The editor's site API is `prepare/outputs/render/finalize`; old stock/Cycle
  adapters, ambient renderer state, base64 asset APIs, template-tree helpers,
  generation manifests, and derived-artifact cache are deleted.
- The final host/worker audit also deleted the uncalled standalone `compile`
  RPC/cache/helpers, raw `mountBundles` RPC, bundle-bearing `init`, unused
  package-identity reply, and broken ambient-renderer fidelity script. Worker
  initialization is parameterless and `mountPackages` is the sole transactional
  package mount seam; compilation for a site occurs only inside `prepare`.
- The legacy v3 inflated/base64 bundle-cache migration reader is deleted. The
  only persistent warm package form is PreparedPackage v2; a missing/corrupt
  artifact safely reacquires its exact baked transport, explicit local package,
  or registry coordinate.
- Preview publishes one immutable `{igId, handle, buildId, catalog}` pointer.
  The protocol-4 module Service Worker verifies ContentRefs in OPFS, renders
  only unresolved pages, persists across editor/SW restart, and injects one
  shared response-time base/hot-reload/scroll control module.
- Publisher runtime assets are renderer-owned outputs. Rust assembles exact
  core/template/authored precedence, fixed licensed assets, generated table
  backgrounds, and the exact-pair-gated jQuery bridge. Browser package bundles
  now normalize the *complete* cache tree into one transport `package/` root;
  this retains native sibling `other/**` as `package/other/**`.
- Resolver schema 3 roots context traversal at every compile-set member. Exact
  automatic/transitive package dependencies are acquired without retargeting;
  the mCODE multi-version extensions case is covered.
- Native Fig preserves every exact coordinate in a multi-version closure and
  resolves each manifest dependency from its own requested version. The Cycle
  v2 integration therefore supports simultaneous automatic-latest and exact
  transitive terminology/extensions versions without by-id retargeting.
- Publisher preparation now allows source-less navigation only for explicitly
  generated non-Markdown pages. Missing authored Markdown still fails loudly;
  this fixes mCODE's generated `artifacts.html` without a slug special case.
- `compileProject` privately reuses the exact prior semantic compile when
  config, parsed FSH, predefined resources, normalized page listing, and full
  `ResolvedPackages` match. It always captures the new authored site files;
  any compiler-visible identity change takes the real compile path.
- Normative README/runbook prose is updated. A stale Pages invocation of the
  deleted `site-gen/ingest.ts` and a stale Cycle tsconfig entry were removed.
- The package-list drift recipe resolves through `cargo run` from the pinned
  engine checkout. It accepts no ambient binary override, so a stale target
  executable cannot make a local drift check disagree with CI; the generated
  exact-version ordering is refreshed from `2de40588`. The union helper also
  rejects an unsatisfied resolver result instead of writing a partial list from
  an incomplete cache.
- Node WASM parity/consistency gates construct isolated `Session` handles; no
  active editor, script, or workflow calls the deleted `Session.global()`.

## Current verification

The first Pages run for editor `818d215` reached the byte-parity gate after all
earlier build/data gates passed, then failed because `scripts/byte-check.mjs`
still called the deleted standalone `Session.compile`. Editor correction
`5f0422e` uses the complete `resolveProject -> compileProject` boundary, seeds
mutable version selection from its exact mounted labels, mounts the full
multi-version Cycle closure, and captures every non-FSH authored input byte.
The exact local reproduction passed 10/10 byte-identical WASM/native resources,
with only the expected disk-only ImplementationGuide native output. Pages run
`29161468247` then passed the byte gate, all engine/Cycle/app/browser gates,
artifact upload, and deploy. The live origin served that deployment with engine
`86d3457` and the new outcome-oriented welcome screen.

Green static/native evidence:

- Engine: compiler 20/20; site_producer 16/16; wasm_api 35 pass/1 ignored; Session 8/8;
  package resolver/store and Publisher facade regressions; workspace check;
  wasm32 check; current browser WASM rebuilt (6.3 MB).
- Cycle: renderer typecheck and 239/239 tests (662 assertions).
- App: 56/56 tests (345 assertions), current Pages-base production build green
  at 1,134 transformed modules. The count includes the deterministic late-layout
  scroll-restoration regression; removed standalone compile-helper tests remain
  deleted.
- Complete browser transport regression proves R4 core resources plus
  `other/fhir.css`, `other/icon_element.gif`, and `other/tbl_spacer.png`.
- Prior correct-base run after the transport fix rendered Publisher, Cycle, and
  US Core. US Core had one shell, 1,535/1,535 decoded images, and 85/85 runtime
  assets. The compatibility gate now checks the correct `publisher-runtime`
  owner rather than the deleted editor producer.

The authoritative Pages-subpath fresh-profile browser gate is GREEN; full JSON
and logs are in `/tmp/fhir-full-gate-final3.log`. It proved:

- real Cycle and Publisher pages plus arbitrary package-template acquisition and
  fail-closed unsupported custom-Ant refusal;
- real US Core (212 resources, 908 outputs), patient hierarchy, 1,535/1,535
  decoded images, 85/85 runtime assets, no browser exceptions, and the reported
  CarePlan page with exactly one html/body/header/footer, zero nested shells,
  zero remote tab panels/links;
- real mCODE Publisher `en/index.html` with no error/fallback, including the
  exact dependency, generated-page, unresolved-generator-include, and mixed
  R4-target/R5-support cases that previously failed one after another;
- smart page-scoped hot reload with scroll 640 -> 640, unrelated tabs untouched,
  reload/history, module-Service-Worker restart, editor-close persistence, and
  verified ContentStore/build-cache sources; and
- stock warm edit 1,234 ms under the unchanged 1,500 ms gate. Two earlier runs
  after compile reuse measured 1,251 and 1,191 ms.

The exact `86d34573`/`5883663` overhaul artifact also passes the expanded gate;
the complete receipt is `/tmp/fhir-overhaul-final-gate4.log`. In addition to the
coverage above it proves exact keyboard Source→Definition→Published-page
navigation, Arrow-key/ARIA tabs, definition filtering in 4.5 ms, no R5 fetch at
boot/prepare/Explore followed by a lazy fetch only after Generate snapshot, and
the real 390px layout with no overflow and 323px Author/Explore plus 302px
Preview work areas. Warm edit was 1,181 ms and hot reload preserved scroll
640→640 in 1,380 ms. The CarePlan regression remained one html/body/header/footer
with no nested shell, and mCODE rendered with no fallback or dependency error.

The final deletion-built artifact exposed one intermittent background-tab
scroll-restoration race in a later run: the saved position was removed before
layout had actually accepted it, while its remaining animation-frame/timeouts
could be throttled. Response controls now install at the start of `head`, retain
a generation/SHA-bound target until confirmed, restore on document/load/
pageshow/ResizeObserver lifecycle signals, correct late template-script scrolls,
and cancel immediately for trusted user input. The focused regression is green
(8/8 preview tests), as is the Pages-base build. Two consecutive fresh-profile
full gates passed with scroll 640 -> 640; the second includes the legacy-worker
upgrade fixture and its complete JSON receipt is
`/tmp/fhir-full-gate-scroll-fix.log` (`E2E GATE: PASS`). That receipt also proves
US Core, mCODE, protocol-4 restart/persistence, and a 1,256 ms hot reload.

The exact artifact's current US Core benchmark is
`/tmp/uscore-overhaul-final.json`: cold 79.972 s (112.7 MB package-like
network), fresh-worker persistent warm 7.102 s (104 bytes package-like HTTP
bookkeeping), and same-worker reopen 5.348 s. Warm package init/mount is 1.346 s
(18.9%); `prepare` is 4.138 s and `outputs` 0.623 s. Same-worker `prepare` is
3.797 s and `outputs` 0.169 s. The new phase metrics locate same-worker prepare
at compileProject 1.689 s plus Rust prepare 2.056 s: PreparedGuide 0.896 s,
template materialization 0.313 s, render model 0.379 s, catalog 0.107 s, and
the smaller remaining phases. Transport is no longer the floor. Do not present
7.1 s as instant; the next performance work belongs in exact compile/
PreparedGuide/SiteBuild reuse and canonical SiteOutput scheduling, not another
transport or preview representation.

Pre-optimization warm-edit profiling was 1,799-1,848 ms: ~300 ms debounce,
672-688 ms unnecessary compile, ~444-504 ms Publisher preparation/catalog,
20-33 ms preview commit, and ~275-340 ms page reload/scripts/polling. Exact
prose-only compile reuse removed the compiler component without lowering the
budget or debounce.

Known fidelity boundary discovered by the real mCODE gate: catalog and
live-GitHub inputs now capture `input/images-source/*.plantuml` into the typed
PreparedGuide boundary, but project-local `#template` directories remain
outside the supported source set and PlantUML execution is not implemented.
mCODE's stock Publisher generates
`patients-with-cancer-condition.svg` from such a source; this browser preview
does not generate that figure. Safe unresolved generator/template products no
longer reject unrelated pages; the coherent future fix is a generator-owned
generated-asset artifact bound to captured source, template/tool bytes, and
options (or an authenticated precomputed result). Do not masquerade the result
as authored.

## Remaining work

1. Retain the documented PlantUML/source-capture boundary as follow-up design
   work.
2. After every editor push, inspect the actual GitHub Pages workflow and live
   artifact. A local green build is not a successful deployment.

## Invariants

- Labels are not persistent package identities; cache keys bind exact prepared
  package identities for every compile/context/support member.
- Persistent locks are hints: refresh mutable authorities, acquire exact
  coordinates, mount transactionally, and require Rust to reproduce closure.
- Publish content before pointers; every read rechecks digest and length.
- Cycle is callback-free and Publisher need resolution stays inside Rust.
- Site assets are ordinary outputs and ContentRefs, never a second asset API.
- Numeric preview generations order commits but never identify content.
- Two Liquid engines are intentional: Rust Liquid for Publisher and LiquidJS
  for Cycle. There is no third implementation.
