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
async function gunzipStream(
  body: ReadableStream<Uint8Array>,
  onCompressedBytes?: (bytes: number) => void,
  onCompressedComplete?: () => void,
): Promise<Uint8Array> {
  let compressedBytes = 0;
  let reportedBytes = 0;
  let reportedAt = performance.now();
  const counted = onCompressedBytes || onCompressedComplete
    ? body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        compressedBytes += chunk.byteLength;
        const now = performance.now();
        if (now - reportedAt >= 100) {
          onCompressedBytes?.(compressedBytes);
          reportedBytes = compressedBytes;
          reportedAt = now;
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (reportedBytes !== compressedBytes) onCompressedBytes?.(compressedBytes);
        onCompressedComplete?.();
      },
    }))
    : body;
  const ds = new DecompressionStream('gzip');
  const out = counted.pipeThrough(ds);
  const result = new Uint8Array(await new Response(out).arrayBuffer());
  return result;
}

/** Inflate a `.tgz` straight from a fetch Response (streaming). */
export async function inflateBundleResponse(
  resp: Response,
  onCompressedBytes?: (bytes: number) => void,
  onCompressedComplete?: () => void,
): Promise<Record<string, string>> {
  if (!resp.body) {
    const compressed = await resp.arrayBuffer();
    onCompressedBytes?.(compressed.byteLength);
    onCompressedComplete?.();
    return untarPackage(await gunzip(compressed));
  }
  return untarPackage(await gunzipStream(resp.body, onCompressedBytes, onCompressedComplete));
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

function tarString(bytes: Uint8Array, label: string): string {
  const nul = bytes.indexOf(0);
  const body = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  try {
    return utf8.decode(body);
  } catch {
    throw new Error(`tar ${label} is not UTF-8`);
  }
}

function tarOctal(bytes: Uint8Array, label: string): number {
  // Base-256 numeric fields are legal in some GNU archives but are not emitted
  // by the FHIR/npm package transport. Failing closed is safer than reading a
  // different member boundary than Rust's tar implementation.
  if ((bytes[0] & 0x80) !== 0) throw new Error(`unsupported base-256 tar ${label}`);
  const value = tarString(bytes, label).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error(`invalid tar ${label}`);
  const parsed = parseInt(value, 8) || 0;
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`unsafe tar ${label}`);
  return parsed;
}

function verifyTarChecksum(header: Uint8Array, member: string): void {
  const expected = tarOctal(header.subarray(148, 156), `checksum for ${member}`);
  let actual = 0;
  for (let i = 0; i < header.length; i++) {
    actual += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  if (actual !== expected) throw new Error(`invalid tar checksum for ${member}`);
}

function paxPath(data: Uint8Array): string | null {
  let cursor = 0;
  let path: string | null = null;
  while (cursor < data.length) {
    let space = cursor;
    while (space < data.length && data[space] !== 0x20) space++;
    if (space === data.length) throw new Error('malformed PAX record length');
    const lengthText = new TextDecoder().decode(data.subarray(cursor, space));
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('malformed PAX record length');
    const length = Number(lengthText);
    const end = cursor + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error('truncated PAX record');
    }
    const record = data.subarray(space + 1, end - 1);
    const equals = record.indexOf(0x3d);
    if (equals <= 0) throw new Error('malformed PAX record');
    const key = new TextDecoder().decode(record.subarray(0, equals));
    if (key === 'path') path = tarString(record.subarray(equals + 1), 'PAX path');
    cursor = end;
  }
  return path;
}

/** Parse the package tar transport into the same package-relative member map consumed
 * by Rust package normalization. Exported for byte-level parity/security tests. */
export function untarPackage(tar: Uint8Array): Record<string, string> {
  // A null-prototype object keeps archive names such as `__proto__` as plain
  // data. Rust performs the authoritative package identity/material check when
  // this map is mounted; this parser preserves safe nested template content but
  // prevents a transport path from escaping the synthetic package root.
  const files: Record<string, string> = Object.create(null) as Record<string, string>;
  let off = 0;
  let extendedPath: string | null = null;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const headerName = tarString(header.subarray(0, 100), 'member name');
    if (headerName === '') break;
    verifyTarChecksum(header, headerName);
    const magic = tarString(header.subarray(257, 263), 'magic');
    const prefix = tarString(header.subarray(345, 500), 'member prefix');
    if (prefix && !magic.startsWith('ustar')) {
      throw new Error(`tar member uses a prefix without a USTAR header: ${headerName}`);
    }
    const ustarName = prefix ? `${prefix}/${headerName}` : headerName;
    const name = extendedPath || ustarName;
    const size = tarOctal(header.subarray(124, 136), `member size for ${name}`);
    const typeflag = header[156];
    off += 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (off + size > tar.length || off + paddedSize > tar.length) {
      throw new Error(`truncated tar member ${name}`);
    }
    const data = tar.subarray(off, off + size);
    off += paddedSize;

    // POSIX PAX and GNU long-name headers replace the path of the next real
    // member. Applying them before top-level classification prevents a long or
    // prefixed nested path from being mistaken for a short top-level filename.
    if (typeflag === 0x78) { // x: per-file PAX header
      extendedPath = paxPath(data);
      continue;
    }
    if (typeflag === 0x4c) { // L: GNU long name
      extendedPath = tarString(data, 'GNU long member name').replace(/\n$/, '');
      continue;
    }
    if (typeflag === 0x67 || typeflag === 0x4b) { // g: global PAX, K: GNU long link
      throw new Error(`unsupported stateful tar header type ${String.fromCharCode(typeflag)}`);
    }
    extendedPath = null;
    if (typeflag === 0x30 || typeflag === 0) {
      let relative = name;
      while (relative.startsWith('./')) relative = relative.slice(2);
      if (relative.startsWith('package/')) relative = relative.slice('package/'.length);
      const parts = relative.split('/');
      if (
        !relative ||
        relative.startsWith('/') ||
        relative.includes('\\') ||
        relative.includes('\0') ||
        parts.some((part) => !part || part === '.' || part === '..')
      ) {
        throw new Error(`unsafe tar member name ${JSON.stringify(name)}`);
      }
      if (Object.hasOwn(files, relative)) {
        throw new Error(`duplicate tar member ${JSON.stringify(relative)}`);
      }
      files[relative] = base64(data);
    }
  }
  return files;
}

export async function inflateBundle(tgz: ArrayBuffer): Promise<Record<string, string>> {
  return untarPackage(await gunzip(tgz));
}
