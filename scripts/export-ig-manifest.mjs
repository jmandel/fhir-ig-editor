#!/usr/bin/env node
// Export the baked default IG (spec §5, mode 1) from the cycle submodule into
// app/public/data/cycle/manifest.json — a single JSON with every project file
// inlined, so "Open demo IG" is one fetch + one OPFS hydrate (offline after first
// load). Gitignored / regenerated here + in CI.
//
//   node scripts/export-ig-manifest.mjs
//
// Text files (`files`): sushi-config.yaml, input/fsh/**.fsh,
// input/resources/**.json, input/pagecontent/**, input/includes/** — the compile
// input AND the authored site content semantic preparation reads.
// Binary files (`binaryFiles`, base64): input/images/**. Base64 is only this
// catalog archive's JSON transport; preparation publishes ordinary ContentRefs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// Default: the cycle submodule -> data/cycle. `--src DIR --out NAME` exports
// any publisher-shaped project dir (sushi-config.yaml + input/**) instead —
// used for the US Core demo project (node scripts/export-ig-manifest.mjs
// --src <us-core dir> --out uscore).
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const CYCLE = argOf('--src') ? path.resolve(argOf('--src')) : path.join(REPO, 'vendor/cycle');
const OUT_DIR = path.join(REPO, 'app/public/data', argOf('--out') || 'cycle');

if (!fs.existsSync(path.join(CYCLE, 'sushi-config.yaml'))) {
  console.error(`FATAL: no sushi-config.yaml under ${CYCLE}`);
  process.exit(2);
}

/** Recursively collect files under `dir` (project-relative), filtered by ext. */
function collect(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p, exts));
    else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
  return out.sort();
}

const files = {};
const binaryFiles = {};
function addText(abs) {
  const rel = path.relative(CYCLE, abs).split(path.sep).join('/');
  files[rel] = fs.readFileSync(abs, 'utf8');
}
function addBinary(abs) {
  const rel = path.relative(CYCLE, abs).split(path.sep).join('/');
  binaryFiles[rel] = fs.readFileSync(abs).toString('base64');
}

addText(path.join(CYCLE, 'sushi-config.yaml'));
for (const f of collect(path.join(CYCLE, 'input/fsh'), ['fsh'])) addText(f);
for (const f of collect(path.join(CYCLE, 'input/resources'), ['json'])) addText(f);
// S6 site content: page bodies + any liquid includes (text).
for (const f of collect(path.join(CYCLE, 'input/pagecontent'), ['md', 'xml'])) addText(f);
for (const f of collect(path.join(CYCLE, 'input/includes'), ['md', 'xml', 'xhtml', 'html', 'txt'])) addText(f);
for (const f of collect(path.join(CYCLE, 'input/intro-notes'), ['md', 'xml', 'xhtml', 'html'])) addText(f);
for (const f of collect(path.join(CYCLE, 'input/data'), ['json', 'yaml', 'yml', 'csv'])) addText(f);
// Images are binary → base64.
for (const f of collect(path.join(CYCLE, 'input/images'), ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp'])) addBinary(f);

// Read the IG name from sushi-config (best-effort; no YAML dep).
const cfg = files['sushi-config.yaml'] ?? '';
const nameMatch = cfg.match(/^title:\s*(.+)$/m) || cfg.match(/^name:\s*(.+)$/m);
const name = (nameMatch ? nameMatch[1] : 'cycle IG').trim().replace(/^["']|["']$/g, '');

fs.mkdirSync(OUT_DIR, { recursive: true });
const fileCount = Object.keys(files).length + Object.keys(binaryFiles).length;
const manifest = { name, fileCount, files, binaryFiles };
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

console.log(
  `[export-ig-manifest] ${name}: ${Object.keys(files).length} text + ${Object.keys(binaryFiles).length} binary files -> ${OUT_DIR}/manifest.json`,
);
