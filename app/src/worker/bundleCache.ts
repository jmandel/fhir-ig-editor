// OPFS-backed cache of INFLATED package bundles (spec §1: "OPFS-persist inflated
// bundles → warm start ~instant"). A bundle is a `{ name: base64 }` file map; on
// a cold start we fetch the `.tgz`, inflate it, mount it, AND write the inflated
// map here. On a warm start (reload) we read it straight back — no network, no
// gunzip/untar — which is the bulk of cold-start cost.
//
// One file per package under a dedicated OPFS dir, keyed by a filesystem-safe
// encoding of the label. The stored JSON is `{ label, files }` (a BundleSpec).
// If OPFS is unavailable (Safari private mode, etc.), every method degrades to a
// miss / no-op — the app still works, it's just always a cold start (spec §11).

import type { BundleSpec } from './protocol';

const CACHE_DIR = 'fhir-ig-editor-bundles';
// Bump when the inflated-bundle shape or the pinned engine's bundle format
// changes, so stale entries are ignored rather than mounted.
const CACHE_VERSION = 'v1';

/** '#'/'/' are legal in labels but not in OPFS file names — encode them. */
function keyFor(label: string): string {
  return `${CACHE_VERSION}__${label.replaceAll('/', '∕').replaceAll('#', '＃')}.json`;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

/** Read an inflated bundle for `label` from OPFS, or null on miss/unavailable. */
export async function readCachedBundle(label: string): Promise<BundleSpec | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const fh = await d.getFileHandle(keyFor(label));
    const text = await (await fh.getFile()).text();
    const spec = JSON.parse(text) as BundleSpec;
    if (spec.label !== label || !spec.files) return null;
    return spec;
  } catch {
    return null;
  }
}

/** Persist an inflated bundle so the next load is a warm (network-free) start. */
export async function writeCachedBundle(spec: BundleSpec): Promise<void> {
  const d = await dir();
  if (!d) return;
  try {
    const fh = await d.getFileHandle(keyFor(spec.label), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(spec));
    await w.close();
  } catch {
    /* best-effort cache; a write failure just means the next start is cold */
  }
}

/** Whether an inflated bundle for `label` is already cached (cheap existence
 *  check used to drive the "warm start" progress messaging). */
export async function hasCachedBundle(label: string): Promise<boolean> {
  const d = await dir();
  if (!d) return false;
  try {
    await d.getFileHandle(keyFor(label));
    return true;
  } catch {
    return false;
  }
}
