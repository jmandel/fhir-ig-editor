import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRendererPackage } from '../../vendor/cycle/site-gen/core/renderer-package';
import {
  buildCycleRendererPackageArtifact,
  verifyCycleRendererPackageArtifact,
  writeCycleRendererPackageArtifact,
} from '../../scripts/bake-cycle-renderer-package';

describe('baked Cycle browser renderer package', () => {
  test('is deterministic and contains the exact renderer-owned browser inputs', async () => {
    const first = await buildCycleRendererPackageArtifact();
    const second = await buildCycleRendererPackageArtifact();
    expect(second.manifest).toEqual(first.manifest);
    expect([...second.bodies.keys()].sort()).toEqual([...first.bodies.keys()].sort());
    expect(first.manifest.schemaVersion).toBe('cycle-renderer-package/v1');
    expect(first.manifest.packageId).toMatch(/^crp1-sha256:[0-9a-f]{64}$/);

    const paths = first.manifest.files.map((file) => file.path);
    expect(paths).toContain('assets/app.js');
    expect(paths).toContain('assets/project.css');
    expect(paths).toContain('assets/cycle/styles.css');
    expect(paths).toContain('assets/cycle-mark.svg');
    expect(paths.some((path) => path.startsWith('assets/fonts/') && path.endsWith('.woff2'))).toBeTrue();
    expect(paths).toEqual([...paths].sort());

    for (const file of first.manifest.files) {
      const bytes = first.bodies.get(file.content.sha256);
      expect(bytes, file.path).toBeDefined();
      expect(bytes!.byteLength, file.path).toBe(file.content.byteLength);
      expect(createHash('sha256').update(bytes!).digest('hex'), file.path).toBe(file.content.sha256);
      expect(file.content.mediaType, file.path).toBe(file.mediaType);
    }
    await CycleRendererPackage.open(first.manifest, {
      get: async (content) => first.bodies.get(content.sha256) ?? null,
    });
  }, 30_000);

  test('writes only the manifest closure and verifies an independent rebuild', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cycle-renderer-package-'));
    try {
      const output = join(root, 'package');
      const artifact = await buildCycleRendererPackageArtifact();
      await writeCycleRendererPackageArtifact(output, artifact);
      const verified = await verifyCycleRendererPackageArtifact(output);
      expect(verified).toEqual(artifact.manifest);
      expect(readFileSync(join(output, 'manifest.json'), 'utf8')).toBe(
        `${JSON.stringify(artifact.manifest)}\n`,
      );
      expect(readdirSync(join(output, 'objects')).sort()).toEqual(
        [...artifact.bodies.keys()].sort(),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
