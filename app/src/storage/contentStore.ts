/** Browser implementation of the shared immutable ContentStore contract.
 * Identity is SHA-256 of exact bytes; typed manifests retain meaning, media type,
 * recipes, and dependency graphs. Reads always recheck digest and length. */

import { sha256Hex } from '../worker/bundleIntegrity';

const OPFS_DIR = 'fhir-ig-editor-content-v1';
const SHA256 = /^[0-9a-f]{64}$/;

export interface ContentRef {
  sha256: string;
  byteLength: number;
  mediaType?: string;
}

export interface ContentStore {
  get(ref: ContentRef): Promise<ArrayBuffer | null>;
  put(bytes: BufferSource, mediaType?: string): Promise<ContentRef | null>;
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: true });
  } catch {
    return null;
  }
}

function validateRef(ref: ContentRef): void {
  if (!SHA256.test(ref.sha256)) throw new Error(`invalid content SHA-256 ${ref.sha256}`);
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0) {
    throw new Error(`invalid content byte length ${ref.byteLength}`);
  }
}

function viewBytes(source: BufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
}

export class OpfsContentStore implements ContentStore {
  async get(ref: ContentRef): Promise<ArrayBuffer | null> {
    validateRef(ref);
    const dir = await directory();
    if (!dir) return null;
    try {
      const handle = await dir.getFileHandle(ref.sha256);
      const bytes = await (await handle.getFile()).arrayBuffer();
      if (bytes.byteLength !== ref.byteLength) return null;
      if (await sha256Hex(bytes) !== ref.sha256) return null;
      return bytes;
    } catch {
      return null;
    }
  }

  async put(source: BufferSource, mediaType?: string): Promise<ContentRef | null> {
    const bytes = viewBytes(source);
    const ref: ContentRef = {
      sha256: await sha256Hex(bytes),
      byteLength: bytes.byteLength,
      ...(mediaType ? { mediaType } : {}),
    };
    const dir = await directory();
    if (!dir) return null;
    const handle = await dir.getFileHandle(ref.sha256, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    // Verify publication. If a previous/torn writer produced different bytes,
    // callers see a miss/failure instead of an authorized corrupt object.
    if (!(await this.get(ref))) throw new Error(`ContentStore failed to publish ${ref.sha256}`);
    return ref;
  }
}

export const contentStore: ContentStore = new OpfsContentStore();
