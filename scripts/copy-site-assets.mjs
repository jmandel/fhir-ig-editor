#!/usr/bin/env node
// Copy the cycle site-gen DESIGN assets (CSS/fonts/marks + project.css) into
// app/public/data/cycle/site-assets/ mirroring the layout build.tsx produces via
// cpSync (assets/cycle/*.css, assets/fonts/*, assets/project.css,
// assets/cycle-mark*.svg). The M2 preview iframe serves the rendered HTML with a
// <base> pointing here, so pages look identical to the real site build.
// Gitignored / regenerated here + in CI.
//
//   node scripts/copy-site-assets.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DESIGN = path.join(REPO, 'vendor/cycle/site-gen/designs/cycle');
const PROJECT_CSS = path.join(REPO, 'vendor/cycle/site-gen/project/cycle.css');
const OUT = path.join(REPO, 'app/public/data/cycle/site-assets/assets');

if (!fs.existsSync(DESIGN)) {
  console.error('FATAL: vendor/cycle not checked out (run: git submodule update --init)');
  process.exit(2);
}

fs.rmSync(path.join(REPO, 'app/public/data/cycle/site-assets'), { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// build.tsx: cpSync(`${DESIGN}/styles`, `${OUT}/assets/cycle`) — tokens + base.css
fs.cpSync(path.join(DESIGN, 'styles'), path.join(OUT, 'cycle'), { recursive: true });
// cpSync(`${DESIGN}/fonts`, `${OUT}/assets/fonts`)
fs.cpSync(path.join(DESIGN, 'fonts'), path.join(OUT, 'fonts'), { recursive: true });
// cpSync(`${DESIGN}/assets`, `${OUT}/assets`) — cycle-mark*.svg
fs.cpSync(path.join(DESIGN, 'assets'), OUT, { recursive: true });
// cpSync(project.projectCss, `${OUT}/assets/project.css`)
fs.copyFileSync(PROJECT_CSS, path.join(OUT, 'project.css'));

const count = fs.readdirSync(OUT, { recursive: true }).filter((f) => fs.statSync(path.join(OUT, f)).isFile()).length;
console.log(`[copy-site-assets] ${count} design assets -> app/public/data/cycle/site-assets/assets/`);
