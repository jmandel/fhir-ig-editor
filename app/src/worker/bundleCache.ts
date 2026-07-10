// OPFS-backed cache of INFLATED package bundles (spec §1: warm start).
//
// Every v3 data entry is keyed by label + content identity. For baked bundles
// that identity is the SHA-256 of the compressed `.tgz` declared by the app's
// manifest. A redeploy can therefore never serve an inflated map cached for
// different bytes under the same package coordinate. Registry packages have no
// prior authority, so their deterministic inflated-map digest is recorded in a
// small per-label pointer. Baked reads never consult that unpinned pointer.
//
// v1/v2 label-only files are intentionally ignored rather than migrated: there
// is no safe way to prove which compressed blob produced them. If OPFS is
// unavailable, every method degrades to a miss/no-op.

import type { BundleSpec } from './protocol';
import { isSha256Hex, sha256Hex } from './bundleIntegrity';

const CACHE_DIR = 'fhir-ig-editor-bundles';
const CACHE_VERSION = 'v3';
const CACHE_IDENTITY = /^(?:tgz|content)-[0-9a-f]{64}$/;

interface CachedBundleEnvelope {
  cacheVersion: typeof CACHE_VERSION;
  identity: string;
  spec: BundleSpec;
}

function safeLabel(label: string): string {
  return label.replaceAll('/', '∕').replaceAll('#', '＃');
}

/** Pure key helper exported for the cache migration/integrity gate. */
export function bundleCacheKey(label: string, identity: string): string {
  if (!CACHE_IDENTITY.test(identity)) throw new Error(`invalid bundle cache identity ${identity}`);
  return `${CACHE_VERSION}__${safeLabel(label)}__${identity}.json`;
}

function pointerKey(label: string): string {
  return `${CACHE_VERSION}__${safeLabel(label)}__latest-unpinned.json`;
}

export function pinnedBundleCacheIdentity(sha256: string): string {
  if (!isSha256Hex(sha256)) throw new Error(`invalid baked bundle SHA-256 ${sha256}`);
  return `tgz-${sha256}`;
}

/** Identity for an unpinned registry result. Sorting makes insertion order
 * irrelevant; this digest is cache identity only, not a registry authenticity
 * claim. */
export async function contentBundleCacheIdentity(spec: BundleSpec): Promise<string> {
  const files = Object.keys(spec.files)
    .sort()
    .map((name) => [name, spec.files[name]]);
  const digest = await sha256Hex(new TextEncoder().encode(JSON.stringify(files)));
  return `content-${digest}`;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

function validSpec(value: unknown, label: string): value is BundleSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const spec = value as Partial<BundleSpec>;
  if (spec.label !== label || typeof spec.files !== 'object' || spec.files === null || Array.isArray(spec.files)) {
    return false;
  }
  return Object.values(spec.files).every((body) => typeof body === 'string');
}

async function readPointer(
  directory: FileSystemDirectoryHandle,
  label: string,
): Promise<string | null> {
  try {
    const handle = await directory.getFileHandle(pointerKey(label));
    const value = JSON.parse(await (await handle.getFile()).text()) as { identity?: unknown };
    return typeof value.identity === 'string' && /^content-[0-9a-f]{64}$/.test(value.identity)
      ? value.identity
      : null;
  } catch {
    return null;
  }
}

/** Read an inflated bundle. `compressedSha256` makes this a pinned baked read;
 * omitting it selects only the latest content-addressed unpinned registry entry. */
export async function readCachedBundle(
  label: string,
  compressedSha256?: string,
): Promise<BundleSpec | null> {
  const directory = await dir();
  if (!directory) return null;
  const identity = compressedSha256
    ? pinnedBundleCacheIdentity(compressedSha256)
    : await readPointer(directory, label);
  if (!identity) return null;
  try {
    const handle = await directory.getFileHandle(bundleCacheKey(label, identity));
    const envelope = JSON.parse(await (await handle.getFile()).text()) as Partial<CachedBundleEnvelope>;
    if (
      envelope.cacheVersion !== CACHE_VERSION
      || envelope.identity !== identity
      || !validSpec(envelope.spec, label)
    ) {
      return null;
    }
    return envelope.spec;
  } catch {
    return null;
  }
}

/** Persist an inflated map. A baked digest writes a pinned entry with no
 * unpinned pointer; registry results receive an inflated-content identity. */
export async function writeCachedBundle(spec: BundleSpec, compressedSha256?: string): Promise<void> {
  const directory = await dir();
  if (!directory) return;
  try {
    const identity = compressedSha256
      ? pinnedBundleCacheIdentity(compressedSha256)
      : await contentBundleCacheIdentity(spec);
    const envelope: CachedBundleEnvelope = { cacheVersion: CACHE_VERSION, identity, spec };
    const handle = await directory.getFileHandle(bundleCacheKey(spec.label, identity), { create: true });
    let writable = await handle.createWritable();
    await writable.write(JSON.stringify(envelope));
    await writable.close();

    if (!compressedSha256) {
      const pointer = await directory.getFileHandle(pointerKey(spec.label), { create: true });
      writable = await pointer.createWritable();
      await writable.write(JSON.stringify({ cacheVersion: CACHE_VERSION, identity }));
      await writable.close();
    }
  } catch {
    /* best-effort cache; a write failure just means the next start is cold */
  }
}

/** Cheap existence check used only for warm-start messaging. */
export async function hasCachedBundle(label: string, compressedSha256?: string): Promise<boolean> {
  const directory = await dir();
  if (!directory) return false;
  const identity = compressedSha256
    ? pinnedBundleCacheIdentity(compressedSha256)
    : await readPointer(directory, label);
  if (!identity) return false;
  try {
    await directory.getFileHandle(bundleCacheKey(label, identity));
    return true;
  } catch {
    return false;
  }
}
