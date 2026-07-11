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

Dependency landing receipts for this overhaul:

- `jmandel/sushi-rs` `579cacf4` is pushed to `snapshot-gen` and `main`.
- `jmandel/cycle` `9aba386` is pushed to `main`.
- The editor pins those commits and rebuilds WASM from `579cacf4`; its local
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
  exact-version ordering is refreshed from `579cacf4`. The union helper also
  rejects an unsatisfied resolver result instead of writing a partial list from
  an incomplete cache.
- Node WASM parity/consistency gates construct isolated `Session` handles; no
  active editor, script, or workflow calls the deleted `Session.global()`.

## Current verification

Green static/native evidence:

- Engine: focused compile-reuse 6/6; wasm_api 35 pass/2 ignored; Session 8/8;
  package resolver/store and Publisher facade regressions; workspace check;
  wasm32 check; current browser WASM rebuilt (6.3 MB).
- Cycle: renderer typecheck and 237/237 tests (641 assertions).
- App: 43/43 tests (276 assertions), current Pages-base production build green
  at 1,130 transformed modules. The count includes the deterministic late-layout
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

The exact artifact's US Core benchmark is
`/tmp/uscore-benchmark-architecture-final.json`: cold 87.982 s (129.1 MB
package-like network), fresh-worker persistent warm 7.204 s (104 bytes
package-like HTTP bookkeeping), and same-worker reopen 5.609 s. Warm package
init/mount is 1.466 s (20.4%); `prepare` is 4.234 s and `outputs` 0.571 s.
Same-worker `prepare` is 3.901 s and `outputs` 0.165 s. Transport is no longer
the main floor, but this is slower than the prior 5.13-5.34 s fresh-worker
PreparedPackage-only checkpoint because the coherent Publisher facade now
prepares and publishes the complete 908-output/runtime catalog. Do not present
7.2 s as instant; the next performance work belongs inside compile/Publisher
preparation/catalog reuse, not another transport or preview layer.

Pre-optimization warm-edit profiling was 1,799-1,848 ms: ~300 ms debounce,
672-688 ms unnecessary compile, ~444-504 ms Publisher preparation/catalog,
20-33 ms preview commit, and ~275-340 ms page reload/scripts/polling. Exact
prose-only compile reuse removed the compiler component without lowering the
budget or debounce.

Known fidelity boundary discovered by the real mCODE gate: current catalog and
live-GitHub allowlists omit `input/images-source/*.plantuml` and project-local
`#template` directories. mCODE's stock Publisher generates
`patients-with-cancer-condition.svg` from such a source; this browser preview
does not generate that figure. Safe unresolved generator/template products no
longer reject unrelated pages, but the coherent future fix is complete source
capture plus a generator-owned generated-asset artifact bound to source,
template/tool bytes, and options (or an authenticated precomputed result). Do
not add another guessed path allowlist or masquerade the result as authored.

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
