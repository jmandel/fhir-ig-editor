import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';

const ENGINE_COMMIT = (() => {
  try {
    return execSync('git -C ../vendor/sushi-rs rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return process.env.ENGINE_COMMIT ?? 'dev';
  }
})();
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// The cycle site-gen renderer (submodule, READ-ONLY) opens a bun:sqlite file at
// `core/db.ts` import time. For the M2 preview we redirect that module to our
// RowStore-backed shim (src/preview/dbShim.ts) so importing Layout/Menu resolves
// to in-memory rows, not a file DB. Aliasing the exact submodule file path is how
// we override a read-only submodule without patching it.
const DB_SHIM = resolve(HERE, 'src/preview/dbShim.ts');
const CYCLE_SITEGEN = resolve(HERE, '../vendor/cycle/site-gen');
// Match the submodule's `core/db` module however it's imported (relative
// `../core/db`, `@cycle/core/db`, or the resolved absolute path). Redirecting it to
// our RowStore shim is what stops bun:sqlite from being pulled into the bundle.
const CYCLE_DB_RE = /(^|\/)vendor\/cycle\/site-gen\/core\/db(\.ts)?$/;

// A resolveId plugin that redirects the submodule's `core/db` (bun:sqlite) to our
// RowStore shim — however it is imported. A plain alias can't reliably catch the
// relative `../core/db` specifier from inside the submodule, so we intercept at the
// resolved-id level (after Vite resolves it against the importer).
function cycleDbRedirect() {
  return {
    name: 'cycle-db-redirect',
    enforce: 'pre' as const,
    async resolveId(this: any, source: string, importer: string | undefined, options: any) {
      // Fast path: relative `../core/db` from inside the submodule.
      if (/(^|\/)core\/db(\.ts)?$/.test(source) && importer && importer.replace(/\\/g, '/').includes('/vendor/cycle/site-gen/')) {
        return DB_SHIM;
      }
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved && CYCLE_DB_RE.test(resolved.id.replace(/\\/g, '/'))) return DB_SHIM;
      return null;
    },
  };
}

// Static SPA for GitHub Pages. `base` is set from BASE_PATH at build time so the
// site works both at a user/org root and under /<repo>/ (project Pages). The
// engine worker + wasm live in public/ (copied verbatim); large FHIR package
// bundles + the baked cycle manifest land in public/data/ via scripts/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [cycleDbRedirect(), react()],
  resolve: {
    alias: [
      // `@cycle/*` -> the real submodule render pieces (bundled + transpiled by
      // esbuild; app-side tsc maps them to a stub instead — see tsconfig paths).
      { find: /^@cycle\/(.*)$/, replacement: `${CYCLE_SITEGEN}/$1` },
      // The submodule imports these bare packages but its node_modules is not
      // ours; resolve them from THIS app's node_modules (we pin the same versions
      // as the cycle repo). Exact-match aliases so subpaths (e.g. fhirpath/...) and
      // our own imports are unaffected.
      { find: /^react$/, replacement: resolve(HERE, 'node_modules/react') },
      // Use the BROWSER build of react-dom/server (the `default`/node build needs
      // node's `util`/`stream` and dies in the worker with "reading 'prototype'").
      { find: /^react-dom\/server$/, replacement: resolve(HERE, 'node_modules/react-dom/server.browser.js') },
      { find: /^markdown-it$/, replacement: resolve(HERE, 'node_modules/markdown-it') },
      { find: /^markdown-it-anchor$/, replacement: resolve(HERE, 'node_modules/markdown-it-anchor') },
      { find: /^fast-xml-parser$/, replacement: resolve(HERE, 'node_modules/fast-xml-parser') },
      // fhirpath uses subpath imports (fhirpath/fhir-context/r4); alias the prefix.
      { find: /^fhirpath$/, replacement: resolve(HERE, 'node_modules/fhirpath') },
      { find: /^fhirpath\/(.*)$/, replacement: `${resolve(HERE, 'node_modules/fhirpath')}/$1` },
    ],
  },
  // The cycle renderer's project config reads specific `process.env.SITE_*` vars
  // at module load (all have `||` fallbacks). Define just those as undefined so
  // they resolve to the cycle defaults — WITHOUT clobbering the whole
  // `process.env` (React etc. read process.env.NODE_ENV; replacing the object
  // breaks them). Bare `process` is shimmed to `{ env: {} }` for the SITE_PROJECT
  // membership check without touching NODE_ENV reads.
  define: {
    // Cache-buster for the un-hashed pkg/ engine assets (wasm + bindgen js):
    // they sit outside vite's content-hashing, so without this a browser HTTP
    // cache can pair an OLD engine with NEW app bundles after a redeploy —
    // which breaks in maximally confusing ways (raw liquid served as pages).
    __ENGINE_COMMIT__: JSON.stringify(ENGINE_COMMIT),
    'process.env.SITE_PROJECT': 'undefined',
    'process.env.OUT_DIR': 'undefined',
    'process.env.SITE_DESIGN_DIR': 'undefined',
    'process.env.SITE_PROJECT_CSS': 'undefined',
    'process.env.SITE_CONTENT_DIR': 'undefined',
    'process.env.SITE_IMAGE_DIR': 'undefined',
    'process.env.SITE_LIQUID_ASSET_DIRS': 'undefined',
    'process.env.SITE_EXTERNAL_LINKS': 'undefined',
    'process.env.SITE_CNAME': 'undefined',
    'process.env.SITE_PACKAGE_LIST': 'undefined',
    'process.env.SITE_BRAND_WORDMARK': 'undefined',
    'process.env.SITE_BRAND_TLD': 'undefined',
    'process.env.SITE_BRAND_MARK': 'undefined',
    'process.env.SITE_BRAND_TAGLINE': 'undefined',
    'process.env.SITE_GEN_LENIENT': 'undefined',
    'process.env.SITE_DB': 'undefined',
  },
  worker: {
    format: 'es',
    // The worker imports the render adapter (submodule pieces incl. core/db); it
    // gets its own rollup pass, so the db redirect must be registered here too.
    plugins: () => [cycleDbRedirect()],
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // Monaco is large; keep it in its own chunk so the shell paints fast.
    chunkSizeWarningLimit: 4096,
  },
  // COOP/COEP not required: we use a single classic-ish ES worker + wasm, no
  // SharedArrayBuffer. OPFS works without cross-origin isolation.
  server: {
    fs: { allow: ['..'] },
  },
});
