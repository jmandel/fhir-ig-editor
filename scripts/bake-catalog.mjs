#!/usr/bin/env node
// Bake the catalog IGs into same-origin gzipped source archives — the "worst CDN".
// For each entry in app/src/igCatalog.json, download the repo's publisher-input
// subset (the SAME selection githubIg.ts / export-ig-manifest.mjs use) at the
// pinned ref and write app/public/data/<id>/source.tgz with PROJECT-RELATIVE
// paths. The editor's loadTgz path fetches one .tgz per IG (no CORS, offline after
// first load, pinned + reproducible). CI has no browser CORS limit, so it can pull
// straight from codeload. Enforces a per-IG size budget so the deploy can't balloon.
//
//   node scripts/bake-catalog.mjs            # all catalog IGs
//   node scripts/bake-catalog.mjs uscore ips # a subset by id
//
// Requires: curl, tar (present on GitHub Actions runners).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(REPO, 'app/src/igCatalog.json'), 'utf8'));
const MAX_MB = 20; // per-IG zipped budget

// The publisher-input allow-list — MUST match githubIg.ts TEXT_DIRS/BINARY_DIRS +
// TOP_TEXT_FILES and export-ig-manifest.mjs. Kept as (dir, exts) so a repo that
// stashes stray files never bloats the archive.
const SELECT = [
  { dir: 'input/fsh', exts: ['fsh'] },
  { dir: 'input/resources', exts: ['json'] },
  { dir: 'input/pagecontent', exts: ['md', 'xml'] },
  { dir: 'input/includes', exts: ['md', 'xml', 'xhtml', 'html', 'txt'] },
  { dir: 'input/intro-notes', exts: ['md', 'xml', 'xhtml', 'html'] },
  { dir: 'input/data', exts: ['json', 'yaml', 'yml', 'csv'] },
  { dir: 'input/images', exts: ['png', 'svg', 'jpg', 'jpeg', 'gif', 'webp'] },
];
const TOP_FILES = ['sushi-config.yaml', 'ig.ini'];

function walk(dir, exts, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, base, out);
    else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(path.relative(base, full));
  }
}

const only = process.argv.slice(2);
const igs = only.length ? CATALOG.igs.filter((ig) => only.includes(ig.id)) : CATALOG.igs;
let failed = 0;
const summary = [];

for (const ig of igs) {
  const { id, owner, repo, ref } = ig;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `bake-${id}-`));
  try {
    const tgz = path.join(work, 'src.tgz');
    const url = `https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`;
    execFileSync('curl', ['-sL', '--fail', url, '-o', tgz], { stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('tar', ['xzf', tgz, '-C', work]);
    const root = fs.readdirSync(work).find((n) => fs.statSync(path.join(work, n)).isDirectory());
    const base = path.join(work, root);
    if (!fs.existsSync(path.join(base, 'sushi-config.yaml'))) {
      throw new Error(`no sushi-config.yaml (not publisher-shaped) at ${owner}/${repo}@${ref}`);
    }
    // Collect the subset (project-relative paths).
    const rels = [];
    for (const f of TOP_FILES) if (fs.existsSync(path.join(base, f))) rels.push(f);
    for (const { dir, exts } of SELECT) walk(path.join(base, dir), exts, base, rels);

    const outDir = path.join(REPO, 'app/public/data', id);
    fs.mkdirSync(outDir, { recursive: true });
    const outTgz = path.join(outDir, 'source.tgz');
    const listFile = path.join(work, 'files.txt');
    fs.writeFileSync(listFile, rels.join('\n'));
    // tar from the project root so entries are project-relative (input/…, sushi-config.yaml).
    execFileSync('tar', ['czf', outTgz, '-C', base, '-T', listFile]);

    const bytes = fs.statSync(outTgz).size;
    const mb = bytes / 1048576;
    const ok = mb <= MAX_MB;
    if (!ok) failed++;
    summary.push({ id, ref, files: rels.length, mb: mb.toFixed(1), ok });
    console.log(`${ok ? 'ok  ' : 'OVER'} ${id.padEnd(10)} ${ref.padEnd(10)} ${String(rels.length).padStart(4)} files  ${mb.toFixed(1)} MB`);
  } catch (e) {
    failed++;
    summary.push({ id, error: String(e.message || e) });
    console.error(`FAIL ${id}: ${e.message || e}`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const total = summary.reduce((s, x) => s + (x.mb ? Number(x.mb) : 0), 0);
console.log(`\nbaked ${summary.filter((x) => x.ok).length}/${igs.length} IGs, ${total.toFixed(1)} MB total`);
if (failed) {
  console.error(`\n${failed} IG(s) failed or exceeded the ${MAX_MB} MB budget.`);
  process.exit(1);
}
