#!/usr/bin/env node

// One canonical identity implementation shared by the matrix orchestrator and
// every isolated project runner. Paths are globally bytewise sorted before
// hashing; recursive traversal order is deliberately not identity.

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);

export const benchmarkRecipeNames = Object.freeze([
  'scripts/benchmark-identity.mjs',
  'scripts/benchmark-cdp-lifecycle.mjs',
  'scripts/benchmark-matrix.mjs',
  'scripts/benchmark-project.mjs',
  'scripts/run-project-benchmark.sh',
]);

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function comparePathBytes(left, right) {
  return Buffer.from(left.name).compare(Buffer.from(right.name));
}

export async function artifactIdentity(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.isFile()) files.push({ name, path });
      else {
        throw new Error(
          `benchmark artifact contains unsupported non-regular entry: ${name}`,
        );
      }
    }
  }
  await walk(root);
  files.sort(comparePathBytes);

  const digest = createHash('sha256');
  digest.update(Buffer.from('fhir-ig-editor-benchmark-artifact-v1\0'));
  let byteLength = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const info = await lstat(file.path);
    if (!info.isFile()) {
      throw new Error(
        `benchmark artifact entry changed or is not a regular file: ${file.name}`,
      );
    }
    digest.update(u64(name.byteLength));
    digest.update(name);
    digest.update(u64(info.size));
    digest.update(await readFile(file.path));
    byteLength += info.size;
  }
  return { sha256: digest.digest('hex'), fileCount: files.length, byteLength };
}

export async function benchmarkRecipeIdentity(repoRoot) {
  const digest = createHash('sha256');
  digest.update(Buffer.from('fhir-ig-editor-benchmark-runner-v1\0'));
  for (const name of benchmarkRecipeNames) {
    const encodedName = Buffer.from(name);
    const bytes = await readFile(join(repoRoot, name));
    digest.update(u64(encodedName.byteLength));
    digest.update(encodedName);
    digest.update(u64(bytes.byteLength));
    digest.update(bytes);
  }
  return digest.digest('hex');
}

if (resolve(process.argv[1] || '') === scriptPath) {
  const dist = resolve(process.argv[2] || 'app/dist');
  const repoRoot = resolve(process.argv[3] || join(scriptDir, '..'));
  const artifact = await artifactIdentity(dist);
  const recipe = await benchmarkRecipeIdentity(repoRoot);
  process.stdout.write(
    `${artifact.sha256}\n${artifact.fileCount}\n${artifact.byteLength}\n${recipe}\n`,
  );
}
