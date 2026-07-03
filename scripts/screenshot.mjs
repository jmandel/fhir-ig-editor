// Capture a screenshot of the running app (after opening the demo IG) via CDP.
const base = process.argv[2] || 'http://localhost:4173/';
const out = process.argv[3] || 'screenshot.png';
import fs from 'node:fs';
const id = { n: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = id.n++;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === msgId) { ws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
async function evalJs(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result.value;
}
const targets = await (await fetch('http://localhost:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));
await cdp(ws, 'Page.enable');
await cdp(ws, 'Runtime.enable');
await cdp(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cdp(ws, 'Page.navigate', { url: base });
// wait for engine + open demo + compile + snapshot
for (let i = 0; i < 200; i++) { if (await evalJs(ws, `!!document.querySelector('.welcome-card button:not([disabled])')`)) break; await sleep(300); }
await evalJs(ws, `document.querySelector('.welcome-card button').click()`);
for (let i = 0; i < 100; i++) { if (await evalJs(ws, `!!document.querySelector('.snapshot .sd-table tbody tr')`)) break; await sleep(300); }
await sleep(800);
const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('wrote ' + out);
ws.close();
process.exit(0);
