// End-to-end verification of the built app under headless Chromium via raw CDP.
// Drives the M1 loop (spec §9): open demo IG -> compile roundtrip -> introduce an
// FSH error -> observe a diagnostic with the right file/line -> snapshot tree for
// one profile. Prints timings + a PASS/FAIL summary.
//
//   node scripts/verify-e2e.mjs http://localhost:4173/
//
// Requires headless chromium already running with --remote-debugging-port=9222.

const base = process.argv[2] || 'http://localhost:4173/';

async function cdp(ws, method, params = {}, id = { n: 1 }) {
  return new Promise((resolve, reject) => {
    const msgId = id.n++;
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === msgId) {
        ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}
const id = { n: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalJs(ws, expression) {
  const r = await cdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, id);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression.slice(0, 80));
  return r.result.value;
}
async function waitFor(ws, expr, timeoutMs = 60000, label = expr) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await evalJs(ws, expr);
    if (v) return v;
    await sleep(300);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

// find page target
let targets;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch('http://localhost:9222/json')).json();
    if (targets.find((t) => t.type === 'page')) break;
  } catch {
    /* retry */
  }
  await sleep(250);
}
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => ws.addEventListener('open', res));

// Capture console + page errors for debugging.
const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
});

await cdp(ws, 'Page.enable', {}, id);
await cdp(ws, 'Runtime.enable', {}, id);

const results = {};
function fail(msg) {
  console.error('FAIL:', msg);
  console.error('--- page logs ---\n' + logs.join('\n'));
  process.exit(1);
}

try {
  const t0 = Date.now();
  await cdp(ws, 'Page.navigate', { url: base }, id);

  // 1. Wait for the engine to be ready (the "Open demo IG" button enables).
  await waitFor(
    ws,
    `!!document.querySelector('.welcome-card button:not([disabled])')`,
    90000,
    'engine ready',
  );
  results.engineReadyMs = Date.now() - t0;

  // Capture the engine version shown.
  results.engineLabel = await evalJs(ws, `document.querySelector('.welcome-engine')?.textContent || ''`);

  // 2. Click "Open demo IG".
  await evalJs(ws, `document.querySelector('.welcome-card button').click()`);

  // 3. Wait for compile to finish (build status shows a ms value + resources).
  await waitFor(ws, `!!document.querySelector('.res-row')`, 60000, 'compiled resources');
  await sleep(400);
  results.resourceCount = await evalJs(ws, `document.querySelectorAll('.res-row').length`);
  results.buildMs = await evalJs(
    ws,
    `(document.querySelectorAll('.bs-val')[2]?.textContent||'').trim()`,
  );
  results.cleanDiagnostics = await evalJs(ws, `document.querySelectorAll('.diag').length`);

  // 4. Snapshot tree renders for the default-selected profile.
  await waitFor(ws, `!!document.querySelector('.snapshot .sd-table tbody tr')`, 30000, 'snapshot tree');
  results.snapshotRows = await evalJs(ws, `document.querySelectorAll('.snapshot .sd-table tbody tr').length`);
  results.snapshotMeta = await evalJs(ws, `document.querySelector('.snapshot-meta')?.textContent || ''`);

  // 5. Introduce an FSH error: select an FSH file, set its Monaco model text to
  //    something with an unresolvable insert rule, and let the debounced compile run.
  //    We use Monaco's API via the global editor instance registered by the app.
  const inject = `(async () => {
    // Find the Monaco editor instance holding an .fsh model and append a broken profile.
    const ed = (window.monaco && window.monaco.editor.getEditors && window.monaco.editor.getEditors()[0]);
    if (!ed) return 'no-editor';
    const model = ed.getModel();
    const broken = model.getValue() + "\\n\\nProfile: E2EBroken\\nParent: Observation\\nId: e2e-broken\\n* insert NoSuchRuleSet\\n";
    model.setValue(broken);
    return 'ok';
  })()`;
  const injected = await evalJs(ws, inject);
  if (injected !== 'ok') fail('could not inject broken FSH: ' + injected + ' (monaco global missing?)');

  // 6. Wait for a diagnostic mentioning the missing ruleset.
  await waitFor(
    ws,
    `[...document.querySelectorAll('.diag-msg')].some(e => e.textContent.includes('Unable to find definition for RuleSet NoSuchRuleSet'))`,
    30000,
    'error diagnostic',
  );
  results.brokenDiagnostic = await evalJs(
    ws,
    `(() => {
      const el = [...document.querySelectorAll('.diag')].find(d => d.textContent.includes('NoSuchRuleSet'));
      if (!el) return null;
      return { msg: el.querySelector('.diag-msg')?.textContent, loc: el.querySelector('.diag-loc')?.textContent };
    })()`,
  );
  results.brokenDiagCount = await evalJs(ws, `document.querySelectorAll('.diag').length`);

  console.log(JSON.stringify(results, null, 2));

  // assertions
  let ok = true;
  if (results.resourceCount < 5) { console.error('assert: too few resources'); ok = false; }
  if (results.cleanDiagnostics !== 0) { console.error('assert: clean IG had diagnostics'); ok = false; }
  if (results.snapshotRows < 10) { console.error('assert: snapshot tree too small'); ok = false; }
  if (!results.brokenDiagnostic) { console.error('assert: no broken diagnostic'); ok = false; }
  else if (!/e2e-broken|Broken\.fsh|\.fsh/.test(results.brokenDiagnostic.loc || '')) {
    // location should reference the edited fsh file
    console.error('assert: diagnostic missing fsh location:', results.brokenDiagnostic.loc); ok = false;
  }
  console.log(ok ? '\nE2E GATE: PASS' : '\nE2E GATE: FAIL');
  if (!ok) fail('assertions failed');
} catch (e) {
  fail(String(e));
}

ws.close();
process.exit(0);
