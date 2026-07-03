// Engine Web Worker (spec §4). Owns the wasm-bindgen module (rust_sushi compiler
// + snapshot walk engine, wasm32-unknown-unknown / web target). The UI thread
// never blocks: all engine work happens here.
//
// The wasm module is emitted by scripts/build-wasm.sh into app/public/pkg/ and
// served as a static asset; we import it at runtime via the app base URL. This
// mirrors demo/wasm-p2/worker.js in the sushi-rs repo (the reference), adapted to
// the typed protocol + TS.

import type { WorkerRequest, WorkerReply, BundleSpec } from './protocol';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  init: (bundlesJson: string) => number;
  compile: (filesJson: string, config: string, predefinedJson: string) => string;
  generate_snapshot: (input: string) => string;
  version: () => string;
};

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
  const version = JSON.parse(w.version());
  return { mounted, version, initMs: performance.now() - t0 };
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

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  try {
    let result: unknown;
    switch (msg.type) {
      case 'init':
        result = await doInit(msg.bundles);
        break;
      case 'compile':
        result = await doCompile(msg.config, msg.files, msg.predefined);
        break;
      case 'snapshot':
        result = await doSnapshot(msg.url);
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
