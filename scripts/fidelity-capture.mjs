// Render-fidelity capture: open the built app in headless Chromium, open the
// demo IG, build the site, render EVERY preview page through the worker, and
// write {file -> html} JSON. Run before and after a renderer change; the gate
// is byte-identity (the demo IG's build timestamp is a fixed epoch, so outputs
// are deterministic).
//
//   node scripts/fidelity-capture.mjs http://localhost:4173/ out.json
//
// Requires headless chromium on --remote-debugging-port=9222.
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'fidelity.json';

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
if (!page) throw new Error('no chromium page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let n = 1;
const pend = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = n++;
    pend.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('page threw: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: base });

// Cold profile: wait for the welcome card and open the demo IG. Warm profile
// (persisted project): the app opens it automatically — no card to click.
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  if (await ev(`!!document.querySelector('.welcome-card button:not([disabled])')`)) break;
  if (await ev(`!document.querySelector('.welcome-card') && !!window.__igDebug`)) break;
}
await ev(`(() => { const b=[...document.querySelectorAll('.welcome-card button')].find(x=>!x.disabled); if (b) b.click(); return true; })()`);

// site build done = buildSite resolves; poll via a probe render of index.html
let pages = null;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  pages = await ev(`(async () => {
    const d = window.__igDebug; if (!d) return null;
    try { const r = await d.engine.buildSite === undefined ? null : null; } catch {}
    return null;
  })()`);
  // The engine holds lastRows only after the app's own buildSite; ask the app-built list:
  pages = await ev(`(() => {
    const sel = document.querySelector('.preview-page-select select');
    return sel ? [...sel.querySelectorAll('option')].map(o => o.value) : null;
  })()`);
  if (pages && pages.length) break;
  // switch to preview tab so the pane mounts
  await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/Site preview/i.test(x.textContent)); b&&b.click(); return !!b; })()`);
}
if (!pages || !pages.length) throw new Error('no page list');

const result = {};
for (const file of pages) {
  const html = await ev(`window.__igDebug.engine.renderPage(${JSON.stringify(file)}).then(r => r.html)`);
  result[file] = html;
}
fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(`captured ${Object.keys(result).length} pages -> ${out}`);
process.exit(0);
