# FHIR IG Editor working agreement

## Authority and safety

- Work only in `/home/jmandel/hobby/fhir-ig-editor` and its vendored repositories.
- Preserve the current dirty trees. The user explicitly authorized the current
  dependency-order commit, push, Pages deployment, and fresh-profile live
  verification. This authorization does not extend to destructive resets or
  unrelated repositories.
- The R4/R5 design is closed for this round. One build has one explicit target release; internal normalization remains private.
- The public site API remains exactly `prepare -> Build -> outputs/render/finalize`.
- The two Liquid implementations are intentional: Rust Liquid for Publisher and LiquidJS for Cycle. Do not add a third.

## Current live correctness checkpoint

The structural-output and architecture landing is live. Engine `652581b8` is
pushed identically to `snapshot-gen` and `main`; Cycle remains unchanged at
`d49e0b57`; editor `d0cf0228` is pushed to `main`. Pages run `29603160517`
passed every native/Rust/WASM/Cycle/app/Chromium build, artifact upload, and
deploy step. The live origin serves app `assets/index-IDEn-OIK.js`, Worker
`assets/engine.worker-DsQKJwf8.js`, and an optimized 8,011,948-byte WASM that
reports engine `652581b`.

The disposable-profile live receipt
`/tmp/fhir-landing-live-full-652581b8.log` ends in `E2E GATE: PASS`. It proves
Tiny SQL A -> B -> A, one-shell US Core CarePlan, 1,535/1,535 images and 85/85
assets, US Core TOC and Artifacts from `build-cache` with `fallback:false`,
real mCODE without a dependency error, Genomics, Cycle, restart persistence,
hot-reload scroll preservation, and mobile geometry. The live run explicitly
disables only the local-artifact mixed prepared/cold transport-coverage
assertion; Pages CI retains that assertion by default. Independent fresh-origin
receipts are also `ok:true`: US Core at
`/tmp/fhir-landing-live-uscore-652581b8.json` (cold 51.011 s, reload 6.875 s,
exact edit 1.736 s, reopen 0.872 s) and mCODE at
`/tmp/fhir-landing-live-mcode-652581b8.json` (cold 35.653 s, reload 6.316 s,
exact edit 1.251 s, reopen 0.528 s).

The exact post-cleanup Pages artifact
`a632ce642e03e36bd3f533f7e9f1ed3226b08bc978b619849b21970b83c87aac`
(204 files / 180,056,499 bytes; recipe `aa32c465...`) passes the complete
Pages-subpath browser gate at `/tmp/fhir-landing-deletion-browser.log`. It
proves Tiny SQL A -> B -> A, Tiny and US Core TOC/Artifacts with
`fallback:false`, one-shell US Core CarePlan, 1,535/1,535 images and 85/85
assets, real mCODE with both Extensions 5.2.0 and 5.3.0 resolved, Cycle,
restart/persistence, hot-reload scroll preservation, and mobile reachability.
The committed-stamp WASM is 8,038,038 bytes, SHA-256 `386df225...`, and reports
engine `652581b8`. The focused Rust gate passes SiteEngine 51/52 with one
fixture ignore, site_producer 14/14 plus 7/7 integrations, the full widened
release suite and wasm32 check; app 155/155, Cycle 240/240, and lifecycle/
identity 42/42 also pass. This is the exact local artifact evidence that
preceded the successful landing and independent live verification above.

The exact current four-guide frozen differential passes at
`vendor/sushi-rs/target/incremental-differential/landing-deletion-four-guide-20260717/aggregate.json`:
Tiny 603, IPS 1,012, US Core 2,155, and mCODE 1,639 complete outputs match in
fresh and retained A -> B -> A runs, both render orders, including every
ContentRef/body, ClosedSiteBuild, diagnostics, and final SiteOutput.

## Maintainability cleanup checkpoint (2026-07-17)

The deletion-first reconstruction is landed and independently live-verified.
The committed engine delta from
`c3c9f881` is 8,612 additions / 6,685 deletions (net +1,927); production crate
source is net +3,116 including SQLite, below the 3.5k–4.5k review budget. Disabled
dependency observation/page replay and the whole snapshot-completed cache are
gone. SiteEngine has exactly three `History2` owners: semantic compilation,
preparation, and runtime. `CompilationCandidate` and `TargetCandidate` remain
off-side until close/verification; the canonical ProjectRevision path has one
infallible `commit_success`.

It was landed as coherent dependency commits rather than one opaque interwoven
commit. No local green gate is deployment evidence.

### Landing contents

1. Structural TOC/Artifacts correctness in `site_producer`. It must emit
   ordinary closed outputs from one shared structural model used by bodies and
   page metadata. SiteEngine mounts one generic collision-checked produced-file
   catalog; it must not hard-code structural paths.
2. One immutable package environment and declarative package-file surface.
   Carriers, ordered labels, views, and lock material derive from one authority.
   This includes strict typed WASM input and the small direct-file resolver win.
3. Workspace per-path source projection and a bounded leading/latest-only edit
   scheduler. These are current-source/scheduling mechanics, not build caches.
4. Typed per-StructureDefinition snapshot recomposition, one canonical SD
   loader, authenticated immutable package-member proof with canonical fallback,
   current/previous bounds, tombstones, and failed-build nonpromotion.
5. Publisher SQL as one isolated Rust/SQLite capability. The current honest
   first slice covers own compiled Resources, CodeSystem relational rows, and
   basic ConceptMap rows with bounded read-only execution. It deliberately does
   not claim full Java `package.db` compatibility; unsupported tables fail
   explicitly. Accept the measured WASM cost and keep the capability reversible.
   A pinned Java schema/query/error oracle is required before broadening the
   compatibility claim.
6. The preview publication race fix, mobile reachability, and the one existing
   iframe remaining visible beside Author/Explore on wide screens. These stay
   UI-only and must not create another build or preview state.
7. Fresh-process restore and the external Cycle builder, both through the same
   `SiteBuild` lifecycle and bounded runtime history.

### Implemented invariants

- Publisher's staged-project/generation/closure/promotion graph is replaced by one
  owned `CompilationCandidate`, one owned `TargetCandidate`, close/verify, and
  one infallible `commit_success`.
- The overlapping preparation caches are replaced by one bounded
  `PreparationHistory2`. Retain exactly three histories: semantic, preparation,
  and runtime.
- One eager collision-checked Publisher catalog/ready inventory replaces
  the lazy output-plan/`OnceCell` catalog left by the rejected visible-first
  experiment; planning cost was only about 3 ms.
- Move authenticated in-memory objects into the content-store boundary instead
  of maintaining a SiteEngine mini content store.
- SQL expands once during Publisher model closure into ordinary page/include/data
  files. `render_page` and Liquid should not own a database or SQL lifecycle.
  Direct SQL output must be raw-isolated; `sqlToData` is site-global and
  deterministic. Unsupported compatibility tables fail explicitly rather than
  returning plausible empty results.
- Keep a small set of stable generic phase spans. Remove domain-specific
  microtiming structures and benchmark-only metric plumbing.

### Defer; do not include in the minimal landing

- The compiler instance evaluator. Its 368 ms IPS gain is real, but its roughly
  1k-line dependency/replay engine is the highest-risk and least natural added
  boundary. Preserve the experiment as reference. Reconsider only as an
  isolated compiler slice after the smaller stack is landed and remeasured.
- Declaration-level reuse, page carry-forward, and other selective execution.
  Unknown dependency facts still require the canonical path.
- Any PreparedGuide exact-result cache without an isolated qualifying result.

### Drop

- Disabled production dependency-observation/page-replay plumbing. It never
  authorizes incremental execution and all pages remain Unknown; retain only an
  external differential oracle if needed.
- Browser mirrors of Rust-active project/template resolution state.
- The separate `closed_cycle` cache; runtime history owns exact Cycle reuse.
- Preview observation callbacks, compiler/export microtimers, Publisher
  mounted-tree/artifact microtimers, and receipt-specific production fields.
- Generated Liquid capability JSON/manifest/generator/drift tests. Keep one
  concise hand-written capability page and executable behavior tests.
- Unrelated Ctrl/Option-word shortcut work from this batch.
- Chronological AGENTS experiment diaries and candidate-specific benchmark
  branches. Git history and frozen receipts are the archive.

## Target shape and acceptance

The steady-state execution flow is:

```text
Workspace -> ProjectRevision -> PackageEnvironment
          -> CompilationCandidate -> TargetCandidate
          -> close/verify -> commit_success
          -> Build(outputs, render, finalize)
```

Publisher's complete pre-render handoff is a closed ordinary file/data catalog;
render-time fragment lookup remains internal to the renderer. Cycle remains a
callback-free external builder consuming the same closed SiteBuild.

Aim for roughly 3.5k–4.5k net new production lines across all accepted slices,
including the mandatory SQLite capability, rather than the current roughly 10k
engine increase. This is a review budget, not permission to delete correctness.
Every optimization slice needs an independent measurement; every correctness
slice needs focused tests plus the relevant four-guide/browser/restore gates.
Measurement code must be generic, test-only, or removed before landing.

Completed landing order:

1. Commit the engine as coherent deletion/structural-SQL/snapshot/core/docs
   slices and push `snapshot-gen`, then fast-forward identical `main`.
2. Rebuild the committed-stamp WASM with the pinned toolchain.
3. Commit the editor UX/workspace/demo/gates plus exact engine pin and WASM;
   Cycle remains unchanged unless its tree actually changes.
4. Push editor `main`, monitor every Pages job through deploy, fix any failure,
   and verify the live origin from a fresh disposable browser profile.

## Toolchain

Use Rust 1.96, wasm32, wasm-bindgen 0.2.126, and Binaryen 117:

```text
PATH=/home/jmandel/.local/opt/binaryen-version_117/bin:/home/jmandel/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin:/home/jmandel/.cargo/bin:/usr/bin:/bin WASM_RUSTUP_HOME=/home/jmandel/.rustup WASM_CARGO_HOME=/home/jmandel/.cargo WASM_TOOLCHAIN_BIN=/home/jmandel/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin WASM_BINDGEN=/home/jmandel/.cargo/bin/wasm-bindgen SUSHI_RS_DIR=/home/jmandel/hobby/fhir-ig-editor/vendor/sushi-rs scripts/build-wasm.sh
```

Do not claim success from a local build alone. After any authorized push,
monitor the full Pages workflow through deploy and verify the live origin from a
fresh disposable profile. Known mCODE diagram 404s must remain explicit; never
claim zero failures when they are present.
