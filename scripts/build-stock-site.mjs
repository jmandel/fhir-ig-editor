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
const pages = fs.readdirSync(path.join(PAGES, 'en')).filter((f) => f.endsWith('.html') && !isDump(f));
for (const f of pages) putText(`en/${f}`, path.join(PAGES, 'en', f));

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
for (const f of pages) scan(out[`en/${f}`]);
while (frontier.length) {
  const name = frontier.pop();
  for (const [rel, abs] of [[`_includes/${name}`, path.join(INC, name)], [`_includes/en/${name}`, path.join(INC, 'en', name)]]) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
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
walk(path.join(SRC, 'input-cache/txcache'), 'txcache');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
const mb = (fs.statSync(OUT).size / 1e6).toFixed(1);
console.log(`packed ${Object.keys(out).length} files (${pages.length} pages, ${seen.size} include names) -> ${OUT} (${mb} MB)`);
