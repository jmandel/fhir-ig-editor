# FHIR IG Editor working agreement

## Active correctness round (2026-07-18, live and verified)

The user authorized dependency-order commit/push/deploy after complete gates.
This round fixes three live failures: PDEx package resolution and large VSAC
carrier preparation, SDC R4 `Expression` conversion, and preview timeouts/
ownership. Engine `e72ffa10` is pushed identically to `snapshot-gen`/`main`,
Cycle `45fac48` is pushed to `main`, and editor `7c3232bf` is pushed to `main`.
The initial Pages run `29671429179` was semantically green but exposed that the
workflow's floating Rust `stable` had advanced to 1.97.1. Editor commit
`7c3232bf` pins `dtolnay/rust-toolchain@1.96.0`; replacement Pages run
`29672331685` proves rustc 1.96.0 in its log and passed every native, Rust,
WASM, Cycle, app, complete Chromium, artifact-upload, and deploy job. Fresh
live full, PDEx, and SDC receipts against that exact deployment are green.

Preview protocol 8 has no total-duration deadline for activation, commit,
persisted-pointer read, render/content transfer, publication, or scroll
restoration. One exact committing WindowClient owns unresolved output; a 1 s
observation cadence detects that concrete client disappearing but missed
heartbeats never manufacture failure. Commit reposts are idempotent status
checks, and the Service Worker retains at most one completion waiter. Protocol
replacement reacquires a semantically compatible worker and replays the same
commit id. Schema-4/5 verified pointers and output caches remain readable until
the first successful schema-6 publication for that same IG; publishing another
guide cannot erase them. The physical protocol-8 worker and
its controls module are both versioned behind the protocol-6 compatibility URL.
The 60 s package transport guard is renewable no-progress policy, not total
work time or package validity. The former uncalibrated 250 ms Worker-recycle
grace is replaced by one task yield; Chromium exposes no memory-release
acknowledgement, so whole-browser memory gates—not a guessed sleep—remain
authoritative.

The timeout audit is explicit. No production `8_000 ms` deadline remains; the
only 8 s values are Cycle headless smoke-test process watchdogs and frozen
legacy fixtures. The preview protocol has no elapsed-time correctness deadline.
Its 1 s liveness poll is only an observation cadence and missed polls cannot
fail work. The app's 500 ms interval only repaints the displayed elapsed time,
and `setTimeout(0)` is one task yield after Worker termination. The renewable
60 s package no-progress interval is mechanically deterministic and fake-
scheduler tested, but 60 s is still an explicit dead-connection policy, not an
empirically calibrated truth. CI/benchmark watchdogs remain outside product
correctness so broken automation eventually terminates.

Streaming PreparedPackage v3 preparation retains canonical nested package
bytes without the old 256 MiB aggregate map. A frozen deployed-engine oracle is
exact: 1,077 bytes / SHA-256 `f5054d7b...42118`. Gzip CRC/truncation/
concatenation/tail and legacy JSON semantics are covered. The exact real
`us.nlm.vsac#0.18.0` carrier at `/tmp/us.nlm.vsac-0.18.0.tgz` has SHA-256
`50d8739f...bfbd`; native release preparation passes in 9.7 s: 95,737,525 input
bytes, 1,184,717,662 logical raw bytes, 30,151 members, and a 129,277,934-byte
v3 artifact (`8e485ea2...a191`). Sampled native single-process peak RSS was
543,316 KiB. The exact committed-stamp WASM is 8,097,098 bytes, SHA-256
`2733235a...bc4366`, and reports engine `e72ffa10`. The final semantic-source
combined-artifact PDEx receipt at
`/tmp/fhir-final-pdex.json` is `ok:true`: real preview, hard reload, and
same-Worker reopen all pass with no site error; cold Ready is 131.947 s,
persistent reload 12.075 s, reopen 0.555 s, observed whole-Chromium peak RSS
2,932,846,592 bytes, and peak observed WASM linear memory 1,212,743,680 bytes.
These whole-process values—not the 640 MiB per-call estimate—are the honest
browser cost. The 1.5 GiB logical, 32 MiB metadata, and 64x+8 MiB ratio bounds
remain resource policy, not package validity claims.

The final combined-artifact SDC receipt at `/tmp/fhir-final-sdc.json` is also
`ok:true`: cold 28.967 s, persistent reload 11.816 s, same-Worker reopen
0.482 s, real preview, no site error, 1,647,529,984-byte whole-Chromium peak,
and 422,445,056-byte peak observed WASM linear memory. This closes the reported
`SdcQuestionLibrary` R4 `Expression` preparation failure because the failing
conversion precedes SiteBuild closure.

Streaming preparation resource-policy exhaustion is now distinct from carrier
integrity failure at the package_store, private WASM envelope, and canonical
BuildError boundaries. It is non-retryable: the app does not fetch the same
coordinate from another registry, and explains that the package may still be
valid, the 640 MiB value is a per-call estimate, and native publishing is the
current alternative. Corrupt carriers retain the existing integrity fallback.
No cap changed. Package_store 67/67, focused WASM carrier 3/3, wasm32, focused
app 18/18, TypeScript, generated-contract drift, formatting, and diff checks
pass for this classification slice.

App 164/164 (892 assertions), focused preview 16/16 (117 assertions),
TypeScript, package_store 67/67, snapshot_gen 34/34, wasm_api 30/30,
SiteEngine 51 pass/1 fixture ignore, wasm32 release, and workspace all-target
checks pass. Independent final diff review found no remaining code blocker.
The complete Rust-1.96 committed-stamp artifact (206 files / 180,131,686 bytes, SHA-256
`5903f8b1...bf1`, recipe `aa32c465...b54`) passes the full Pages-subpath
browser gate at `/tmp/fhir-pdex-sdc-committed-stamp-browser.log` with protocol 8
and `E2E GATE: PASS`: exact deployed protocol-6 state/output A survives takeover
and a current Tiny B publication, Tiny SQL A -> B -> A, US Core one-shell/TOC/
Artifacts and 1,535/1,535 images + 85/85 assets, real mCODE/Genomics, two
zero-delay Worker recycles, restart/persistence, 601 ms Cycle hot reload with
scroll preserved, fallback after owner close, and mobile geometry.

The initial live deployment is functionally green. The disposable-profile
receipt `/tmp/fhir-pdex-sdc-live-full.log` ends in `E2E GATE: PASS` against app
`assets/index-BA9gjwRo.js`, Worker `assets/engine.worker-C_8XSV9A.js`, preview
protocol 8, and engine `e72ffa1`; it covers Tiny SQL A -> B -> A, US Core one
shell/TOC/Artifacts and 1,535/1,535 images + 85/85 assets, real mCODE/Genomics,
Cycle, restart, 569 ms hot reload with preserved scroll, and mobile geometry.
The isolated live PDEx receipt `/tmp/fhir-pdex-live-e72ffa1.json` is `ok:true`:
128.086 s cold, 11.948 s persistent reload, 0.562 s same-Worker reopen, 180
resources, verified preview in every phase, and no site error. The independently
restarted SDC receipt `/tmp/fhir-sdc-live-e72ffa1-summary.json` is `ok:true`:
29.381 s cold, 12.037 s reload, 0.532 s reopen, 201 resources, verified preview
in every phase, and no site error.

Do not use the initial CI artifact as the release checkpoint. Its downloaded
Pages artifact is 179 files / 113,709,498 bytes, SHA-256 `4b3e591d...f7c3`,
recipe `aa32c465...b54`, with an 8,071,346-byte WASM
(`9806c9ec...ec7b`); the job log proves Rust 1.97.1. It is only historical
semantic evidence.

The authoritative pinned-toolchain Pages artifact downloaded from run
`29672331685` is 179 files / 113,758,749 bytes, SHA-256
`98bf076d...553a`, recipe `aa32c465...b54`. Its 8,120,597-byte WASM has
SHA-256 `c3fe2e82...731`; a no-cache live-origin fetch has the same length and
hash, and the live app serves `assets/index-DjH2MThC.js` with Worker
`assets/engine.worker-DLOFb2r2.js`. The local explicit Rust-1.96 rebuild
reproduces the earlier 8,097,098-byte `2733235a...4366` WASM exactly. It is not
byte-identical to CI because release panic/source strings retain absolute Cargo
registry roots (`/home/jmandel/.cargo/...` versus `/home/runner/.cargo/...`).
Both embed rustc 1.96.0 and engine `e72ffa1`; use the downloaded/live CI hash,
not a cross-build-root equality claim, as deployment provenance. In this shell
`/usr/bin/rustc` precedes rustup and is currently Arch Rust 1.97, so release
checks/builds must use the absolute Rust-1.96 paths documented below rather
than assuming `rustc +1.96.0` reaches the rustup proxy.

The exact deployed-artifact full receipt
`/tmp/fhir-pdex-sdc-live-rust196-full.log` ends in `E2E GATE: PASS`. It proves
protocol 8, Tiny SQL A -> B -> A, one-shell US Core TOC/Artifacts and
1,535/1,535 images + 85/85 assets, real mCODE/Genomics, restart/persistence,
503 ms Cycle hot reload with scroll preserved, fallback after owner close, and
mobile geometry. Isolated receipts are also `ok:true` and carry the exact
`98bf076d...553a` provenance: PDEx at
`/tmp/fhir-pdex-live-rust196-summary.json` (125.357 s cold, 12.478 s reload,
0.573 s reopen, 180 resources, real preview in every phase, no site error) and
SDC at `/tmp/fhir-sdc-live-rust196-summary.json` (28.090 s cold, 11.373 s
reload, 0.502 s reopen, 201 resources, real preview in every phase, no site
error). The reported PDEx fixpoint/large-VSAC and SDC R4 `Expression` failures
are therefore independently closed on the live pinned build.

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
`d49e0b57`; deployed editor code is `d0cf0228`, and editor `main` includes the
subsequent documentation-only verification record. Pages run `29603160517`
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
