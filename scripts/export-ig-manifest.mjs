#!/usr/bin/env node
// Export the baked tiny authoring guide (spec §5, mode 1) into
// app/public/data/tiny/manifest.json — a single JSON with every project file
// inlined, so opening the tiny guide is one fetch + one OPFS hydrate (offline after first
// load). Gitignored / regenerated here + in CI.
//
//   node scripts/export-ig-manifest.mjs
//
// Text files (`files`): sushi-config.yaml, input/fsh/**.fsh,
// input/resources/**.json and the complete authored Publisher input roots — the
// compile input AND the authored site content semantic preparation reads.
// Binary files (`binaryFiles`, base64): input/images/**. Base64 is only this
// catalog archive's JSON transport; preparation publishes ordinary ContentRefs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
// Default: demo/tiny-guide -> data/tiny. `--src DIR --out NAME` exports
// any publisher-shaped project dir (sushi-config.yaml + input/**) instead; the
// static-data assembly uses that explicit form for the Cycle fixture.
const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const PROJECT = argOf('--src') ? path.resolve(argOf('--src')) : path.join(REPO, 'demo/tiny-guide');
const OUT_DIR = path.join(REPO, 'app/public/data', argOf('--out') || 'tiny');

if (!fs.existsSync(path.join(PROJECT, 'sushi-config.yaml'))) {
  console.error(`FATAL: no sushi-config.yaml under ${PROJECT}`);
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
  const rel = path.relative(PROJECT, abs).split(path.sep).join('/');
  files[rel] = fs.readFileSync(abs, 'utf8');
}
function addBinary(abs) {
  const rel = path.relative(PROJECT, abs).split(path.sep).join('/');
  binaryFiles[rel] = fs.readFileSync(abs).toString('base64');
}

addText(path.join(PROJECT, 'sushi-config.yaml'));
if (fs.existsSync(path.join(PROJECT, 'ig.ini'))) addText(path.join(PROJECT, 'ig.ini'));
for (const f of collect(path.join(PROJECT, 'input/fsh'), ['fsh'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/resources'), ['json'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/examples'), ['json'])) addText(f);
// S6 site content: page bodies + any liquid includes (text).
for (const f of collect(path.join(PROJECT, 'input/pagecontent'), ['md', 'xml'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/pages'), ['md', 'xml', 'html'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/includes'), ['md', 'xml', 'xhtml', 'html', 'txt'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/intro-notes'), ['md', 'xml', 'xhtml', 'html'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/resource-docs'), ['md', 'xml', 'xhtml', 'html'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/data'), ['json', 'yaml', 'yml', 'csv'])) addText(f);
for (const f of collect(path.join(PROJECT, 'input/images-source'), ['plantuml', 'puml', 'txt'])) addText(f);
// Images are binary → base64.
for (const f of collect(path.join(PROJECT, 'input/images'), ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp'])) addBinary(f);

// Read the IG name from sushi-config (best-effort; no YAML dep).
const cfg = files['sushi-config.yaml'] ?? '';
const nameMatch = cfg.match(/^title:\s*(.+)$/m) || cfg.match(/^name:\s*(.+)$/m);
const name = (nameMatch ? nameMatch[1] : 'FHIR implementation guide').trim().replace(/^["']|["']$/g, '');

fs.mkdirSync(OUT_DIR, { recursive: true });
const fileCount = Object.keys(files).length + Object.keys(binaryFiles).length;
const manifest = { name, fileCount, files, binaryFiles };
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

console.log(
  `[export-ig-manifest] ${name}: ${Object.keys(files).length} text + ${Object.keys(binaryFiles).length} binary files -> ${OUT_DIR}/manifest.json`,
);
