// "Open demo IG" (spec §5, mode 1): hydrate the project store from the baked
// cycle IG manifest. scripts/export-ig-manifest.ts exports the cycle submodule's
// sushi-config.yaml + input/fsh/** + input/resources/** into
// public/data/cycle/manifest.json (a single JSON with inlined file text), so one
// fetch + one loadAll gives an offline-capable working project.

import type { ProjectStore, ProjectFile, BinaryProjectFile } from './store';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

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

/** Load a baked project by id (`data/<id>/manifest.json`). */
export async function loadProject(store: ProjectStore, projectId: string): Promise<DemoIgMeta> {
  const manifest: IgManifest = await (
    await fetch(`${BASE}data/${projectId}/manifest.json`)
  ).json();
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
