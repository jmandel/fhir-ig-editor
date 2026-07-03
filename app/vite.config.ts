import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Static SPA for GitHub Pages. `base` is set from BASE_PATH at build time so the
// site works both at a user/org root and under /<repo>/ (project Pages). The
// engine worker + wasm live in public/ (copied verbatim); large FHIR package
// bundles + the baked cycle manifest land in public/data/ via scripts/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
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
