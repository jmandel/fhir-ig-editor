# PUBLISH — status & operations notes for `jmandel/fhir-ig-editor`

## 🧩 Task #40 — LIVE template loader (branch `template-live`, NOT merged)

Pick any `template#version` in the browser and the site renders with it. The
template package chain rides the SAME resolve→fetch→mount path as regular
packages; the engine's loader (`Session.mountTemplate`) then materializes it
byte-exact (walk_base_chain + union-copy + config deep-merge, ZERO ant). The
selector's DEFAULT experience is a curated set of key templates with LIVE
registry-fetched version lists (no typing); a free-text `id#version` input is the
demoted "advanced" affordance.

### Engine bump (already committed on this branch)

`vendor/sushi-rs` bumped `92ed7362` → **`d9dc53e1`** (`template_loader` +
`Session.mountTemplate`). `d9dc53e1` is on `jmandel/sushi-rs` `refs/heads/snapshot-gen`
(CI can fetch it). The wasm is rebuilt from the pin in CI; locally it was rebuilt
via `scripts/build-wasm.sh` (scratch 1.96.0 + wasm32-unknown-unknown toolchain,
wasm-bindgen 0.2.126). **wasm-parity gate PASS @ d9dc53e1** (verbatim):
```
engine: {"version":"0.1.0","commit":"d9dc53e1",...}
PASS  ladder: 17/17 (expected 17)
PASS  ips: 29/29 (expected 29)
PASS  mcode: 46/46 (expected 46)
PASS  sdc: 73/73 (expected 73)
WASM PARITY GATE: PASS
```
NOTE (breaking-ish, handled): at `d9dc53e1` the `resolve`/`bundle` subcommands
still exist in `rust_sushi` (used by `gen-packages-list.sh` + `bundle-packages.sh`),
so those scripts are unchanged — CI just rebuilds a fresh `rust_sushi` from the
new pin. A STALE pre-bump `rust_sushi` binary silently lacks output; CI's clean
build avoids it.

### As-built flow (resolve→fetch→mount→materialize→render)

- **WARM (default, committed artifact present):** stock adapter mounts the IG
  layer (`{project}-stock.json`), then `EngineClient.fetchTemplateArtifact(coord)`
  → OPFS materialized-tree cache (keyed by coord + engine commit) → else fetch the
  committed `data/templates/<coord %23>.json` (`fig packages bundle --template`
  output) → map `includes/*`→`_includes/*`, else→`template/*` → `mountSite(merge)`
  → write-through OPFS → `listSitePages` → render. No network beyond one same-origin
  artifact (HTTP-cached).
- **LIVE (custom coord / forced):** IG layer → `mountTemplateChain(coord)` walks the
  `base` chain (mirrors `fig::template::acquire_and_materialize`: read each
  package.json `base`+`dependencies[base]`, leaf→root, visited-guard), fetching +
  mounting each package via the SHARED transport (OPFS→local→baked→registry) →
  `Session.mountTemplate(coord)` materializes into the site tree → render. Both
  paths mount the byte-identical tree.
- **Failure:** custom-ant → `AntHookError` (message contains "never execute ant" /
  "server-side") → adapter throws a friendly "needs server-side rendering" Error →
  `selectTemplate` shows a non-wedging banner and falls back to the previous good
  template (which re-renders). Unfetchable chain → "could not obtain …", same fallback.

### Curated version catalog (default UX)

`app/src/adapters/templateCatalog.ts`: curated families = `hl7.fhir.template`,
`hl7.base.template`, `hl7.davinci.template` (the known no-ant-surprise stock
family). Each family's versions are fetched from the SAME CORS-open npm-style
endpoint #32 uses (`<registry>/<id>` → `Access-Control-Allow-Origin: *`, verified;
`dist-tags.latest` = the default selection, newest-first). Resilience ladder:
fresh-OPFS (1-day TTL) → live-fetch → stale-OPFS (last-known-good) → pinned
oracle-tested versions (the byte-gated `1.0.0` chains) — the selector NEVER wedges
offline. Oracle-tested versions carry a `✓ verified` badge; other versions run
through the same loader honestly (driven means driven), protected by AntHookError.

### Build-time dependency (NEW) + pipeline changes

- **`fig` (built from the submodule)** produces the warm-start artifact:
  `scripts/build-template-bundle.sh <id#ver>` → `fig packages bundle --template …`
  → `site-bundles/templates/<coord %23>.json` (committed). CI must build `fig` from
  `vendor/sushi-rs` (host target) before staging templates.
- `scripts/gen-packages-list.sh` now appends the stock template CHAIN
  (`hl7.fhir.template#1.0.0` → `hl7.base.template#1.0.0` → `fhir.base.template#1.0.0`,
  walked by `scripts/gen-template-chain.sh`) to `packages.list`; the **drift gate
  PASSES** with the chain included.
- `scripts/bundle-packages.sh` REPACKS template packages (their content lives at
  the Publisher-native top level, which `rust_sushi bundle` would strip) so all
  content sits under `package/` in the tgz — mounts as a complete template tree
  for the LIVE fallback source (a).
- `scripts/prepare-data.sh` stages `site-bundles/templates/` → `data/templates/`
  and the E2E fixtures → `data/fixtures/`.

### Gate evidence

- **wasm-parity: PASS** (above).
- **template-parity gate (`scripts/template-parity.mjs`): PASS** — live
  `mountTemplate` tree == packed `fig` artifact (179 == 179 render-affecting files;
  the `.derived-index.json` CAS byproduct is normalized out). This is the
  "live-mounted == packed-artifact" byte anchor.
- **E2E (`scripts/verify-e2e.mjs`, extended): see the block below** — curated
  version catalog populated (16 versions, default `1.0.0` published, `✓` verified),
  LIVE-path render matches warm, AntHookError refusal + non-wedging fallback.

### Merge / deploy steps (coordinator)

1. Engine first: `jmandel/sushi-rs` `snapshot-gen` already contains the pinned
   `d9dc53e1` — confirm `git -C vendor/sushi-rs rev-parse HEAD` = `d9dc53e1…` and it
   is pushed (it is on `refs/heads/snapshot-gen`).
2. CI builds `fig` + `rust_sushi` from the pin, regenerates bundles (incl. the
   repacked template chain) + the template warm-start artifact, runs the drift +
   template-parity + byte + E2E gates, deploys.
3. Live verify: Site preview → Template family = "HL7 FHIR IG template", Version =
   latest (✓ verified) → US Core `StructureDefinition-us-core-patient.html` renders
   with tables; switch Version / advanced coord loads live; a custom-ant template
   shows the "needs server-side rendering" banner without wedging.
4. Deferred: finer-grained per-page `invalidate` replay-skip (structural today);
   non-1.0.0 chains are not byte-gated (they run honestly through the loader).

## 🚀 F6 — branch `f6-integration`: DEPLOY SEQUENCE (coordinator runs this)

Everything below is committed on `f6-integration` (pushed) with local gates
green. The engine side lives on `sushi-rs` `snapshot-gen` (coordinator
verifies/pushes those commits first — the submodule pin here references them).

What ships: Session-only wasm API + render surface; SiteGeneratorAdapter v1
(cycle TS + stock FHIR-template Rust renderers) with the template selector;
TS-liquid sunset (engine ContentApi; byte-gate 17/17); live md staging; the
<1s warm-edit gate in verify-e2e; baked projects `cycle` AND `uscore`
(US Core is resource-authored — no FSH upstream); packed stock site bundles
under `site-bundles/` (committed; staged into `app/public/data/sites/` by
`scripts/prepare-data.sh` + the pages workflow).

1. **Engine first**: confirm `jmandel/sushi-rs` `snapshot-gen` contains the
   pinned submodule SHA (`git -C vendor/sushi-rs rev-parse HEAD`) and is
   pushed. CI clones submodules from GitHub — an unpushed pin = red build.
2. Merge `f6-integration` → `main`, push. `pages.yml` rebuilds the wasm from
   the pin (binaryen 117), regenerates bundles/manifests, runs the drift +
   consistency gates, deploys.
3. **Live verification** (the gates that matter, in order):
   a. https://joshuamandel.com/fhir-ig-editor/ loads; engine version footer
      shows the pinned commit.
   b. Open demo IG → Site preview: cycle generator renders index; switch
      Template to "FHIR IG template (Rust, stock)" → pages render.
   c. Edit `input/pagecontent/index.md` → stock-rendered page updates (<1s
      warm — this is the F6 gate; verify-e2e's `stockWarmEditMs` proves it
      headlessly at build time).
   d. Open US Core → wait for the resolver loop (registry fetches, first time
      is minutes; OPFS-cached after) → stock template lists ~960 pages →
      `StructureDefinition-us-core-patient.html` renders with tables.
4. **E2E harness note**: serve `app/dist` with a %23-faithful static server
   (`python3 -m http.server`), NOT `vite preview` (it SPA-fallbacks the
   encoded-`#` bundle URLs and the engine never boots).
5. Rollback = revert the merge commit; the wasm + data artifacts are all
   build-generated from the pin, so no stale-artifact hazard.

Known limits shipping with this (documented, not hidden): fragment kinds the
engine does not yet produce fall back to packed staged copies or a loud gap
marker (instance `-html` narrative = F4b); the us-core in-editor fragment set
is not yet byte-audited against the native corpus (the native page corpus IS
closed at 1332/1332 + 2 classified); `adapter.invalidate` is structural
(any compile drops the whole render state — the <1s gate passes without
finer-grained replay-skip, which remains a future optimization).

## Task #37 — "Open preview in new window" (branch `preview-window`, NOT merged)

A Service-Worker-backed REAL browser tab that serves the rendered IG site under
`<base>preview/<generator>/<page>` with real navigation (URL bar, links,
back/forward, F5) and smart hot reload. NO engine change — `vendor/sushi-rs` stays
pinned; the render path is the existing adapter surface (`renderPage`/`assetBytes`).

### As built (tiers, freshness, lifecycle, scope)

- **Virtual site via SW** (`app/public/preview-sw.js`, scope `<base>preview/`): the
  SW script sits at `<base>preview-sw.js` (app base = ancestor of the scope), so it
  claims `<base>preview/` with no `Service-Worker-Allowed` header. Confirmed working
  under the local `/`-base build; the same derivation (`new URL('./', self.location)`)
  yields `/fhir-ig-editor/preview/` for project Pages.
- **Three-tier answer ladder** (foolproof) for a `/preview/` GET:
  (a) **Cache API** (`igpreview::<generation>`): write-through of every served page +
  asset; survives editor-tab close and SW restarts.
  (b) **Live render**: SW → `clients.matchAll` → MessageChannel → an open editor tab
  renders via the adapter (`renderPage`/`assetBytes`); write-through; returned.
  (c) **Friendly fallback**: a self-contained 200 HTML page ("this preview isn't
  rendered yet — reopen the editor", auto-retry every 5s) — never a browser error.
- **Assets**: preview pages are served with `<base href="<base>preview/<gen>/<dir>/">`
  so EVERY relative ref (design css/js AND IG images) routes back through the SW. The
  responder resolves adapter-known bytes via `assetBytes`, and design assets the
  adapter serves from the app's static tree (cycle's `baseHref`) are fetched and
  relayed so they too ride the SW as real, cacheable URLs.
- **Freshness policy**: cache name carries the compile generation; the editor announces
  each new generation to the SW, which prunes to the newest 2 generations (a
  just-bumped, still-refilling generation can fall back to the previous complete one).
  Policy: **bump + lazy/eager refill** — the hot-reload pass eagerly re-renders OPEN
  pages into the new generation; other pages refill on demand.
- **Hot reload (designed-in)**: a tiny, clearly-marked (`data-igpreview`) client
  snippet injected ONLY into preview HTML opens a `BroadcastChannel('igpreview')`,
  announces `{generator,path,generation}`, and reloads itself ONLY when the editor
  broadcasts `{type:'reload', paths:[...]}` containing its path. On each new compile
  generation the editor re-renders every OPEN preview page, byte-compares the fresh
  render against the bytes currently in the SW cache (what the tab last showed —
  ignoring only the injected generation stamp), and broadcasts a reload for ONLY the
  changed pages. Debounced: a newer generation supersedes an in-flight pass. Reload =
  `location.reload()` (browser restores scroll); fetch-and-swap noted as future work.
  The snippet fails silent if the channel is gone (editor closed → tab stays static;
  the SW tiers still serve it).
- **SW lifecycle**: `skipWaiting()` (install) + `clients.claim()` (activate) so the
  newest SW controls `/preview/` immediately — safe because it governs ONLY `/preview/`.
- **Scope guards (asserted in code)**: the fetch handler returns early for any request
  not same-origin AND under `<base>preview/`. The editor app's own traffic — shell,
  `/pkg/` wasm, `/data/` bundles (incl. the %23-encoded `.tgz` URLs) — is NEVER
  intercepted (double protection: registration scope + pathname guard). The %23
  constraint is untouched because those URLs live under `/data/`, outside `/preview/`.
- **UI**: an "Open site in new window ↗" button in the preview bar (per selected
  generator + current page). `window.open` to the preview URL. Disabled with a tooltip
  when SW is unavailable (private windows / no-SW) — the in-pane preview is unchanged.
- **Multiple editor tabs**: the SW broadcasts the render request to all editor clients
  and takes the FIRST reply (the MessageChannel port resolves once — no double-answer).

### Foolproofing checklist (verified vs assumed)

- VERIFIED (headless Chromium, `scripts/verify-e2e.mjs` preview-window gate + standalone
  probe): SW registers + controls; preview page renders via SW; snippet injected;
  write-through to cache; cross-page link navigation; F5 reload; back/forward; smart
  hot reload (edited page's tab reloads, an UNRELATED open tab does NOT); editor-closed
  fallback ladder (cached page → 200; non-cached page → friendly fallback); button
  disabled path is code-guarded on `previewCapable`.
- VERIFIED: the SW never breaks the editor's %23-encoded bundle boot — every E2E run
  boots the engine with the SW registered.
- ASSUMED (not exercised headlessly): true private-window/no-SW degradation (the code
  path is the same `previewCapable=false` branch, asserted enabled in the normal case);
  Safari specifics; multi-editor-tab race under real concurrency (single-tab verified;
  the first-reply-wins logic is by construction).

### Gate evidence + latency (this build)

E2E `previewWindow` block: `previewCapable`, `indexRenderedLen 3594`, `snippetInjected`,
`cachedWriteThrough`, `crossPageNav` (418 KB profile page), `reloadLen 418781`,
`backWorked`, `forwardWorked`, `indexHotReloaded` (unrelated tab `unrelatedStayedPut`),
`cachedAfterClose {status:200}`, `fallbackAfterClose {status:200,isFallback:true}` →
`E2E GATE: PASS`. Latency: **live render 2 ms, cache hit 1.9 ms**; **hot-reload
edit→tab-updated ≈ 1.5 s** (300 ms edit debounce + warm stock compile/render).

### Merge / deploy steps (coordinator)

1. No engine dependency — `vendor/sushi-rs` stays at its pinned rev. Nothing to bump.
2. Merge `preview-window` → `main`. `app/public/preview-sw.js` is copied verbatim into
   `dist/` by Vite (confirmed: `dist/preview-sw.js` present), so it ships at
   `<base>preview-sw.js` under Pages. No workflow change needed.
3. CI runs `verify-e2e.mjs` (now incl. the preview-window gate) + tsc + vite build +
   the byte gates — all green locally.
4. Verify LIVE at `https://joshuamandel.com/fhir-ig-editor/`: open demo IG → Site
   preview → "Open site in new window" → navigate links/back/forward/F5; edit a page
   and watch the open tab hot-reload.

## ✅ Task #32 — arbitrary-IG runtime loading (SHIPPED; historical notes)

Branch `task-32-arbitrary-ig-loading` makes arbitrary IGs load at runtime with a
Rust-DRIVEN, host-TRANSPORTED package-acquisition loop. It depends on an
**additive** engine change (new `wasm_api` export `resolve_project`, and the new
`package_store::resolve` module + `context_closure_for_root`) that is
**uncommitted** in the `sushi-rs-snapshot` working tree (branch `snapshot-gen`):

- `crates/package_store/src/resolve.rs` (new) — the ONE resolution API:
  `resolve_project(config, mounted, cache, index) -> ResolutionStep {compile_set,
  context_closure, missing, satisfied}`. `compile_set` reuses stock's
  non-transitive `resolve_load_order_with`; `context_closure` ports
  `snapshot/package-deps.cjs`'s transitive R4-compat walk (each rule cites the
  `.cjs` line). Plus `context_closure_for_root` (the `.cjs`-equivalent, single
  published-root) + `version_index_from_cache`.
- `crates/package_store/src/lib.rs` — `pub(crate)` accessors on `ProjectConfig`,
  `PackageRequest` gains `Serialize/Deserialize`, and the `resolve` re-exports.
- `crates/wasm_api/src/lib.rs` — new `resolve_project(config, versionIndexJson)`
  export (thin marshal over `package_store::resolve_project` on the mounted set).
- `crates/package_acquisition/src/lib.rs` — `read_bundle` now strips the
  `package/` prefix + skips dir entries, so a RAW registry npm tarball mounts
  identically to a repacked bundle (parity-gated).
- `snapshot/package-deps.cjs` — rewritten as a THIN SHIM over `rust_sushi resolve
  --root` (DRY consolidation), with the original Node algorithm kept only as an
  offline fallback (byte-parity-gated on 8 IGs by `snapshot/package-deps-gate.sh`).

Engine gates (all green locally):
- `cargo test --workspace` — green (package_store resolve 7/7, package_acquisition
  raw-tgz parity, wasm_api resolver-equality).
- DRY parity: `snapshot/package-deps-gate.sh` = **8/8 IGs** Rust ↔ .cjs identical.
- E2E: `snapshot/arbitrary-ig-e2e.sh IG_DIR=<fhir-ips>` = resolve → fetch (bundle)
  → mount → compile (118) → snapshot (47 elems) for a NON-prepinned IG.
- SUSHI-harvest **326/326 cases, 256/256 byte-identical** (additive).

**Merge steps (IN ORDER, per the standard flow):**
1. Coordinator reviews + commits the engine change in `jmandel/sushi-rs`, pushes.
2. Bump `vendor/sushi-rs` in this repo to that commit (the wasm CI rebuild needs
   `resolve_project` in the submodule, else `acquireForProject` degrades to a
   no-op warning and arbitrary IGs won't fetch their closure).
3. Merge `task-32-arbitrary-ig-loading` → main. CI rebuilds wasm, runs the new
   package-list drift gate + DRY parity gate, byte-checks, deploys.
4. Verify LIVE: load fhir-ips (or another non-prepinned IG) end-to-end.

**CORS findings (empirical, 2026-07-03, `Origin: https://joshuamandel.com`):**
BOTH registries are CORS-open for direct browser fetch — no proxy needed in the
common case.
- `packages.fhir.org`: `Access-Control-Allow-Origin: *` on BOTH the metadata
  (`/{id}` → JSON) and the tarball (`/{id}/{ver}` → 200 `application/tar+gzip`).
  OPTIONS preflight → 204, `Allow-Methods: GET`, `Allow-Origin: *`. **Clean.**
- `packages2.fhir.org/packages`: also `Access-Control-Allow-Origin: *`, but the
  tarball is a **302 redirect** to `/web/<id>-<ver>.tgz` (the redirect ALSO carries
  `ACAO: *`, so browsers follow it). CAVEAT: it emits a DUPLICATE ACAO header
  (`https://joshuamandel.com` AND `*`) with `Allow-Credentials: true`, which some
  browsers reject — so the editor tries `packages.fhir.org` FIRST (clean single
  `*`), packages2 as fallback (`app/src/vfs/packageSettings.ts`).

Lockfile un-handing (gate v): `scripts/packages.list` is now GENERATED by
`scripts/gen-packages-list.sh` (native resolver over `vendor/cycle` + the r5.core
snapshot-engine special). CI drift gate (`CHECK=1`) fails if the committed list
diverges. Regenerate: `FHIR_CACHE=<dir> scripts/gen-packages-list.sh`.


## ⏳ Task #22 — deploy is GATED on an engine commit (2026-07-03)

Branch `task-22-terminology-lazy` adds lazy cold-start + tiered terminology. It
depends on an **additive** engine change (two new `wasm_api` exports:
`expand_enumerable`, `mount_bundles`; `BundleSource: Clone`). That change is
**uncommitted** in the `sushi-rs-snapshot` working tree (branch `snapshot-gen`),
in:
- `crates/wasm_api/src/lib.rs` — `expand_enumerable(vs, resources)` (tier-1
  wrapper over `compiler::terminology`) + `mount_bundles(bundles)` (additive
  lazy mount; the engine `bundle` is now an `Rc<BundleSource>` appended
  copy-on-write) + a `tests/expand_api.rs` native gate (4 tests).
- `crates/package_store/src/bundle.rs` — `#[derive(Clone)]` on `BundleSource`.

**Deploy sequence (coordinator):**
1. Review + commit the engine change in `jmandel/sushi-rs`, push it.
2. Bump `vendor/sushi-rs` in this repo to that commit (currently pinned at the
   pre-change `5390b38`, which LACKS the two exports — CI would build an engine
   that breaks init/expansion).
3. Merge `task-22-terminology-lazy` → main; CI rebuilds wasm from the bumped
   submodule, runs the byte-check + the new consistency gate, deploys to Pages.

Gates (all green locally): engine `cargo test -p compiler -p wasm_api
-p snapshot_gen -p package_store` (all suites ok, incl. new expand_api 4/4 +
oracle_tx 1/1); SUSHI-harvest **326/326 cases, 256/256 byte-identical**;
snapshot_gen parity (ips 29/29 covered); wasm-vs-native byte-check **10/10
identical**; consistency gate **PASS** (0 committed entries + 2 self-tests);
extended E2E **PASS** (cold-start progress, lazy r5 defer, VS tab 5 codes,
external-filter refusal). Cold start 9.7s→6.1s, warm 9.7s→2.2s (0 fetches).

## ✅ PUBLISHED (2026-07-03)

- [x] Repo public: https://github.com/jmandel/fhir-ig-editor
- [x] Engine diagnostics change landed in `jmandel/sushi-rs`;
      `vendor/sushi-rs` bumped to `4edef7b` (was pre-change `209effd`)
- [x] `vendor/cycle` pinned @ `aa10e71`; `.gitmodules` carries real https URLs
- [x] Pages enabled (Source: GitHub Actions)
- [x] CI package acquisition fixed (see design note below) — the first deploy
      run after publish (28648330577) failed on an empty `.fhir-cache`
- [x] Live: https://joshuamandel.com/fhir-ig-editor/

## CI package-fetch design (added post-publish)

CI populates `.fhir-cache` by downloading the pinned closure from the FHIR
package registry (`packages.fhir.org`, fallback `packages2.fhir.org`):

- **`scripts/packages.list`** — the single source of truth for the closure,
  consumed by both `fetch-packages.sh` (download) and `bundle-packages.sh`
  (bundle). It documents WHY each package is present. Notably **r5.core stays
  even though cycle is an R4 IG**: the snapshot walk engine is R5-internal, so
  R4 profile bases resolve against r5.core during snapshot generation — without
  it the snapshot-tree view (a core M1 deliverable) breaks. It ALSO carries the
  **transitively-declared exact-version pins** `hl7.terminology.r4#7.1.0` and
  `hl7.fhir.uv.extensions.r4#5.2.0` (branch `bundle-closure`) — see the
  closure-completeness note below.
- **`scripts/fetch-packages.sh`** — idempotent per-package download+extract to
  `.fhir-cache/<id>#<ver>/package/`; the engine derives its
  `.derived-index.json` sidecar itself, so plain registry tarballs suffice.
- **`actions/cache`** wraps `.fhir-cache` keyed on `hashFiles('scripts/packages.list')`
  (~240 MB) — repeat runs are a no-op; the registry is hit once per closure change.
  This is CI's only registry traffic; no live tx server is ever called.
- The SPA build uses **bun** (`bun install --frozen-lockfile`) — the committed
  lockfile is `bun.lock`, so the original `npm ci` could never have worked.
- **binaryen is a pinned release (117), not apt**: the runner's apt ships
  binaryen 108, whose `wasm-opt -Oz` corrupts wasm-bindgen's externref table —
  the first deployed wasm died at init in the browser with
  `Table.grow(): failed to grow table by 4` (caught by the live headless-Chromium
  check). `build-wasm.sh` also skips wasm-opt below binaryen 116 as a backstop.

### Known limit — exact-version transitive deps (branch `bundle-closure`)

The engine's compile load is NON-transitive (stock SUSHI parity): automatic deps
(`hl7.fhir.uv.tools.r4` / `hl7.terminology.r4` / `hl7.fhir.uv.extensions.r4`)
resolve at `latest` = highest cached, so cycle's cold-start compile loads
terminology.r4 **7.2.0** and extensions.r4 **5.3.0**. But the engine's separate
TRANSITIVE `context_closure` (`crates/package_store/src/resolve.rs`, ported from
`snapshot/package-deps.cjs`) walks a **configured** dependency's `package.json`
and demands its declared deps at their EXACT pin. `tools.r4#1.1.2` declares
`hl7.terminology.r4#7.1.0` + `hl7.fhir.uv.extensions.r4#5.2.0` — DIFFERENT
versions than the compile's `latest`-picked 7.2.0/5.3.0.

- **Impact**: any user IG (or the baked-seed E2E probe) that lists
  `hl7.fhir.uv.tools.r4` under `dependencies:` needs BOTH versions present. On a
  registry-denied live env, the closure blocked on 7.1.0/5.2.0 (they weren't
  baked) — the baked-seed E2E gate failed against production.
- **Fix (closure-completeness)**: `scripts/gen-packages-list.sh` now appends every
  declared **exact-version** dep of a closure package that isn't already present
  (DERIVED from the packages' own `package.json`, not hand-listed), so
  `packages.list` + the baked bundles carry 7.1.0/5.2.0. `bundle-packages.sh`
  marks them `defer:true` (supersession-shadowed: a strictly higher version of the
  same id is in the closure, so no cold-start compile needs them — only a
  configured-`tools.r4` context walk does). Added ~5.4 MB of bundles, ALL deferred
  off the cold-start critical path (fetched lazily / on the acquisition ladder).
  The engine's `by_name` index mounts both versions of an id simultaneously, so
  this is additive — the compile set is unchanged and byte-check stays **10/10**.
- **Why it masked locally**: `obtainPackage`'s first ladder rung is the OPFS warm
  cache. A prior local session that opened US Core (whose closure DOES pull
  terminology.r4#7.1.0/extensions.r4#5.2.0, then from a reachable registry)
  OPFS-cached those tgz, so the probe served them from OPFS with zero registry
  hits and passed. CI (fresh Chromium profile → empty OPFS) had no such cache and
  blocked. **Repro the CI state**: delete `app/public/data/bundles` +
  `app/dist/data/bundles`, rebuild from `packages.list`, and run E2E against a
  fresh `--user-data-dir` profile.

---

## Original pre-publish checklist (kept for the record)

## 0. Prerequisite: land the engine change first

The engine gains one **additive** change this repo depends on: `compile()` now
returns SUSHI-exact **diagnostics** (wording + file + line). Without it the
editor's Problems panel / Monaco markers are empty.

- The change lives **uncommitted** in the `sushi-rs-snapshot` working tree
  (branch `snapshot-gen`), in:
  - `crates/compiler/src/lib.rs` — a `CompileDiagnostic {severity,message,file,line}`
    type; the internal ruleset-expansion + SD-export `diag` collectors now build
    these (attaching the insert-rule's file+line where in scope) instead of bare
    strings; `CompiledProject.diagnostics`; a new
    `build_project_in_memory_with_diagnostics(...)`.
  - `crates/wasm_api/src/lib.rs` — `compile()` serializes a structured
    `diagnostics: [{severity,message,file?,line?}]` array (was `[]`).
- It is **additive**: no resource bytes change (harvest 326/326 still byte-clean).
- **Action:** review + commit it in `sushi-rs`, push to `jmandel/sushi-rs`, then
  **bump `vendor/sushi-rs` in this repo to that commit** (currently pinned at the
  pre-change `209effd`). The locally-built wasm in `app/public/pkg/` was compiled
  from the *working tree with the change*; CI rebuilds from the submodule, so the
  submodule MUST point at the committed change or CI's engine will lack diagnostics.

Gates for the engine change (all pass locally):
- `cargo test --workspace` — green.
- SUSHI-harvest: **326/326** case parity, 100% byte-identical (unchanged).
- wasm diagnostic roundtrip: a broken FSH file yields
  `{severity:"error", message:"Unable to find definition for RuleSet …",
  file:"input/fsh/…", line:N}`; a clean IG yields `0` diagnostics.

## 1. Create the repo + push

```sh
gh repo create jmandel/fhir-ig-editor --public --source . --remote origin --push
# or: gh repo create jmandel/fhir-ig-editor --public  &&  git remote add origin … && git push -u origin main
```

`.gitmodules` already carries the real GitHub URLs
(`https://github.com/jmandel/sushi-rs.git`, `https://github.com/jmandel/cycle.git`).
They were cloned locally via `insteadOf` rewrite; on a networked box a plain
`git submodule update --init --recursive` resolves them normally. **Ensure both
submodule remotes exist and contain the pinned commits** (sushi-rs must contain
the diagnostics commit from step 0; cycle @ `aa10e71`).

## 2. Enable Pages

- Repo Settings → Pages → Source: **GitHub Actions**.
- The workflow (`.github/workflows/pages.yml`) needs `pages: write` +
  `id-token: write` (already declared) and the environment `github-pages`.

## 3. First CI run — things to watch

- **wasm-bindgen version**: CI installs the CLI version parsed from
  `vendor/sushi-rs/Cargo.lock` (must match the crate's `wasm-bindgen`). Local
  build used **0.2.126**.
- **Package cache / bundles** (spec §8 steps 4-6): CI materializes the cycle
  closure into a scratch cache, then `scripts/bundle-packages.sh` bundles the
  5-package closure (r4.core, uv.tools, terminology, uv.extensions, r5.core).
  If the cycle IG has no lockfile for `materialize`, commit a maintainer-built
  cache or adjust `FHIR_CACHE` — see the `bundle-packages.sh` header. **No live
  tx.fhir.org calls in CI** (hermetic; §6 tier 3).
- **Base path**: the SPA is built with `BASE_PATH=/fhir-ig-editor/` for project
  Pages. If served at a user/org root, set `BASE_PATH=/`.
- **`data/` + `app/public/pkg/` are gitignored** (regenerable, large — the wasm
  is ~2.5 MB, bundles ~16 MB). CI regenerates them; nothing heavy is committed.

## 4. Submodule URL notes

```
[submodule "vendor/sushi-rs"]  url = https://github.com/jmandel/sushi-rs.git   # pin: <diagnostics commit>
[submodule "vendor/cycle"]     url = https://github.com/jmandel/cycle.git      # pin: aa10e71
```

Local clones used:
`git -c url."file:///home/jmandel/hobby/sushi-rs-snapshot".insteadOf=https://github.com/jmandel/sushi-rs.git …`
(and the analogous `file:///home/jmandel/hobby/periodicity-impl/cycle` for cycle).
`.gitmodules` records the https URLs, so no rewrite is needed once the remotes are public.

## Local verification (evidence, this build)

- App builds: `tsc -b` clean, `vite build` OK (Monaco bundled, no CDN).
- **E2E in headless Chromium** (`scripts/verify-e2e.mjs`): open demo IG → 10
  resources compiled in **~100 ms** → 0 diagnostics on the clean IG → snapshot
  tree **49–60 elements** in ~50 ms → introduced FSH error → diagnostic
  `"Unable to find definition for RuleSet NoSuchRuleSet."` at `input/fsh/…:N`.
  Edit→feedback well under the 1 s M1 gate.
- **Byte-check** (`scripts/byte-check.mjs`): all **10/10** wasm-compiled cycle
  resources byte-identical to native `rust_sushi build`; the only native-only
  file is the ImplementationGuide (in-memory compile skips it by design).

## M2 site preview (spec §7) — BUILT on branch `m2-preview` (not yet on main)

The M2 site preview (cycle's TS site generator rendering real IG pages IN THE
BROWSER from a Rust-produced site.db) is implemented on branch **`m2-preview`**.
It depends on an **additive engine change** that is NOT yet in the pinned
`vendor/sushi-rs` submodule, so the branch must NOT merge to main until the
engine commit lands and the submodule is bumped.

### Engine dependency (additive, uncommitted in `sushi-rs-snapshot`)

The editor's `build_site_db` worker call needs a new wasm export + two additive
engine seams (all left uncommitted in the `sushi-rs-snapshot` working tree,
branch `snapshot-gen`):

- `crates/compiler/src/lib.rs`: new `build_project_in_memory_with_ig(...)` — the
  in-memory compile path now CAN emit the ImplementationGuide (fed a page-folder
  listing instead of a `std::fs` scan). `ig_export`'s `IgInputs` gains an optional
  `page_dir_listing` (disk path passes `None` → byte-identical `std::fs` scan).
- `crates/site_db`: `build_from_inputs(...)` + `assemble_rows(...)` — S5/S6 over
  fully in-memory inputs; `augment` gains a `FileSource` trait (disk vs VFS). The
  SQLite writer (S7) is now behind a default `sqlite` feature so the wasm build
  (`default-features = false`) links the row model + pipeline WITHOUT C-sqlite.
  Row model structs are `Serialize` (SQLite/core-db.ts column casing; assets
  base64).
- `crates/wasm_api`: new `build_site_db(input_json) -> rows JSON` export. Builds
  the snapshot context over ONLY the FHIR core package (matching the native
  pipeline — loading the whole mounted closure inflated snapshots vs the oracle).

Engine gates (all green locally):
- `cargo test --workspace` green; `-p compiler -p wasm_api -p snapshot_gen -p
  site_db --release` green (incl. NEW `site_db::inmem_vs_disk` — in-memory rows ==
  disk rows JSON-identical for cycle — and `wasm_api::site_db_snapshot` — the
  build_site_db snapshot counts == disk pipeline).
- SUSHI-harvest **326/326** case parity, 100% byte-identical (engine change is
  additive; disk `ig_export` path unchanged).
- wasm byte-check: **10/10** cycle resources byte-identical wasm vs native.

### Merge steps for main (do these IN ORDER)

1. Coordinator reviews + commits the engine change in `jmandel/sushi-rs`, pushes.
2. In this repo on `m2-preview`: `git -C vendor/sushi-rs fetch && git -C
   vendor/sushi-rs checkout <engine-commit>`; `git add vendor/sushi-rs`;
   commit "Bump vendor/sushi-rs to <commit> (M2 build_site_db)".
3. Rebuild data locally to sanity-check: `bash scripts/prepare-data.sh` (now also
   runs `copy-site-assets.mjs`), then `cd app && bun run build`.
4. Merge `m2-preview` → main. CI (`pages.yml`) rebuilds the wasm from the bumped
   submodule (so `build_site_db` is present), bundles + exports manifest + copies
   site-assets, byte-checks, deploys.
5. Verify the LIVE URL end-to-end (headless-Chromium E2E already extended:
   `scripts/verify-e2e.mjs` opens the Preview tab, renders index + a profile page,
   edits a title, asserts the preview updates).

### M2 as built (architecture)

- **Row store (JS):** a thin typed `RowStore` (`app/src/preview/rowStore.ts`)
  implementing `core/db.ts`'s exact query surface over the wasm-produced rows —
  NO wa-sqlite (cycle's pages use no `{% sql %}`; a tiny `SELECT … FROM <table>`
  interpreter covers the documented Metadata case, fail-loud otherwise). The
  submodule's `core/db` (bun:sqlite) is redirected to a shim (`dbShim.ts`) via a
  Vite `resolveId` plugin so importing `Layout`/`Menu` never opens a file DB.
- **SSR in the Worker:** `app/src/preview/render.tsx` re-implements `build.tsx`'s
  per-page selection + `Layout`-wrapping (build.tsx is a Bun script, not callable)
  by importing the submodule's pure pieces via a `@cycle/*` alias. Shims:
  `react-dom/server` → the BROWSER build (the node build needs `util`/`stream`);
  `process.env.SITE_*` defined as `undefined` (project config fallbacks);
  submodule bare deps (react/liquidjs/markdown-it/fhirpath/fast-xml-parser)
  aliased to this app's node_modules. Wrapper-generated includes absent from IG
  source (e.g. `sample-viewer-links.md`) render an honest in-editor placeholder
  instead of failing the page.
- **Preview tab:** a sandboxed iframe renders the selected page's HTML (`srcDoc`)
  with a `<base>` to the copied design assets and IG images served via blob URLs.
  Render-on-demand per visible page (M2 scope, stated in the UI as "on-demand
  render"); recompile → rebuild rows → re-render the current page.
- **HTML fidelity:** the in-browser rendered profile/VS/CS/artifacts/narrative
  pages are IDENTICAL to the native TS pipeline's output for cycle after
  normalizing the known blob-URL/`<base>`/timestamp differences.

## Out of scope this run

- OPFS is used with an in-memory fallback; Safari degrades to no-persistence
  (stated in spec §11, not hardened here).
