// Load an IG project directly from a GitHub repo @ ref, at runtime, in the
// browser — no CI data-gen, no local checkout. The produced manifest is the
// SAME shape `scripts/export-ig-manifest.mjs` emits ({ name, fileCount, files,
// binaryFiles }), so every downstream consumer (the store, the compiler, any
// site generator) is agnostic to whether the project came from a baked
// data/<id>/manifest.json or was fetched live here.
//
// FETCH ROUTE (empirically CORS-verified in headless Chromium from a real http
// origin — see the task investigation):
//   * the tag/branch ZIP (github.com / codeload.github.com) is CORS-BLOCKED.
//   * api.github.com git-trees (recursive) IS CORS-enabled → the file LIST.
//   * raw.githubusercontent.com IS CORS-enabled and is not subject to the
//     api.github.com 60/hr unauthenticated rate limit → per-FILE bytes.
// So: ONE git-trees request for the manifest of paths, then each wanted file
// from raw.githubusercontent.com (bounded concurrency).

import type { ProjectStore, ProjectFile, BinaryProjectFile } from './store';
import type { ProgressEvent } from '../worker/protocol';
import type { DemoIgMeta } from './demoIg';

/** A GitHub-hosted IG source: repo @ ref, optionally rooted in a subdir. */
export interface GithubIgSpec {
  owner: string;
  repo: string;
  /** A tag, branch, or commit sha. */
  ref: string;
  /** Display name (falls back to the sushi-config title/name, then the repo). */
  name?: string;
  /** Repo-relative dir that holds sushi-config.yaml (default: repo root). */
  root?: string;
}

/** The project manifest — byte-shape-identical to export-ig-manifest.mjs. */
export interface IgManifest {
  name: string;
  fileCount: number;
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
}

// The publisher-input file set the compiler + the S6 site producer read — the
// SAME selection scripts/export-ig-manifest.mjs collects. `dir` is matched as a
// path PREFIX; `exts` are the lower-cased extensions kept from that subtree.
const TEXT_DIRS: Array<{ dir: string; exts: string[] }> = [
  { dir: 'input/fsh', exts: ['fsh'] },
  { dir: 'input/resources', exts: ['json'] },
  { dir: 'input/pagecontent', exts: ['md', 'xml'] },
  { dir: 'input/includes', exts: ['md', 'xml', 'xhtml', 'html', 'txt'] },
  { dir: 'input/intro-notes', exts: ['md', 'xml', 'xhtml', 'html'] },
  { dir: 'input/data', exts: ['json', 'yaml', 'yml', 'csv'] },
];
const BINARY_DIRS: Array<{ dir: string; exts: string[] }> = [
  { dir: 'input/images', exts: ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp'] },
];
// Top-level single files always taken verbatim (text).
const TOP_TEXT_FILES = ['sushi-config.yaml', 'ig.ini'];

const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

function wantText(rel: string): boolean {
  if (TOP_TEXT_FILES.includes(rel)) return true;
  return TEXT_DIRS.some((m) => rel.startsWith(`${m.dir}/`) && m.exts.includes(extOf(rel)));
}
function wantBinary(rel: string): boolean {
  return BINARY_DIRS.some((m) => rel.startsWith(`${m.dir}/`) && m.exts.includes(extOf(rel)));
}

interface TreeEntry {
  path: string;
  type: string;
}

/** Run `worker` over `items` with at most `limit` in flight. Preserves order of
 *  completion side effects only through the worker; results are discarded. */
async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

async function arrayBufferToBase64(buf: ArrayBuffer): Promise<string> {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Parse the IG display name from sushi-config.yaml (title, else name) — the
 *  same best-effort, no-YAML-dep read export-ig-manifest.mjs does. */
function nameFromConfig(cfg: string | undefined): string | null {
  if (!cfg) return null;
  const m = cfg.match(/^title:\s*(.+)$/m) || cfg.match(/^name:\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Fetch a GitHub-hosted IG's publisher-input files into an IgManifest. Throws a
 *  descriptive Error on any network/CORS/HTTP/parse failure (the caller surfaces
 *  it) — never resolves with a partial project. */
export async function fetchGithubIgManifest(
  spec: GithubIgSpec,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<IgManifest> {
  const { owner, repo, ref } = spec;
  const rootPrefix = spec.root ? spec.root.replace(/\/?$/, '/') : '';
  const label = `${owner}/${repo}@${ref}`;

  // 1. One CORS-enabled git-trees request → the full recursive path list.
  onProgress?.({ stage: 'manifest', label, message: `Listing files in ${label}…` });
  const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(
    ref,
  )}?recursive=1`;
  let treeResp: Response;
  try {
    treeResp = await fetch(treeUrl);
  } catch (e) {
    throw new Error(
      `Could not reach GitHub to list ${label} (${String(e)}). Check the network / that the repo and ref exist.`,
    );
  }
  if (treeResp.status === 404) throw new Error(`GitHub repo or ref not found: ${label} (HTTP 404).`);
  if (treeResp.status === 403) {
    throw new Error(
      `GitHub API rate limit or access denied listing ${label} (HTTP 403). Try again later or use a different ref.`,
    );
  }
  if (!treeResp.ok) throw new Error(`Listing ${label} failed: HTTP ${treeResp.status}.`);
  let tree: { tree?: TreeEntry[]; truncated?: boolean };
  try {
    tree = await treeResp.json();
  } catch (e) {
    throw new Error(`GitHub returned an unparseable file list for ${label}: ${String(e)}.`);
  }
  if (tree.truncated) {
    throw new Error(
      `The file list for ${label} was truncated by GitHub (repo too large for a single tree request).`,
    );
  }
  const entries = (tree.tree ?? []).filter((e) => e.type === 'blob');

  // 2. Select the publisher-input files (repo-relative, after any root subdir).
  const rel = (p: string): string | null =>
    rootPrefix ? (p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : null) : p;
  const textPaths: string[] = [];
  const binaryPaths: string[] = [];
  for (const e of entries) {
    const r = rel(e.path);
    if (r == null) continue;
    if (wantText(r)) textPaths.push(r);
    else if (wantBinary(r)) binaryPaths.push(r);
  }
  if (!textPaths.includes('sushi-config.yaml')) {
    throw new Error(
      `No sushi-config.yaml found in ${label}${spec.root ? ` under '${spec.root}'` : ''} — not a publisher-shaped IG.`,
    );
  }

  // 3. Fetch each file from raw.githubusercontent.com (CORS-ok, bounded pool).
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  const total = textPaths.length + binaryPaths.length;
  let done = 0;
  const rawUrl = (r: string) =>
    `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${rootPrefix}${r
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  const bump = (r: string) => {
    done++;
    if (done % 10 === 0 || done === total) {
      onProgress?.({
        stage: 'manifest',
        label,
        fraction: total ? done / total : undefined,
        message: `Fetching ${label} — ${done}/${total} files (${r})`,
      });
    }
  };

  await mapPool(textPaths, 8, async (r) => {
    const resp = await fetch(rawUrl(r)).catch((e) => {
      throw new Error(`Fetching ${r} from ${label} failed: ${String(e)} (network/CORS).`);
    });
    if (!resp.ok) throw new Error(`Fetching ${r} from ${label} failed: HTTP ${resp.status}.`);
    files[r] = await resp.text();
    bump(r);
  });
  await mapPool(binaryPaths, 8, async (r) => {
    const resp = await fetch(rawUrl(r)).catch((e) => {
      throw new Error(`Fetching ${r} from ${label} failed: ${String(e)} (network/CORS).`);
    });
    if (!resp.ok) throw new Error(`Fetching ${r} from ${label} failed: HTTP ${resp.status}.`);
    binaryFiles[r] = await arrayBufferToBase64(await resp.arrayBuffer());
    bump(r);
  });

  const name =
    spec.name ?? nameFromConfig(files['sushi-config.yaml']) ?? `${owner}/${repo}`;
  const fileCount = Object.keys(files).length + Object.keys(binaryFiles).length;
  return { name, fileCount, files, binaryFiles };
}

/** Fetch a GitHub-hosted IG and hydrate the store — the live twin of
 *  `loadProject`'s baked path. Errors propagate (open flow surfaces them). */
export async function loadGithubIg(
  store: ProjectStore,
  spec: GithubIgSpec,
  onProgress?: (ev: ProgressEvent) => void,
): Promise<DemoIgMeta> {
  const manifest = await fetchGithubIgManifest(spec, onProgress);
  const files: ProjectFile[] = Object.entries(manifest.files).map(([path, text]) => ({ path, text }));
  const binary: BinaryProjectFile[] = Object.entries(manifest.binaryFiles).map(([path, base64]) => ({
    path,
    base64,
  }));
  await store.loadAll(files, binary);
  return { name: manifest.name, fileCount: files.length + binary.length };
}
