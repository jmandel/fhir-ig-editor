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
import type { SiteDbRows } from '../preview/rowStore';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** The wasm-bindgen `Session` class surface (string-envelope methods). */
interface WasmSession {
  init(bundlesJson: string): string;
  mount(bundlesJson: string): string;
  resolveProject(config: string, versionIndexJson: string): string;
  compile(filesJson: string, config: string, predefinedJson: string): string;
  setLocalResources(json: string): string;
  snapshot(input: string): string;
  buildSiteDb(inputJson: string): string;
  expandValueSet(valueSetJson: string, resourcesJson: string): string;
  mountSite(filesJson: string, optionsJson: string): string;
  mountTemplate(coord: string): string;
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

// The last-built site.db rows, so renderPage/assetBytes render on demand without
// rebuilding (render-on-demand per visible page — M2 scope, honest per spec §7).
let lastRows: SiteDbRows | null = null;

// ---- gzip + tar inflation (mirrors package_acquisition::read_bundle) --------

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Response(buf).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function untar(tar: Uint8Array): Record<string, string> {
  const files: Record<string, string> = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    let name = '';
    for (let i = 0; i < 100 && header[i] !== 0; i++) name += String.fromCharCode(header[i]);
    if (name === '') break;
    let sizeStr = '';
    for (let i = 124; i < 136 && header[i] !== 0 && header[i] !== 0x20; i++)
      sizeStr += String.fromCharCode(header[i]);
    const size = parseInt(sizeStr.trim(), 8) || 0;
    const typeflag = header[156];
    off += 512;
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (typeflag === 0x30 || typeflag === 0) {
      const b = name.replace(/^package\//, '').replace(/^\.\//, '');
      files[b] = base64(data);
    }
  }
  return files;
}

/** Inflate a `.tgz` bundle fetched as an ArrayBuffer into `{name: base64}`. */
export async function inflateBundle(tgz: ArrayBuffer): Promise<Record<string, string>> {
  return untar(await gunzip(tgz));
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
    const fresh = bundles.filter((b) => !mountedLabels.has(b.label));
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

  async compile(config, files, predefined) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(
      s.compile(JSON.stringify(files), config, JSON.stringify(predefined)),
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

  // ---- M2 cycle-generator preview path ----

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
    lastRows = unwrap<SiteDbRows>(s.buildSiteDb(JSON.stringify(input)));
    // Enumerate pages (needs the render module; imported lazily so the wasm-only
    // paths don't pull React into their critical path).
    const render = await import('../preview/render');
    // Engine ContentApi hook (TS-liquid sunset): narrative Liquid runs in the
    // wasm session; the render module supplies cycle's include tree + data.
    render.setEngineContent({
      renderLiquid: (source, dataJson) => unwrap<{ html: string }>(s.renderLiquid(source, dataJson)).html,
      mountSite: (filesJson, optionsJson) => {
        unwrap(s.mountSite(filesJson, optionsJson));
      },
    });
    render.mountEngineSite(lastRows);
    const pages = render.listPages(lastRows);
    const assets = lastRows.assets.map((a) => ({ name: a.Name, mime: a.Mime }));
    return { pages, assets, buildMs: performance.now() - t0 };
  },

  async renderPage(file) {
    if (!lastRows) throw new Error('renderPage before buildSite');
    const { renderPage } = await import('../preview/render');
    const t0 = performance.now();
    const { html } = renderPage(lastRows, file);
    return { file, html, renderMs: performance.now() - t0 };
  },

  async assetBytes(name) {
    if (!lastRows) return null;
    const a = lastRows.assets.find((x) => x.Name === name);
    return a ? { name: a.Name, mime: a.Mime, base64: a.Content } : null;
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

  // ---- ContentApi (TS-liquid sunset): engine renders all content ----

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
