// Template-parity gate (#40): prove the LIVE template path (resolve→fetch→mount→
// mountTemplate) produces the SAME materialized tree as the packed warm-start
// artifact (`fig packages bundle --template`). Both come from the ONE engine
// loader (`package_store::template_loader::materialize`) — fig calls it natively,
// Session.mountTemplate calls it in-wasm — so the file COUNT and the CHAIN must
// agree exactly. This is the editor-side byte anchor for "pages rendered via the
// live-mounted template == the packed-artifact path": identical template trees ⇒
// identical page renders.
//
//   node scripts/template-parity.mjs <wasm-nodejs-dir> <bundle-dir> <template-artifact.json>
//
// <wasm-nodejs-dir>       — a wasm-bindgen --target nodejs build of wasm_api
//                           (scripts/wasm-parity.sh emits one at target/wasm-parity/pkg).
// <bundle-dir>            — app/public/data/bundles (has the repacked template chain tgz).
// <template-artifact.json>— the fig warm-start artifact (site-bundles/templates/…json).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [WASM_DIR, BUNDLE_DIR, ARTIFACT] = process.argv.slice(2).map((p) => path.resolve(p));
if (!WASM_DIR || !BUNDLE_DIR || !ARTIFACT) {
  console.error('usage: template-parity.mjs <wasm-nodejs-dir> <bundle-dir> <template-artifact.json>');
  process.exit(2);
}
const mod = await import(path.join(WASM_DIR, 'wasm_api.js'));

// Untar a gzipped bundle into { name: base64 } — mirrors the worker's inflate
// (strip the leading `package/` so BundleSource.mount_package re-roots it).
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

function unwrap(envJson, op) {
  const env = JSON.parse(envJson);
  if (!env.ok) throw new Error(`${op}: ${env.error?.message}`);
  return env.result;
}

// The template coord + its base chain (the fetch list the loader's walk decides;
// the editor walks it live — here we mount the whole chain up front, as the editor
// does after the walk, then mountTemplate materializes).
const artifact = JSON.parse(fs.readFileSync(ARTIFACT, 'utf8'));
const COORD = artifact.template;
const CHAIN = ['hl7.fhir.template#1.0.0', 'hl7.base.template#1.0.0', 'fhir.base.template#1.0.0'];

const session = mod.Session.global();
// Mount the whole template chain as bundle packages (the SAME path regular
// packages take), then materialize via mountTemplate.
const bundles = CHAIN.map((label) => ({ label, files: untarGz(path.join(BUNDLE_DIR, `${label}.tgz`)) }));
unwrap(session.init(JSON.stringify(bundles)), 'init');
const mt = unwrap(session.mountTemplate(COORD), 'mountTemplate');

// Package normalization now regenerates `.derived-index.json` in both hosts
// before template materialization. It is therefore present on both sides and
// must be counted symmetrically. (The old gate subtracted it only from Fig,
// producing a false 180-vs-179 failure after the normalizer became shared.)
const liveFiles = mt.files; // mountTemplate returns the complete merged tree count.
const packedFiles = artifact.fileCount;

console.log(`template:            ${COORD}`);
console.log(`chain:               ${CHAIN.join(' -> ')}`);
console.log(`live mountTemplate:  ${liveFiles} files`);
console.log(`packed fig artifact: ${packedFiles} files`);

const ok = liveFiles === packedFiles && liveFiles > 0;
console.log(ok ? '\nTEMPLATE-PARITY GATE: PASS' : '\nTEMPLATE-PARITY GATE: FAIL (live tree != packed tree)');
process.exit(ok ? 0 : 1);
