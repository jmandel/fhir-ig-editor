// OPFS cache of MATERIALIZED template trees (#40 scope 4 — the derived-index
// precedent). A materialized template is the loader's `mountSite`-shaped tree
// (`{ "_includes/…": text|{b64}, "template/…": … }`) for one `id#version` chain.
// We key each entry by (the coord + a content hash of the source template tree +
// the loader/format version), and INVALIDATE on engine-version change so a bumped
// wasm never serves a stale materialization.
//
// Why cache the tree and not just the chain packages: the chain packages are
// already OPFS-cached (bundleCache), but re-materializing (walk + union-copy +
// config deep-merge) still costs a wasm round-trip per template switch. The
// materialized tree is the derived artifact; caching it makes a repeat load of the
// SAME template (any session) a pure OPFS read → mountSite, no re-walk.
//
// Degrades to a no-op miss when OPFS is unavailable (the app still works, just
// re-materializes each time).

import type { SiteTreeFile } from './protocol';

const CACHE_DIR = 'fhir-ig-editor-template-trees';
// Bump when the mapped-tree SHAPE or mapping rule changes (independent of the
// engine commit, which is folded into the key below).
const FORMAT_VERSION = 'v1';

/** SHA-256 hex of a string (Web Crypto — window + worker). */
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Deterministic canonical JSON (sorted keys) so equal trees hash equal. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

/** The cache key for a materialized template: coord + engine commit + format +
 *  a content hash of the mapped tree (so a template content change — same coord,
 *  different bytes — is a distinct key; content-addressed, like the derived-index
 *  ledger). `engineCommit` folds the loader/engine version in, so a wasm bump
 *  invalidates every entry. */
async function keyFor(coord: string, engineCommit: string, treeHash: string): Promise<string> {
  const safe = coord.replaceAll('/', '∕').replaceAll('#', '＃');
  return `${FORMAT_VERSION}__${engineCommit}__${safe}__${treeHash}.json`;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Read a materialized tree for `coord` (any content hash) built by the CURRENT
 *  engine. We can't know the content hash without the source, so we index by a
 *  small manifest file per (coord, engine) that records the newest tree hash. */
async function manifestKey(coord: string, engineCommit: string): Promise<string> {
  const safe = coord.replaceAll('/', '∕').replaceAll('#', '＃');
  return `${FORMAT_VERSION}__${engineCommit}__${safe}__manifest.json`;
}

export async function readCachedTemplateTree(
  coord: string,
  engineCommit: string,
): Promise<Record<string, SiteTreeFile> | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const mf = await d.getFileHandle(await manifestKey(coord, engineCommit));
    const { treeHash } = JSON.parse(await (await mf.getFile()).text()) as { treeHash: string };
    const fh = await d.getFileHandle(await keyFor(coord, engineCommit, treeHash));
    const tree = JSON.parse(await (await fh.getFile()).text()) as Record<string, SiteTreeFile>;
    return tree && typeof tree === 'object' ? tree : null;
  } catch {
    return null;
  }
}

/** Persist a materialized tree (write-through). Content-hashes the tree, writes
 *  the entry, and points the (coord, engine) manifest at it. Best-effort. */
export async function writeCachedTemplateTree(
  coord: string,
  engineCommit: string,
  tree: Record<string, SiteTreeFile>,
): Promise<void> {
  const d = await dir();
  if (!d) return;
  try {
    const treeHash = (await sha256Hex(canonical(tree))).slice(0, 32);
    const fh = await d.getFileHandle(await keyFor(coord, engineCommit, treeHash), { create: true });
    let w = await fh.createWritable();
    await w.write(JSON.stringify(tree));
    await w.close();
    const mf = await d.getFileHandle(await manifestKey(coord, engineCommit), { create: true });
    w = await mf.createWritable();
    await w.write(JSON.stringify({ treeHash, coord, engineCommit }));
    await w.close();
  } catch {
    /* best-effort; a miss just re-materializes next time */
  }
}
