// Tier-2 tx `$expand` result cache (spec §6 tier 2 + tier 3 cache discipline).
//
// Keyed by a CONTENT HASH of (the ValueSet + the referenced IG-local resources +
// the server identity) — so an edit to the VS/compose, a change to a referenced
// local CodeSystem, or switching endpoints all invalidate the cache. The cached
// value stores the FULL `$expand` response, INCLUDING `expansion.parameter`
// (the used-codesystem versions the server pinned) — that's the tier-3 discipline
// (cache each $expand WITH the versions it drew from), and the CI consistency
// gate compares `expand_enumerable` against exactly these committed entries.
//
// Same content-hash key shape the committed cache uses, so a maintainer-refreshed
// committed entry and a live-fetched one are interchangeable.

const CACHE_DIR = 'fhir-ig-editor-tx-cache';

export interface TxCacheEntry {
  /** The content-hash key (hex). */
  hash: string;
  /** The canonical URL of the expanded ValueSet. */
  valueSet: string;
  /** The tx server the expansion came from. */
  server: string;
  /** ISO timestamp the result was fetched/stored. */
  fetchedAt: string;
  /** The FHIR `ValueSet.expansion` object (contains[], parameter[], total). */
  expansion: unknown;
  /** Lifted `used-codesystem` pins from expansion.parameter, for display. */
  usedCodeSystems: { system: string; version?: string }[];
}

/** SHA-256 hex of a string (Web Crypto — available in window + worker). */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic JSON stringify (sorted keys) so equal content hashes equal. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The content-hash cache key for (VS + referenced local resources + server). The
 *  `referencedResources` are the IG-local CodeSystems/ValueSets the compose can
 *  reach — passing all conformance resources is safe (extra ones don't change the
 *  hash's meaning, they just widen invalidation), but callers should pass the
 *  compose's referenced set for tight keys. */
export async function cacheKey(
  valueSet: unknown,
  referencedResources: unknown[],
  server: string,
): Promise<string> {
  const payload = canonical({
    vs: valueSet,
    refs: referencedResources.map(canonical).sort(),
    server,
  });
  return sha256Hex(payload);
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

export async function readTxCache(hash: string): Promise<TxCacheEntry | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const fh = await d.getFileHandle(`${hash}.json`);
    return JSON.parse(await (await fh.getFile()).text()) as TxCacheEntry;
  } catch {
    return null;
  }
}

export async function writeTxCache(entry: TxCacheEntry): Promise<void> {
  const d = await dir();
  if (!d) return;
  try {
    const fh = await d.getFileHandle(`${entry.hash}.json`, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(entry, null, 2));
    await w.close();
  } catch {
    /* best-effort */
  }
}

export async function deleteTxCache(hash: string): Promise<void> {
  const d = await dir();
  if (!d) return;
  try {
    await d.removeEntry(`${hash}.json`);
  } catch {
    /* already gone */
  }
}
