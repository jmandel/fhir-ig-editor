# fhir-ig-editor

A fully static, GitHub-Pages-hosted web editor for FHIR Implementation Guides.
Edit FSH in the browser, compile with **rust_sushi** and generate snapshots with
the **walk engine** — both compiled to WebAssembly and running in a Web Worker —
and see diagnostics + rendered results live. Loads an existing IG (default: the
**cycle** period-tracking IG) and works offline after first load. No server, ever.

> Status: **M1** (the demo bar). See [SPEC.md](./SPEC.md) for the full design.

## What works (M1)

- **Open the demo IG** (one click): hydrates the cycle IG into OPFS (in-memory
  fallback where OPFS is unavailable). Offline thereafter.
- **Edit FSH** in Monaco (multi-file, FSH syntax highlighting, per-file error
  markers).
- **Live compile** on a 300 ms debounce → compiled FHIR resources +
  **SUSHI-exact diagnostics** (correct file + line), sub-second for cycle.
- **Per-resource views**: compiled JSON, the **differential** table, and the
  **snapshot element tree** (the walk engine's output) — generated on demand,
  memoized per profile.
- **Build timings** + engine identity (version + git commit) shown throughout.

The engine output is **byte-identical to native** `rust_sushi build` for the
whole cycle IG (`scripts/byte-check.mjs`; a CI gate).

## Architecture

```
UI (React + Monaco)  ──edits(300ms debounce)──▶  Engine Worker (owns wasm)
   file tree · views                               init(bundles)
        ▲                                           compile(files,config,predef)
        └── diagnostics → markers + problems        generate_snapshot(url)
            resources   → JSON / differential / snapshot tree
```

- `app/src/worker/` — the engine worker + typed protocol (the reusable seam).
- `app/src/vfs/` — OPFS-backed project store + the baked-IG loader.
- `app/src/editor/` — Monaco setup, FSH language, file tree.
- `app/src/views/` — diagnostics, JSON, differential, snapshot tree, build status.
- `vendor/sushi-rs` (submodule) — the engine. **This repo never patches it**;
  the pinned submodule SHA *is* the engine version.
- `vendor/cycle` (submodule) — the default IG.

## Editor component

**Monaco** (bundled locally, no CDN — the whole app is offline-capable). FSH
highlighting is a native Monaco **Monarch** tokenizer (`app/src/editor/fshLanguage.ts`)
rather than the TextMate-grammar-via-onigasm shim the spec lists as the first
choice: the Monarch route needs no second wasm and no extra offline assets, which
matters for a static/offline bundle. The TextMate grammar can be registered
alongside later — the editor setup is the seam.

## Develop

```sh
git submodule update --init --recursive     # (see note below if offline)

# 1. Assemble static data into app/public/ (wasm + package bundles + IG manifest).
#    Needs a wasm32-unknown-unknown toolchain + wasm-bindgen + a FHIR package
#    cache. See scripts/*.sh headers and PUBLISH.md for the toolchain knobs.
bash scripts/prepare-data.sh

# 2. Run the app.
cd app && npm install && npm run dev        # or: bun install && bun run dev
```

## Verify

```sh
cd app && npm run build                      # tsc + vite build
# headless end-to-end (open demo → edit → diagnostic → snapshot):
#   serve app/dist, launch chromium --remote-debugging-port=9222, then:
node scripts/verify-e2e.mjs http://localhost:4173/
# byte-check wasm vs native (needs a nodejs-target wasm build + native output):
node scripts/byte-check.mjs <pkg-node> app/public/data/bundles vendor/cycle <native-resources>
```

## Deploy

`git push` to `main` → `.github/workflows/pages.yml` → GitHub Pages. CI runs the
pinned engine's own fast gates before deploying and byte-compares wasm vs native
for the whole cycle IG. See [PUBLISH.md](./PUBLISH.md) for the one-time setup.
