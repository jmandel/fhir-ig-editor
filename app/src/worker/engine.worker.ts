// Engine Web Worker (spec §4). Owns the wasm-bindgen module (rust_sushi compiler
// + snapshot walk engine, wasm32-unknown-unknown / web target). The UI thread
// never blocks: all engine work happens here.
//
// The wasm module is emitted by scripts/build-wasm.sh into app/public/pkg/ and
// served as a static asset; we import it at runtime via the app base URL. This
// mirrors demo/wasm-p2/worker.js in the sushi-rs repo (the reference), adapted to
// the typed protocol + TS.

import type { WorkerRequest, WorkerReply, BundleSpec } from './protocol';
import type { SiteDbRows } from '../preview/rowStore';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init: (bundlesJson: string) => number;
  mount_bundles?: (bundlesJson: string) => number;
  resolve_project?: (config: string, versionIndexJson: string) => string;
  compile: (filesJson: string, config: string, predefinedJson: string) => string;
  generate_snapshot: (input: string) => string;
  build_site_db: (inputJson: string) => string;
  expand_enumerable: (valueSetJson: string, resourcesJson: string) => string;
  version: () => string;
};

/** Labels currently mounted in the engine — so `mountBundles` is idempotent and
 *  the UI's lazy loader never re-fetches an already-mounted package. */
const mountedLabels = new Set<string>();

// The last-built site.db rows, so renderPage/assetBytes render on demand without
// rebuilding (render-on-demand per visible page — M2 scope, honest per spec §7).
let lastRows: SiteDbRows | null = null;

let wasm: WasmModule | null = null;

async function ensureWasm(): Promise<WasmModule> {
  if (wasm) return wasm;
  // Dynamic import of the emitted ES module + its .wasm sibling.
  const mod = (await import(/* @vite-ignore */ `${BASE}pkg/wasm_api.js`)) as WasmModule;
  await mod.default(`${BASE}pkg/wasm_api_bg.wasm`);
  wasm = mod;
  return wasm;
}

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

// ---- protocol handlers ------------------------------------------------------

async function doInit(bundles: BundleSpec[]) {
  const w = await ensureWasm();
  const t0 = performance.now();
  const mounted = w.init(JSON.stringify(bundles));
  for (const b of bundles) mountedLabels.add(b.label);
  const version = JSON.parse(w.version());
  return { mounted, version, initMs: performance.now() - t0 };
}

/** Incrementally mount additional bundles (lazy per-bundle loading, spec §1).
 *  Idempotent: labels already mounted are skipped both here and in the engine. */
async function doMountBundles(bundles: BundleSpec[]) {
  const w = await ensureWasm();
  if (!w.mount_bundles) throw new Error('engine lacks mount_bundles (rebuild wasm)');
  const t0 = performance.now();
  const fresh = bundles.filter((b) => !mountedLabels.has(b.label));
  const mounted = fresh.length > 0 ? w.mount_bundles(JSON.stringify(fresh)) : mountedLabels.size;
  for (const b of fresh) mountedLabels.add(b.label);
  return {
    mounted,
    newlyMounted: fresh.map((b) => b.label),
    mountMs: performance.now() - t0,
  };
}

/** Resolve a project's package sets against the CURRENTLY MOUNTED bundles
 *  (task #32). Returns the engine's ResolutionStep JSON — the host loop reads
 *  `missing` to know what to fetch next and `satisfied` to know when to stop. The
 *  resolution logic lives entirely in Rust (`package_store::resolve_project`); this
 *  is a thin marshal. */
async function doResolveProject(config: string, versionIndex?: unknown) {
  const w = await ensureWasm();
  if (!w.resolve_project) throw new Error('engine lacks resolve_project (rebuild wasm)');
  const idxJson = versionIndex ? JSON.stringify(versionIndex) : '';
  return JSON.parse(w.resolve_project(config, idxJson));
}

/** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
 *  content — no tx, no mounted packages needed beyond the resources passed in. */
async function doExpandValueSet(valueSetJson: string, resourcesJson: string) {
  const w = await ensureWasm();
  const t0 = performance.now();
  const raw = JSON.parse(w.expand_enumerable(valueSetJson, resourcesJson));
  const expandMs = performance.now() - t0;
  if (raw.ok) {
    return {
      ok: true,
      total: raw.expansion.total ?? (raw.expansion.contains?.length ?? 0),
      contains: raw.expansion.contains ?? [],
      usedCodeSystems: raw.usedCodeSystems ?? [],
      copyright: raw.copyright ?? [],
      expandMs,
    };
  }
  return { ok: false, notEnumerable: raw.notEnumerable, expandMs };
}

async function doCompile(
  config: string,
  files: Record<string, string>,
  predefined: Record<string, unknown>,
) {
  const w = await ensureWasm();
  const t0 = performance.now();
  const out = JSON.parse(w.compile(JSON.stringify(files), config, JSON.stringify(predefined)));
  const buildMs = performance.now() - t0;
  return { ...out, buildMs, fileCount: Object.keys(files).length };
}

async function doSnapshot(url: string) {
  const w = await ensureWasm();
  const t0 = performance.now();
  const out = JSON.parse(w.generate_snapshot(url));
  return { ...out, snapshotMs: performance.now() - t0 };
}

// ---- M2 site preview --------------------------------------------------------

async function doBuildSite(
  config: string,
  files: Record<string, string>,
  predefined: Record<string, unknown>,
  siteFiles: Record<string, string>,
  buildEpochSecs: number,
) {
  const w = await ensureWasm();
  const t0 = performance.now();
  const input = {
    config,
    fsh: files,
    predefined,
    site_files: siteFiles,
    build_epoch_secs: buildEpochSecs,
  };
  const rowsJson = w.build_site_db(JSON.stringify(input));
  lastRows = JSON.parse(rowsJson) as SiteDbRows;
  // Enumerate pages (needs the render module; imported lazily so the wasm-only
  // paths don't pull React/liquid into their critical path).
  const { listPages } = await import('../preview/render');
  const pages = listPages(lastRows);
  const assets = lastRows.assets.map((a) => ({ name: a.Name, mime: a.Mime }));
  return { pages, assets, buildMs: performance.now() - t0 };
}

async function doRenderPage(file: string) {
  if (!lastRows) throw new Error('renderPage before buildSite');
  const { renderPage } = await import('../preview/render');
  const t0 = performance.now();
  const { html } = renderPage(lastRows, file);
  return { file, html, renderMs: performance.now() - t0 };
}

function doAssetBytes(name: string): { name: string; mime: string; base64: string } | null {
  if (!lastRows) return null;
  const a = lastRows.assets.find((x) => x.Name === name);
  if (!a) return null;
  return { name: a.Name, mime: a.Mime, base64: a.Content };
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  try {
    let result: unknown;
    switch (msg.type) {
      case 'init':
        result = await doInit(msg.bundles);
        break;
      case 'mountBundles':
        result = await doMountBundles(msg.bundles);
        break;
      case 'resolveProject':
        result = await doResolveProject(msg.config, msg.versionIndex);
        break;
      case 'expandValueSet':
        result = await doExpandValueSet(msg.valueSetJson, msg.resourcesJson);
        break;
      case 'compile':
        result = await doCompile(msg.config, msg.files, msg.predefined);
        break;
      case 'snapshot':
        result = await doSnapshot(msg.url);
        break;
      case 'buildSite':
        result = await doBuildSite(msg.config, msg.files, msg.predefined, msg.siteFiles, msg.buildEpochSecs);
        break;
      case 'renderPage':
        result = await doRenderPage(msg.file);
        break;
      case 'assetBytes':
        result = doAssetBytes(msg.name);
        break;
      default:
        throw new Error(`unknown message type: ${(msg as { type: string }).type}`);
    }
    reply({ id: msg.id, ok: true, result });
  } catch (err) {
    const e2 = err as Error;
    reply({ id: msg.id, ok: false, error: String(e2?.stack ?? e2) });
  }
};
