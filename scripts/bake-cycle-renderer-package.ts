#!/usr/bin/env bun
/**
 * Bake Cycle's exact browser renderer inputs as one authenticated renderer
 * package manifest plus content-addressed bodies.
 *
 * Package construction, path policy, ordering, and package-id canonicalization
 * belong to Cycle. This host script only persists the already-prepared package
 * in the static transport layout that the worker will ingest during `prepare`:
 *
 *   app/public/data/cycle/renderer-package/manifest.json
 *   app/public/data/cycle/renderer-package/objects/<sha256>
 */
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeCycleRendererPackage } from '../vendor/cycle/site-gen/native-renderer-package.ts';
import {
  computeCycleRendererPackageId,
  CycleRendererPackage,
  type CycleRendererPackageFile,
  type CycleRendererPackageManifest,
} from '../vendor/cycle/site-gen/core/renderer-package.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
export const DEFAULT_CYCLE_RENDERER_PACKAGE_DIR = join(
  REPO,
  'app/public/data/cycle/renderer-package',
);

export interface BakedCycleRendererPackage {
  manifest: CycleRendererPackageManifest;
  bodies: ReadonlyMap<string, Uint8Array>;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Build through Cycle's native package builder; do not duplicate its input
 * selection or its canonical package-id algorithm in the editor repository. */
export async function buildCycleRendererPackageArtifact(): Promise<BakedCycleRendererPackage> {
  const prepared = await prepareNativeCycleRendererPackage({
    designDirectory: join(REPO, 'vendor/cycle/site-gen/designs/cycle'),
    projectCss: join(REPO, 'vendor/cycle/site-gen/project/cycle.css'),
    clientEntry: join(REPO, 'vendor/cycle/site-gen/client/entry.tsx'),
  });
  const bodies = new Map<string, Uint8Array>();
  const files: CycleRendererPackageFile[] = prepared.outputs().map((output) => {
    const bytes = prepared.render(output.file);
    if (!bytes) throw new Error(`Cycle renderer package omitted declared body '${output.file}'`);
    const sha256 = digest(bytes);
    const prior = bodies.get(sha256);
    if (prior && !Buffer.from(prior).equals(Buffer.from(bytes))) {
      throw new Error(`Cycle renderer package SHA-256 collision at ${sha256}`);
    }
    bodies.set(sha256, bytes);
    return {
      path: output.file,
      mediaType: output.mime,
      producer: output.producer,
      content: { sha256, byteLength: bytes.byteLength, mediaType: output.mime },
    };
  });
  const manifest: CycleRendererPackageManifest = {
    schemaVersion: 'cycle-renderer-package/v1',
    packageId: await computeCycleRendererPackageId(files),
    files,
  };
  if (manifest.packageId !== prepared.packageId) {
    throw new Error(
      `Cycle renderer package reconstruction changed identity: ${prepared.packageId} -> ${manifest.packageId}`,
    );
  }
  // Exercise Cycle's complete validator against the exact persisted shape before
  // any pointer can be published.
  await CycleRendererPackage.open(manifest, {
    get: async (content) => bodies.get(content.sha256) ?? null,
  });
  return { manifest, bodies };
}

function manifestBytes(manifest: CycleRendererPackageManifest): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
}

/** Content first, manifest last, then replace the generated directory. */
export async function writeCycleRendererPackageArtifact(
  outputDirectory = DEFAULT_CYCLE_RENDERER_PACKAGE_DIR,
  artifact?: BakedCycleRendererPackage,
): Promise<BakedCycleRendererPackage> {
  const value = artifact ?? await buildCycleRendererPackageArtifact();
  const staging = `${outputDirectory}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(join(staging, 'objects'), { recursive: true });
  for (const sha256 of [...value.bodies.keys()].sort()) {
    writeFileSync(join(staging, 'objects', sha256), value.bodies.get(sha256)!);
  }
  writeFileSync(join(staging, 'manifest.json'), manifestBytes(value.manifest));
  await verifyCycleRendererPackageArtifact(staging, value);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(dirname(outputDirectory), { recursive: true });
  renameSync(staging, outputDirectory);
  return value;
}

/** Validate both Cycle semantics and deterministic equality with a fresh build. */
export async function verifyCycleRendererPackageArtifact(
  outputDirectory = DEFAULT_CYCLE_RENDERER_PACKAGE_DIR,
  expected?: BakedCycleRendererPackage,
): Promise<CycleRendererPackageManifest> {
  const manifest = JSON.parse(
    readFileSync(join(outputDirectory, 'manifest.json'), 'utf8'),
  ) as CycleRendererPackageManifest;
  const objectDirectory = join(outputDirectory, 'objects');
  const objectNames = readdirSync(objectDirectory).sort();
  const bodies = new Map<string, Uint8Array>(
    objectNames.map((name) => [name, new Uint8Array(readFileSync(join(objectDirectory, name)))]),
  );
  await CycleRendererPackage.open(manifest, {
    get: async (content) => bodies.get(content.sha256) ?? null,
  });
  const referenced = [...new Set(manifest.files.map((file) => file.content.sha256))].sort();
  if (JSON.stringify(objectNames) !== JSON.stringify(referenced)) {
    throw new Error('Cycle renderer package object directory is not the exact manifest closure');
  }
  const fresh = expected ?? await buildCycleRendererPackageArtifact();
  if (JSON.stringify(manifest) !== JSON.stringify(fresh.manifest)) {
    throw new Error('Baked Cycle renderer package manifest is not deterministic');
  }
  for (const [sha256, bytes] of fresh.bodies) {
    const stored = bodies.get(sha256);
    if (!stored || !Buffer.from(stored).equals(Buffer.from(bytes))) {
      throw new Error(`Baked Cycle renderer package body differs at ${sha256}`);
    }
  }
  return manifest;
}

if (import.meta.main) {
  const verifyOnly = process.argv.includes('--verify');
  if (verifyOnly) {
    const manifest = await verifyCycleRendererPackageArtifact();
    console.log(
      `[cycle-renderer-package] verified ${manifest.packageId}: ${manifest.files.length} files`,
    );
  } else {
    const value = await writeCycleRendererPackageArtifact();
    const bytes = [...value.bodies.values()].reduce((sum, body) => sum + body.byteLength, 0);
    console.log(
      `[cycle-renderer-package] ${value.manifest.packageId}: `
      + `${value.manifest.files.length} files, ${value.bodies.size} objects, ${bytes} bytes`,
    );
  }
}
