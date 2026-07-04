// Template catalog (#40 UX): the selector's DEFAULT experience is a curated set
// of key templates, each with its version list fetched LIVE from the FHIR package
// registry (newest first, default = latest published) — the user never has to
// type. The free-text `id#version` input is demoted to an "advanced / custom
// template…" affordance (still present — driven means driven, any resolvable
// template loads).
//
// Resilience ladder for the version catalog (so offline / registry-down never
// wedges the selector):
//   1. OPFS cache with a short TTL (fresh within 1 day → use as-is).
//   2. Live registry fetch (npm-style `<registry>/<id>` — the SAME CORS-open
//      endpoint #32's arbitrary-IG loader uses for `latest`/`x` resolution;
//      verified `Access-Control-Allow-Origin: *`). On success → refresh OPFS.
//   3. Stale OPFS cache (last-known-good) if the live fetch fails.
//   4. Pinned ORACLE-TESTED versions (the byte-gated 1.0.0 chains) as the
//      ultimate fallback — the selector ALWAYS has something real to offer.

import { getRegistries, metadataUrl, viaProxy } from '../vfs/packageSettings';

/** The curated template families the selector offers by default. Kept SMALL and
 *  explicit: this is the "known, no-ant-surprise" stock family (their config.json
 *  declares no active ant hooks, so the loader materializes them byte-exact — see
 *  AntHookError). Other templates still load via the advanced input; they run
 *  through the SAME loader honestly, protected by AntHookError. */
export interface CuratedTemplate {
  id: string;
  label: string;
  /** Oracle-tested (byte-gated vs the Java publisher) versions — get the
   *  'verified' badge AND serve as the offline fallback version list. */
  verified: string[];
}

export const CURATED_TEMPLATES: CuratedTemplate[] = [
  { id: 'hl7.fhir.template', label: 'HL7 FHIR IG template', verified: ['1.0.0'] },
  { id: 'hl7.base.template', label: 'HL7 base template', verified: ['1.0.0'] },
  { id: 'hl7.davinci.template', label: 'HL7 Da Vinci template', verified: ['1.0.0'] },
];

/** Whether a coord (`id#version`) is oracle-verified (byte-gated). */
export function isVerified(id: string, version: string): boolean {
  return CURATED_TEMPLATES.find((t) => t.id === id)?.verified.includes(version) ?? false;
}

export interface TemplateCatalog {
  id: string;
  /** Available versions, NEWEST FIRST. */
  versions: string[];
  /** The registry's `dist-tags.latest`, if any (the default selection). */
  latest: string | null;
  /** ISO time this catalog was fetched. */
  fetchedAt: string;
  /** True when this came from the pinned fallback (registry unreachable). */
  fromFallback?: boolean;
}

const CACHE_DIR = 'fhir-ig-editor-template-catalog';
// Bump when the catalog shape changes so stale entries are ignored.
const CACHE_VERSION = 'v1';
const TTL_MS = 24 * 60 * 60 * 1000; // 1 day — templates publish rarely.

function keyFor(id: string): string {
  return `${CACHE_VERSION}__${id.replaceAll('/', '∕')}.json`;
}

async function dir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

async function readCache(id: string): Promise<TemplateCatalog | null> {
  const d = await dir();
  if (!d) return null;
  try {
    const fh = await d.getFileHandle(keyFor(id));
    const cat = JSON.parse(await (await fh.getFile()).text()) as TemplateCatalog;
    return cat.id === id && Array.isArray(cat.versions) ? cat : null;
  } catch {
    return null;
  }
}

async function writeCache(cat: TemplateCatalog): Promise<void> {
  const d = await dir();
  if (!d) return;
  try {
    const fh = await d.getFileHandle(keyFor(cat.id), { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(cat));
    await w.close();
  } catch {
    /* best-effort; a miss just means a live fetch next time */
  }
}

/** Semver-ish descending sort: numeric field compare, longer wins ties. Good
 *  enough for FHIR template versions (plain `M.N.P`, no pre-release soup). */
function sortNewestFirst(versions: string[]): string[] {
  const cmp = (a: string, b: string) => {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0);
      if (d) return d;
    }
    return 0;
  };
  return [...new Set(versions)].sort(cmp);
}

/** Fetch the npm-style version catalog for a template id from the configured
 *  registries (the CORS-open `<registry>/<id>` endpoint, via the proxy if set).
 *  Returns null if no registry answers. */
async function fetchCatalog(id: string): Promise<TemplateCatalog | null> {
  for (const registry of getRegistries()) {
    const url = viaProxy(metadataUrl(registry, id));
    try {
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) continue;
      const meta = await resp.json();
      const versions = meta?.versions ? Object.keys(meta.versions) : [];
      if (!versions.length) continue;
      const sorted = sortNewestFirst(versions);
      const latest =
        (typeof meta?.['dist-tags']?.latest === 'string' && meta['dist-tags'].latest) ||
        sorted[0] ||
        null;
      return { id, versions: sorted, latest, fetchedAt: new Date().toISOString() };
    } catch {
      /* try the next registry */
    }
  }
  return null;
}

/** The pinned fallback catalog for a curated template (oracle-tested versions),
 *  used when the registry is unreachable AND nothing is cached. */
function fallbackCatalog(id: string): TemplateCatalog {
  const verified = CURATED_TEMPLATES.find((t) => t.id === id)?.verified ?? [];
  const versions = sortNewestFirst(verified);
  return {
    id,
    versions,
    latest: versions[0] ?? null,
    fetchedAt: new Date(0).toISOString(),
    fromFallback: true,
  };
}

/** Resolve a template's version catalog through the resilience ladder:
 *  fresh-OPFS → live-fetch → stale-OPFS → pinned-fallback. NEVER throws — the
 *  selector always gets a usable (non-empty for curated ids) catalog. */
export async function getTemplateCatalog(id: string): Promise<TemplateCatalog> {
  const cached = await readCache(id);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) return cached;

  const live = await fetchCatalog(id);
  if (live) {
    void writeCache(live);
    return live;
  }
  // Registry down: last-known-good, else the pinned oracle versions.
  if (cached) return cached;
  const fb = fallbackCatalog(id);
  // Don't persist the fallback (it's not a real fetch) — leave the cache empty so
  // the next attempt tries the registry again.
  return fb;
}

/** Load every curated template's catalog concurrently (the selector's default
 *  data). Each resolves independently through the ladder, so one slow/broken
 *  registry entry never blocks the others. */
export async function getCuratedCatalogs(): Promise<Record<string, TemplateCatalog>> {
  const entries = await Promise.all(
    CURATED_TEMPLATES.map(async (t) => [t.id, await getTemplateCatalog(t.id)] as const),
  );
  return Object.fromEntries(entries);
}
