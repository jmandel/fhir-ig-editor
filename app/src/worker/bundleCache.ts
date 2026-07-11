// Legacy OPFS cache of INFLATED package bundles. New writes use the binary
// PreparedPackage ContentStore; this reader exists only to migrate existing v3
// profiles once, after which `deleteCachedBundle` removes the base64 envelope.
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

export interface BundleCacheReadMetrics {
  storedBytes: number;
  opfsReadMs: number;
  jsonParseMs: number;
  validationMs: number;
  totalMs: number;
}

export interface MeasuredBundleCacheRead {
  spec: BundleSpec;
  metrics: BundleCacheReadMetrics;
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
  return (await readCachedBundleMeasured(label, compressedSha256))?.spec ?? null;
}

/** Warm-cache read with timings kept separate so benchmarks can distinguish
 * OPFS I/O from UTF-16 JSON materialization and full-map validation. */
export async function readCachedBundleMeasured(
  label: string,
  compressedSha256?: string,
): Promise<MeasuredBundleCacheRead | null> {
  const started = performance.now();
  const directory = await dir();
  if (!directory) return null;
  const identity = compressedSha256
    ? pinnedBundleCacheIdentity(compressedSha256)
    : await readPointer(directory, label);
  if (!identity) return null;
  try {
    const handle = await directory.getFileHandle(bundleCacheKey(label, identity));
    const readStarted = performance.now();
    const text = await (await handle.getFile()).text();
    const opfsReadMs = performance.now() - readStarted;
    const parseStarted = performance.now();
    const envelope = JSON.parse(text) as Partial<CachedBundleEnvelope>;
    const jsonParseMs = performance.now() - parseStarted;
    const validationStarted = performance.now();
    if (
      envelope.cacheVersion !== CACHE_VERSION
      || envelope.identity !== identity
      || !validSpec(envelope.spec, label)
    ) {
      return null;
    }
    const validationMs = performance.now() - validationStarted;
    return {
      spec: envelope.spec,
      metrics: {
        storedBytes: text.length,
        opfsReadMs,
        jsonParseMs,
        validationMs,
        totalMs: performance.now() - started,
      },
    };
  } catch {
    return null;
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

/** Remove a legacy inflated/base64 entry after the Worker has durably published
 * the equivalent PreparedPackage. PreparedPackage becomes the sole warm form. */
export async function deleteCachedBundle(label: string, compressedSha256?: string): Promise<void> {
  const directory = await dir();
  if (!directory) return;
  const identity = compressedSha256
    ? pinnedBundleCacheIdentity(compressedSha256)
    : await readPointer(directory, label);
  if (!identity) return;
  await directory.removeEntry(bundleCacheKey(label, identity)).catch(() => {});
  if (!compressedSha256) await directory.removeEntry(pointerKey(label)).catch(() => {});
}
