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
// Bundle .tgz fetches, in order — drives the lazy-loading gate (only the
// compile-critical bundles should be fetched before the first snapshot; r5.core
// must NOT appear until a snapshot/site build needs it).
const bundleFetches = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  }
  if (m.method === 'Network.requestWillBeSent') {
    const url = m.params.request.url;
    if (/\/data\/bundles\/.*\.tgz/.test(url)) {
      // Decode the bundle label from the (percent-encoded) filename.
      const file = decodeURIComponent(url.split('/data/bundles/')[1].split('?')[0]);
      bundleFetches.push({ file: file.replace(/\.tgz$/, ''), at: Date.now() });
    }
  }
});

await cdp(ws, 'Page.enable', {}, id);
await cdp(ws, 'Runtime.enable', {}, id);
await cdp(ws, 'Network.enable', {}, id);

const results = {};
function fail(msg) {
  console.error('FAIL:', msg);
  console.error('--- page logs ---\n' + logs.join('\n'));
  process.exit(1);
}

try {
  const t0 = Date.now();
  await cdp(ws, 'Page.navigate', { url: base }, id);

  // 0. Cold-start progress must be VISIBLE during startup (spec §1 gate). Poll
  //    for the startup progress bar + a staged message before the engine is
  //    ready. (On a very fast warm start this may be brief; we poll tightly.)
  results.progressSeen = false;
  {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const seen = await evalJs(
        ws,
        `(() => {
          const p = document.querySelector('.startup-progress');
          const ready = !!document.querySelector('.welcome-card button:not([disabled])');
          return { bar: !!(p && p.querySelector('.startup-bar-fill')),
                   msg: (p && p.querySelector('.startup-msg')?.textContent) || '',
                   ready };
        })()`,
      );
      if (seen.bar) {
        results.progressSeen = true;
        results.progressMsg = seen.msg;
      }
      if (seen.ready) break;
      await sleep(120);
    }
  }

  // 1. Wait for the engine to be ready (the "Open demo IG" button enables).
  await waitFor(
    ws,
    `!!document.querySelector('.welcome-card button:not([disabled])')`,
    90000,
    'engine ready',
  );
  results.engineReadyMs = Date.now() - t0;
  // Bundles fetched BEFORE the engine became ready = the eager (compile-critical)
  // set. r5.core (deferred) must NOT be among them (lazy-loading gate).
  results.eagerBundles = bundleFetches.map((b) => b.file);
  results.r5FetchedAtInit = bundleFetches.some((b) => /r5\.core/.test(b.file));

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
  // The deferred r5.core bundle should have been fetched LAZILY by now (the
  // snapshot needs it), i.e. it appeared only after init — the lazy-loading gate.
  results.r5FetchedLazily = bundleFetches.some((b) => /r5\.core/.test(b.file));

  // ---- ValueSet expansion tab (spec §6 tier 1) ----------------------------
  // Select the cycle IG's menstrual-flow ValueSet, open its Expansion tab, and
  // confirm tier-1 renders exactly 5 codes (the 5 local flow codes).
  const selectedMenstrual = await evalJs(ws, `(() => {
    const rows = [...document.querySelectorAll('.res-row')];
    const vs = rows.find(r => /menstrual-flow|MenstrualFlow/i.test(r.textContent) || /ValueSet/.test(r.querySelector('.res-type')?.textContent||'') && /menstrual/i.test(r.textContent));
    // Fallback: first ValueSet row.
    const target = vs || rows.find(r => /ValueSet/.test(r.querySelector('.res-type')?.textContent||''));
    if (!target) return 'no-vs-row';
    target.click();
    return target.textContent;
  })()`);
  results.selectedValueSet = selectedMenstrual;
  if (selectedMenstrual !== 'no-vs-row') {
    // Make sure we picked the menstrual-flow VS specifically (retry by scanning
    // all ValueSet rows for one whose expansion has 5 flow codes).
    await waitFor(ws, `[...document.querySelectorAll('.inspector-tabs .tab-btn')].some(b => /Expansion/.test(b.textContent))`, 15000, 'expansion tab present');
    await evalJs(ws, `[...document.querySelectorAll('.inspector-tabs .tab-btn')].find(b => /Expansion/.test(b.textContent))?.click()`);
    // Ensure the specific menstrual-flow VS is selected (scan rows if needed).
    await evalJs(ws, `(() => {
      const rows = [...document.querySelectorAll('.res-row')];
      const vs = rows.find(r => /menstrual/i.test(r.textContent));
      if (vs) vs.click();
    })()`);
    await sleep(300);
    await evalJs(ws, `[...document.querySelectorAll('.inspector-tabs .tab-btn')].find(b => /Expansion/.test(b.textContent))?.click()`);
    await waitFor(ws, `!!document.querySelector('.vs-contains tbody tr') || !!document.querySelector('.vs-refusal')`, 20000, 'expansion rendered');
    results.menstrualFlowExpansion = await evalJs(ws, `(() => {
      const rows = document.querySelectorAll('.vs-contains tbody tr');
      const codes = [...rows].map(r => r.querySelector('.vs-code')?.textContent?.replace(/inactive$/,'').trim());
      const used = [...document.querySelectorAll('.vs-used li code')].map(c => c.textContent);
      const ok = !!document.querySelector('.vs-ok-badge');
      return { count: rows.length, codes, used, tier1Ok: ok };
    })()`);
  }

  // ---- external-filter refusal state (spec §6 tier 1 boundary) ------------
  // Inject a ValueSet whose compose is an external-system filter (SNOMED is-a) —
  // tier-1 must REFUSE and the "needs terminology server" state must appear with
  // the refusal verbatim. We add it to ValueSets.fsh via Monaco.
  const injectedRefusal = await evalJs(ws, `(async () => {
    // Open ValueSets.fsh in the file tree.
    const leaves = [...document.querySelectorAll('.file-tree *')].filter(e => e.children.length === 0);
    const row = leaves.find(e => (e.textContent||'').replace(/[^\\x20-\\x7e]/g,'').trim() === 'ValueSets.fsh');
    if (!row) return 'no-valuesets-file';
    (row.closest('[class*=row]') || row).click();
    await new Promise(r => setTimeout(r, 400));
    const ed = window.monaco && window.monaco.editor.getEditors()[0];
    if (!ed) return 'no-editor';
    const m = ed.getModel();
    const vs = [
      '',
      'ValueSet: E2EExternalFilterVS',
      'Id: e2e-external-filter',
      'Title: "E2E External Filter"',
      '* include codes from system http://snomed.info/sct where concept is-a #73211009',
      ''
    ].join('\\n');
    m.setValue(m.getValue() + vs);
    return 'ok';
  })()`);
  results.injectedRefusal = injectedRefusal;
  if (injectedRefusal === 'ok') {
    // Wait for the recompile, then select the new VS + open its Expansion tab.
    await sleep(1500);
    const pickedRefusalVs = await evalJs(ws, `(() => {
      const rows = [...document.querySelectorAll('.res-row')];
      const vs = rows.find(r => /e2e-external-filter|E2EExternalFilter/i.test(r.textContent));
      if (!vs) return 'no-row';
      vs.click();
      return 'ok';
    })()`);
    results.pickedRefusalVs = pickedRefusalVs;
    if (pickedRefusalVs === 'ok') {
      await evalJs(ws, `[...document.querySelectorAll('.inspector-tabs .tab-btn')].find(b => /Expansion/.test(b.textContent))?.click()`);
      await waitFor(ws, `!!document.querySelector('.vs-refusal')`, 20000, 'refusal state');
      results.refusalState = await evalJs(ws, `(() => {
        const r = document.querySelector('.vs-refusal');
        if (!r) return null;
        return {
          badge: r.querySelector('.vs-refusal-badge')?.textContent || '',
          kind: r.querySelector('.vs-refusal-kind')?.textContent || '',
          reason: r.querySelector('.vs-refusal-reason')?.textContent || '',
        };
      })()`);
    }
    // Clean the injected VS back out so the site preview + later steps are clean.
    await evalJs(ws, `(() => {
      const ed = window.monaco && window.monaco.editor.getEditors()[0];
      if (!ed) return;
      const m = ed.getModel();
      m.setValue(m.getValue().replace(/\\n*ValueSet: E2EExternalFilterVS[\\s\\S]*$/, '\\n'));
    })()`);
    await sleep(1200);
    // Re-select an SD so the later snapshot/preview steps have their default.
    await evalJs(ws, `(() => { const r = [...document.querySelectorAll('.res-row')].find(r => /StructureDefinition/.test(r.querySelector('.res-type')?.textContent||'')); if (r) r.click(); })()`);
  }

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

  // ---- M2 site preview (spec §7 / gate ii) --------------------------------
  // Undo the broken FSH so the site rebuilds cleanly, then open the Preview tab.
  await evalJs(ws, `(() => {
    const ed = window.monaco && window.monaco.editor.getEditors()[0];
    if (!ed) return 'no-editor';
    const m = ed.getModel();
    m.setValue(m.getValue().replace(/\\n\\nProfile: E2EBroken[\\s\\S]*$/, ''));
    return 'ok';
  })()`);
  // Wait for the clean recompile to clear diagnostics.
  await waitFor(ws, `document.querySelectorAll('.diag').length === 0`, 30000, 'clean recompile');

  // Click the "Site preview" tab.
  await waitFor(ws, `[...document.querySelectorAll('.inspect-tab')].some(b => /Site preview/.test(b.textContent))`, 15000, 'preview tab present');
  await evalJs(ws, `[...document.querySelectorAll('.inspect-tab')].find(b => /Site preview/.test(b.textContent)).click()`);

  // Wait for the preview iframe to render the index page (a real IG page).
  await waitFor(ws, `!!document.querySelector('.preview-frame')`, 30000, 'preview iframe');
  const frameHasContent = `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    if (!doc || !doc.body) return 0;
    return doc.body.textContent.length;
  })()`;
  await waitFor(ws, `${frameHasContent} > 200`, 30000, 'preview page rendered');
  results.previewTextLen = await evalJs(ws, frameHasContent);
  results.previewTitle = await evalJs(ws, `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    return doc ? (doc.querySelector('h1,h2')?.textContent || doc.title || '') : '';
  })()`);
  // The index page should mention the IG's subject matter ("Period Tracking").
  results.previewHasIgContent = await evalJs(ws, `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    return doc ? /Period Tracking/i.test(doc.body.textContent) : false;
  })()`);

  // Switch to a PROFILE page and confirm it renders an element table.
  results.hasProfileOption = await evalJs(ws, `!!document.querySelector('.preview-page-select select optgroup[label="Profiles"] option')`);
  if (results.hasProfileOption) {
    await evalJs(ws, `(() => {
      const sel = document.querySelector('.preview-page-select select');
      const opt = sel.querySelector('optgroup[label="Profiles"] option');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    })()`);
    await waitFor(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return doc && /StructureDefinition|Formal definition|Overview/i.test(doc.body.textContent);
    })()`, 30000, 'profile page rendered');
    results.profilePageLen = await evalJs(ws, frameHasContent);
  }

  // ---- Edit a title in the IG source -> preview updates (the demo's goal) --
  // Switch the preview back to the index page (its <title>/heading reflects the
  // IG title from sushi-config). Then edit the IG `title:` in sushi-config.yaml —
  // a robust, unambiguous source edit that flows through compile -> site.db ->
  // rendered page.
  await evalJs(ws, `(() => {
    const sel = document.querySelector('.preview-page-select select');
    if (sel) { sel.value = 'index.html'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await sleep(500);
  // Open input/pagecontent/index.md from the file tree (click the leaf row whose
  // text is exactly the file name), then rewrite its `# ` H1 — this drives the
  // rendered index page's title + heading, an unambiguous source-edit-to-preview link.
  const editTitle = await evalJs(ws, `(async () => {
    const leaves = [...document.querySelectorAll('.file-tree *')].filter(e => e.children.length === 0);
    const row = leaves.find(e => (e.textContent||'').replace(/[^\\x20-\\x7e]/g,'').trim() === 'index.md');
    if (!row) return 'no-index-row';
    (row.closest('[class*=row]') || row).click();
    await new Promise(r => setTimeout(r, 500));
    const ed = window.monaco && window.monaco.editor.getEditors()[0];
    if (!ed) return 'no-editor';
    const m = ed.getModel();
    const v = m.getValue();
    if (!/^# /m.test(v)) return 'model-not-index:' + v.slice(0, 40);
    m.setValue(v.replace(/^# .*/m, '# E2E Preview Title Changed'));
    return 'ok';
  })()`);
  results.editTitleResult = editTitle;
  if (editTitle === 'ok') {
    await waitFor(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      // The IG title flows to the Layout <title> and the index page heading.
      return doc && (/E2E Preview Title Changed/.test(doc.title) || /E2E Preview Title Changed/.test(doc.body.textContent));
    })()`, 30000, 'preview reflects edited title');
    results.previewUpdatedAfterEdit = true;
  }

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
  // M2 preview assertions.
  if (!(results.previewTextLen > 200)) { console.error('assert: preview page did not render'); ok = false; }
  if (!results.previewHasIgContent) { console.error('assert: preview missing IG content'); ok = false; }
  if (results.editTitleResult === 'ok' && !results.previewUpdatedAfterEdit) { console.error('assert: preview did not update after FSH/page edit'); ok = false; }

  // ---- cold-start progress + lazy-loading gates (spec §1) ----------------
  if (!results.progressSeen) { console.error('assert: cold-start progress bar never appeared'); ok = false; }
  // r5.core (deferred) must NEVER be fetched at init, on cold OR warm start.
  if (results.r5FetchedAtInit) { console.error('assert: r5.core was fetched at init (should be lazy/deferred)'); ok = false; }
  // On a COLD start the eager set is fetched over the network and excludes
  // r5.core; on a WARM start (OPFS cache populated) NOTHING is fetched — both are
  // correct. So: if any eager bundle was fetched, it must exclude r5.core (checked
  // via r5FetchedAtInit above); r5.core is fetched lazily only once a snapshot
  // needs it. A warm start (0 eager fetches) is explicitly allowed.
  results.warmStart = (results.eagerBundles || []).length === 0;
  if (!results.warmStart && results.eagerBundles.some((b) => /r5\.core/.test(b))) {
    console.error('assert: r5.core appeared in the eager set'); ok = false;
  }
  // r5FetchedLazily is a cold-start signal (warm start serves it from cache with
  // no network); only assert it when we actually saw a cold fetch of eager bundles.
  if (!results.warmStart && !results.r5FetchedLazily) {
    console.error('assert: r5.core was never fetched on a cold start (snapshot needs it — lazy mount failed?)'); ok = false;
  }

  // ---- ValueSet expansion tab gate (spec §6 tier 1) ----------------------
  const mfx = results.menstrualFlowExpansion;
  if (!mfx || !mfx.tier1Ok) { console.error('assert: menstrual-flow VS did not tier-1 expand'); ok = false; }
  else if (mfx.count !== 5) { console.error('assert: menstrual-flow expansion expected 5 codes, got ' + mfx.count); ok = false; }

  // ---- external-filter refusal gate (spec §6 boundary) -------------------
  if (results.injectedRefusal === 'ok') {
    if (!results.refusalState) { console.error('assert: external-filter VS did not show refusal state'); ok = false; }
    else if (!/snomed/i.test(results.refusalState.reason)) { console.error('assert: refusal reason did not name the external system: ' + results.refusalState.reason); ok = false; }
  }
  console.log(ok ? '\nE2E GATE: PASS' : '\nE2E GATE: FAIL');
  if (!ok) fail('assertions failed');
} catch (e) {
  fail(String(e));
}

ws.close();
process.exit(0);
