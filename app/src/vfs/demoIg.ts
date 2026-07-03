// "Open demo IG" (spec §5, mode 1): hydrate the project store from the baked
// cycle IG manifest. scripts/export-ig-manifest.ts exports the cycle submodule's
// sushi-config.yaml + input/fsh/** + input/resources/** into
// public/data/cycle/manifest.json (a single JSON with inlined file text), so one
// fetch + one loadAll gives an offline-capable working project.

import type { ProjectStore, ProjectFile } from './store';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

interface IgManifest {
  name: string;
  /** path → text, project-relative. */
  files: Record<string, string>;
}

export interface DemoIgMeta {
  name: string;
  fileCount: number;
}

export async function loadDemoIg(store: ProjectStore): Promise<DemoIgMeta> {
  const manifest: IgManifest = await (
    await fetch(`${BASE}data/cycle/manifest.json`)
  ).json();
  const files: ProjectFile[] = Object.entries(manifest.files).map(([path, text]) => ({
    path,
    text,
  }));
  await store.loadAll(files);
  return { name: manifest.name, fileCount: files.length };
}
