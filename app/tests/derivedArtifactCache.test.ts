import { describe, expect, test } from 'bun:test';

import {
  canonicalDerivedRecipe,
  derivedRecipeDigest,
} from '../src/storage/derivedArtifactCache';
import { projectCompileRevision } from '../src/build/projectRevision';
import { cycleBuildRecipe, isProjectCompileRevision } from '../src/worker/cycleCacheIdentity';

describe('derived artifact recipe identity', () => {
  test('is recursively canonical and changes for every recipe input', async () => {
    const first = {
      renderer: { version: '2', id: 'cycle-site' },
      projectRevision: 'a'.repeat(64),
      options: { buildEpochSecs: 1700000000, flags: [true, false] },
    };
    const reordered = {
      options: { flags: [true, false], buildEpochSecs: 1700000000 },
      projectRevision: 'a'.repeat(64),
      renderer: { id: 'cycle-site', version: '2' },
    };
    expect(canonicalDerivedRecipe(first)).toBe(canonicalDerivedRecipe(reordered));
    expect(await derivedRecipeDigest(first)).toBe(await derivedRecipeDigest(reordered));
    expect(await derivedRecipeDigest({ ...first, projectRevision: 'b'.repeat(64) }))
      .not.toBe(await derivedRecipeDigest(first));
  });

  test('rejects non-finite numeric recipe inputs', () => {
    expect(() => canonicalDerivedRecipe({ timeout: Number.NaN })).toThrow('finite numbers');
  });

  test('accepts the actual projectCompileRevision wire format', async () => {
    const projectRevision = await projectCompileRevision({
      config: 'id: example',
      files: {},
      predefined: {},
      siteFiles: {},
      packageClosure: JSON.stringify({
        packages: [{ label: 'example.pkg#1.0.0', cacheKey: `pp1-sha256-${'a'.repeat(64)}-n1-d1-a1` }],
      }),
    });
    expect(isProjectCompileRevision(projectRevision)).toBe(true);
    const engineA = cycleBuildRecipe(projectRevision, 1700000000, 'engine-commit', 'engine-recipe-a', '[]');
    const engineB = cycleBuildRecipe(projectRevision, 1700000000, 'engine-commit', 'engine-recipe-b', '[]');
    expect(() => engineA).not.toThrow();
    expect(await derivedRecipeDigest(engineA)).not.toBe(await derivedRecipeDigest(engineB));
    expect(() => cycleBuildRecipe('a'.repeat(64), 1700000000, 'engine-commit', 'engine-recipe', '[]')).toThrow('invalid project revision');
  });
});
