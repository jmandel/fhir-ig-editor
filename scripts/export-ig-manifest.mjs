#!/usr/bin/env node
// Export the baked default IG (spec §5, mode 1) from the cycle submodule into
// app/public/data/cycle/manifest.json — a single JSON with every project file's
// text inlined, so "Open demo IG" is one fetch + one OPFS hydrate (offline after
// first load). Gitignored / regenerated here + in CI.
//
//   node scripts/export-ig-manifest.mjs
//
// Includes: sushi-config.yaml, input/fsh/**.fsh, input/resources/**.json. The
// engine's compile input is exactly these (config + FSH + predefined resources).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CYCLE = path.join(REPO, 'vendor/cycle');
const OUT_DIR = path.join(REPO, 'app/public/data/cycle');

if (!fs.existsSync(path.join(CYCLE, 'sushi-config.yaml'))) {
  console.error('FATAL: vendor/cycle not checked out (run: git submodule update --init)');
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
function add(abs) {
  const rel = path.relative(CYCLE, abs).split(path.sep).join('/');
  files[rel] = fs.readFileSync(abs, 'utf8');
}

add(path.join(CYCLE, 'sushi-config.yaml'));
for (const f of collect(path.join(CYCLE, 'input/fsh'), ['fsh'])) add(f);
for (const f of collect(path.join(CYCLE, 'input/resources'), ['json'])) add(f);

// Read the IG name from sushi-config (best-effort; no YAML dep).
const cfg = files['sushi-config.yaml'] ?? '';
const nameMatch = cfg.match(/^title:\s*(.+)$/m) || cfg.match(/^name:\s*(.+)$/m);
const name = (nameMatch ? nameMatch[1] : 'cycle IG').trim().replace(/^["']|["']$/g, '');

fs.mkdirSync(OUT_DIR, { recursive: true });
const manifest = { name, fileCount: Object.keys(files).length, files };
fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest));

console.log(
  `[export-ig-manifest] ${name}: ${manifest.fileCount} files -> app/public/data/cycle/manifest.json`,
);
