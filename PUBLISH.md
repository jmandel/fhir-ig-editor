# Build, certify, and publish `fhir-ig-editor`

This is the current operations runbook. It replaces the former chronological
task/branch diary; statements such as “not merged,” old commit pins, and old
`dbShim`/forked-renderer instructions are deliberately removed.

The deployed product is one immutable Vite artifact built from three exact Git
commits:

- this repository;
- `vendor/sushi-rs`; and
- `vendor/cycle`.

The editor's WASM and expected-engine constant must both name the pinned engine
commit. Never publish a WASM rebuild from a dirty engine tree and treat its
`HEAD` stamp as a released dependency.

## One-time GitHub setup

The repository is `jmandel/fhir-ig-editor` and deploys from GitHub Actions.

1. In **Settings → Pages**, select **GitHub Actions** as the source.
2. Permit the workflow's `pages: write` and `id-token: write` permissions.
3. Configure the custom domain/DNS for `joshuamandel.com` if the public URL is
   meant to remain <https://joshuamandel.com/fhir-ig-editor/>.
4. Do not commit generated `app/public/` or `app/dist/` data as a substitute for
   the build recipe. Pages uploads `app/dist` from CI.

No application-server secret or terminology-server credential is required.

## Toolchain

Local full builds need:

- Rust and the `wasm32-unknown-unknown` target;
- `wasm-bindgen-cli` at the version in `vendor/sushi-rs/Cargo.lock`;
- `wasm-opt` 116 or newer (CI pins Binaryen 117);
- Bun and the committed `bun.lock` files;
- Chrome/Chromium for the browser gate; and
- the FHIR packages listed in `scripts/packages.list`.

The useful environment variables are:

| Variable | Meaning |
| --- | --- |
| `FHIR_CACHE` | explicit `.fhir/packages`-shaped package cache used by scripts and native gates |
| `SUSHI_RS_DIR` | engine source used by `scripts/build-wasm.sh`; defaults to `vendor/sushi-rs` |
| `WASM_BINDGEN` | exact `wasm-bindgen` executable when it is not on `PATH` |
| `CHROME_BIN` | browser executable for `scripts/run-browser-gates.sh` |
| `BASE_PATH` | deployment base; `/fhir-ig-editor/` for project Pages and `/` for root hosting |

## Canonical data build

Initialize dependencies and populate an explicit cache:

```sh
git submodule update --init --recursive
export FHIR_CACHE="$PWD/.fhir-cache"
bash scripts/fetch-packages.sh
```

The one-shot local recipe is:

```sh
bash scripts/prepare-data.sh
```

It performs exactly two stages:

1. `scripts/build-wasm.sh` builds `wasm_api`, runs `wasm-bindgen`, optionally
   optimizes it, writes `app/public/pkg/`, and generates the app's expected
   engine-commit constant.
2. `scripts/assemble-static-data.sh` builds package bundles, Cycle/catalog
   source manifests, template/site/fixture artifacts, expansion warm starts,
   and the versioned Publisher-runtime asset pack under `app/public/data/`.

Pages CI invokes the same assembly script after its separately tested WASM
build. There must not be a second CI-only catalog or asset recipe.

## Local certification

Run the focused engine contracts from the engine commit that will be pinned:

```sh
cd vendor/sushi-rs
cargo test -p compiler -p wasm_api -p snapshot_gen --release
cargo test -p site_build --features site-db-compat --release
cargo test -p render_page --release
cargo test -p fig --release
cd ../..
```

Run Cycle's shared CLI/browser renderer contract:

```sh
cd vendor/cycle
bun install --frozen-lockfile
bun run typecheck:renderer
SITE_GEN_USE_FIXTURE=1 bun site-gen/ingest.ts
bun test
cd ../..
```

The Pages job also runs the preferred native path against an archived copy of
the pinned guide: project-specific example generation, `fig prepare` with the
explicit package cache, then `SITE_BUILD_DIR=<bundle> bun site-gen/build.tsx`.
The exact reusable command and its input/output boundary are documented in
[`vendor/cycle/site-gen/FIG-INTEGRATION.md`](vendor/cycle/site-gen/FIG-INTEGRATION.md).

Run app contracts and build with the actual Pages base:

```sh
cd app
bun install --frozen-lockfile
bun test tests
BASE_PATH=/fhir-ig-editor/ bun run build
cd ..
```

Finally certify an immutable copy of that exact artifact in a fresh browser
profile:

```sh
BASE_PATH=/fhir-ig-editor/ bash scripts/run-browser-gates.sh app/dist
```

The script serves a private snapshot rather than the live worktree. Its CDP
harness covers engine boot and commit identity, compilation/diagnostics,
snapshot/terminology behavior, Cycle and stock rendering, arbitrary template
loading/refusal, US Core runtime closure, independent-window navigation,
reload/history, IG-scoped hot reload, and editor-close cache/fallback behavior.

The runtime-closure assertion requires zero broken images, zero missing or
HTML-fallback same-origin assets, required table globals, the exact gated jQuery
compatibility behavior, and no unexpected uncaught browser exceptions.

## What Pages CI does

`.github/workflows/pages.yml` runs on `main` and performs:

1. recursive submodule checkout;
2. focused engine tests;
3. version-matched `wasm-bindgen` and pinned Binaryen installation;
4. cached fetch of `scripts/packages.list`;
5. native engine build and resolver-generated package-list drift check;
6. WASM build and canonical static-data assembly;
7. native/WASM compiler byte comparison;
8. live-mounted versus packed-template parity;
9. local-expansion versus committed-cache consistency machinery;
10. Cycle shared-renderer tests;
11. a real Fig `cycle-site/v1` versus `cycle-site/v2` build whose complete
    ordinary output trees must be byte-identical and whose input-bound receipts
    must differ;
12. editor data-contract tests and a production Vite build under
    `/<repository>/`;
13. fresh-profile Chrome certification of the exact artifact; and
14. Pages artifact upload/deployment.

The eight-IG `snapshot/package-deps-gate.sh` needs a separate corpus/cache and is
explicitly reported as out of scope in Pages CI. A notice is not a green parity
result.

## Dependency-first landing

When a change crosses repositories, land in this order.

### 1. Engine

Review the engine diff, run its gates, commit, and push the active engine branch.
Fast-forward/push `main` according to the repository's branch policy. Record the
new full commit:

```sh
git -C /path/to/sushi-rs rev-parse HEAD
```

### 2. Cycle

If the shared renderer/content/view changed, review its diff and tests, commit,
and push Cycle before updating the editor pin.

### 3. Editor pins and generated WASM

Update `vendor/sushi-rs` and `vendor/cycle` to the pushed commits. Then rebuild
WASM from `vendor/sushi-rs` (not an uncommitted sibling tree), reassemble data,
and rerun app/Cycle/browser gates.

Confirm all three identities explicitly:

```sh
git submodule status vendor/sushi-rs vendor/cycle
git -C vendor/sushi-rs rev-parse HEAD
git -C vendor/cycle rev-parse HEAD
```

The browser's engine label and the app's expected commit must match the pinned
engine SHA. A mismatch is a release blocker, even if rendering appears to work.

### 4. Editor

Review generated-source assumptions, `git diff --check`, and submodule pins.
Commit/push editor `main`. Watch the Pages workflow through deployment; do not
call a local pass a deployment pass.

## Live smoke check

After Pages succeeds:

1. Load <https://joshuamandel.com/fhir-ig-editor/> with a fresh profile and
   confirm the engine commit.
2. Open Cycle, render with the Cycle generator, edit page content, and confirm
   only Cycle preview windows for the changed page reload.
3. Switch to the stock template and render/edit a profile or page.
4. Open US Core, render `StructureDefinition-us-core-patient.html`, and inspect
   tables/icons/images.
5. Open an independent preview tab and exercise links, back/forward, and reload.

The automated artifact gate is authoritative; the smoke check catches hosting,
cache, custom-domain, or browser-policy conditions outside the build runner.

## Rollback

Revert the editor commit (including its submodule pins) and push `main`. CI will
rebuild all WASM/data bytes from those older exact pins and deploy a coherent
artifact. Do not manually mix an older `dist`, newer app JavaScript, and an
unrelated WASM module.

## Known release limitations

- Templates with custom `ant` hooks are refused; no browser path executes them.
- Native Fig can promote a captured stock render into a CAS-backed immutable
  `SiteBuild` successor. The browser stock adapter does not yet publish that
  successor through its worker/build-handle protocol.
- Stock adapter/session state is still mutable behind the serial build queue;
  immutable per-build stock handles remain convergence work.
- Direct `SITE_DB` still opens an unsealed compatibility database and enables
  native-only Liquid SQL. It is an explicit legacy fallback; the preferred
  native Cycle path is the closed `fig prepare` bundle.
- Large catalog guides are sampled by the browser gate rather than exhaustively
  rendering every page on every deployment.
