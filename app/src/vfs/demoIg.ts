// "Open demo IG" (spec §5, mode 1): hydrate the project store from the baked
// cycle IG manifest. scripts/export-ig-manifest.ts exports the cycle submodule's
// sushi-config.yaml + input/fsh/** + input/resources/** into
// public/data/cycle/manifest.json (a single JSON with inlined file text), so one
// fetch + one loadAll gives an offline-capable working project.

import type { ProjectStore, ProjectFile, BinaryProjectFile } from './store';
import type { ProgressEvent } from '../worker/protocol';
import { loadGithubIg, type GithubIgSpec } from './githubIg';
import igCatalog from '../igCatalog.json';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** Catalog IG (CI-baked to data/<id>/source.tgz — the same-origin "worst CDN").
 *  One gzipped fetch, no CORS, offline after first load, pinned + reproducible. */
export interface CatalogIg {
  id: string;
  owner: string;
  repo: string;
  ref: string;
  name: string;
}
export const CATALOG_IGS: CatalogIg[] = (igCatalog as { igs: CatalogIg[] }).igs;
const CATALOG_BY_ID: Record<string, CatalogIg> = Object.fromEntries(
  CATALOG_IGS.map((ig) => [ig.id, ig]),
);

const IMAGE_EXTS = new Set(['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp']);
const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

async function toBase64(bytes: Uint8Array): Promise<string> {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Parse a POSIX ustar archive (what GNU `tar czf` emits for our short paths —
 *  no GNU longname/pax records needed; long paths use the prefix/name split).
 *  Yields regular-file entries only. */
function untar(buf: Uint8Array): Array<{ path: string; data: Uint8Array }> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  const dec = new TextDecoder();
  const str = (off: number, len: number) => dec.decode(buf.subarray(off, off + len)).replace(/\0.*$/, '');
  let p = 0;
  while (p + 512 <= buf.length) {
    // Two consecutive zero blocks terminate the archive.
    if (buf.subarray(p, p + 512).every((b) => b === 0)) break;
    const name = str(p, 100);
    const prefix = str(p + 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(str(p + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(buf[p + 156] || 0);
    p += 512;
    if (type === '0' || type === '\0') out.push({ path, data: buf.subarray(p, p + size) });
    p += Math.ceil(size / 512) * 512;
  }
  return out;
}

/** Load a CI-baked IG from its same-origin gzipped source archive
 *  (`data/<id>/source.tgz`): fetch → gunzip → untar → hydrate the store. */
async function loadTgzProject(
  store: ProjectStore,
  ig: CatalogIg,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<DemoIgMeta> {
  onProgress?.({ stage: 'manifest', label: ig.id, message: `Loading ${ig.name}…` });
  const resp = await fetch(`${BASE}data/${ig.id}/source.tgz`);
  if (!resp.ok || !resp.body) throw new Error(`fetch ${ig.id} source.tgz -> ${resp.status}`);
  const stream = resp.body.pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  onProgress?.({ stage: 'manifest', label: ig.id, message: `Unpacking ${ig.name}…` });

  const files: ProjectFile[] = [];
  const binary: BinaryProjectFile[] = [];
  const dec = new TextDecoder();
  for (const { path, data } of untar(bytes)) {
    if (IMAGE_EXTS.has(extOf(path))) binary.push({ path, base64: await toBase64(data) });
    else files.push({ path, text: dec.decode(data) });
  }
  await store.loadAll(files, binary);
  return { name: ig.name, fileCount: files.length + binary.length };
}

/** A featured/openable project whose SOURCE is fetched live from a GitHub repo
 *  @ ref (no baked data/<id>/manifest.json). The loader is rendering-path-
 *  agnostic — the produced project is the same shape as a baked one. Add a
 *  preset here (or bump `ref`) to feature a new IG. */
// The featured IGs are now CI-baked (see igCatalog.json / loadTgzProject), so this
// live-from-GitHub map is empty — kept as the generic fallback path for opening an
// arbitrary GitHub-hosted IG that isn't pre-baked.
export const GITHUB_PROJECTS: Record<string, GithubIgSpec> = {};

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

interface IgManifest {
  name: string;
  /** path → text, project-relative. */
  files: Record<string, string>;
  /** path → base64, project-relative (images). */
  binaryFiles?: Record<string, string>;
}

export interface DemoIgMeta {
  name: string;
  fileCount: number;
}

export async function loadDemoIg(store: ProjectStore): Promise<DemoIgMeta> {
  return loadProject(store, 'cycle');
}

/** Load a baked project by id (`data/<id>/manifest.json`). The optional
 *  `onProgress` surfaces the manifest fetch (with byte count when the response
 *  carries Content-Length) so the project-open overlay reads as alive. */
export async function loadProject(
  store: ProjectStore,
  projectId: string,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<DemoIgMeta> {
  // Dispatch: a catalog IG loads from its CI-baked same-origin source.tgz; a
  // GITHUB_PROJECTS entry loads live from GitHub (generic fallback for anything
  // not pre-baked); everything else is a baked data/<id>/manifest.json fetch
  // (the cycle demo).
  const cat = CATALOG_BY_ID[projectId];
  if (cat) return loadTgzProject(store, cat, onProgress);
  const gh = GITHUB_PROJECTS[projectId];
  if (gh) return loadGithubIg(store, gh, onProgress);

  const resp = await fetch(`${BASE}data/${projectId}/manifest.json`);
  if (!resp.ok) throw new Error(`fetch ${projectId} manifest -> ${resp.status}`);
  const len = Number(resp.headers.get('content-length')) || 0;
  onProgress?.({
    stage: 'manifest',
    label: projectId,
    bytes: len || undefined,
    message: `Loading ${projectId} project files${len ? ` (${fmtBytes(len)})` : ''}…`,
  });
  const manifest: IgManifest = await resp.json();
  const files: ProjectFile[] = Object.entries(manifest.files).map(([path, text]) => ({
    path,
    text,
  }));
  const binary: BinaryProjectFile[] = Object.entries(manifest.binaryFiles ?? {}).map(
    ([path, base64]) => ({ path, base64 }),
  );
  await store.loadAll(files, binary);
  return { name: manifest.name, fileCount: files.length + binary.length };
}
