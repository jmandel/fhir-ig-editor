# Session handoff

## Post-compaction resume rule

Read the newest user message before deriving work from this handoff. Closed
topics are constraints, not pending tasks. Do not resume, answer, research, or
delegate a closed topic merely because it appears in a compacted summary.

## Authoritative worktree

Work only in:

```text
/home/jmandel/hobby/fhir-ig-editor
```

The user explicitly made this the session worktree on 2026-07-15. Do not resume
repository work in `/home/jmandel/hobby/fhir-publisher-rs/fhir-ig-editor`;
historical receipts may remain there and unrelated app edits now exist there.
Preserve intentional dirty trees. Permission to push from this tree is not a
request to push unfinished work. The engine has additional operating guidance
in `vendor/sushi-rs/AGENTS.md`.

## Current objective

**PROPER INCREMENTALISM, SNAPSHOT SLICE (ENGINE LANDED; EDITOR LANDING ACTIVE
2026-07-15):**
all repository work is rooted in this checkout. Canonical compilation and the
public `prepare -> outputs/render/finalize` API are unchanged. SiteEngine now
records an opaque bounded dependency manifest for each StructureDefinition
snapshot (positive/negative fetch, selected body/order, local/package origin,
package id, canonical version, and recursive reads), revalidates against a
fresh current PackageContext, and reuses only exact resource derivations while
constructing a new complete PreparedGuide. Promotion is off-side until full
PreparedGuide success. Current and previous successful semantic generations
are the hard lifetime bound; empty or over-budget successes install empty
tombstones so old facts still age out. Generated values/manifests are shared by
`Rc`; byte metrics are explicitly logical/approximate, not process memory.

Focused release evidence is green: snapshot_gen 15 unit + all integration
suites, SiteEngine 36 pass/1 fixture ignore, and Fig 14 pass/1 exhaustive
ignore. Tests cover inactive observation, per-manifest overflow, package-backed
origin/body invalidation, negative/preference facts, transitive invalidation,
real public `prepare_project` A -> B reuse, failed-successor nonpromotion,
aggregate tombstone eviction, and `Rc` sharing. The authoritative frozen
four-guide receipt is
`vendor/sushi-rs/target/incremental-differential/snapshot-reuse-four-guide-final2-20260715/aggregate.json`:
`pass`, 4/4. Tiny/IPS/US Core/mCODE compare 1,799/2,233/3,848/2,872 complete
outputs in forward and reverse orders across compilation, diagnostics,
ClosedSiteBuild closure and bytes, catalogs, every ContentRef/body, and final
SiteOutput. Tiny/IPS/US Core retained B have classified partial resource reuse;
mCODE's site-only edit deliberately uses the older whole-snapshot cache. Tiny's
injected uniquely missing base fails with the typed preparation error and then
recovers on the same engine to a fully rendered/finalized B byte-identical to
fresh B. Native retained-vs-fresh-B PreparedGuide time is 37 vs 41 ms Tiny,
466 vs 660 ms IPS, and 236 vs 573 ms US Core; retained Rust prepare is 144 vs
318 ms, 783 vs 1,154 ms, and 1,007 vs 1,631 ms respectively. Remaining
semantic-edit cost is now dominated by canonical render-context construction
(about 230 ms IPS and 577 ms US Core). The render-context follow-up and combined
WASM/browser evidence below close those items for this round.

**PROPER INCREMENTALISM, RENDER PACKAGE-CATALOG SLICE (ENGINE LANDED
2026-07-15):** `render_sd::IgContext` separates an immutable `Rc`
package metadata catalog from a fresh own-resource/tx/tree/lazy-cache overlay.
On a semantic edit SiteEngine shares only package entries; it rebuilds current
own mappings, mixed lookup/body caches, FragmentEngine, RenderState, catalog,
pages, and final output. The key binds engine recipe/API, primary IG identity,
the exact first FHIR version and ordered dependsOn pairs read by selection,
exact compile-lock carriers, resolver-ordered labels, and package root;
render_sd independently rechecks ordered dependencies and selected core.
History is current+previous and promotes only after complete runtime install.
Metrics distinguish catalog hit/build, fresh own context, entry/generation
counts, `renderSemanticsMs`, and `renderStateMs`. Focused selection, stale-
cache, key, identity-miss, and bounded A -> B -> A tests pass. The authoritative
receipt is
`vendor/sushi-rs/target/incremental-differential/render-package-catalog-four-guide-v2-20260715/aggregate.json`:
`pass`, 4/4, with 1,799/2,233/3,848/2,872 complete outputs. It requires this
reuse for Tiny/IPS/US Core, exact RenderSemantics for site-only mCODE, canonical
fresh construction, failed-successor recovery, and return-A non-masquerading.
Retained/fresh render-semantics time is 79/98 ms Tiny, 154/245 ms IPS, and
343/605 ms US Core; RenderState is only .15/2.5/30 ms. Retained Rust prepare is
136/719/807 ms.

**PREPARSED OWN-RESOURCE + BOUNDED CATALOG FOLLOW-UP (ENGINE LANDED; EDITOR
LANDING ACTIVE 2026-07-15):** current PreparedGuide resources now enter IgContext as parsed
values; the old serialize-to-session-tree then parse-back pass is deleted.
Own-resource maps, tx state, and lazy mixed caches remain fresh. A read-only
review found pseudo-JSON's rare referenced-own-SD path still bypassed the new
value map; one shared `load_resource_path` seam now covers preparsed and
filesystem/package paths, with an explicit profiled-type byte-equivalence
regression. Package-catalog admission is capped at 1,024 packages, 100,000
resource/spec entries, and 32 MiB deterministic logical weight. Over-budget
successful generations install same-key tombstones and current+previous is the
hard lifetime bound. Real Publisher preparation tests now prove late staged
failure nonpromotion, over-budget tombstone/rebuild, restored admission, and
loader equivalence. Focused tests are green. The corrected authoritative frozen
receipt is
`vendor/sushi-rs/target/incremental-differential/render-bounded-own-four-guide-final2-20260715/aggregate.json`:
`pass`, 4/4, 1,799/2,233/3,848/2,872 complete outputs and all existing failure/
return invariants. Retained/fresh Rust prepare is 128/313 ms Tiny, 680/1,134 ms
IPS, 722/1,604 ms US Core, and 122/1,242 ms mCODE (site-only exact semantics).
Retained/fresh render-semantics is 71/88, 111/198, and 266/532 ms for Tiny/IPS/
US Core. Catalog logical weights are .25/2.72/7.22/4.19 MB, below the 32 MiB
bound. The first pre-fix bounded run was intentionally interrupted and remains
non-evidence. Current-source native suites, workspace all-target check, fmt,
Rust 1.96 WASM 15+5+8, app 149/149, Pages-base production/lazy-boundary build,
and the complete browser receipt `/tmp/fhir-incremental-render-full-browser-final.log`
are green. The first browser attempt lacked generated Cycle renderer-package
data and failed honestly; the canonical static-data assembly corrected the
artifact before the full rerun. The passing receipt includes Tiny/Cycle, US Core
1,535/1,535 images and 85/85 assets with one shell, real mCODE, restart,
navigation/scroll, mobile geometry, and atomic registry retry.

The final reviewed one-repeat fast browser measurement is `ok:true` at
`vendor/sushi-rs/target/benchmark-results/incremental-render-fast-once-reviewed-final-20260715/aggregate.json`,
bound to artifact `4942078d...` (204 files / 178,518,562 bytes) and recipe
`522d751b...`. Cold Tiny/IPS/US Core/mCODE is 11.134/15.436/34.429/34.824 s;
edits are 1.225/2.704/3.554/1.550 s; reopens are .513/.594/1.584/.918 s. Every
edit boundary has zero pending/cross-phase requests. Versus the prior repeated
fast medians, edits improve about 5%/15%/19%, with mCODE neutral. US Core compile
is only 105 ms of its edit and IPS compile 572 ms, so declaration-level reuse is
rejected for this round: its dependency evidence is incomplete and the maximum
payoff does not justify the risk. A first measurement run exposed that the
matrix and child runner duplicated artifact hashing with divergent traversal
order; the failed aggregate is non-evidence. Both now use one globally bytewise
`benchmark-identity.mjs`, reject non-regular entries, propagate helper failure,
and compare the matrix source with each child's actual served frozen copy. The
41 identity/lifecycle tests pass and independent final review has no remaining
finding. Engine `c3c9f881` is committed and pushed identically to
`snapshot-gen` and `main`. The editor's optimized committed-stamp WASM is
6,517,441 bytes (SHA-256 `101019f2...`) and directly reports engine
`c3c9f881`. The exact fresh-profile Pages-subpath receipt is
`/tmp/fhir-incremental-committed-stamp-full-browser-rerun.log` (`E2E GATE:
PASS`): Tiny/Cycle, US Core 1,535/1,535 images and 85/85 assets with one-shell
CarePlan, real mCODE, atomic retry, persistence, navigation, scroll, and mobile
geometry pass. An earlier attempt was invalidated by root-disk exhaustion and
is not evidence. The editor commit/push, Pages run, and live-origin verification
remain; do not report deployment success before all three complete.

**LOCAL RUST/WASM TOOLCHAIN (2026-07-15):** do not infer that `rustup` is
unavailable merely because it is absent from the default `PATH`. The user-local
manager is `/home/jmandel/.cargo/bin/rustup`. Rust `1.96.0` with
`wasm32-unknown-unknown` is installed at
`/home/jmandel/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu`, and the
matching generator is `/home/jmandel/.cargo/bin/wasm-bindgen` 0.2.126. Rebuild
the current engine with Binaryen 117 at
`/home/jmandel/.local/opt/binaryen-version_117/bin/wasm-opt` on `PATH`:

```text
PATH=/home/jmandel/.local/opt/binaryen-version_117/bin:/home/jmandel/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin:/home/jmandel/.cargo/bin:/usr/bin:/bin WASM_RUSTUP_HOME=/home/jmandel/.rustup WASM_CARGO_HOME=/home/jmandel/.cargo WASM_TOOLCHAIN_BIN=/home/jmandel/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu/bin WASM_BINDGEN=/home/jmandel/.cargo/bin/wasm-bindgen SUSHI_RS_DIR=/home/jmandel/hobby/fhir-ig-editor/vendor/sushi-rs scripts/build-wasm.sh
```

That exact command is green against current dirty engine source. The first
link took 33.32 s; the optimized WASM is 6,475,349 bytes with SHA-256
`3526f0398573ddea26eff6c86dedb4d6bcc4a2e1af1f4071bf7e070eba7f5843`.
App tests are 149/149, the Pages-base TypeScript/Vite production build and
Worker split checks pass, focused WASM API suites are 15 + 5 + 8 green, and
Cycle's renderer typecheck plus 176 Publisher tests pass.
The first browser attempt is intentionally retained as a failed receipt at
`/tmp/fhir-local-rust-196-full-browser.log`: it used a root-base Vite build
under a Pages subpath, so `/assets/*` returned 404 before engine startup. The
corrected production-equivalent artifact is
`c89e08f94528ec7918336aef20de39562e56798805f5da275fb91740fb4b413e`
(177 files / 112,608,648 bytes). Its complete fresh-profile receipt is
`/tmp/fhir-local-rust-196-binaryen117-pages-full-browser.log` (`E2E GATE:
PASS`): startup assessment, Tiny/Cycle, US Core 1,535/1,535 images and 85/85
assets with one-shell CarePlan, real mCODE, atomic registry retry, restart and
persistence, navigation, scroll 640 -> 640, and stable mobile geometry all
pass. This closes local browser correctness for the current dirty source; the
exact matrix below separately closes repeated performance/memory measurement.
Neither receipt authorizes a commit/deployment.

Use the benchmark harness's bytewise path ordering for artifact identity. A
discarded manual helper used locale collation and produced `3712f003...` over
the same 177 files/112,608,648 bytes; that value is not the canonical artifact
ID and must not be used in receipts.

**EXACT CURRENT MATRIX COMPLETE (2026-07-15):** the authoritative receipt is
`vendor/sushi-rs/target/benchmark-results/current-rust196-binaryen117-matrix`,
bound to artifact `c89e08f9...` and recipe `f9f7648a...`. `aggregate.json` is
`ok:true`; all 24 fresh receipts pass across Tiny/IPS/US Core/mCODE, fast and
verified whole-Chromium 25%-CPU modes, three repeats each. All receipts have
memory evidence; max pending/cross-in/cross-out requests are zero; all quota
scopes were applied and released. Fast cold medians (min-max) are Tiny 11.293 s
(11.291-12.090), IPS 15.505 (15.478-15.624), US Core 34.749
(34.698-34.805), and mCODE 36.656 (35.299-41.348). Fast edit medians are
1.296/3.111/4.318/1.566 s; same-Worker reopen medians are
.446/.593/1.646/.937 s. Throttled cold medians are
58.620/85.319/172.339/169.027 s; throttled edit medians are
6.933/16.597/24.015/10.909 s. Fast observed process-tree RSS medians are
1.531/1.739/2.597/2.029 GB and throttled are 1.551/1.694/2.277/1.993 GB.
Compared with the frozen baseline, large-guide fast cold improves 11-19% and
Tiny/IPS/US Core edits improve 27-55%; mCODE's already-small prose edit remains
neutral. Exact cold transferred bytes are 46.52/54.34/120.88/117.16 MB, of
which 36.24/43.94/114.05/110.33 MB are package-like. The only failed requests
are 18 known `mCodeDiagram.svg` 404s and two favicon 404s; never claim zero
request failures. Explicit representative edit debounce is recorded separately
as 300 ms for Tiny/IPS/US Core and 120 ms for mCODE.

**PAGE CARRY-FORWARD AUDIT (2026-07-15):** do not enable selective execution
from the current observer. It intentionally installs six global Unknowns and
marks every page's catalog membership/render completeness Unknown, so no
cross-build page is eligible. `INCREMENTAL_EXECUTION_ENABLED` stays `false`.
The earliest safe later experiment is post-prepare Publisher-page reuse after
canonical compilation, RenderState, and output-catalog construction: record a
complete bounded manifest of page source, positive/negative include and data
lookups, fragment output digests, runtime post-pass inputs, and renderer/options
recipe; replay it against the new state; reuse only an exact page descriptor
and prior authenticated content; otherwise render canonically. Keep manifests
inside the existing current/previous runtimes, cap them at 100k facts/32 MiB,
and extend the four-guide A -> B -> A oracle with data/include precedence,
add/delete/rename, config/package/template, overflow, observer-failure, and
failed-B cases before any enablement. This is design evidence, not an active
optimization or performance claim.

**LANDING IN PROGRESS (2026-07-15):** pre-dirty branches exactly matched their
remotes at editor `3420fae7`, engine `cbfadd9e`, and Cycle `090453f1`. The
engine is now committed and pushed as `3f9ec07b` on both `snapshot-gen` and
`main`; Cycle's generated contract is committed and pushed as `d49e0b57` on
`main`. The editor is locally commit-ready with both new pins. Its WASM was
rebuilt from committed engine `3f9ec07b` using Rust 1.96/Binaryen 117 and
directly reports that stamp. App 149/149, Pages-base build and lazy bundle
boundaries, contract/diff checks, and the exact complete browser receipt
`/tmp/fhir-performance-committed-full-browser.log` (`E2E GATE: PASS`) are
green. The receipt covers startup, Tiny/Cycle, US Core 1,535/1,535 images and
85/85 assets plus one shell, real mCODE, atomic registry retry,
restart/persistence, navigation, scroll 640 -> 640, and mobile geometry.
Current gates are:
engine workspace/all-target check and fmt; generated editor/Cycle/schema drift;
WASM 15 + 5 + 8; app 149/149 plus Pages-base production/lazy-boundary build;
Cycle renderer typecheck and 176 Publisher tests; exact native four-guide
differential parity; exact complete browser gate; exact 24/24 performance/
memory matrix; and diff integrity. When explicitly authorized, land in this
order: (1) engine landed; (2) Cycle landed; (3) editor repin, committed-stamp
WASM rebuild, and local gate are complete—commit/push editor next; (4) monitor
every Pages job through deploy and verify the live origin from a fresh profile.
The user explicitly authorized these writes; do not claim completion until the
Pages deploy and fresh-profile live verification pass.

**EXACT CURRENT THROTTLED-NETWORK RECEIPT COMPLETE (2026-07-15):** the
authoritative raw receipt is
`vendor/sushi-rs/target/benchmark-results/current-rust196-binaryen117-uscore-fast4g.json`.
The process exited zero and the receipt is `ok:true`, bound to exact artifact
`c89e08f9...` (177 files / 112,608,648 bytes) and recipe `f9f7648a...`. Under
the harness's 150 ms / 200,000 B/s fast-4G rule, US Core cold is 627.571 s for
120,877,107 observed/profiled bytes, of which 114,048,991 are package-like;
persistent hard reload is 9.863 s, representative profile edit is 4.408 s
including its explicit 300 ms debounce, and same-Worker reopen is 1.927 s.
Every phase has zero pending/cross-in/cross-out requests. The one returned rule
id covers page 55/55, dedicated-Worker 32/32, and engine-Worker 32/32 eligible
requests with zero unproven requests; Chromium 148's Worker main-script loads
remain explicitly unprofiled rather than inferred. Direct package-fetch and
`stagePackageMount` preparation interval union overlaps for 13.882 s, proving
the intended general transaction overlap under constrained transport. Process
memory evidence is available: observed peak whole-Chromium RSS is
2,286,370,816 bytes across 10 processes. This individual receipt has no failed
requests, but the repeated matrix above still contains the documented mCODE
diagram and favicon 404s. The embedded `cbfadd9e` stamp names the pre-dirty
engine commit, not committed provenance for the current bytes. This certifies
fast-4G only; slow-4G remains unrun and must not be claimed.

**DO NOT REOPEN THE R4/R5 DESIGN QUESTION:** the user has explicitly closed
that discussion for this round. The established conclusion is one explicitly
targeted release per build, with internal R5 normalization kept private. Do not
research, restate, redesign, or delegate this question after compaction. The
active work is the general-purpose performance goal below.

**DELETION-FIRST CERTIFICATION CHECKPOINT (ACTIVE, UNCOMMITTED 2026-07-15):**
the exact current Pages artifact is
`b2aadfb08ae9c994fe7a370f86fc5f27541f1209b19519d81628442db2a31c5a`
(177 files / 112,616,944 bytes). PreparedGuide selection now borrows candidates
and clones only final resources; its private SiteEngine cache uses
`Rc<PreparedGuide>`. PreparedPackage derives its index directly from borrowed
files and no longer constructs an unused normalized payload. Public APIs and
identities are unchanged. Rust workspace/all-target/wasm32, app 149/149,
TypeScript, production build, and the exact complete Pages-subpath browser gate
pass. The browser receipt is
`/tmp/fhir-performance-deletion-full-browser-final.log` (`E2E GATE: PASS`):
Tiny/Cycle, US Core 1,535/1,535 images and 85/85 assets with one-shell CarePlan,
real mCODE, restart/persistence, scroll 640 -> 640, mobile geometry, baked alias
resolution with zero registry calls, and real-Worker retry with invisible staged
packages plus one ordered atomic commit all pass.

The browser gate's synthetic registry case must run after the baked-seed case:
the version-observation cache deliberately owns one source scope, so the fake
registry source replaces the baked scope. This is test ordering, not a product
race or weakened assertion. The first final matrix correctly failed closed on
a separate CDP ordering edge: a Monaco dedicated-Worker attachment can be
delivered before its parent-page request event. The final benchmark keeps one
complete request ledger and one canonical target-evidence record, joins exact
`{phaseGeneration, URL}` only at 1:1 cardinality, consumes both once, preserves
attachment through detach/destroy, and leaves old/ambiguous/non-Worker/reused
evidence open. A five-run fresh IPS stress is `ok:true` at
`vendor/sushi-rs/target/benchmark-results/ips-worker-join-stress/aggregate.json`.
The exact final fast+25%-CPU browser matrix is `ok:true` at
`vendor/sushi-rs/target/benchmark-results/deletion-final-matrix/aggregate.json`:
24/24 fresh receipts share artifact `b2aadfb0...` and recipe `10fbff08...`, with
zero pending or cross-phase requests. Fast cold medians are 11.307/15.634/
34.996/37.258 s for Tiny/IPS/US Core/mCODE; representative edits are 1.252/
3.085/4.356/1.565 s. Eighteen closed mCODE request failures are the known
`mCodeDiagram.svg` 404 across cold/reload/reopen; do not claim zero request
failures. The discarded partial matrix remains non-evidence.

Network profiling exposed a different Chromium 148 protocol boundary and now
fails honestly. One page global `Network.emulateNetworkConditionsByRule` owns
the profile. Worker `fetch()` request events arrive on the Worker session while
their exact rule-id ExtraInfo arrives on the page session, so the harness joins
complete ledgers by raw request id only at 1:1 cardinality and binds phase
generation. Worker main-script loads receive no applied rule id from Chromium;
they are explicitly listed as unprofiled and never inferred from target
attachment or elapsed time. Lifecycle/profiling tests pass 36/36. The exact
Tiny fast-4G receipt is `ok:true` at
`vendor/sushi-rs/target/benchmark-results/deletion-network-fast4g-proof/aggregate.json`:
35/35 eligible page and 29/29 engine-Worker subresource requests carry the one
returned rule id. Cold is 242.394 s for 46.53 MB observed/profiled transfer
(36.24 MB package-like), cached edit 1.270 s, and every network boundary is
closed. The same
frozen recipe's US Core fast-4G receipt is `ok:true` at
`vendor/sushi-rs/target/benchmark-results/deletion-network-uscore-fast4g/aggregate.json`:
48/48 eligible page and 29/29 engine-Worker subresource requests carry its one
returned rule id. Cold is 628.395 s for 120.89 MB observed/profiled transfer
(114.05 MB package-like); persistent hard reload is 9.075 s, semantic edit
4.352 s, and exact same-Worker reopen 1.629 s, all with closed network
boundaries. These two
receipts deliberately certify one fast-4G profile, not the unrun slow-4G profile.

The fresh current-source native four-guide/three-repeat matrix passes at
`vendor/sushi-rs/target/native-cli-benchmarks/20260715T115056Z-3788346/receipt.json`.
It built Fig `c93b38cbf0fc...` from the dirty current engine source in an isolated
hardlinked cache. Tiny/IPS/US Core/mCODE prepare medians are 9.062/12.780/
33.126/30.093 s; outputs .375/.636/1.452/1.331 s; one render .384/.637/
1.500/1.399 s; and finalize .523/2.247/6.349/4.034 s. No commit/push without a
new explicit request.

**IPS LOGICAL-SPECIALIZATION CORRECTNESS PREREQUISITE (ACTIVE, UNCOMMITTED
2026-07-14):** the first representative IPS benchmark exposed a real engine
failure, not a harness issue. The final audit corrected an important initial
misdiagnosis: SUSHI's `sushi-r5forR4#1.0.0` virtual `Base` is a 5.0.0 compiler
definition and must never be used as Publisher's R4 logical-model base.
Publisher instead synthesizes a minimal `Base` at its context FHIR version only
when that release's universe lacks Base; R5 must retain its real Base and
inherited `ele-1`. Snapshot resolution now models that separate versioned
resource, rejects cross-version Base references, and continues to share the
other immutable R5-for-R4 datatype definitions. The Java oracle installs the same synthetic
Base without enabling the deliberately separate version-pinning layer.
`walk/specialization.rs` ports Publisher Q20/Q2/Q9, including its raw-prefix
insertion edge. The corrected seven-element Java golden has no leaked R5 root
constraint/mapping and carries base version 4.0.1; published-IPS-shaped R4 and
real-Base R5 tests plus a local `Base -> Document -> IPSSectionsLM` chain cover
the seam. All snapshot tests pass (10 unit, bundle, conversion, Layer B, 5 specialization,
walk), as does SiteEngine 25/25 with one explicit fixture ignore. A rebuilt
pre-final WASM opened real IPS with 117 resources and 468 pages in
`/tmp/ips-performance-root-benchmark-current.json`; rebuild and rerun the
browser after these final corrections before freezing the baseline.

**GENERAL-PURPOSE PERFORMANCE ROUND (ACTIVE, UNCOMMITTED 2026-07-14):** the
current goal is to improve arbitrary-guide cold startup and edit latency without
package-specific artifacts, a second build path, or changing the public
`prepare -> Build -> outputs/render/finalize` API. Three read-only audits found
that the live 5.199 s engine-ready baseline excludes Worker evaluation, WASM
download/compile/instantiate, and Session construction; workspace restore and
manifest loading unnecessarily delay init; Publisher startup statically loads
Monaco and Cycle-only graphs; package fetch/preparation overlap has a small
local-Tiny ceiling but may matter under throttling; and the strongest general
reuse seam is one exact immutable package corpus shared by compiler, snapshot,
and renderer views. Declaration-level incremental compilation is not yet safe
because actual symbol/read dependencies are incomplete.

The active uncommitted slice extends the generated `BuildEvent` observation
plane with optional machine `phase`, `source`, and epoch-aligned `startMs`, then
records Window/Worker startup, streaming WASM fetch/compile, instantiate/start,
Session construction/init, workspace/SW/catalog work, package fetch/verify/
prepare/stage/commit, SiteBuild/output/publication, first preview load, and WASM
memory. No parallel metrics channel is being added. Focused Rust/WASM contract
gates, editor 110/110, TypeScript, generated-contract drift, and the Pages build
are green. The exact full-browser proof is
`/tmp/fhir-performance-timeline-browser.log` (`E2E GATE: PASS`): engine ready
510 ms, Worker-to-ready 122.7 ms, app module/initial render 327.8 ms, streaming
WASM fetch 12.7 ms for 5,763,275 bytes, compile 14.5 ms, Tiny Ready 10.305 s,
and a 915 ms warm edit split into the explicit 300 ms debounce, 400.7 ms
prepare RPC, 12.5 ms outputs, 7.1 ms first render, and 33.4 ms publication. All
US Core/mCODE/restart/navigation/scroll/mobile cases pass. The corrected generic
benchmark removes padded publication waits, gates on exact current-generation
Ready after the Service Worker acknowledgement, records request/response/
finish timing, and fail-closes on incomplete dedicated-Worker/WASM/network/
memory evidence. `/tmp/project-benchmark-tiny-audit.json` proves 11.002 s cold,
3.916 s hard reload, and 207.9 ms retained reopen. CDP CPU throttling is
truthfully page-only; the mobile-class matrix instead applies and verifies a
transient 25%-CPU systemd scope around the whole disposable Chrome tree. Its
Tiny proof `/tmp/fhir-mobile-smoke.json` is 54.334 s cold, 26.186 s warm, and
2.001 s retained reopen with no leaked scope. The authoritative frozen-artifact
three-repeat matrix is complete and `ok:true` at
`/tmp/fhir-performance-baseline-recipe-final/aggregate.json`: 24/24
Tiny/IPS/US Core/mCODE fast+25%-CPU receipts share artifact
`5d241fd01b3bf85791fdb395cb9a39b23d0ca551360d2969c00bc7a5f0061121`
(169 files / 112,498,192 bytes) and runner recipe
`d24a79761b04bfbace953f5a0be563c1fd683d51e29a87fa8631f02144ae7d91`.
Fast cold medians are 11.628/17.838/42.825/41.437 s; persistent hard reloads
4.066/6.375/9.046/8.606 s; representative edits 2.846/5.013/5.903/1.641 s;
and same-Worker reopens 0.514/0.671/1.655/0.924 s. Verified 25%-CPU cold
medians are 59.595/88.446/177.483/174.924 s, demonstrating that cached mobile
startup is primarily CPU work rather than transfer. Preserve the separately
deployed live Tiny baseline: Ready 12.327 s, engine ready 5.199 s.

The exact independent-process native baseline is `pass` at
`vendor/sushi-rs/target/native-cli-benchmarks/20260715T040711Z-3225234/receipt.json`.
It used the SHA-authorized frozen Fig
`de1d9abfc4ef391ba040e36e98ae7e84faf9db660f0cc04cc3e8e2cbe2a06b24`,
three repeats, and an isolated temporary hardlinked cache. Tiny/IPS/US Core/
mCODE prepare medians are 9.863/13.735/37.028/34.180 s; outputs
0.359/0.612/1.422/1.314 s; one render 0.374/0.614/1.471/1.383 s; and finalize
0.517/2.187/6.417/4.108 s. This independently confirms that package/index/
compile/preparation work, not UI debounce or one-page rendering, is dominant.

The final current Pages-base artifact is frozen at
`b4e10d41f82ee7d382c136ca892b4de3697b6abe66af26850f36b8b57421e90e`
(171 files / 112,611,492 bytes). Four independent fast smokes from the prior
exact source checkpoint pass at
`/tmp/fhir-performance-current-{tiny,ips,uscore,mcode}-smoke*.json`.
Single-sample cold Tiny/IPS/US Core/mCODE times are
11.881/16.050/35.956/37.129 s and representative edits are
1.263/3.544/4.368/1.679 s. Tiny's edit proves the compiler package-store path:
`compileProject` fell from the frozen ~1.556 s to 8 ms with 44 body hits/zero
misses, while reported prepare WASM memory fell from ~226 to ~192 MB. Early
startup moves Worker attachment from 307 to 15 ms and the WASM request from 424
to 143 ms; the complete application graph loads concurrently. Do not turn these
smokes or the incomplete `/tmp/fhir-performance-current-matrix` pilot into a
claim. That pilot exposed multiple benchmark-only CDP lifecycle edges. The
runner now joins the exact top-level `frameId`/`loaderId` and default execution
context for setup/cold/reload, accepts context-before-commit ordering, pins
reload to the prior loader, and evaluates only through the resulting context
lease. The remaining preselection stall was a synchronous `Runtime.evaluate`
requested with unnecessary Promise-await semantics while the app itself
remained idle. Initial project selection is now installed before navigation and
owned by the committed page: it waits for the real React select to be enabled,
dispatches on the next animation-frame commit boundary, and is acknowledged
only when the app persists the selected project. It emits once; there is no
sleep/retry masking. Every benchmark expression is synchronous and now uses
`awaitPromise:false`. Context, protocol, timeout, transport, selection, and
network-boundary loss all fail terminally. The deterministic lifecycle/
handshake suite passes 17/17. Three fresh whole-Chrome 25%-CPU Tiny attempts at
`/tmp/fhir-selection-handshake-throttled-{3,4,5}.json` all completed cold,
reload, edit, and same-Worker phases with zero pending requests. They share the
frozen artifact above and exact runner recipe
`3db3a9e662e9ba132173487cfcbb37b4d2579c9326e5b2ae3f94d84f2da773a5`;
cold times are 59.030/59.611/59.612 s.

The authoritative post-change browser matrix is now complete and `ok:true` at
`/tmp/fhir-performance-current-matrix-final5/aggregate.json`: all 24 receipts
share that exact artifact/recipe, every network boundary is closed, and no
pilot receipt was reused. Fast Tiny/IPS/US Core/mCODE cold medians are
11.860/16.237/35.835/36.829 s versus 11.628/17.838/42.825/41.437 s baseline;
semantic/prose edit medians are 1.261/3.136/4.385/1.599 s versus
2.846/5.013/5.903/1.641 s. CPU-capped cold medians remain essentially flat at
59.405/88.312/176.018/171.299 s, showing that the large-guide fast cold gain is
host overlap/startup rather than less total CPU. US Core's summed Worker RPC
work increases 32.8 -> 54.5 s while its RPC envelope falls 41.9 -> 35.3 s,
directly proving overlap. Compiler package-store reuse is exercised on each
semantic edit: Tiny/IPS/US Core compileProject medians fall 1,556 -> 9 ms,
2,422 -> 568 ms, and 1,641 -> 103 ms with `compilerPackageStoreCacheHit=1` and
zero store rebuild. US Core process-tree RSS is effectively flat (2.610 ->
2.626 GB median) while observed edit-phase WASM memory falls 849.3 -> 822.5 MB.

The independent current-source native matrix is `pass` at
`vendor/sushi-rs/target/native-cli-benchmarks/20260715T072147Z-3332136/receipt.json`
using release Fig `fc1f4d65b0aa`. Tiny/IPS/US Core/mCODE prepare medians are
9.845/13.416/35.739/33.833 s; outputs .349/.608/1.405/1.282 s; one render
.372/.603/1.456/1.342 s; and finalize .506/2.194/6.325/4.020 s. Relative to the
frozen independent-process baseline, canonical native execution is stable;
this supports attributing browser cold gains to the host transaction overlap
and early startup rather than a second execution path. The frozen baseline and
its recipe remain intact.

The exact current artifact also passes the complete Pages-subpath browser gate
at `/tmp/fhir-performance-full-browser-final3.log` (`E2E GATE: PASS`). It
re-proves Tiny/Cycle, US Core, real mCODE, preview-Service-Worker restart and
persistence, navigation/history, hot reload with scroll 640 -> 640, and stable
390px/320px mobile geometry. The benchmark's initial-selection race is closed
structurally: a probe installed before navigation binds to the committed
document, waits for the enabled React guide selector, dispatches exactly once
on the next animation-frame boundary, and completes only after the app persists
the selected project. CDP evaluation is synchronous (`awaitPromise:false`), and
the 17/17 lifecycle suite plus three independent throttled receipts prove the
handshake without retries or sleeps. `verify-e2e.mjs` now fail-closes CDP and
WebSocket calls on timeout/close/error instead of spinning after a browser
crash. `run-browser-gates.sh` accepts `BROWSER_WORK_ROOT` for disposable copied
artifacts/profiles while leaving Chromium's own `TMPDIR` semantics untouched.

The first optional-capability split is retained locally and reproducibly
certified. Every executable Cycle/ReactDOM/Liquid/FHIRPath/XML import lives in
one private `cycleRuntime` dynamic Worker module; Publisher still uses the
canonical Rust Build and unchanged `prepare/outputs/render/finalize` protocol.
The production gate rejects eager Cycle markers/references and verifies the
Worker entry stays below 256 KiB. Vite's default CommonJS `strictRequires:
"auto"` made identical builds race while detecting the large cyclic Cycle CJS
graph, alternating between two chunk sets with a 593-byte size difference.
`build.commonjsOptions.strictRequires: true` preserves lazy Node-style require
semantics and removes that race. Five consecutive identical-source builds now
produce the byte-identical artifact
`a05e9fd4d05ca8ae1666a71a2dcc479596d357e33544e8917c2f6008753829e3`
(172 files / 112,623,560 bytes), with Worker
`engine.worker-CDoyfBGt.js` and Cycle chunk `cycleRuntime-CL6rUBxa.js`.

The six-receipt Tiny matrix at
`/tmp/fhir-cycle-split-tiny-matrix/aggregate.json` is `ok:true`: module
evaluation median falls 125.5 -> 28.5 ms fast and 1,506.7 -> 301 ms at 25%
whole-Chrome CPU; throttled cold falls 59.405 -> 58.344 s and warm 30.541 ->
29.917 s, with RSS within the prior range. The exact reproducible-artifact
receipts are `/tmp/fhir-cycle-split-deterministic-{fast,throttled}.json`, both
`ok:true` with zero Cycle-chunk requests during Publisher phases and exactly one
at first Cycle use. Fast phases are 11.756 s cold, 4.160 s reload, 1.247 s edit,
2.651 s first Cycle, and 0.435 s reopen; 25%-CPU phases are 58.931/30.601/7.040/
14.217/4.997 s. IPS/US Core/mCODE fast smokes remain green at
`/tmp/fhir-cycle-split-large-fast/aggregate.json`. App 147/147 (778 assertions),
TypeScript, the production bundle boundary, lifecycle 17/17, five-build byte
reproducibility, and diff integrity pass. The exact deterministic artifact
passed the complete Pages-subpath gate at
`/tmp/fhir-cycle-split-deterministic-full-browser.log` (`E2E GATE: PASS`),
including Tiny/Cycle, US Core 1,535/1,535 images and 85/85 assets, one-shell
CarePlan, real mCODE, restart/persistence, navigation, scroll 640 -> 640, and
390px/320px mobile cases. Do not commit or push without a new explicit request.

The second optional-capability split is retained locally and certified. The
source editor and compiled-JSON viewer are the only two lazy leaves; profile
Differential/Snapshot/Expansion stay in the ordinary Explore graph. One shared
pane-local Suspense/error boundary prevents layout collapse or app-wide import
failure. The exact current artifact is
`62a0c1841ddac6f84ae5d976a6d978b85f1b4f92b185caca1a0c496108b51713`
(175 files / 112,620,612 bytes): eager `reactBootstrap` falls from 3,567,196
bytes to 240,580 (75,438 gzip), while `monacoSetup` is a separate 3,319,685-
byte capability and CodeEditor/ResourceJson are 2,779/452-byte leaves. The
production gate traverses the eager static-import closure, rejects an eager
Monaco leaf, and requires the editor/JSON Worker URLs to be rooted only by the
Monaco capability.

The exact full-browser receipt is `/tmp/fhir-monaco-split-full-browser.log`
(`E2E GATE: PASS`). Its network assertions prove: welcome requests no Monaco
surface/core/Worker; Author loads CodeEditor + Monaco + only the base Worker;
Differential still loads no JSON capability; selecting JSON then loads
ResourceJson + the JSON Worker. It also re-proves Tiny/Cycle, US Core
1,535/1,535 images and 85/85 assets plus one-shell CarePlan, real mCODE,
restart/persistence, navigation, scroll 640 -> 640, and mobile geometry. Fast
US Core `/tmp/fhir-monaco-split-uscore-fast.json` is `ok:true`: cold JS transfer
falls 3.647 MB -> 0.323 MB, app-module evaluation 275.4 -> 22.7 ms, and observed
JS heap 133.8 -> 110.0 MB; Ready is neutral at 35.63 -> 35.45 s. The exact
whole-Chrome 25%-CPU receipt
`/tmp/fhir-monaco-split-uscore-throttled-final.json` is `ok:true`: app-module
evaluation falls from the 2.50 s prior median to 0.10 s, cold Ready is 170.7 s
versus the prior 176.0 s median, and process-tree RSS remains within the prior
range. App 149/149 (791 assertions), TypeScript, bundle gates, and diff
integrity pass.

That final throttled run also closed a benchmark-only setup race. The harness
formerly required a default Runtime context for its throwaway `about:blank`
document even though setup never evaluates it; under throttling Chrome could
commit the page while that unused join waited. Setup now binds the exact
top-level frame/loader returned by `Page.navigate`; every measured navigation
still requires the stricter frame + loader + default-context lease. Lifecycle
tests pass 18/18, and the corrected run crossed setup and the page-owned catalog
selection once without retry or sleep masking. Do not commit or push without a
new explicit request.

The first startup optimization is source-frozen but deliberately not yet built
into `app/dist`. `engineStartup.ts` owns one page-process EngineClient at module
evaluation, buffers startup events, and disposes it on owner HMR;
`EngineClient.init` is single-flight and overlaps manifest fetch/parse with the
Worker init RPC. The tiny `main.tsx` bootstrap now creates that owner before it
dynamically imports the React/ReactDOM/App graph; its DOM shell remains visible
through that import. App concurrently opens the workspace/restores stale preview
before joining `startup.ready`, and a page-process `WorkspaceStartup` makes the
repository plus initial project read single-flight across StrictMode replay.
Fatal Worker `error`/`messageerror` rejects every pending request, boot failures
have a stable visible reload action, and replacement-Worker recycle now reports
its explicit 250 ms memory-release wait plus Worker/WASM/Session events on the
same timeline. StrictMode no longer constructs or initializes a second engine.
These post-review source corrections have focused tests written but deliberately
not run while the frozen benchmark matrix owns the machine. After that matrix,
run the focused/type gates, build this slice with app-local `bun run build` only,
and remeasure against the same harness; retain it only on measured improvement.

The bounded adversarial startup follow-up is also source-only and unverified
while that matrix runs. `EngineClient` now exposes a replayable terminal-Worker
failure observation; the page owner combines it with classified manifest/WASM
initialization rejection, and App turns either that failure or an independently
classified workspace/OPFS failure into one stable reload surface while retiring
the Worker. A post-ready crash can no longer leave `engineReady` true or let a
React remount join the old resolved init promise. Startup events, fatal
listeners, every EngineClient progress callback, and WorkspaceStartup metrics
are guarded so an observation sink cannot change initialization, package,
recycle, or repository ownership. Replacement-Worker init/version failure is
terminal and observable. StrictMode reuses the preview-worker and curated-
catalog promises and emits their spans once; curated catalog I/O itself is
page-process single-flight. A failed dynamic React/App import disposes the
already-started engine. Focused tests now cover event-observer isolation,
post-ready fatal replay, manifest failure classification, workspace-observer
isolation, and the corrected Promise-all source join. These edits touch
`app/src/{App.tsx,main.tsx}`, `app/src/worker/{client.ts,engineStartup.ts}`,
`app/src/vfs/workspaceStartup.ts`, `app/src/adapters/templateCatalog.ts`, and
their three focused test files. After the frozen matrix completed, the combined
startup/workspace/catalog plus directly adjacent timeline/prepare/local-package/
workspace run passed 38/38 tests (232 assertions). Typecheck, production build,
rebuilt-WASM, browser, and performance claims remain pending this source slice.

A read-only eager-graph audit found two additional independent experiments to
run only after that startup slice is measured. `engine.worker.ts` currently
statically pulls the Cycle-only ReactDOM/Liquid/FHIRPath/XML renderer graph into
every Publisher startup (2,339,637-byte frozen worker entry, 449,428 bytes
gzip). Move that graph behind one private worker-side dynamic `cycleRuntime`
module while keeping Rust finalization and the four-operation API unchanged;
prove that Publisher runs request no Cycle chunk and that Cycle loads it once
with unchanged output. Separately, both `CodeEditor` and
`ResourceInspector -> ResourceJson` statically root Monaco in the
3,584,019-byte frozen app entry (931,672 bytes gzip). Both roots must be split
together with pane-local stable Suspense/error surfaces, then prove no Monaco
request occurs before Author/JSON use and preview scroll/lifecycle is unchanged.
Measure these experiments separately; do not use either to obscure the result
of the already-written early-startup slice.

The first exact immutable-reuse slice is active source work in `vendor/sushi-rs`
and deliberately absent from the frozen browser artifact. SiteEngine retains
the compiler `PackageStore` through only its current and previous successful
semantic compilations. Its key binds recipe/API, full config identity, ordered
executable and support labels, and every authenticated prepared-package
carrier; a candidate installs only after successful compilation. Ordinary and
prebuilt-store compiler APIs share one implementation, and prepare events expose
key/build/hit/use/retention metrics. Independent review rejected the initial
direct reuse of a retained `PackageStore`: its interior parsed-JSON cache could
grow during a failed compile. The corrected source now shares immutable lookup
indexes, compressed carrier bytes, and decoded member indexes while isolating
both parsed bodies and decompression/read state per compilation. Promotion
drops the transient read cache. Mutable disk sources reject the reuse fork but
still compile canonically from the supplied view and attach no retained store;
each retained store is limited to 1,024 entries/16 MiB source bytes. A second
independent review found that its first deterministic byte-budget trim was greedy rather than strict LRU; it is now oldest-first with
one consistent lower-index tie rule and an adversarial fragmentation fixture.
The real transaction test now performs a successful Patient compile, a
same-key Observation read followed by a deliberately late render-path failure,
and a successful mixed hit/miss promotion while asserting the prior retained
store is byte-for-byte observationally unchanged. A full test-only cache
fingerprint covers values/recency/counters; a warm mixed-hit/miss result/render
set is compared with a clean compile. Metrics now distinguish active state,
current+previous logical totals, deduplicated parsed bodies, and unique retained
catalogs. The compiler derives cache root from its store and rejects mismatched
package-affecting config. Corrected native gates are green: package_store 50
unit + 2 integration, compiler 25 lib + 3 definition-location integration, and
SiteEngine 31 passed/1 fixture-dependent ignored. The real DiskSource
regression compiles two distinct fresh revisions with zero retained
store/catalog/body generations. Do not claim a browser or memory improvement
until the WASM is rebuilt and measured independently. The complete engine
boundary receipt is `/tmp/engine-boundary-gate-final.log`: snapshot_gen 21/21
including all five R5-for-R4/logical-specialization tests, WASM lib 15/15,
expand 5/5, Session 8/8, generated wire-contract drift, the documented Rust
1.96 wasm32 release build, workspace formatting, and diff integrity are green.
The raw wasm32 artifact exists only under engine `target`; no editor WASM or
`app/dist` was built or copied.

The general package-overlap slice is now source-active and unbuilt. The old
whole-array Worker `mountPackages` operation is replaced by one private
`open -> stage(index) -> commit/abort` ticket. The main-thread mount mutex spans
the complete ticket lifetime; ordinary resolver rounds open before their four
bounded fetchers, and persistent-lock and single-package/template paths use the
same transaction. Rust stores staged FPP artifacts by resolver index, validates
both cache key and expected label before occupying a retryable slot,
reconstructs exact resolver order at commit, and retains the existing
generation guard/all-or-nothing mutation. Prepared-cache and typed registry-
integrity recovery retry only the failed slot. Worker per-slot events return
immediately, so later measurements can prove real fetch/preparation overlap.
Do not claim a gain until focused transaction, TypeScript, app, rebuilt-WASM,
and repeated matrix evidence pass.

The same source-only package lifecycle work now makes session-local package
authority truthful for an already-mounted exact coordinate. A dropped TGZ is
staged with an order-independent effective-file comparison and an exact
rollback token. An identical repeated drop is a no-op. If new local bytes would
replace a mounted baked/local package with the same `id#version`, EngineClient
recycles before the next `prepare`, then commits the local authority only after
the complete prepare succeeds. A failed compile/site preparation restores the
prior local store and requires a clean recovery Worker, because Rust may have
committed candidate bytes before the later failure. Ingestion waits for the
current immutable prepare barrier, so it cannot join an older ProjectRevision
mid-flight; workspace/source ownership and resolver package order are unchanged.
Deterministic source tests cover baked -> local replacement, failed replacement
rollback/recovery, and unchanged-authority no-recycle.

Package fetches also have one general transport inactivity boundary: total
transfer time remains unlimited while chunks arrive, but 60 seconds without
response headers or another body chunk aborts baked tarball, registry tarball,
and mutable-version metadata transport. Metadata preserves origin revalidation
with `cache: no-cache` and parses only completely consumed guarded bytes. The
existing acquisition transaction then aborts and releases its mount ticket.
Manual-clock tests cover stalled headers/body, a slowly progressing stream
whose total duration exceeds the interval, and ticket abort without commit.
After the frozen matrix completed, the focused package suite passed 42/42 tests
(236 assertions) across integrity/inactivity, local authority, metrics, registry
TGZ fallback, resolution locks/metadata, and template transactions. App
TypeScript (`bunx tsc -b`) is also green. No production build has run yet.

The same source cleanup removes the obsolete unconditional R5-core snapshot
mount. Snapshot inspection now runs only against the current project's exact
resolved closure; the manifest keeps R5 core as an `on-demand` candidate for an
actual R5 target, not a global R4 snapshot prerequisite. This avoids a hidden
16.4 MB acquisition and package-generation invalidation and makes the current
release rule explicit: one guide target owns compilation/rendering semantics,
while the snapshot engine's R5-internal representation and SUSHI's R5-for-R4
definitions remain implementation support. The broader typed R4/R4B/R5 context
is a later correctness migration, not a second performance build path. The dead
single-artifact `mount`, `mountPrepared`, and `prepareAndMount` APIs are being
deleted so cold, warm, persistent-lock, and template acquisition all use the
same indexed transaction.

The safe-incremental observation checkpoint is implemented but execution is
still deliberately disabled. Non-default `dependency-observation/v1` records
typed source/declaration/lookup/package/compiled/prepared/artifact/fragment/
page/runtime/output evidence through the canonical full build. Exact facts,
conservative scopes, and explicit Unknown gaps accumulate monotonically; every
global invalidation and every missing fact still selects a full build. Observer
capture/render failures are contained as global Unknown evidence and cannot
change canonical prepare/render success. Package lookup traces share the one
production selector, have separate 100,000-record and exact 32 MiB retained-
collection-capacity limits, drop all records on overflow, and are always cleared
on retained-store promotion. The feature remains absent from default dependency
trees and `INCREMENTAL_EXECUTION_ENABLED` is `false`.

The final current-source differential receipt is
`vendor/sushi-rs/target/incremental-differential/full-current-race-free-final-20260715/aggregate.json`
(`status: pass`, 4/4). It runs only an exec'd frozen runner and one binary built
from a read-only before==copy==after engine snapshot in a private Cargo target.
Fixtures, helper, catalog manifests/TGZ files, and baked bundles are frozen and
reverified. Resolver hardlinks are only a transient read view: Rust requires two
identical closure/carrier captures, executes solely from those immutable bytes,
and preserves the exact prepared carriers in a read-only SHA-256 object store.
The aggregate covers 30 objects / 203,819,085 bytes and proves Tiny 1,799, IPS
2,233, US Core 3,848, and mCODE 2,872 outputs in fresh A, retained A -> B -> A,
and fresh B with forward/reverse rendering. Compilation plus ordered diagnostics,
ClosedSiteBuild closure and addressed bytes, initial/final catalogs, every
ContentRef/body, and canonical SiteOutput match; return-A semantic compilation
and SiteBuild cache hits are 1 for all four. The frozen source input hash is
`0cd5768d69368c875bff9a895bdbf66dd4fe4313c3f193192a9a634e0f51717d` and
the frozen binary hash is
`a2d4d1d19f88fd3ca12a51953663ce01f040ccd8954aa3be6f3e20c349b08701`.
Default and observation-enabled package/render/producer/SiteEngine suites,
workspace all-target check, fmt, Python syntax, and diff integrity pass. The
user-local Rust 1.96 wasm32 toolchain documented above has now rebuilt the exact
current engine successfully; the complete browser gate remains the acceptance
boundary. This checkpoint adds evidence and a correctness oracle,
not an incremental execution path or measured performance gain. Page carry-
forward remains the earliest possible later execution milestone; declaration-
level reuse stays disabled until the recorded Unknown gaps are eliminated and
proved.

Native CLI measurement now has one uncommitted executable,
`scripts/benchmark-native-cli.py`. It builds release Fig for current-source
measurements or accepts one explicitly SHA-authorized frozen Fig binary for the
baseline, creates a
temporary hardlinked cache overlay below the engine target (never `~/.fhir`),
and invokes `prepare`, `outputs`, `render`, and `finalize` as independent
processes while validating every JSON envelope, build/output identity,
ContentRef, published page, and complete receipt. Tiny's one-repeat proof is
`vendor/sushi-rs/target/native-cli-benchmarks/20260715T020609Z-3135615/receipt.json`:
9,837.285 ms prepare, 376.386 ms outputs, 391.896 ms render, and 534.731 ms
finalize; 1,799 files / 36,752,344 bytes agree throughout. Run the full four-guide
three-repeat native matrix only after the browser baseline to avoid contention.

All earlier baseline directories are historical only. A post-network stall was
traced to a detached transient Monaco Worker leaving `Runtime.getHeapUsage`
pending, not to application or network work. Every CDP command now has a finite
CPU-scaled deadline; detach rejects only that session's pending commands;
active page/engine sampling failures are terminal; and target attachment/
destruction closes only one unambiguous matching network entry. Six deterministic
lifecycle tests pass. Every receipt is also bound to the exact four-file runner
recipe SHA `d24a79761b04bfbace953f5a0be563c1fd683d51e29a87fa8631f02144ae7d91`;
invalid/truncated/drifted receipts rerun. The authoritative clean no-resume
matrix is unified-exec session `27544`, writing 24 Tiny/IPS/US Core/mCODE
fast+25%-CPU receipts to `/tmp/fhir-performance-baseline-recipe-final`. Do not
edit the four benchmark recipe files or run builds until it finishes. Require
`aggregate.json` `ok:true`, exact recipe/artifact identity, and all 24 receipts.

The representative-edit descriptor now records its actual UI debounce as data:
Tiny/IPS/US Core semantic edits use 300 ms, while mCODE's prose edit uses the
site-only 120 ms path. The measured first Worker operation and post-debounce
pipeline were always trace-derived; the former unconditional `300` receipt
label would only have mislabeled future mCODE samples and was corrected before
any mCODE baseline ran.

The final corrected direct Tiny runner smoke is
`/tmp/fhir-cdp-lifecycle-final-smoke.json`: exact frozen artifact/recipe, 11.646
s cold, 4.115 s hard reload, 2.845 s edit, 0.530 s same-worker reopen, and zero
requests at every measured network boundary.

**TINY COLD-START REGRESSION FIX (DEPLOYED 2026-07-14):** a fresh live
mobile profile reproduced the reported apparently-hung Tiny Explore pane. It
was not deadlocked: Ready arrived at 23.05s while all HTTP requests completed
within 0.67s. The dominant work was host inflate -> base64 object -> JSON
serialization/clone -> Rust JSON/base64 decode for about 36.2 MB compressed and
269 MB of transient wire input. The active fix carries baked and registry TGZ
bytes directly to the Worker/WASM and uses one bounded
`package_store::read_package_tgz` parser shared with native acquisition. Raw
local-drop bundles remain a compatibility input; they are not used by the
published Tiny path. All-cold pinned batches transfer their ArrayBuffers;
registry batches retain bytes only while typed decode failure may continue at
the next registry. Prepared-pointer fallback and mount commit remain the same
atomic transaction.

The progress surface now reports transport, `Located ...; ready to prepare`,
package preparation/mount, and combined compilation/site preparation without
the frozen `Loaded` claim or duplicate Explore placeholder. Persisted boot uses
the same visible progress surface. The parser rejects unsafe/duplicate paths,
more than 65,536 entries, any entry over 128 MiB, or more than 256 MiB expanded
before allocation/read; rejection leaves Session state unchanged. Current
evidence: Rust workspace release tests green (SiteEngine 24/25 with one explicit
fixture ignore), all-target check, wasm32, and fmt; editor 107/107, TypeScript,
Pages build, and diff checks. The engine is committed and pushed on
`snapshot-gen` and `main` as `cbfadd9e`. The exact committed-stamp full browser
receipt is `/tmp/fhir-tgz-full-browser-committed.log` (`E2E GATE: PASS`): the
browser reports engine `cbfadd9e`, Tiny Ready in 10.445s, all five cold mount
batches have zero JSON/base64/serialization, Cycle edit is 803ms with scroll
640 -> 640, US Core has 1,535/1,535 images and 85/85 assets plus one CarePlan
shell, and real mCODE/restart/workspace/mobile gates remain green. Editor
`a976d8d` is pushed on `main`. Pages run `29374339985` passed the Rust/native
Fig/package/WASM/byte-parity/Cycle/app/browser/artifact-upload and deploy jobs.
The live origin serves app `assets/index-BomFcmZb.js`, worker
`assets/engine.worker-D6_vwuJI.js`, preview protocol 6, and the 5,759,418-byte
WASM stamped `cbfadd9e`. An independent disposable-profile live receipt at
`/tmp/live-tiny-cbfadd9e-PASS.json` has `pass: true`: engine ready 5.199s, Tiny
Ready 12.327s, four compiled definitions with `StructureDefinition/editor-user`
selected and populated, a 51,939-character published profile, five cold mounts
with zero JSON/base64/Worker serialization, and no app/worker/preview/request
errors.

Complete and certify the deletion-first architecture overhaul. The only domain
values are:

```text
PreparedGuide -> SiteBuild -> SiteOutput
                      |
                 ContentStore
```

The site host surface is exactly:

```text
prepare(project, generatorSpec) -> Build
build.outputs()                 -> catalog
build.render(path)              -> ContentRef
build.finalize()                -> SiteOutput
```

`ARCHITECTURE.md` is the one normative cross-repository contract and deletion
ledger. Do not restore compatibility wrappers, v1 values, mutable adapters,
asset side channels, host callbacks, or parallel serialized build formats.

## Active API convergence (landing 2026-07-12)

**FINAL CONVERGENCE CERTIFICATION (2026-07-12):** the
functional app contract is now one immutable `Build` with compilation
inspection plus `outputs/render/finalize`; its public barrel fell from 52
exports to 13 canonical UI/functional names. Worker, package, renderer, and
envelope transports import the generated Rust declarations directly. Cycle has
one read-only `ContentStore` capability and one writable refinement (four
parallel interfaces deleted), and native cache-hit/fresh execution both pass
through one private frozen `outputs -> render -> finalize` Build facade. A
cache hit reconstructs and verifies the exact renderer catalog before returning
authenticated refs; it does not infer a lossy catalog from file MIME types.
ProjectSource alone owns the operation lease, so five cancellation checkpoints
remain while the duplicate PackageProvider callback is deleted.

The final dependency commits are sushi-rs
`a1bf34ec96b695209be9bd2f6709333949c515de` and Cycle
`090453f1d64326b96c37887ebfe44b8702b4ffc3`; both are pushed on `main`
(and the engine is also pushed on `snapshot-gen`). The editor's rebuilt WASM
identifies engine `a1bf34ec`. Its exact committed-stamp Pages-subpath receipt is
`/tmp/fhir-api-convergence-stamped-browser-final3.log` (`E2E GATE: PASS`). It
proves Tiny and Cycle edits (892/659 ms), exact private Publisher reuse, US Core
1,535/1,535 images and 85/85 assets, one html/body/header/footer on CarePlan,
real mCODE without fallback/dependency error, protocol-6 upgrade/restart,
dirty Workspace A -> B/C -> A plus reload, scroll 640 -> 640, and stable 390px
and 320px mobile geometry. Native Cycle's real two-pass 91-file output is
identical and its second pass verifies the full catalog then skips Liquid.
Native Publisher independently finalizes 1,799 files. Rust workspace/all-target/
wasm32/fmt, generated-contract drift/schema, byte parity 10/10, consistency,
Cycle 240/240 plus typecheck/bundles, and editor 104/104 plus TypeScript/Pages
build are green.

The repeatable performance receipt is
`/tmp/fhir-api-convergence-uscore.json`: cold US Core 78.398 s, persistent hard
reload 8.999 s with prior verified UI/page at 0.998/1.089 s, and same-worker
Cycle -> US Core 1.562 s with a 155 ms retained SiteBuild prepare. Relative to
the recorded pre-optimization floors, persistent reload is down from 15.8 s,
same-worker reopen from 5.348 s, and the exercised Publisher prose edit from
about 1.8 s to 0.897 s. The loaded US Core semantic profile edit remains
5.702 s (1.637 s compile plus 2.204 s Rust preparation dominate); do not claim
that path improved in this architecture-only slice. Local implementation,
dependency landing, commit-stamped WASM rebuild, and certification are
complete. Editor commit `54b77862f67d352896d7902a1882335dbfac5b9a` is pushed
on `main`. Pages run `29218151254` passed the Rust, native Fig, package-list,
WASM, byte-parity, Cycle, app, Chromium, artifact-upload, and deploy jobs. The
live origin serves app `assets/index-DN3nLCvl.js`, worker
`assets/engine.worker-CrUU-4x0.js`, and reports engine
`rust_sushi + snapshot_gen (walk) · a1bf34e`.

**NO-ARG FINALIZE + PRIVATE CACHE CHECKPOINT (2026-07-12):**
the public web and Fig `Build` facades no longer expose lifecycle build ids or
generator fields; preview publication uses `OutputCatalog.buildId`. Cycle's
generator likewise has only `outputs()` and `render(path) -> ContentRef`.
SiteEngine now has one no-argument `finalize(handle)` for Publisher and Cycle.
The external renderer binds its immutable path catalog once and admits each
verified `SiteOutputFile` as it renders; the former public serialized
`RendererOutput` bulk plan and optional-finalize argument are deleted through
Rust, WASM, and the Worker. Native Bun transport is a hidden Fig IPC command,
absent from normal CLI help, rather than a fifth public finalization mode.

`OutputCacheKey`, `SiteOutputCache`, `FileSiteOutputCache`, and every public
cache accessor are deleted from `site_build`. `SiteOutput` contains only its
functional receipt and `so1` identity. Fig privately derives/publishes the
verified native optimization pointer; Cycle's exported native resolution view
contains only `{receipt, store}`. Fig's concrete filesystem ProjectSource and
PackageProvider implementations are private behind one path-based `prepare`.
Generated schema exactness is now tested for omitted/non-null options, the
nullable input allowlist, concrete compilation errors, and BuildEvent required
fields. Current focused evidence: SiteEngine 23 pass/1 ignored, SiteBuild
16+4+4, WASM 6+8, Fig 10+4, app 102/102 (509 assertions), TypeScript, contract
generation drift, and diff integrity. Rebuilt WASM/native Cycle/full Chromium
certification remains pending; do not land yet.

A follow-up wire/documentation audit reran only the generated-contract drift
check, the four exporter schema-exactness tests, Fig's four shared-envelope
tests, and editor TypeScript; all passed. The generated editor/Cycle
declarations remain identical,
`PrepareResult.generator` is the closed generated `GeneratorKind`, and no cache
field/type, bulk renderer plan, or optional-finalize payload appears in
generated `SiteOutput` or its schemas. This follow-up did not rerun app tests or
production build, WASM, native Cycle, Chromium, or deployment gates.

**GENERATED-CONTRACT CHECKPOINT (SUPERSEDED BY NO-ARG FINALIZE ABOVE):** the
generated contract now covers the complete
ClosedSiteBuild/SiteOutput graph in both editor and Cycle, and SiteOutput no
longer serializes its private `sok1` lookup key. Rust derives that key only for
private cache addressing; `so1` now hashes exactly the functional receipt plus
files. Rust and Cycle independent identity/cache fixtures pass. `outputs`,
`render`, and `finalize` now return the same typed `BuildError` envelope as
`prepare`; the Worker uses `unwrapBuild` for all four and no longer fabricates
phases/codes from strings. The unused standalone WASM `compileProject` route is
deleted and the byte-parity gate calls atomic `prepareProject`.

All preparation, package-storage, init, and prepared-mount observations now
travel as generated `BuildEvent`; flat prepare/mount/storage result metrics and
the ambient `EngineClient.progressCb/setProgress` channel are deleted. Event
sinks are explicit per operation, functional build events name operation and
build id, and the browser Build registry is bounded to two generations. Focused
evidence at this checkpoint: SiteEngine 21 pass/1 ignored, WASM 6+5+8, Fig
10+4, SiteBuild 16+4+6, app 102/102 plus TypeScript, and Cycle core/native
orchestration 60/60 plus both entrypoint bundles. This older checkpoint is
superseded by “NO-ARG FINALIZE + PRIVATE CACHE” above; its named deletion work
is complete. Full rebuilt-WASM/browser certification has not run.

Feature-gated Rust derives now generate `app/src/site/contract.generated.ts`
and Draft 2020-12 schemas at `contracts/site-wire.schema.json`;
`scripts/generate-wire-contract.sh --check` gates drift. Generated roots cover
ProjectRevision, GeneratorSpec, ContentRef, output catalog/SiteOutput,
BuildEvent, and typed BuildError. The browser's former five-argument prepare
transport is one ProjectRevision plus one normalized GeneratorSpec; workspace
id is adapter metadata, render epoch belongs to GeneratorSpec, and FSH is
consistently `fsh`. The second Rust ProjectRevision name embedded in SiteBuild
is now `ProjectIdentity`.

Render now returns only ContentRef through Rust, WASM, worker, client, preview,
and Fig. Web and Fig expose immutable Build facades; raw build ids remain
lifecycle addressing. Rust PrepareResult and preview protocol 6 no longer carry
duplicate handle/buildId fields. Progress uses generated BuildEvent and worker
failures use generated typed BuildError. Focused Rust checks, app TypeScript,
and 102/102 app tests pass; rebuilt-WASM/full browser certification has not run.
The Cycle staging-tree external plan named by this older checkpoint has since
been deleted in favor of renderer writes to ContentStore references and the
single no-argument finalization path described above.

## Active performance/UX certification (2026-07-12)

**MOBILE REACHABILITY + AGGREGATE PACKAGE PROGRESS (LANDING 2026-07-12):** a real
phone report exposed two gaps in the prior gate. Before Preview was selected,
the six-card overview's intrinsic width expanded the fixed app to 492px inside
a 390px visual viewport; the gate then invoked the stranded Preview tab with
JavaScript. The app and workspace now use zero-minimum grid columns/children,
the mobile top bar has explicit rows, and Author/Explore/Site preview are three
equal viewport-bound columns. The gate now center-point hit-tests every real tab
before clicking it and also renders the exact busy tab DOM at 320px, where
clientWidth == scrollWidth == 320 and each target is 105px. At 390px all three
targets are 128.7px and Preview exposes a 467px iframe.

The resolver still retains bounded four-way I/O, but packages in one atomic
mount batch now report one aggregate completed/total count and cumulative bytes
instead of racing individual names and denominators into the banner. A cold
Tiny receipt measured 20.693s open-to-published versus only 1.578s compiler
time, so pending UI now says “Preparing” and no longer attributes package,
template, SiteBuild, and publication work to compilation. Focused receipt:
`/tmp/fhir-mobile-reachability-progress-final.log` (`MOBILE LAYOUT GATE: PASS`).
The exact complete Pages-subpath receipt is
`/tmp/fhir-mobile-progress-full.log` (`E2E GATE: PASS`): real US Core displayed
stable 8-, 6-, and 2-package batches, retained 1,535/1,535 images, 85/85 assets,
and one shell; real mCODE, persistence/restart, scroll/hot reload, and every
prior gate remain green. App 102/102 (518 assertions), TypeScript, the 1,135-
module Pages build, diff integrity, commit, push, and Pages deployment are
green. Editor `7cfc66f` is pushed to `main`; Pages run `29209149872` passed the
complete engine/native/package/Cycle/app gates, fresh-profile Chromium closure,
artifact upload, and deploy. The live origin was separately verified serving
app `assets/index-BOlma0xV.js`, CSS `assets/index-BJ03kRGq.css` with the
viewport-bound three-column tabs/overflow fix, and preview protocol 5.

**MOBILE PROGRESS STABILITY FOLLOW-UP (`36a20f1`, PUSHED 2026-07-12):** the project-open
banner now reserves its progress bar and byte-counter slots before the first
response chunk, uses fixed grid areas, ellipsizes package detail, and gives
mobile a stable phase/detail/bytes layout. The deferred snapshot-package copy is
now user-facing “profile dependencies”; Explore calls the result “Full
definition” and visibly explains that FHIR's snapshot is the complete inherited
definition after applying the profile differential. Initial compilation no
longer presents absent results as zero/empty: definition-derived counts are
pending ellipses, Explore says Compiling and disables its picker, and the panel
explains that the authored profile appears after FHIR dependencies load. Once
compilation returns, Explore is immediately usable without waiting for site
publication. App 96/96 (493 assertions) and the 1,135-module build pass. The
complete browser receipt is `/tmp/fhir-pending-definitions-full2.log` (`E2E
GATE: PASS`); it observes the pending-definition state during real package
fetching, and its 390px regression
measures 63/63/63/63px for empty, short, growing, and long byte labels (0px
range, no overflow), while US Core/mCODE/scroll/restart/mobile gates remain
green. Editor `36a20f1` is pushed to `main`; Pages run `29206515712` passed the
complete engine/native/package/Cycle/app/build gates, fresh-profile Chromium,
artifact upload, and deploy. The live origin was separately verified serving
app `assets/index-DMW22hhF.js`, CSS `assets/index-BclA8Kk1.css`, worker
`assets/engine.worker-D8QfEkFa.js`, preview protocol 5, the new progress/Explore
copy, and the exact 11,747,189-byte baked R4 core artifact.

**BAKED TRANSPORT RETRY FOLLOW-UP (`dcc6e6c`, PUSHED 2026-07-12):** investigation of
the mobile screenshot that unexpectedly downloaded baked R4 core from the
registry found that `obtainPackage` silently swallowed every generic
same-origin load failure. The active patch classifies only HTTP/network/body
read failures as `BakedBundleTransportError`, retries the same authenticated
immutable artifact once, and allows local/registry fallback only after a second
transport interruption. Integrity, inflate/decode, and programming failures
stay fatal instead of being hidden behind a second large download. Focused
tests prove transient retry, HTTP/body classification, digest fail-closed,
decode fail-closed, and fallback to an explicit local package only after two
transport interruptions. The full app is green at 100/100 tests (505 assertions),
TypeScript, and a 1,135-module Pages-base production build. The exact full
Pages-subpath browser receipt is `/tmp/fhir-baked-retry-full.log` (`E2E GATE:
PASS`): Tiny/Cycle, US Core 1,535/1,535 images and one-shell CarePlan, real
mCODE, persistence/restart/scroll, 63px-stable mobile progress, and a 922 ms
warm edit all remain green. Pages run `29207110648` passed every engine/native/
package/Cycle/app/build/browser/upload/deploy job. The live origin was separately
verified serving app `assets/index-CdYUDRdQ.js`, resolver
`assets/packageResolver-D9o9M5Zj.js` containing the typed retry/fallback, preview
protocol 5, and the exact 11,747,189-byte baked R4 core artifact.

**ATOMIC MIXED PACKAGE MOUNT FOLLOW-UP (`fdd8900`, DEPLOYED 2026-07-12):** the complete
browser receipt exposed a second, separate cause of repeat work: whenever one
resolver batch contained both prepared and raw packages, `EngineClient`
deliberately reacquired every prepared member as raw because the Worker only
accepted all-warm or all-cold batches. That restriction and the duplicated
Worker mount branches are deleted (31 net lines). Warm and cold carriers now
stage in original resolver order behind one `beginPreparedMount`, and one Rust
commit remains the sole mounted-state mutation. Recovery replaces only prepared
members and retries the same atomic batch. Protocol metrics distinguish mixed
transactions. App 101/101 (512 assertions), TypeScript, syntax, diff integrity,
and the 1,135-module Pages-base build pass. The exact browser receipt is
`/tmp/fhir-mixed-package-mount-full.log` (`E2E GATE: PASS`): real US Core used
two mixed transactions with nine prepared hits and `refetched: []`; all prior
Tiny/Cycle, 1,535-image/one-shell CarePlan, mCODE, persistence/restart/scroll,
mobile, and warm-edit gates remain green. The repeatable benchmark receipt is
`/tmp/uscore-mixed-package-mount.json`: 77.439 s cold, 8.740 s persistent hard
reload, and 1.423 s same-worker reopen. Those are within the prior baseline
because this benchmark jumps from engine boot directly to US Core and therefore
correctly reports zero mixed calls; do not claim a warm-reload improvement from
this slice. The measured gain is the Tiny/Cycle -> US Core transition exercised
by the full gate: nine prepared packages retained, zero baked re-fetches.
Pages run `29207689560` passed every build/browser/upload/deploy job. The live
origin was separately verified serving app `assets/index-bqcubdX4.js`, worker
`assets/engine.worker-ByyXv0X0.js` containing warm/cold/mixed modes, resolver
`assets/packageResolver-DsWQqzCL.js`, and preview protocol 5.

**EDIT LATENCY MEASUREMENT (UNCOMMITTED BENCHMARK OPTION 2026-07-12):** the 300
ms semantic and 120 ms prose pauses are explicit trailing debounces in
`LatestTaskQueue`, not processing measurements. `BENCH_PROFILE_EDIT=1` now adds
a loaded US Core Patient JSON title edit to the existing benchmark and waits for
the changed published profile page. Two receipts are
`/tmp/uscore-profile-edit.json` and `/tmp/uscore-profile-edit-final.json`:
5,569.7/5,610.8 ms edit-to-visible, first Worker operation at 530.3/522.9 ms,
and 5,039.4/5,087.9 ms from that boundary to the visible page. The new
SiteBuild/catalog took 4,480.7/4,482.4 ms: compile 1,629/1,617 ms and the
remaining Rust/Worker preparation boundary about 2,547/2,589 ms (PreparedGuide
814/826, Publisher model 114/117, render model 774/787, output catalog 85/86,
Publisher artifacts 172/174, close 14/15). `outputs` was 35.5/40.6 ms and
open-page render 143.8/144.2 ms; preview commit was 177.6/181.6 ms and final
reload/scripts/layout about 394/406 ms. Exact edit-scoped package downloads
were zero. Do not present debounce tuning as the main semantic-edit optimization;
compile and preparation dominate.
The same follow-up now immediately invalidates the current latest-task lease on
every source edit, before starting the trailing debounce. Previously an older
capture retained publication authority until the timer enqueued its successor,
leaving a 120/300 ms stale-commit window. The next build remains debounced and
serialized; only publication authority changes immediately.
App 102/102 (514 assertions), TypeScript, the 1,135-module Pages build, and the
exact full browser receipt `/tmp/fhir-edit-lease-full.log` (`E2E GATE: PASS`)
are green after this change; the receipt preserves the mixed-mount zero-refetch,
US Core/mCODE, edit/hot-reload/scroll, persistence/restart, and mobile gates.

The audit patch is landed and Pages run `29195715737` passed. The active
uncommitted round keeps the four-operation architecture and makes the persistent
package path exact and lazy. SiteBuild v2 roots the exact deterministic
PreparedPackage carrier used by execution; the unprovable parallel normalized
payload and redundant renderer-package artifacts are deleted. One typed mount
owns carrier identity and lazy files, rejects nested-only same-label drift, and
gives live/restored Publisher rendering the same top-level semantic members plus
`other/spec.internals`. Warm A/B pointer labels are compared before atomic
commit. The path-membership check is logarithmic.

The final corrected rebuilt-WASM receipt is `/tmp/uscore-v2-bound-final.json`.
Fresh-profile US Core cold setup is 77.435 s; hard reload exposes prior verified
UI/page at 659/765 ms and reaches exact Ready at 8.432 s (8.683 s tail). A
deliberately strict interim v1 verification was measured at 20.638 s because it
inflated and hashed the entire semantic closure; it was not shipped. Prepared
mounting retains 152 MB of compact artifacts, inflates zero chunks/bytes, and
closure verification is 0 ms because carrier bytes are authenticated exactly
once. US Core -> Cycle -> US Core is 1.250 s with no Worker recycle,
`siteBuildCacheHit=1`, and zero template/runtime/model/render/catalog
reconstruction. The benchmark fails on body inflation, a >=1 s closure walk,
or retained-runtime/lifecycle regression.

The exact committed-engine-stamp Pages-subpath browser receipt is
`/tmp/fhir-v2-bound-stamped-full.log` (`E2E GATE: PASS`): 632 ms Cycle edit,
924 ms Publisher edit, exact diagnostic
source/definition/published-page navigation, US Core 1,535/1,535 images and
85/85 assets, one-shell CarePlan, real mCODE, exactly one US Core -> mCODE
recycle, dirty workspace persistence, scroll 640 -> 640, restart, and mobile
geometry. Fresh-process native Publisher also passes at
`/tmp/fhir-v2-bound-fig-gate.log` with the 1,799-file
`so1-sha256:eb61f833...` receipt. Engine implementation `e0d3a217` plus its
certification-only handoff commit `bfcb9903` are pushed identically to
`snapshot-gen` and `main`; Cycle `70231bd` is pushed to `main`. Editor
`5476bea` pins both and is pushed to `main`. Pages run `29201262281` passed the
engine/native/package/Cycle/app/build gates, complete fresh-profile Chromium
closure, artifact upload, and deploy. The live origin serves app
`assets/index-Dq4nSwVK.js`, worker `assets/engine.worker-D8QfEkFa.js`, preview
Service Worker protocol 5, and the `bfcb990`-expected 5,653,630-byte WASM.

The same app patch adds exact diagnostic owner navigation through source,
definition, and published consequence; one truthful build status; page-owned
artifact trails; bounded Cycle coexistence; changed-ContentRef publication; and
targeted preview pre-resolution. App 94/94 and focused Rust/static gates are
green at this checkpoint.

## Completion-audit landing (engine landed, editor patch active 2026-07-12)

An independent requirement-by-requirement audit confirmed the deletion-first
architecture is real, then found a small amount of public/test/documentation
residue. The current uncommitted follow-up:

- deletes `nonReadyFragments` from Rust, Fig, and TypeScript so Publisher
  fragment observations remain private behind `render(handle, path)`;
- makes the complete public Rust input `site_engine::ProjectRevision`, renames
  the post-compile executor state to private `CompiledProjectRevision`, and
  deletes its unused test-support feature/mutators;
- directly gates `prepared_guide` and `site_engine` in Pages CI, adds exact
  retained-runtime/recency/render-semantics reuse tests, and adds
  `scripts/fig-publisher-gate.sh` for a fresh-process native Publisher
  `prepare -> outputs -> render -> finalize` integration;
- makes the full browser gate assert the dirty Cycle workspace survives both
  A -> US Core/mCODE -> A and a complete editor reload; and
- corrects old relational/watch/test prose and distinguishes the private
  config/template package-acquisition handshake from the one complete project
  payload that crosses in `prepare`.

The completion audit is fully green. Focused evidence: SiteEngine 17 pass/1
explicit oracle-fixture ignore, Fig 17+4, WASM 3+5+8, app 78/78 (422
assertions) plus production build, Cycle 236/236 (651 assertions) plus renderer
typecheck, all-target workspace and wasm32 checks, formatting, syntax, and
diff-integrity checks. The fresh-process native Publisher gate produced 1,799
files with receipt `so1-sha256:f082806d...`. The rebuilt Pages-subpath Chromium
receipt is `/tmp/fhir-architecture-completion-audit.log` (`E2E GATE: PASS`): it
proves US Core 1,535/1,535 images and a one-shell CarePlan, real mCODE without
fallback/error, dirty workspace survival across A -> B/C -> A and editor
reload, exact retained-render reuse, protocol-5 persistence, scroll retention,
and mobile geometry. Engine commit `19856385` is pushed identically to
`snapshot-gen` and `main`; the current editor patch pins that engine and adds
the CI/browser certification. The user has authorized landing this patch.
Rebuild WASM from `19856385`, commit/push editor `main`, and monitor Pages
through deployment before claiming the live site is updated.

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
91-file receipt and skipped Liquid rendering on its verified cache hit. At that
historical checkpoint current-WASM certification was still running; later
sections record its completion. It was not committed or pushed there.

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
- native Cycle may look up and publish only canonical `SiteOutput` through a
  private host pointer derived from the verified closed `SiteBuild` and exact
  renderer recipe/options; no cache type belongs to `site_build`; and
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
  only persistent warm package form is PreparedPackage v3; a missing/corrupt
  artifact safely reacquires its exact baked transport, explicit local package,
  or registry coordinate.
- Preview publishes one immutable `{igId, handle, buildId, catalog}` pointer.
  The protocol-5 module Service Worker verifies ContentRefs in OPFS, renders
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
