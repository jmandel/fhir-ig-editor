// Byte-check: the cycle resources the wasm engine compiles must be byte-identical
// to the native `rust_sushi build` output (spec §9 M1 gate; §11 wasm/native
// drift is prevented structurally). Runs the nodejs-target wasm module over the
// cycle sources and SHA-256-compares each resource against the native output dir.
//
//   node scripts/byte-check.mjs <wasm-nodejs-dir> <bundle-dir> <cycle-dir> <native-resources-dir>
//
// The in-memory compile path deliberately does NOT emit the ImplementationGuide
// (disk-only in the engine), so that one native file is expected-missing here.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const [WASM_DIR, BUNDLE_DIR, CYCLE_DIR, NATIVE_DIR] = process.argv
  .slice(2)
  .map((p) => path.resolve(p)); // absolute, so the dynamic import below isn't a bare specifier
const mod = await import(path.join(WASM_DIR, 'wasm_api.js'));

function untarGz(tgz) {
  const tar = zlib.gunzipSync(fs.readFileSync(tgz));
  const files = {};
  let off = 0;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    let name = '';
    for (let i = 0; i < 100 && h[i] !== 0; i++) name += String.fromCharCode(h[i]);
    if (name === '') break;
    let s = '';
    for (let i = 124; i < 136 && h[i] !== 0 && h[i] !== 0x20; i++) s += String.fromCharCode(h[i]);
    const size = parseInt(s.trim(), 8) || 0;
    const type = h[156];
    off += 512;
    const data = tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 0x30 || type === 0) files[name.replace(/^package\//, '')] = Buffer.from(data).toString('base64');
  }
  return files;
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const LABELS = [
  'hl7.fhir.r4.core#4.0.1',
  'hl7.fhir.uv.tools.r4#1.1.2',
  'hl7.terminology.r4#7.2.0',
  'hl7.fhir.uv.extensions.r4#5.3.0',
  'hl7.fhir.r5.core#5.0.0',
];
mod.init(JSON.stringify(LABELS.map((label) => ({ label, files: untarGz(path.join(BUNDLE_DIR, `${label}.tgz`)) }))));

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.includes(path.extname(e.name).slice(1).toLowerCase())) out.push(p);
  }
  return out.sort();
}
const config = fs.readFileSync(path.join(CYCLE_DIR, 'sushi-config.yaml'), 'utf8');
const files = {};
for (const f of walk(path.join(CYCLE_DIR, 'input/fsh'), ['fsh'])) files[path.relative(CYCLE_DIR, f)] = fs.readFileSync(f, 'utf8');
const predefined = {};
const resDir = path.join(CYCLE_DIR, 'input/resources');
if (fs.existsSync(resDir)) for (const f of walk(resDir, ['json'])) predefined[path.relative(CYCLE_DIR, f)] = JSON.parse(fs.readFileSync(f, 'utf8'));

const out = JSON.parse(mod.compile(JSON.stringify(files), config, JSON.stringify(predefined)));

let match = 0, diff = 0, miss = 0;
for (const r of out.resources) {
  const nativePath = path.join(NATIVE_DIR, r.filename);
  if (!fs.existsSync(nativePath)) { miss++; console.log(`  MISS  ${r.filename} (no native file)`); continue; }
  const nativeText = fs.readFileSync(nativePath, 'utf8');
  if (sha(nativeText) === sha(r.text)) match++;
  else { diff++; console.log(`  DIFF  ${r.filename}  native=${sha(nativeText).slice(0,12)} wasm=${sha(r.text).slice(0,12)}`); }
}
// Report native files the wasm did not emit (expected: the ImplementationGuide).
const nativeFiles = fs.readdirSync(NATIVE_DIR).filter((f) => f.endsWith('.json'));
const wasmNames = new Set(out.resources.map((r) => r.filename));
const onlyNative = nativeFiles.filter((f) => !wasmNames.has(f));

console.log(`\nwasm resources: ${out.resources.length}`);
console.log(`byte-identical: ${match} / ${out.resources.length}`);
console.log(`diffs: ${diff}, missing-native: ${miss}`);
console.log(`native-only (expected: ImplementationGuide): ${onlyNative.join(', ') || '(none)'}`);

const ok = diff === 0 && miss === 0 && onlyNative.every((f) => f.startsWith('ImplementationGuide-'));
console.log(ok ? '\nBYTE-CHECK GATE: PASS' : '\nBYTE-CHECK GATE: FAIL');
process.exit(ok ? 0 : 1);
