#!/usr/bin/env node

// Produce two minimal, deterministic FHIR package carriers for the real-browser
// registry retry gate. Keeping the packages synthetic and unique prevents the
// gate from borrowing authority from the baked catalog or another E2E fixture.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(
  process.argv[2] || path.join(here, '..', 'app', 'public', 'data', 'fixtures'),
);

const fixtures = [
  { name: 'e2e.registry.retry', version: '1.0.0' },
  { name: 'e2e.registry.sibling', version: '1.0.0' },
];

function writeAscii(target, offset, length, value) {
  const encoded = Buffer.from(value, 'ascii');
  if (encoded.length > length) throw new Error(`tar field is too long: ${value}`);
  encoded.copy(target, offset);
}

function writeOctal(target, offset, length, value) {
  writeAscii(target, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  writeAscii(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30; // regular file
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function tarEntry(name, contents) {
  const bytes = Buffer.from(contents);
  const padding = Buffer.alloc((512 - (bytes.length % 512)) % 512);
  return Buffer.concat([tarHeader(name, bytes.length), bytes, padding]);
}

function packageTgz({ name, version }) {
  const packageJson = `${JSON.stringify({
    name,
    version,
    type: 'IG',
    canonical: `https://example.org/${name}`,
    fhirVersions: ['4.0.1'],
    dependencies: {},
  }, null, 2)}\n`;
  const indexJson = `${JSON.stringify({ files: [] })}\n`;
  const tar = Buffer.concat([
    tarEntry('package/.index.json', indexJson),
    tarEntry('package/package.json', packageJson),
    Buffer.alloc(1024),
  ]);
  return gzipSync(tar, { level: 9, mtime: 0 });
}

await mkdir(outputDirectory, { recursive: true });
for (const fixture of fixtures) {
  const label = `${fixture.name}#${fixture.version}`;
  const bytes = packageTgz(fixture);
  const destination = path.join(outputDirectory, `${label}.tgz`);
  await writeFile(destination, bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  console.log(`[registry-retry-fixture] ${label} ${bytes.length} bytes sha256:${digest}`);
}
