/** OPFS ContentStore specialization for versioned Rust PreparedPackage bytes.
 *
 * The main thread reads only tiny transport-identity pointers. The Worker reads
 * and authenticates compact binary artifacts. The Worker stages one artifact at
 * a time in WASM, so bytes never become base64, a filename->body object, or a
 * closure-sized concatenated JavaScript buffer on the warm path.
 */

import { sha256Hex } from './bundleIntegrity';
import type { PreparedPackagePointer } from './protocol';
export type { PreparedPackagePointer } from './protocol';
import { contentStore } from '../storage/contentStore';
import {
  PREPARED_PACKAGE_FORMAT_VERSION,
  PREPARED_PACKAGE_MEDIA_TYPE,
} from '../site/contract.generated';
export { PREPARED_PACKAGE_MEDIA_TYPE } from '../site/contract.generated';

const CACHE_DIR = 'fhir-ig-editor-prepared-packages';
const SHA256 = /^[0-9a-f]{64}$/;
const CACHE_KEY = /^pp3-sha256-[0-9a-f]{64}-n1-d1-a1$/;

function safe(value: string): string {
  return encodeURIComponent(value).replaceAll('%', '_');
}

function pointerName(label: string, transportIdentity: string): string {
  return `pointer__${safe(label)}__${safe(transportIdentity)}.json`;
}

export function validPreparedPackagePointer(
  value: unknown,
  label?: string,
  transportIdentity?: string,
): value is PreparedPackagePointer {
  const pointer = value as Partial<PreparedPackagePointer> | null;
  const cacheKey = typeof pointer?.cacheKey === 'string'
    ? CACHE_KEY.exec(pointer.cacheKey)
    : null;
  return !!pointer
    && pointer.schema === PREPARED_PACKAGE_FORMAT_VERSION
    && typeof pointer.label === 'string'
    && (label === undefined || pointer.label === label)
    && typeof pointer.transportIdentity === 'string'
    && (transportIdentity === undefined || pointer.transportIdentity === transportIdentity)
    && !!cacheKey
    && typeof pointer.artifactSha256 === 'string'
    && SHA256.test(pointer.artifactSha256)
    && Number.isSafeInteger(pointer.bytes)
    && (pointer.bytes ?? -1) >= 0;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Tiny main-thread lookup. No artifact bytes are read here. */
export async function findPreparedPackage(
  label: string,
  transportIdentity: string,
): Promise<PreparedPackagePointer | null> {
  const directory = await dir();
  if (!directory) return null;
  try {
    const handle = await directory.getFileHandle(pointerName(label, transportIdentity));
    const pointer = JSON.parse(await (await handle.getFile()).text()) as unknown;
    return validPreparedPackagePointer(pointer, label, transportIdentity) ? pointer : null;
  } catch {
    return null;
  }
}

/** Worker-side authenticated binary read. ContentStore verifies the exact
 * carrier SHA-256; Rust checks the selected key and canonical
 * label/dependency/member/chunk metadata;
 * member bodies are digest-checked when lazily materialized. Package identity
 * and the derived index were established by the shared preparation boundary. */
export async function readPreparedPackage(
  pointer: PreparedPackagePointer,
): Promise<ArrayBuffer | null> {
  if (!validPreparedPackagePointer(pointer)) return null;
  return contentStore.get({
    sha256: pointer.artifactSha256,
    byteLength: pointer.bytes,
    mediaType: PREPARED_PACKAGE_MEDIA_TYPE,
  });
}

/** Worker-side publication: content first, pointer last. A torn write can only
 * cause a miss; it can never authorize partial bytes. */
export async function writePreparedPackage(
  pointer: PreparedPackagePointer,
  bytes: Uint8Array,
): Promise<boolean> {
  const label = pointer.label;
  if (!validPreparedPackagePointer(pointer as unknown)) throw new Error(`invalid prepared-package pointer for ${label}`);
  if (bytes.byteLength !== pointer.bytes) throw new Error(`prepared-package byte length mismatch for ${pointer.label}`);
  const digest = await sha256Hex(bytes);
  if (digest !== pointer.artifactSha256) throw new Error(`prepared-package SHA-256 mismatch for ${pointer.label}`);
  const stored = await contentStore.put(bytes, PREPARED_PACKAGE_MEDIA_TYPE);
  if (!stored) return false;
  if (stored.sha256 !== pointer.artifactSha256 || stored.byteLength !== pointer.bytes) {
    throw new Error(`prepared-package ContentStore identity mismatch for ${pointer.label}`);
  }
  const directory = await dir();
  if (!directory) return false;
  const pointerHandle = await directory.getFileHandle(
    pointerName(pointer.label, pointer.transportIdentity),
    { create: true },
  );
  const writable = await pointerHandle.createWritable();
  await writable.write(JSON.stringify(pointer));
  await writable.close();
  return true;
}

export const UNPINNED_TRANSPORT_IDENTITY = 'unpinned';
