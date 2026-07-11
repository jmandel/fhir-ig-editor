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
