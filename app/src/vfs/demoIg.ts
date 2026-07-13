// Baked-project loader. The first-run authoring guide and the Cycle external-
// builder fixture are exported to data/<id>/manifest.json; catalog IGs use the
// authenticated source.tgz path below. Every route installs or reopens one
// project-scoped Workspace.

import {
  type BinaryProjectFile,
  type ProjectFile,
  type Workspace,
  WorkspaceRepository,
} from './workspace';
import type { BuildEvent } from '../worker/protocol';
import { loadGithubIg, type GithubIgSpec } from './githubIg';
import igCatalog from '../igCatalog.json';
import { readResponseBytes, sha256Hex } from '../worker/bundleIntegrity';

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

interface CatalogSourceDescriptor {
  schema: 1;
  id: string;
  ref: string;
  sha256: string;
  bytes: number;
  files: number;
}

function parseSourceDescriptor(value: unknown, ig: CatalogIg): CatalogSourceDescriptor {
  const candidate = value as Partial<CatalogSourceDescriptor> | null;
  if (
    !candidate
    || candidate.schema !== 1
    || candidate.id !== ig.id
    || candidate.ref !== ig.ref
    || typeof candidate.sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(candidate.sha256)
    || !Number.isSafeInteger(candidate.bytes)
    || (candidate.bytes ?? -1) < 0
    || !Number.isSafeInteger(candidate.files)
    || (candidate.files ?? -1) < 0
  ) {
    throw new Error(`invalid ${ig.id} source descriptor`);
  }
  return candidate as CatalogSourceDescriptor;
}

/** Load a CI-baked IG from its same-origin gzipped source archive
 * (`data/<id>/source.tgz`): fetch -> gunzip -> untar -> transactional install. */
async function loadTgzProject(
  workspaces: WorkspaceRepository,
  ig: CatalogIg,
  onProgress?: (ev: BuildEvent) => void,
): Promise<DemoIgMeta> {
  const descriptorStarted = performance.now();
  const existing = await workspaces.open(ig.id);
  if (existing?.dirty) {
    onProgress?.({
      stage: 'project-cache-hit',
      label: ig.id,
      message: `Reopening edited ${existing.name} working copy.`,
      fromCache: true,
      fileCount: existing.list().length,
    });
    return { name: existing.name, fileCount: existing.list().length, workspace: existing };
  }
  const descriptorResponse = await fetch(`${BASE}data/${ig.id}/source.json`);
  if (!descriptorResponse.ok) throw new Error(`fetch ${ig.id} source descriptor -> ${descriptorResponse.status}`);
  const descriptor = parseSourceDescriptor(await descriptorResponse.json(), ig);
  const identity = `catalog-source-sha256:${descriptor.sha256}`;
  if (existing?.sourceIdentity === identity) {
    onProgress?.({
      stage: 'project-cache-hit',
      label: ig.id,
      message: `Reusing unchanged ${ig.name} project files.`,
      fromCache: true,
      durationMs: performance.now() - descriptorStarted,
      inputBytes: descriptor.bytes,
      fileCount: descriptor.files,
    });
    return { name: existing.name || ig.name, fileCount: existing.list().length, workspace: existing };
  }

  onProgress?.({
    stage: 'manifest',
    label: ig.id,
    bytes: 0,
    totalBytes: descriptor.bytes,
    message: `Downloading ${ig.name} source…`,
  });
  const resp = await fetch(`${BASE}data/${ig.id}/source.tgz`);
  if (!resp.ok) throw new Error(`fetch ${ig.id} source.tgz -> ${resp.status}`);
  const compressed = await readResponseBytes(resp, (bytes, totalBytes) => {
    onProgress?.({
      stage: 'manifest',
      label: ig.id,
      bytes,
      totalBytes,
      message: `Downloading ${ig.name} source…`,
    });
  }, descriptor.bytes);
  if (compressed.byteLength !== descriptor.bytes) {
    throw new Error(`${ig.id} source.tgz byte length mismatch: expected ${descriptor.bytes}, got ${compressed.byteLength}`);
  }
  onProgress?.({
    stage: 'project-verify',
    label: ig.id,
    message: `Verifying ${ig.name} source archive…`,
    inputBytes: compressed.byteLength,
  });
  const actualSha256 = await sha256Hex(compressed);
  if (actualSha256 !== descriptor.sha256) {
    throw new Error(`${ig.id} source.tgz SHA-256 mismatch: expected ${descriptor.sha256}, got ${actualSha256}`);
  }
  const unpackStarted = performance.now();
  onProgress?.({ stage: 'project-unpack', label: ig.id, message: `Unpacking ${ig.name}…` });
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());

  const files: ProjectFile[] = [];
  const binary: BinaryProjectFile[] = [];
  const dec = new TextDecoder();
  const entries = untar(bytes);
  for (const { path, data } of entries) {
    if (IMAGE_EXTS.has(extOf(path))) binary.push({ path, base64: await toBase64(data) });
    else files.push({ path, text: dec.decode(data) });
  }
  if (entries.length !== descriptor.files) {
    throw new Error(`${ig.id} source file-count mismatch: expected ${descriptor.files}, got ${entries.length}`);
  }
  onProgress?.({
    stage: 'project-unpack',
    label: ig.id,
    message: `Unpacked ${ig.name}.`,
    durationMs: performance.now() - unpackStarted,
    inputBytes: compressed.byteLength,
    outputBytes: bytes.byteLength,
    fileCount: entries.length,
  });

  onProgress?.({ stage: 'project-store', label: ig.id, message: `Storing ${ig.name} project files…` });
  const stored = await workspaces.installSource({
    projectId: ig.id,
    name: ig.name,
    sourceIdentity: identity,
    files,
    binaryFiles: binary,
  }, { replace: existing });
  onProgress?.({
    stage: stored.installed ? 'project-store' : 'project-cache-hit',
    label: ig.id,
    message: stored.installed
      ? `Stored ${ig.name} project files.`
      : `Kept edited ${stored.workspace.name} working copy.`,
    fromCache: !stored.installed,
    durationMs: stored.durationMs,
    inputBytes: stored.storedBytes,
    outputBytes: stored.storedBytes,
    fileCount: stored.textFiles + stored.binaryFiles,
  });
  return {
    name: stored.workspace.name,
    fileCount: stored.workspace.list().length + stored.workspace.binaryFileCount,
    workspace: stored.workspace,
  };
}

/** A featured/openable project whose SOURCE is fetched live from a GitHub repo
 *  @ ref (no baked data/<id>/manifest.json). The loader is rendering-path-
 *  agnostic — the produced project is the same shape as a baked one. Add a
 *  preset here (or bump `ref`) to feature a new IG. */
// The featured IGs are now CI-baked (see igCatalog.json / loadTgzProject), so this
// live-from-GitHub map is empty — kept as the generic fallback path for opening an
// arbitrary GitHub-hosted IG that isn't pre-baked.
export const GITHUB_PROJECTS: Record<string, GithubIgSpec> = {};

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
  workspace: Workspace;
}

/** Load a baked project by id (`data/<id>/manifest.json`). The optional
 *  `onProgress` surfaces the manifest fetch (with byte count when the response
 *  carries Content-Length) so the project-open overlay reads as alive. */
export async function loadProject(
  workspaces: WorkspaceRepository,
  projectId: string,
  onProgress?: (ev: BuildEvent) => void,
): Promise<DemoIgMeta> {
  // Dispatch: a catalog IG loads from its CI-baked same-origin source.tgz; a
  // GITHUB_PROJECTS entry loads live from GitHub (generic fallback for anything
  // not pre-baked); everything else is a baked data/<id>/manifest.json fetch
  // (the tiny guide and Cycle fixture).
  const cat = CATALOG_BY_ID[projectId];
  if (cat) return loadTgzProject(workspaces, cat, onProgress);
  const gh = GITHUB_PROJECTS[projectId];
  if (gh) return loadGithubIg(workspaces, projectId, gh, onProgress);

  const existing = await workspaces.open(projectId);
  if (existing?.dirty) {
    onProgress?.({
      stage: 'project-cache-hit',
      label: projectId,
      message: `Reopening edited ${existing.name} working copy.`,
      fromCache: true,
      fileCount: existing.list().length,
    });
    return { name: existing.name, fileCount: existing.list().length, workspace: existing };
  }
  const resp = await fetch(`${BASE}data/${projectId}/manifest.json`);
  if (!resp.ok) throw new Error(`fetch ${projectId} manifest -> ${resp.status}`);
  const len = Number(resp.headers.get('content-length')) || 0;
  onProgress?.({
    stage: 'manifest',
    label: projectId,
    bytes: 0,
    totalBytes: len || undefined,
    message: `Downloading ${projectId} project files…`,
  });
  const manifestBytes = await readResponseBytes(resp, (bytes, totalBytes) => {
    onProgress?.({
      stage: 'manifest',
      label: projectId,
      bytes,
      totalBytes,
      message: `Downloading ${projectId} project files…`,
    });
  }, len || undefined);
  const sourceIdentity = `baked-manifest-sha256:${await sha256Hex(manifestBytes)}`;
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as IgManifest;
  if (existing?.sourceIdentity === sourceIdentity) {
    onProgress?.({
      stage: 'project-cache-hit',
      label: projectId,
      message: `Reusing unchanged ${existing.name} project files.`,
      fromCache: true,
      fileCount: existing.list().length,
    });
    return { name: existing.name, fileCount: existing.list().length, workspace: existing };
  }
  const files: ProjectFile[] = Object.entries(manifest.files).map(([path, text]) => ({
    path,
    text,
  }));
  const binary: BinaryProjectFile[] = Object.entries(manifest.binaryFiles ?? {}).map(
    ([path, base64]) => ({ path, base64 }),
  );
  const installed = await workspaces.installSource({
    projectId,
    name: manifest.name,
    sourceIdentity,
    files,
    binaryFiles: binary,
  }, { replace: existing });
  return {
    name: installed.workspace.name,
    fileCount: installed.workspace.list().length + installed.workspace.binaryFileCount,
    workspace: installed.workspace,
  };
}
