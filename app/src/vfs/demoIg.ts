// "Open demo IG" (spec §5, mode 1): hydrate the project store from the baked
// cycle IG manifest. scripts/export-ig-manifest.ts exports the cycle submodule's
// sushi-config.yaml + input/fsh/** + input/resources/** into
// public/data/cycle/manifest.json (a single JSON with inlined file text), so one
// fetch + one loadAll gives an offline-capable working project.

import type { ProjectStore, ProjectFile, BinaryProjectFile } from './store';
import type { ProgressEvent } from '../worker/protocol';
import { loadGithubIg, type GithubIgSpec } from './githubIg';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** A featured/openable project whose SOURCE is fetched live from a GitHub repo
 *  @ ref (no baked data/<id>/manifest.json). The loader is rendering-path-
 *  agnostic — the produced project is the same shape as a baked one. Add a
 *  preset here (or bump `ref`) to feature a new IG. */
export const GITHUB_PROJECTS: Record<string, GithubIgSpec> = {
  ips: {
    owner: 'HL7',
    repo: 'fhir-ips',
    ref: '2.0.1',
    name: 'International Patient Summary (IPS)',
  },
  uscore: {
    owner: 'HL7',
    repo: 'US-Core',
    ref: '9.0.0',
    name: 'US Core Implementation Guide',
  },
};

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
  // Live GitHub-sourced projects (no baked manifest) go through the runtime
  // loader; everything else is a baked data/<id>/manifest.json fetch.
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
