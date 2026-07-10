// Engine Web Worker (spec §4). Owns the wasm-bindgen module (rust_sushi compiler
// + snapshot walk engine, wasm32-unknown-unknown / web target). The UI thread
// never blocks: all engine work happens here.
//
// Engine calls go through the wasm `Session` handle (the consolidated API):
// every method returns ONE apiVersion-stamped JSON envelope, unwrapped in ONE
// place (`unwrap`). The protocol to the UI is the typed op table in protocol.ts —
// this file is a handler per op, nothing else (ledger #2).
//
// The wasm module is emitted by scripts/build-wasm.sh into app/public/pkg/ and
// served as a static asset; we import it at runtime via the app base URL.
declare const __ENGINE_COMMIT__: string;

import type { EngineOps, Op, WorkerRequest, WorkerReply, BundleSpec, SiteTreeFile, StockSiteOptions } from './protocol';
import { ClosedBuildHandle } from '@cycle/core/closed-build';
import type { CycleSiteBuildPayload } from '@cycle/core/json-site-build';
import { JsonSiteBuildView } from '@cycle/core/json-site-build';
import type { CyclePreviewRenderer } from '../preview/render';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** The wasm-bindgen `Session` class surface (string-envelope methods). */
interface WasmSession {
  init(bundlesJson: string): string;
  mount(bundlesJson: string): string;
  resolveProject(config: string, versionIndexJson: string): string;
  compile(filesJson: string, config: string, predefinedJson: string): string;
  compileProject(filesJson: string, config: string, predefinedJson: string, siteFilesJson: string): string;
  setLocalResources(json: string): string;
  snapshot(input: string): string;
  buildSiteDb(inputJson: string): string;
  buildSiteDbFromCompile(inputJson: string): string;
  buildSiteBuildFromCompile(inputJson: string): string;
  expandValueSet(valueSetJson: string, resourcesJson: string): string;
  mountSite(filesJson: string, optionsJson: string): string;
  mountTemplate(coord: string): string;
  produceStockSite(): string;
  renderLiquid(source: string, dataJson: string): string;
  renderMarkdown(md: string, optsJson: string): string;
  listPages(): string;
  renderPage(name: string): string;
  renderFragment(ref: string, kind: string): string;
}

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  Session: (new () => WasmSession) & { version(): string };
};

let session: WasmSession | null = null;
let wasmMod: WasmModule | null = null;

async function ensureSession(): Promise<WasmSession> {
  if (session) return session;
  const v = encodeURIComponent(__ENGINE_COMMIT__);
  const mod = (await import(/* @vite-ignore */ `${BASE}pkg/wasm_api.js?v=${v}`)) as WasmModule;
  await mod.default(`${BASE}pkg/wasm_api_bg.wasm?v=${v}`);
  wasmMod = mod;
  session = new mod.Session();
  return session;
}

/** Unwrap a Session result envelope: `{apiVersion, ok, op, result|error}`.
 *  Domain errors arrive as `ok:false` (never thrown across the wasm boundary);
 *  we re-throw them here so the worker's single catch turns them into the
 *  protocol's error reply. */
function unwrap<T>(envelopeJson: string): T {
  const env = JSON.parse(envelopeJson) as
    | { apiVersion: number; ok: true; op: string; result: T }
    | { apiVersion: number; ok: false; op: string; error: { message: string } };
  if (env.apiVersion !== 1) throw new Error(`unsupported engine apiVersion ${env.apiVersion}`);
  if (!env.ok) throw new Error(`${env.op}: ${env.error.message}`);
  return env.result;
}

/** Labels currently mounted in the engine — so `mountBundles` is idempotent and
 *  the UI's lazy loader never re-fetches an already-mounted package. */
const mountedLabels = new Set<string>();

/** One atomically installed external-builder runtime. Its proof-bearing handle,
 * typed view, and prepared renderer can never refer to different builds. */
interface CycleBuildRuntime {
  build: ClosedBuildHandle;
  view: JsonSiteBuildView;
  renderer: CyclePreviewRenderer;
}

let cycleBuild: CycleBuildRuntime | null = null;

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- op handlers (exactly the protocol's EngineOps table) -------------------

type Handlers = { [K in Op]: (...args: EngineOps[K]['args']) => Promise<EngineOps[K]['result']> };

const handlers: Handlers = {
  async init(bundles: BundleSpec[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const { mounted } = unwrap<{ mounted: number }>(s.init(JSON.stringify(bundles)));
    for (const b of bundles) mountedLabels.add(b.label);
    const version = JSON.parse(wasmMod!.Session.version());
    return { mounted, version, initMs: performance.now() - t0 };
  },

  /** Incrementally mount additional bundles (lazy per-bundle loading, spec §1).
   *  Idempotent: labels already mounted are skipped both here and in the engine. */
  async mountBundles(bundles: BundleSpec[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const seen = new Set<string>();
    const fresh: BundleSpec[] = [];
    for (const bundle of bundles) {
      if (mountedLabels.has(bundle.label)) continue;
      if (seen.has(bundle.label)) {
        throw new Error(`mountBundles: duplicate new package label in one transaction: ${bundle.label}`);
      }
      seen.add(bundle.label);
      fresh.push(bundle);
    }
    const mounted =
      fresh.length > 0
        ? unwrap<{ mounted: number }>(s.mount(JSON.stringify(fresh))).mounted
        : mountedLabels.size;
    for (const b of fresh) mountedLabels.add(b.label);
    return { mounted, newlyMounted: fresh.map((b) => b.label), mountMs: performance.now() - t0 };
  },

  /** Resolve a project's package sets against the CURRENTLY MOUNTED bundles
   *  (task #32). Resolution logic lives entirely in Rust; this is a thin marshal. */
  async resolveProject(config, versionIndex) {
    const s = await ensureSession();
    return unwrap(s.resolveProject(config, versionIndex ? JSON.stringify(versionIndex) : ''));
  },

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — no tx, no mounted packages needed beyond the resources passed in. */
  async expandValueSet(valueSetJson, resourcesJson) {
    const s = await ensureSession();
    const t0 = performance.now();
    const raw = unwrap<Record<string, unknown>>(s.expandValueSet(valueSetJson, resourcesJson)) as {
      ok: boolean;
      expansion?: { total?: number; contains?: unknown[] };
      usedCodeSystems?: unknown[];
      copyright?: string[];
      notEnumerable?: unknown;
    };
    const expandMs = performance.now() - t0;
    if (raw.ok) {
      return {
        ok: true,
        total: raw.expansion!.total ?? raw.expansion!.contains?.length ?? 0,
        contains: raw.expansion!.contains ?? [],
        usedCodeSystems: raw.usedCodeSystems ?? [],
        copyright: raw.copyright ?? [],
        expandMs,
      } as EngineOps['expandValueSet']['result'];
    }
    return { ok: false, notEnumerable: raw.notEnumerable, expandMs } as EngineOps['expandValueSet']['result'];
  },

  async compile(config, files, predefined, siteFiles) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(
      s.compileProject(
        JSON.stringify(files),
        config,
        JSON.stringify(predefined),
        JSON.stringify(siteFiles),
      ),
    );
    const buildMs = performance.now() - t0;
    return { ...out, buildMs, fileCount: Object.keys(files).length } as EngineOps['compile']['result'];
  },

  async snapshot(url) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(s.snapshot(url));
    return { ...out, snapshotMs: performance.now() - t0 } as EngineOps['snapshot']['result'];
  },

  // ---- closed Cycle external-builder path ----

  async buildSite(config, files, predefined, siteFiles, buildEpochSecs) {
    const s = await ensureSession();
    const t0 = performance.now();
    const input = {
      config,
      fsh: files,
      predefined,
      site_files: siteFiles,
      build_epoch_secs: buildEpochSecs,
    };
    // The matching compileProject call already established the semantic
    // revision. FSH/predefined bodies are equality assertions at the Rust trust
    // boundary, never inputs to a second compile.
    const handoff = unwrap<CycleSiteBuildPayload>(s.buildSiteBuildFromCompile(JSON.stringify(input)));
    const siteDbBytes = new TextEncoder().encode(handoff.siteDbJson);
    const build = await ClosedBuildHandle.open(handoff.siteBuild, {
      // The current WASM transport returns the one CAS object beside its
      // manifest. ClosedBuildHandle still verifies its length and digest before
      // exposing it; a future worker CAS can replace this transport unchanged.
      get: async () => siteDbBytes,
    });
    const view = await JsonSiteBuildView.fromClosedBuild(build);
    // Enumerate pages (needs the render module; imported lazily so the wasm-only
    // paths don't pull React into their critical path).
    const render = await import('../preview/render');
    // One renderer instance owns this immutable row revision and Cycle's shared
    // closed content policy; no active store, Rust ContentApi, or compiler
    // callback participates.
    const renderer = render.createCycleRenderer(view);
    const pages = renderer.listPages();
    // Validate the complete page/auxiliary/row-asset namespace before installing
    // the runtime. A collision is a build failure, never a request-time surprise.
    renderer.listOutputs();
    const assets = view.assets().map((asset) => ({ name: asset.Name, mime: asset.Mime }));
    const runtime: CycleBuildRuntime = { build, view, renderer };
    cycleBuild = runtime;
    return { buildId: runtime.build.manifest.buildId, pages, assets, buildMs: performance.now() - t0 };
  },

  async renderPage(file) {
    if (!cycleBuild) throw new Error('renderPage before buildSite');
    const t0 = performance.now();
    const { html } = cycleBuild.renderer.renderPage(file);
    return { file, html, renderMs: performance.now() - t0 };
  },

  async assetBytes(name) {
    if (!cycleBuild) return null;
    try {
      const output = cycleBuild.renderer.renderOutput(name);
      const bytes = typeof output.content === 'string'
        ? new TextEncoder().encode(output.content)
        : output.content;
      return { name: output.file, mime: output.mime, base64: base64(bytes) };
    } catch {
      return null;
    }
  },

  // ---- F6 stock-template render surface (engine-side pages/fragments) ----

  async mountSite(files: Record<string, SiteTreeFile>, options?: StockSiteOptions) {
    const s = await ensureSession();
    return unwrap(s.mountSite(JSON.stringify(files), options ? JSON.stringify(options) : ''));
  },

  /** Materialize a template `id#ver` chain from the MOUNTED bundle packages and
   *  merge it into the engine site tree (Rust: walk_base_chain + union-copy +
   *  config deep-merge, byte-exact, no ant). The whole base chain must already
   *  be mounted (the host fetched it on the resolve→fetch→mount path). A custom-
   *  ant template surfaces here as `mountTemplate <coord>: … never execute ant`
   *  (unwrap re-throws it as an Error the adapter maps to a friendly message). */
  async mountTemplate(coord: string) {
    const s = await ensureSession();
    return unwrap<{ files: number }>(s.mountTemplate(coord));
  },

  /** Source-driven stock site (task #45): produce the artifact page shells + the
   *  `_data` model from the current compile + mounted template, merging both into
   *  the engine site tree. Replaces the pre-baked `{id}-stock.json` bundle. */
  async produceStockSite() {
    const s = await ensureSession();
    return unwrap<{ pages: number; data: number }>(s.produceStockSite());
  },

  async listSitePages() {
    const s = await ensureSession();
    return unwrap(s.listPages());
  },

  async renderSitePage(name) {
    const s = await ensureSession();
    const t0 = performance.now();
    const { html } = unwrap<{ html: string }>(s.renderPage(name));
    return { html, renderMs: performance.now() - t0 };
  },

  async renderFragment(ref, kind) {
    const s = await ensureSession();
    return unwrap(s.renderFragment(ref, kind));
  },

  // ---- generic native Rust content surface (not Cycle LiquidJS) ----

  async renderLiquid(source, data) {
    const s = await ensureSession();
    return unwrap(s.renderLiquid(source, data ? JSON.stringify(data) : ''));
  },

  async renderMarkdown(md, opts) {
    const s = await ensureSession();
    return unwrap(s.renderMarkdown(md, opts ? JSON.stringify(opts) : ''));
  },
};

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  try {
    const handler = handlers[msg.op] as (...args: unknown[]) => Promise<unknown>;
    if (!handler) throw new Error(`unknown op: ${msg.op}`);
    reply({ id: msg.id, ok: true, result: await handler(...msg.args) });
  } catch (err) {
    const e2 = err as Error;
    reply({ id: msg.id, ok: false, error: String(e2?.stack ?? e2) });
  }
};
