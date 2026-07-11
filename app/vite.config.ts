import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';

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
const CYCLE_SITEGEN = resolve(HERE, '../vendor/cycle/site-gen');

const ENGINE_RECIPE = (() => {
  try {
    const hash = createHash('sha256');
    for (const name of ['wasm_api.js', 'wasm_api_bg.wasm']) {
      hash.update(name);
      hash.update('\0');
      hash.update(readFileSync(resolve(HERE, `public/pkg/${name}`)));
      hash.update('\0');
    }
    return hash.digest('hex');
  } catch {
    // No emitted engine means there can be no safe persistent semantic reuse.
    // A per-process identity deliberately turns every such dev start into a miss.
    return `unbuilt-${ENGINE_COMMIT}-${Date.now()}`;
  }
})();

/** Content identity of the Cycle renderer implementation and its pinned JS
 * dependency graph. This is stricter than a version string and remains correct
 * for dirty local builds as well as clean CI commits. */
const CYCLE_RENDER_RECIPE = (() => {
  const hash = createHash('sha256');
  const addFile = (file: string, relative: string) => {
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  };
  const walk = (dir: string, relative: string) => {
    for (const name of readdirSync(dir).sort()) {
      const file = resolve(dir, name);
      const rel = `${relative}/${name}`;
      if (statSync(file).isDirectory()) walk(file, rel);
      else if (/\.(?:ts|tsx|js|jsx|json)$/.test(name)) addFile(file, rel);
    }
  };
  walk(CYCLE_SITEGEN, 'vendor/cycle/site-gen');
  addFile(resolve(HERE, 'src/preview/render.tsx'), 'app/src/preview/render.tsx');
  addFile(resolve(HERE, 'package.json'), 'app/package.json');
  addFile(resolve(HERE, 'bun.lock'), 'app/bun.lock');
  return hash.digest('hex');
})();

// Static SPA for GitHub Pages. `base` is set from BASE_PATH at build time so the
// site works both at a user/org root and under /<repo>/ (project Pages). The
// engine worker + wasm live in public/ (copied verbatim); large FHIR package
// bundles + the baked cycle manifest land in public/data/ via scripts/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  resolve: {
    alias: [
      // `@cycle/*` -> the real submodule render pieces (bundled + transpiled by
      // esbuild; app-side tsc follows the same shared sources via tsconfig paths).
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
    __ENGINE_RECIPE__: JSON.stringify(ENGINE_RECIPE),
    __CYCLE_RENDER_RECIPE__: JSON.stringify(CYCLE_RENDER_RECIPE),
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
