// gzip + tar inflation for FHIR package `.tgz` bundles, mirroring
// package_acquisition::read_bundle. Used UI-side by EngineClient.init so bundle
// prep can show progress; the engine worker only ever sees the resulting
// `{name: base64}` map. Pure Web APIs (DecompressionStream + TextDecoder), no
// wasm — safe to load in the window without pulling the engine module.

async function gunzip(buf: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Response(buf).body!.pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate a gzip stream directly, avoiding a full ArrayBuffer round-trip. Piping
 *  `resp.body` straight through DecompressionStream is far kinder on memory for
 *  large package tarballs (r5.core is ~65 MB) than buffering then re-streaming —
 *  the round-trip form intermittently fails ("Failed to fetch") on big blobs in
 *  headless Chromium. */
async function gunzipStream(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const out = body.pipeThrough(ds);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Inflate a `.tgz` straight from a fetch Response (streaming). */
export async function inflateBundleResponse(resp: Response): Promise<Record<string, string>> {
  if (!resp.body) return untar(await gunzip(await resp.arrayBuffer()));
  return untar(await gunzipStream(resp.body));
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

export async function inflateBundle(tgz: ArrayBuffer): Promise<Record<string, string>> {
  return untar(await gunzip(tgz));
}
