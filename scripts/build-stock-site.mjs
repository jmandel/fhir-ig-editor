// Pack the cycle IG's publisher-staged site tree into the stock-template
// adapter's site bundle (app/public/data/sites/cycle-stock.json), in
// Session.mountSite files-JSON form: { "<rel path>": "<text>" | {"b64": ...} }.
//
// Contents: the en content pages (dumps excluded), the TRANSITIVE static
// include closure those pages reach (template scripts + fragment dumps the
// engine can't yet regenerate — engine-first shadows the ones it can), _data,
// assets, and the tx cache. The engine's first-include-miss store serves every
// registered fragment kind LIVE from the current compile; the packed copies
// are the fallback for gap kinds (e.g. instance -html narrative, F4b).
//
//   node scripts/build-stock-site.mjs /path/to/cycle-build app/public/data/sites/cycle-stock.json
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
const OUT = process.argv[3] || 'app/public/data/sites/cycle-stock.json';
// FLAT layouts (us-core): pages at temp/pages ROOT, keys without an en/ prefix.
const FLAT = process.argv.includes('--flat');
// --exclude-live-kinds: DON'T pack fragment includes for kinds the engine
// regenerates live (engine-first shadows a packed copy anyway; leaving them
// out keeps large bundles honest AND small). Names: {ref}-{kind}[-en].xhtml
// for the byte-proven per-resource + singleton kind lists (render_sd
// engine.rs PER_RESOURCE_KINDS/SINGLETON_KINDS). Kinds the engine does NOT
// produce (e.g. -html instance narrative, F4b; uml) still pack — they only
// exist as staged copies.
const EXCLUDE_LIVE = process.argv.includes('--exclude-live-kinds');
const LIVE_KINDS = new Set(('snapshot-by-mustsupport-all snapshot-by-mustsupport snapshot-by-key-all snapshot-by-key ' +
  'snapshot-obligations-all snapshot-obligations snapshot-bindings-all snapshot-bindings snapshot-all snapshot ' +
  'diff-obligations-all diff-obligations diff-bindings-all diff-bindings diff-all diff grid spanall span ' +
  'contained-index history pseudo-ttl pseudo-xml pseudo-json inv-key inv-diff inv sd-use-context ' +
  'tx-diff-must-support tx-must-support tx-diff tx-key tx dict-active dict-diff dict-ms dict-key dict ' +
  'summary-all summary uses sd-xref maps cld expansion content new-extensions related-igs-table related-igs-list ' +
  'globals-table obligation-summary deleted-extensions cross-version-analysis-inline cross-version-analysis ' +
  'valueset-list summary-extensions summary-observations deprecated-list expansion-params codesystem-list ' +
  'canonical-index ip-statements dependency-table-nontech dependency-table-short dependency-table ' +
  'valueset-ref-all-list valueset-ref-list codesystem-ref-all-list codesystem-ref-list').split(' '));
function isLiveKindInclude(name) {
  const base = name.replace(/\.xhtml$/, '').replace(/-en$/, '');
  // singleton kinds are the whole name; per-resource kinds are a suffix after
  // {Type}-{id}-; match longest-suffix against the kind set.
  if (LIVE_KINDS.has(base)) return true;
  for (const k of LIVE_KINDS) {
    if (base.endsWith('-' + k)) return true;
  }
  return false;
}
if (!SRC) { console.error('usage: build-stock-site.mjs <cycle build root> [out.json]'); process.exit(2); }
const PAGES = path.join(SRC, 'temp/pages');
const INC = path.join(PAGES, '_includes');

const out = {};
const putText = (rel, abs) => { out[rel] = fs.readFileSync(abs, 'utf8'); };
const put = (rel, abs) => {
  const bytes = fs.readFileSync(abs);
  const text = bytes.toString('utf8');
  out[rel] = Buffer.from(text, 'utf8').equals(bytes) ? text : { b64: bytes.toString('base64') };
};

// 1. en content pages (skip source dumps + change-history).
const isDump = (f) => /\.(json|ttl|xml)\.html$/.test(f) || /\.change\.history\.html$/.test(f);
const pageDir = FLAT ? PAGES : path.join(PAGES, 'en');
const pagePrefix = FLAT ? '' : 'en/';
const pages = fs.readdirSync(pageDir).filter((f) => {
  const p = path.join(pageDir, f);
  return f.endsWith('.html') && !isDump(f) && fs.statSync(p).isFile();
});
for (const f of pages) putText(`${pagePrefix}${f}`, path.join(pageDir, f));

// 2. transitive static include closure from those pages.
const incRe = /{%-?\s*include\s+("[^"]+"|'[^']+'|\S+)/g;
const seen = new Set();
const frontier = [];
const scan = (text) => {
  for (const m of text.matchAll(incRe)) {
    const name = m[1].replace(/^['"]|['"]$/g, '');
    if (name.includes('{{')) continue; // dynamic -> engine fragment kinds
    if (!seen.has(name)) { seen.add(name); frontier.push(name); }
  }
};
for (const f of pages) scan(out[`${pagePrefix}${f}`]);
while (frontier.length) {
  const name = frontier.pop();
  for (const [rel, abs] of [[`_includes/${name}`, path.join(INC, name)], [`_includes/en/${name}`, path.join(INC, 'en', name)]]) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      if (EXCLUDE_LIVE && name.endsWith('.xhtml') && isLiveKindInclude(name)) break;
      put(rel, abs);
      const v = out[rel];
      if (typeof v === 'string') scan(v);
      break;
    }
  }
}

// 3. _data + assets + txcache.
const walk = (dir, relBase) => {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    const rel = `${relBase}/${e.name}`;
    if (e.isDirectory()) walk(abs, rel);
    else put(rel, abs);
  }
};
walk(path.join(PAGES, '_data'), '_data');
walk(path.join(PAGES, 'assets'), 'assets');
// tx cache: ONLY the externals indexes + the expansion files they reference —
// the Java tx-client's *.cache logs are fhir-core internals the renderer
// never reads (loinc.cache alone is ~19 MB).
const txdir = path.join(SRC, 'input-cache/txcache');
if (fs.existsSync(txdir)) {
  const wanted = new Set(['vs-externals.json', 'cs-externals.json']);
  for (const idx of ['vs-externals.json', 'cs-externals.json']) {
    const f = path.join(txdir, idx);
    if (!fs.existsSync(f)) continue;
    const map = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const entry of Object.values(map)) {
      if (entry && entry.filename) wanted.add(entry.filename);
    }
  }
  for (const name of [...wanted].sort()) {
    const f = path.join(txdir, name);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) put(`txcache/${name}`, f);
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`packed ${Object.keys(out).length} files (${pages.length} pages, ${seen.size} include names) -> ${OUT} (${mb} MB)`);
