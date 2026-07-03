# PUBLISH — coordinator checklist for `jmandel/fhir-ig-editor`

This repo was built **locally, offline** (no `gh`, no push). Everything here is
verified locally (see "Local verification" below). To go public:

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

## Out of scope this run

- **M2 site preview** (spec §7) — not built.
- OPFS is used with an in-memory fallback; Safari degrades to no-persistence
  (stated in spec §11, not hardened here).
