import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  artifactIdentity,
  benchmarkRecipeIdentity,
  benchmarkRecipeNames,
} from './benchmark-identity.mjs';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const identityScript = join(scriptDir, 'benchmark-identity.mjs');

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function expectedIdentity(files) {
  const digest = createHash('sha256');
  digest.update(Buffer.from('fhir-ig-editor-benchmark-artifact-v1\0'));
  for (const [name, body] of files) {
    const encoded = Buffer.from(name);
    digest.update(u64(encoded.byteLength));
    digest.update(encoded);
    digest.update(u64(body.byteLength));
    digest.update(body);
  }
  return digest.digest('hex');
}

test('artifact identity globally byte-sorts directory/file prefix collisions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fhir-benchmark-identity.'));
  try {
    await mkdir(join(root, 'data', 'cycle'), { recursive: true });
    await writeFile(join(root, 'data', 'cycle', 'manifest.json'), 'nested');
    await writeFile(join(root, 'data', 'cycle.json'), 'sibling');
    await writeFile(join(root, 'index.html'), 'index');

    const ordered = [
      ['data/cycle.json', Buffer.from('sibling')],
      ['data/cycle/manifest.json', Buffer.from('nested')],
      ['index.html', Buffer.from('index')],
    ];
    const actual = await artifactIdentity(root);
    assert.equal(actual.sha256, expectedIdentity(ordered));
    assert.equal(actual.fileCount, 3);
    assert.equal(actual.byteLength, 18);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact identity fails closed on symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fhir-benchmark-symlink.'));
  try {
    await writeFile(join(root, 'target-a.txt'), 'one');
    await symlink('target-a.txt', join(root, 'live.txt'));
    await assert.rejects(
      artifactIdentity(root),
      /unsupported non-regular entry: live\.txt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('recipe identity includes its own implementation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fhir-benchmark-recipe.'));
  try {
    assert.ok(benchmarkRecipeNames.includes('scripts/benchmark-identity.mjs'));
    for (const name of benchmarkRecipeNames) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), name);
    }
    const before = await benchmarkRecipeIdentity(root);
    await writeFile(
      join(root, 'scripts/benchmark-identity.mjs'),
      'changed identity implementation',
    );
    const after = await benchmarkRecipeIdentity(root);
    assert.notEqual(after, before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('identity CLI emits the same validated four-field record as the module', async () => {
  const dist = await mkdtemp(join(tmpdir(), 'fhir-benchmark-cli.'));
  try {
    await writeFile(join(dist, 'index.html'), 'index');
    const artifact = await artifactIdentity(dist);
    const recipe = await benchmarkRecipeIdentity(repoRoot);
    const { stdout } = await execFileAsync(process.execPath, [
      identityScript,
      dist,
      repoRoot,
    ]);
    assert.deepEqual(stdout.trimEnd().split('\n'), [
      artifact.sha256,
      String(artifact.fileCount),
      String(artifact.byteLength),
      recipe,
    ]);
  } finally {
    await rm(dist, { recursive: true, force: true });
  }
});

test('matrix and child bind the shared identity to source and served artifacts', async () => {
  const matrix = await readFile(join(scriptDir, 'benchmark-matrix.mjs'), 'utf8');
  const runner = await readFile(join(scriptDir, 'run-project-benchmark.sh'), 'utf8');
  assert.match(
    matrix,
    /artifactIdentity\(dist\)/,
    'the matrix must bind the source artifact before launching children',
  );
  assert.match(
    runner,
    /benchmark-identity\.mjs" "\$SITE_ROOT" "\$ROOT"/,
    'each child must hash the frozen copy Chromium actually serves',
  );
  assert.doesNotMatch(
    runner,
    /benchmark-identity\.mjs" "\$DIST" "\$ROOT"/,
    'hashing the mutable source twice does not certify served bytes',
  );
});
