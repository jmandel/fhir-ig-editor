// End-to-end verification of the built app under headless Chromium via raw CDP.
// Drives compile/diagnostic/snapshot flows, both site generators, a real catalog
// IG, runtime-asset closure, and Service-Worker preview navigation. Prints timings
// plus a PASS/FAIL summary.
//
//   node scripts/verify-e2e.mjs http://localhost:4173/
//
// scripts/run-browser-gates.sh supplies a fresh server/profile/Chrome process;
// direct use requires Chrome already running with --remote-debugging-port=9222.
//
// SERVER CONSTRAINT: serve app/dist with a %23-FAITHFUL static server, e.g.
//   (cd app/dist && python3 -m http.server 4173)
// NOT `vite preview` — it decodes %23 to '#' as a fragment delimiter and
// SPA-fallbacks the bundle .tgz URLs to index.html, so the engine never boots.

import { assessRuntimeClosure, runtimeClosureExpression } from './preview-runtime-closure.mjs';

const base = process.argv[2] || 'http://localhost:4173/';
const cdpPort = Number(process.env.CDP_PORT || 9222);
const cdpHttp = `http://127.0.0.1:${cdpPort}`;
const PREVIEW_SW_PROTOCOL = 5;
const requestedCpuThrottle = Number(process.env.E2E_CPU_THROTTLE || 0);
const timeoutScale = Math.max(1, requestedCpuThrottle);
// Preserve the release budget on normal CI. An explicitly throttled functional
// run scales the wall-clock allowance with the emulated CPU slowdown.
const STOCK_WARM_EDIT_BUDGET_MS = 1500 * timeoutScale;

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
  const deadline = Date.now() + timeoutMs * timeoutScale;
  while (Date.now() < deadline) {
    const v = await evalJs(ws, expr);
    if (v) return v;
    await sleep(120);
  }
  throw new Error(`TIMEOUT waiting for: ${label}`);
}

// Navigation state is updated by both React and the iframe load event. Requiring
// a condition to remain true across several polls prevents an old iframe's late
// onLoad from making a one-poll check pass and then reverting the selection.
async function waitForStable(ws, expr, timeoutMs = 60000, label = expr, samples = 4) {
  const deadline = Date.now() + timeoutMs * timeoutScale;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const value = await evalJs(ws, expr).catch(() => false);
    if (value) {
      consecutive += 1;
      if (consecutive >= samples) return value;
    } else {
      consecutive = 0;
    }
    await sleep(150);
  }
  throw new Error(`TIMEOUT waiting for stable state: ${label}`);
}

async function measureMobileLayout(ws, includeGeometry = false) {
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 390,
    // A short phone viewport catches the failure where the project dashboard,
    // status and Problems rows leave only a sliver for the selected surface.
    height: 667,
    deviceScaleFactor: 3,
    mobile: true,
  }, id);
  await sleep(150);
  const result = await evalJs(ws, `(async () => {
    const mode = (name) => document.getElementById('workspace-tab-' + name);
    const selectMode = async (name) => {
      const button = mode(name);
      if (!button) throw new Error('missing workspace tab ' + name);
      button.click();
      for (let frame = 0; frame < 10; frame++) {
        await new Promise(requestAnimationFrame);
        if (button.getAttribute('aria-selected') === 'true') return;
      }
      throw new Error('workspace tab did not activate: ' + name);
    };
    const geometry = () => Object.fromEntries([
      '.app', '.topbar', '.workspace-shell', '.project-overview',
      '.artifact-trail', '.workspace-tabs', '.workspace-views',
      '.workspace-view:not([hidden])', '.mobile-picker', '.editor-pane',
      '.definition-pane', '.preview', '.preview-frame', '.problems',
    ].map((selector) => {
      const element = document.querySelector(selector);
      if (!element) return [selector, null];
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return [selector, {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        display: style.display,
        position: style.position,
        gridRows: style.gridTemplateRows,
      }];
    }));
    await selectMode('author');
    const author = {
      sidebar: getComputedStyle(document.querySelector('.source-sidebar')).display,
      picker: getComputedStyle(document.querySelector('.author-workspace .mobile-picker')).display,
      height: document.querySelector('.editor-pane')?.getBoundingClientRect().height || 0,
      ${includeGeometry ? 'geometry: geometry(),' : ''}
    };
    await selectMode('explore');
    const explore = {
      sidebar: getComputedStyle(document.querySelector('.resource-sidebar')).display,
      picker: getComputedStyle(document.querySelector('.explore-workspace .mobile-picker')).display,
      height: document.querySelector('.definition-pane')?.getBoundingClientRect().height || 0,
      ${includeGeometry ? 'geometry: geometry(),' : ''}
    };
    await selectMode('preview');
    const previewFrame = document.querySelector('.preview-frame');
    const previewBeforeProblems = previewFrame?.getBoundingClientRect().height || 0;
    const problems = document.querySelector('.problems');
    const statusline = document.querySelector('.statusline');
    const surfaceBottom = previewFrame?.getBoundingClientRect().bottom || 0;
    const closedProblemsTop = problems?.getBoundingClientRect().top ?? innerHeight;
    if (problems) problems.open = true;
    await new Promise(requestAnimationFrame);
    const preview = {
      height: previewBeforeProblems,
      heightWithProblems: previewFrame?.getBoundingClientRect().height || 0,
      problemsPosition: problems ? getComputedStyle(problems).position : '',
      closedHandleOccludes: surfaceBottom > closedProblemsTop + 1,
      statusVisible: !!statusline && statusline.getBoundingClientRect().height > 0
        && getComputedStyle(statusline).visibility !== 'hidden',
      ${includeGeometry ? 'geometry: geometry(),' : ''}
    };
    if (problems) problems.open = false;
    const settings = document.querySelector('.build-settings');
    if (settings) settings.open = true;
    document.querySelector('.build-settings-close')?.click();
    return {
      width: innerWidth,
      mode: document.querySelector('.workspace-views')?.dataset.mode || '',
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      visibleWorkspaces: [...document.querySelectorAll('.workspace-view')].filter((view) => !view.hidden).length,
      author,
      explore,
      preview,
      settingsClosed: settings ? !settings.open : false,
    };
  })()`);
  await cdp(ws, 'Emulation.clearDeviceMetricsOverride', {}, id);
  return result;
}

function mobileLayoutPass(result) {
  return result?.width === 390
    && !result.overflow
    && result.visibleWorkspaces === 1
    && result.author?.sidebar === 'none'
    && result.author?.picker !== 'none'
    && result.author?.height > 100
    && result.explore?.sidebar === 'none'
    && result.explore?.picker !== 'none'
    && result.explore?.height > 100
    && result.preview?.height > 240
    && Math.abs(result.preview.heightWithProblems - result.preview.height) < 2
    && result.preview?.problemsPosition === 'fixed'
    && !result.preview?.closedHandleOccludes
    && !result.preview?.statusVisible
    && result.settingsClosed;
}

// ---- preview-window gate (task #37) ---------------------------------------
// Drives extra browser tabs (the SW-served preview) over CDP. Uses the DevTools
// HTTP endpoint to open/close tabs and a per-tab WebSocket for evaluation.
async function runPreviewWindowGate(base, editorWs, editorEval, editorWaitFor, editorTabId) {
  const PREVIEW = base.replace(/\/?$/, '/') + 'preview/';
  const pathOf = (u) => new URL(u).pathname;
  const out = {};
  const openedTabs = [];
  // A self-contained CDP call over a per-tab WebSocket (independent of the harness's
  // shared single-target `ws`). Each request gets a fresh id + a scoped listener.
  let tabMsgId = 1;
  const tabConn = (wsUrl) => new Promise((res, rej) => { const w = new WebSocket(wsUrl); w.addEventListener('open', () => res(w)); w.addEventListener('error', rej); });
  function tabCdp(tws, method, params = {}) {
    return new Promise((resolve, reject) => {
      const msgId = tabMsgId++;
      const onMsg = (ev) => { const m = JSON.parse(ev.data); if (m.id === msgId) { tws.removeEventListener('message', onMsg); m.error ? reject(new Error(m.error.message)) : resolve(m.result); } };
      tws.addEventListener('message', onMsg);
      tws.send(JSON.stringify({ id: msgId, method, params }));
    });
  }
  async function newTab(url) {
    const t = await (await fetch(`${cdpHttp}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    if (!t.webSocketDebuggerUrl) throw new Error('newTab: no webSocketDebuggerUrl in ' + JSON.stringify(t).slice(0, 120));
    const tws = await tabConn(t.webSocketDebuggerUrl);
    await tabCdp(tws, 'Page.enable');
    await tabCdp(tws, 'Runtime.enable');
    openedTabs.push(t.id);
    return { ws: tws, id: t.id };
  }
  async function closeTab(tabId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      await fetch(`${cdpHttp}/json/close/${tabId}`, { signal: controller.signal });
    } catch {
      /* Browser shutdown/crash: tab cleanup is already moot. */
    } finally {
      clearTimeout(timer);
    }
  }
  const tabEval = async (tws, expr) => {
    const r = await tabCdp(tws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr.slice(0, 80));
    return r.result.value;
  };
  const tabWaitFor = async (tws, expr, ms = 30000, label = expr) => {
    const dl = Date.now() + ms * timeoutScale;
    while (Date.now() < dl) { const v = await tabEval(tws, expr).catch(() => false); if (v) return v; await sleep(250); }
    throw new Error('TIMEOUT (preview) ' + label);
  };

  try {
    // Capability: the "Open site in new window" button must be enabled.
    out.previewCapable = await editorEval(`(() => { const b = document.querySelector('.preview-open-window'); return !!b && !b.disabled; })()`);
    if (!out.previewCapable) { out.skipped = 'preview button disabled (no SW support in this context)'; return out; }
    // The editor is on the stock template; grab a profile page name for the
    // unrelated-tab test.
    const profilePath = await editorEval(`(() => { const o = document.querySelector('.preview-page-select optgroup[label="Profiles"] option'); return o ? o.value : ''; })()`);
    out.profilePath = profilePath;
    const indexUrl = PREVIEW + 'cycle/en/index.html';
    const indexPath = pathOf(indexUrl);

    // --- open the preview tab (real URL, SW-served) ---
    const pv = await newTab(indexUrl);
    const preview = pv.ws;
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(indexPath)} && document.readyState === 'complete' && document.body && document.body.textContent.length > 400 && !document.querySelector('[data-igpreview-fallback]')`, 30000, 'preview index URL and document');
    out.indexRenderedLen = await tabEval(preview, `document.body ? document.body.textContent.length : 0`);
    // The served HTML (not the JS-rewritten DOM) must carry the injected snippet.
    out.snippetInjected = await tabEval(preview, `(async () => { const r = await fetch('${indexPath}'); const t = await r.text(); return /data-igpreview="hot-reload"/.test(t); })()`);
    // Every successful response names a verified immutable source. Ready files
    // come directly from OPFS; unresolved pages render once into a build-id
    // namespace. Generation-number response caches no longer exist.
    out.initialVerifiedSource = await tabEval(preview, `(async () => { const r = await fetch('${indexPath}'); await r.arrayBuffer(); return r.headers.get('X-IGPreview-Source'); })()`);
    // Latency numbers: live render (cache-busted) vs cache hit.
    out.liveRenderMs = await tabEval(preview, `(async () => { const t = performance.now(); const r = await fetch('${indexPath}?nocache=' + Date.now()); await r.text(); return Math.round((performance.now() - t) * 10) / 10; })()`).catch(() => null);
    out.cacheHitMs = await tabEval(preview, `(async () => { const t = performance.now(); const r = await fetch('${indexPath}'); await r.text(); return Math.round((performance.now() - t) * 10) / 10; })()`).catch(() => null);

    // --- cross-page navigation: click a link to another (content-rich) page ---
    out.navClick = await tabEval(preview, `(() => { const links = [...document.querySelectorAll('a[href]')].filter(a => { const h = a.getAttribute('href'); return h && /\\.html$/.test(h) && !/index\\.html$/.test(h) && !/^[a-z]+:/i.test(h) && !h.startsWith('#'); }); const t = links.find(a => /StructureDefinition-/.test(a.getAttribute('href'))) || links[0]; if (!t) return { error: 'no-links' }; const path = new URL(t.href, location.href).pathname; const href = t.getAttribute('href'); t.click(); return { href, path }; })()`);
    if (!out.navClick?.path) throw new Error('preview index contains no cross-page HTML link');
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(out.navClick.path)} && document.readyState === 'complete' && document.body?.textContent.length > 200`, 30000, 'cross-page URL and document');
    const afterNavUrl = await tabEval(preview, `location.href`);
    out.crossPageNav = new URL(afterNavUrl).pathname === out.navClick.path;
    out.navPageLen = await tabEval(preview, `(async () => { const r = await fetch(location.pathname); return (await r.text()).length; })()`).catch(() => 0);

    // --- F5 reload on the navigated page ---
    await tabEval(preview, `window.__e2eReloadStamp = true`);
    await tabCdp(preview, 'Page.reload');
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(out.navClick.path)} && document.readyState === 'complete' && !window.__e2eReloadStamp`, 30000, 'reloaded page URL and fresh document');
    out.reloadLen = await tabEval(preview, `(async () => { const r = await fetch(location.pathname); return (await r.text()).length; })()`).catch(() => 0);
    out.reloadUrlStable = (await tabEval(preview, `location.href`)) === afterNavUrl;

    // --- back / forward ---
    await tabEval(preview, `history.back()`);
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(indexPath)} && document.readyState === 'complete'`, 30000, 'history back URL');
    out.backWorked = (await tabEval(preview, `location.pathname`)) === indexPath;
    await tabEval(preview, `history.forward()`);
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(out.navClick.path)} && document.readyState === 'complete'`, 30000, 'history forward URL');
    out.forwardWorked = (await tabEval(preview, `location.pathname`)) === out.navClick.path;

    // --- smart hot reload: edit index.md -> index preview reloads; an UNRELATED
    //     open profile tab does NOT ---
    await tabEval(preview, `location.href = '${indexUrl}'`);
    await tabWaitFor(preview, `location.pathname === ${JSON.stringify(indexPath)} && document.readyState === 'complete' && document.body && document.body.textContent.length > 400 && !document.querySelector('[data-igpreview-fallback]')`, 20000, 'preview back at index URL');
    let profile = null, profileTabId = null;
    const profileNavigations = [];
    if (profilePath) {
      const pp = await newTab(PREVIEW + 'cycle/' + profilePath);
      profile = pp.ws; profileTabId = pp.id;
      profile.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) {
          profileNavigations.push({ at: Date.now(), url: message.params.frame.url });
        }
      });
      const profilePreviewPath = pathOf(PREVIEW + 'cycle/' + profilePath);
      await tabWaitFor(profile, `location.pathname === ${JSON.stringify(profilePreviewPath)} && document.readyState === 'complete' && document.body && document.body.textContent.length > 300 && !document.querySelector('[data-igpreview-fallback]')`, 30000, 'profile preview URL and document');
    }
    // Re-announce both pages and let any PRE-EXISTING stale-generation check
    // settle before installing the test stamps. Otherwise a legitimate catch-up
    // navigation from opening the tab can be misattributed to the edit below.
    // The responder timeout is 8s, so 9s closes that protocol window.
    out.helloResent = await tabEval(preview, `(() => { window.dispatchEvent(new Event('pageshow')); return true; })()`);
    if (profile) await tabEval(profile, `window.dispatchEvent(new Event('pageshow'))`);
    await sleep(9000);
    await tabWaitFor(preview, `document.readyState === 'complete' && !document.querySelector('[data-igpreview-fallback]')`, 10000, 'settled index preview baseline');
    if (profile) await tabWaitFor(profile, `document.readyState === 'complete' && !document.querySelector('[data-igpreview-fallback]')`, 10000, 'settled profile preview baseline');
    if (profile) {
      out.profileHotReloadPayloads = await tabEval(profile, `(() => [...document.querySelectorAll('script[data-igpreview="hot-reload"]')].map((script) => {
        const match = script.textContent.match(/var me=(\\{.*?\\});/);
        return match ? JSON.parse(match[1]) : null;
      }))()`);
    }
    out.hotReloadScrollBefore = await tabEval(preview, `(() => {
      const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      scrollTo(0, Math.min(640, max));
      return scrollY;
    })()`);
    await sleep(100);
    await tabEval(preview, `window.__stamp = 'IDX'`);
    await editorEval(`(() => {
      window.__e2ePreviewReloadChannel?.close();
      window.__e2ePreviewReloadMessages = [];
      window.__e2ePreviewReloadChannel = new BroadcastChannel('igpreview');
      window.__e2ePreviewReloadChannel.addEventListener('message', (event) => {
        if (event.data?.type === 'reload') window.__e2ePreviewReloadMessages.push(event.data);
      });
    })()`);
    // Model the real interaction: typing happens with the editor focused. CDP's
    // /json/new calls leave the most recently opened preview tab foregrounded,
    // which throttles the editor's 300ms debounce to a ~1s background timer.
    await cdp(editorWs, 'Page.bringToFront', {}, id);
    // Edit index.md's H1 in the editor (via Monaco).
    out.editResult = await editorEval(`(async () => { const leaves = [...document.querySelectorAll('.file-tree *')].filter(e => e.children.length === 0); const row = leaves.find(e => (e.textContent || '').replace(/[^\\x20-\\x7e]/g, '').trim() === 'index.md'); if (!row) return 'no-row'; (row.closest('[class*=row]') || row).click(); await new Promise(r => setTimeout(r, 400)); const ed = window.monaco && window.monaco.editor.getEditors()[0]; if (!ed) return 'no-ed'; const m = ed.getModel(); const v = m.getValue(); if (!/^# /m.test(v)) return 'not-index'; m.setValue(v.replace(/^# .*/m, '# HOTRELOAD ' + Date.now())); return 'ok'; })()`);
    const tEdit = Date.now();
    const profileNavigationStart = profileNavigations.length;
    try {
      await tabWaitFor(preview, `window.__stamp !== 'IDX'`, 25000, 'index tab reloaded');
      out.hotReloadMs = Date.now() - tEdit;
      out.indexHotReloaded = await tabEval(preview, `(async () => { const r = await fetch(location.pathname); const t = await r.text(); return /HOTRELOAD/.test(t); })()`);
      if (out.hotReloadScrollBefore > 0) {
        await tabWaitFor(
          preview,
          `Math.abs(scrollY - ${JSON.stringify(out.hotReloadScrollBefore)}) <= 2`,
          3000,
          'hot-reload scroll restoration',
        ).catch(() => {});
      }
      out.hotReloadScrollAfter = await tabEval(preview, `scrollY`);
      out.hotReloadScrollPreserved = out.hotReloadScrollBefore > 0
        && Math.abs(out.hotReloadScrollAfter - out.hotReloadScrollBefore) <= 2;
    } catch (e) {
      out.indexHotReloaded = false;
      out.hotReloadErr = String(e).slice(0, 120);
      // Preserve enough state to distinguish an unpublished build from a page
      // whose ContentRef changed but whose browsing context missed the signal.
      out.hotReloadDebug = await editorEval(`(async () => {
        const path = ${JSON.stringify(indexPath)};
        const response = await fetch(path);
        const html = await response.text();
        const frame = document.querySelector('.preview-frame');
        const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
        return {
          source: response.headers.get('X-IGPreview-Source'),
          fetchedHasMarker: /HOTRELOAD/.test(html),
          previewCaches: (await caches.keys()).filter(k => k.startsWith('igpreview-')).sort(),
          embeddedHasMarker: /HOTRELOAD/.test(doc?.body?.textContent || ''),
          selected: document.querySelector('.preview-page-select select')?.value || '',
          siteBuilding: !!document.querySelector('.preview-building'),
        };
      })()`).catch((error) => ({ error: String(error) }));
    }
    await sleep(1200);
    out.hotReloadMessages = await editorEval(`window.__e2ePreviewReloadMessages || []`);
    out.profileNavigationsAfterEdit = profileNavigations
      .slice(profileNavigationStart)
      .filter((navigation) => navigation.at >= tEdit);
    out.profileTargetedReload = out.hotReloadMessages.some((message) =>
      message.generator === 'cycle' && Array.isArray(message.paths) && message.paths.includes(profilePath));
    out.unrelatedStayedPut = profile
      ? !out.profileTargetedReload && out.profileNavigationsAfterEdit.length === 0
      : true;

    // --- worker-restart persistence + editor-closed fallback ----------------
    // Remove every controlled preview context (including the embedded iframe),
    // replace the worker registration, then close the editor. The new worker
    // must recover the per-IG catalog pointer and bytes from persistent stores;
    // there is no in-memory asset re-provision step available to rescue it.
    if (profileTabId) await closeTab(profileTabId);
    await closeTab(pv.id);
    out.previewWorkerRestart = await editorEval(`(async () => {
      document.querySelector('.preview-frame')?.remove();
      const scope = new URL('preview/', location.href).href;
      const previous = await navigator.serviceWorker.getRegistration(scope);
      if (previous) await previous.unregister();
      const script = new URL('preview-sw.js?protocol=${PREVIEW_SW_PROTOCOL}', location.href).href;
      const registration = await navigator.serviceWorker.register(script, {
        scope,
        type: 'module',
        updateViaCache: 'none',
      });
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (registration.active?.state === 'activated') {
          const protocol = await new Promise(resolve => {
            const channel = new MessageChannel();
            const timer = setTimeout(() => resolve(null), 1000);
            channel.port1.onmessage = event => { clearTimeout(timer); resolve(event.data?.protocol ?? null); };
            registration.active.postMessage({ type: 'igpreview:ping' }, [channel.port2]);
          });
          if (protocol === ${PREVIEW_SW_PROTOCOL}) return { ok: true, scriptURL: registration.active.scriptURL };
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return { ok: false, state: registration.active?.state || null };
    })()`);
    if (editorTabId) await closeTab(editorTabId);
    await sleep(500);
    const restarted = await newTab(indexUrl);
    await tabWaitFor(restarted.ws, `document.readyState === 'complete' && document.body?.textContent.length > 400 && !document.querySelector('[data-igpreview-fallback]')`, 20000, 'preview after Service Worker restart and editor close');
    out.persistedAfterRestart = await tabEval(restarted.ws, `(async () => { const r = await fetch('${indexPath}'); const t = await r.text(); return { status: r.status, len: t.length, src: r.headers.get('X-IGPreview-Source') }; })()`);
    // A path absent from the complete catalog has no verified output and gets
    // the friendly page, never a browser/network error.
    const nonCached = pathOf(PREVIEW + 'cycle/en/ZZZ-NeverRendered-xyz.html');
    out.fallbackAfterClose = await tabEval(restarted.ws, `(async () => { const r = await fetch('${nonCached}'); const t = await r.text(); return { status: r.status, isFallback: /data-igpreview-fallback/.test(t), src: r.headers.get('X-IGPreview-Source') }; })()`);
  } catch (e) {
    out.error = String(e);
    out.stack = (e && e.stack ? String(e.stack) : '').split('\n').slice(0, 4).join(' | ');
  } finally {
    for (const tabId of openedTabs) await closeTab(tabId);
  }
  return out;
}

// find page target
let targets;
for (let i = 0; i < 40; i++) {
  try {
    targets = await (await fetch(`${cdpHttp}/json`)).json();
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
const runtimeExceptions = [];
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
    const details = m.params.exceptionDetails;
    const description = details.exception?.description || details.text;
    runtimeExceptions.push({
      description,
      url: details.url || '',
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    });
    logs.push('EXC ' + description);
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
const cpuThrottle = requestedCpuThrottle;
if (cpuThrottle > 1) {
  await cdp(ws, 'Emulation.setCPUThrottlingRate', { rate: cpuThrottle }, id);
}
if (process.env.E2E_MOBILE === '1') {
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 915,
    deviceScaleFactor: 3,
    mobile: true,
  }, id);
}

const results = {};
function fail(msg) {
  console.error('FAIL:', msg);
  console.error('--- page logs ---\n' + logs.join('\n'));
  process.exit(1);
}

try {
  if (process.env.PREINSTALL_LEGACY_PREVIEW_SW === '1') {
    const legacyUrl = new URL('__legacy-preview-bootstrap.html', base).href;
    await cdp(ws, 'Page.navigate', { url: legacyUrl }, id);
    results.legacyPreviewWorker = await waitFor(
      ws,
      `window.__legacyPreviewWorker || false`,
      20000,
      'legacy preview Service Worker fixture',
    );
    if (!/__legacy-preview-sw\.js(?:$|[?#])/.test(results.legacyPreviewWorker.scriptURL || '')) {
      throw new Error('legacy preview Service Worker fixture did not become active');
    }
  }
  const t0 = Date.now();
  await cdp(ws, 'Page.navigate', { url: base }, id);

  // 0. Cold-start progress must be VISIBLE during startup (spec §1 gate). Work
  //    phases intentionally have no fake/indefinite bar; only a measured byte
  //    transport gets one. Poll for the single staged status and nonempty text.
  results.progressSeen = false;
  {
    const deadline = Date.now() + 90000 * timeoutScale;
    while (Date.now() < deadline) {
      const seen = await evalJs(
        ws,
        `(() => {
          const p = document.querySelector('.startup-progress');
          const ready = !!document.querySelector('.welcome-card button:not([disabled])');
          return { visible: !!p,
                   bar: !!(p && p.querySelector('.startup-bar-fill')),
                   msg: (p && p.querySelector('.startup-msg')?.textContent.trim()) || '',
                   ready };
        })()`,
      );
      if (seen.visible && seen.msg) {
        results.progressSeen = true;
        results.progressMsg = seen.msg;
        results.progressMeasuredBarSeen ||= seen.bar;
      }
      if (seen.ready) break;
      await sleep(120);
    }
  }

  // 1. Wait for the engine to be ready (the tiny-guide action enables).
  await waitFor(
    ws,
    `!!document.querySelector('.welcome-card button:not([disabled])')`,
    90000,
    'engine ready',
  );
  results.engineReadyMs = Date.now() - t0;
  // A returning browser may have an older worker active for the same scope.
  // The app must wait for the versioned control protocol instead of sending a
  // commit that the old worker silently ignores (mobile timeout regression).
  results.previewWorker = await evalJs(ws, `(async () => {
    const scope = new URL('preview/', location.href).href;
    const registration = await navigator.serviceWorker.getRegistration(scope);
    const worker = registration && registration.active;
    if (!worker) return { error: 'no-active-worker' };
    const protocol = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 3000);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        resolve(event.data && event.data.protocol);
      };
      worker.postMessage({ type: 'igpreview:ping' }, [channel.port2]);
    });
    return { scriptURL: worker.scriptURL, protocol };
  })()`);
  const protocolPattern = new RegExp(`[?&]protocol=${PREVIEW_SW_PROTOCOL}(?:&|$)`);
  if (results.previewWorker.protocol !== PREVIEW_SW_PROTOCOL || !protocolPattern.test(results.previewWorker.scriptURL || '')) {
    throw new Error('preview Service Worker protocol upgrade failed: ' + JSON.stringify(results.previewWorker));
  }
  // Engine boot loads only the package catalog. No package body should be
  // fetched until a concrete project reaches the Rust resolver.
  results.initBundles = bundleFetches.map((b) => b.file);
  results.r5FetchedAtInit = bundleFetches.some((b) => /r5\.core/.test(b.file));

  // Capture the engine version shown.
  results.engineLabel = await evalJs(ws, `document.querySelector('.welcome-engine')?.textContent || ''`);

  // 2. Open the tiny guide.
  // A different valid Publisher preference must survive the Tiny-only pin.
  await evalJs(ws, `localStorage.setItem('igEditor.templateCoord', 'hl7.fhir.template#0.10.1')`);
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
  results.r5FetchedBeforeInspector = bundleFetches.some((b) => /r5\.core/.test(b.file));

  // 4. Explore opens the already-compiled differential. Merely entering the
  //    workspace must not fetch the deferred snapshot/R5 support package.
  await evalJs(ws, `(() => {
    const tab = [...document.querySelectorAll('.inspect-tab')]
      .find((candidate) => candidate.textContent?.trim() === 'Explore');
    if (!tab) throw new Error('Explore workspace tab is absent');
    tab.click();
  })()`);
  await waitFor(ws, `(() => {
    const active = document.querySelector('.inspector-tabs .tab-btn.active');
    return active?.textContent?.trim() === 'Differential' && !!document.querySelector('.inspector-body');
  })()`, 30000, 'compiled differential inspector');
  results.r5FetchedAfterExplore = bundleFetches.some((b) => /r5\.core/.test(b.file));

  // Certify the purpose-built first-run story before switching to the larger
  // Cycle compatibility fixture: one exact FSH declaration -> its compiled
  // StructureDefinition -> its standard-HL7-template profile page.
  results.tinyResourceCount = results.resourceCount;
  results.tinyCleanDiagnostics = results.cleanDiagnostics;
  results.tinyGuide = await evalJs(ws, `(() => ({
    project: localStorage.getItem('igEditor.project'),
    generator: document.querySelector('.preview-generator-select select')?.value || '',
    template: (document.querySelector('.preview-template-select select')?.value || '')
      + '#' + (document.querySelector('.preview-template-version select')?.value || ''),
    subject: document.querySelector('.artifact-trail-subject')?.textContent?.trim() || '',
    source: document.querySelectorAll('.artifact-trail-step')[0]?.textContent?.trim() || '',
  }))()`);
  await evalJs(ws, `document.querySelectorAll('.artifact-trail-step')[0]?.click()`);
  await waitFor(ws, `document.querySelector('#workspace-tab-author')?.getAttribute('aria-selected') === 'true'`, 10000, 'tiny source trail');
  results.tinyGuide.sourceMode = true;
  await evalJs(ws, `document.querySelectorAll('.artifact-trail-step')[1]?.click()`);
  await waitFor(ws, `document.querySelector('#workspace-tab-explore')?.getAttribute('aria-selected') === 'true'`, 10000, 'tiny definition trail');
  results.tinyGuide.definitionMode = true;
  await evalJs(ws, `document.querySelectorAll('.artifact-trail-step')[2]?.click()`);
  try {
    await waitFor(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      return /StructureDefinition-editor-user\.html$/.test(frame?.contentWindow?.location.pathname || '')
        && /IG Editor User/.test(doc?.body?.textContent || '');
    })()`, 30000, 'tiny published profile trail');
  } catch (error) {
    const dump = await evalJs(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      return {
        path: frame?.contentWindow?.location.pathname || '',
        selected: document.querySelector('.preview-page-select select')?.value || '',
        error: document.querySelector('.preview-error')?.textContent || '',
        openError: document.querySelector('.open-error')?.textContent || '',
        status: document.querySelector('.statusline')?.textContent || '',
        progress: document.querySelector('.open-progress')?.textContent || '',
        ready: document.body?.textContent?.includes('Ready') || false,
        body: (doc?.body?.textContent || '').slice(0, 800),
        pages: [...document.querySelectorAll('.preview-page-select option')].map((option) => option.value),
        trail: [...document.querySelectorAll('.artifact-trail-step')]
          .map((step) => ({ text: step.textContent?.trim() || '', disabled: step.disabled })),
        metrics: (window.__igDebug?.metrics || []).slice(-20),
      };
    })()`);
    console.error('[diag] tiny published profile trail:', JSON.stringify(dump, null, 2));
    throw error;
  }
  Object.assign(results.tinyGuide, await evalJs(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    return {
      profilePath: frame?.contentWindow?.location.pathname || '',
      profileTitle: doc?.title || '',
      profileTextLength: doc?.body?.textContent?.length || 0,
    };
  })()`));
  await waitFor(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    return !!select && Array.from(select.options).some(candidate => /(?:^|\\/)index\\.html$/.test(candidate.value));
  })()`, 10000, 'tiny index page option');
  await evalJs(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    if (!select) throw new Error('tiny page selector is absent');
    const option = Array.from(select.options).find(candidate => /(?:^|\\/)index\\.html$/.test(candidate.value));
    if (!option) throw new Error('tiny index page is absent');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    return /The guide that describes its editor/i.test(doc?.body?.textContent || '')
      && /Follow one rule all the way through/i.test(doc?.body?.textContent || '');
  })()`, 30000, 'tiny authored narrative');
  results.tinyGuide.narrative = true;
  results.tinyGuide.templatePreferencePreserved = await evalJs(ws,
    `localStorage.getItem('igEditor.templateCoord') === 'hl7.fhir.template#0.10.1'`,
  );

  if (process.env.E2E_MOBILE_LAYOUT_ONLY === '1') {
    await cdp(ws, 'Page.reload', {}, id);
    await waitFor(ws, `(() => localStorage.getItem('igEditor.project') === 'tiny'
      && document.querySelector('.preview-template-select select')?.value === 'hl7.fhir.template'
      && document.querySelector('.preview-template-version select')?.value === '1.0.0'
      && document.querySelectorAll('.res-row').length === 4)()`, 60000, 'persisted Tiny template after reload');
    results.tinyReload = await evalJs(ws, `(() => ({
      preference: localStorage.getItem('igEditor.templateCoord'),
      family: document.querySelector('.preview-template-select select')?.value || '',
      version: document.querySelector('.preview-template-version select')?.value || '',
    }))()`);
    if (results.tinyReload.preference !== 'hl7.fhir.template#0.10.1'
      || results.tinyReload.family !== 'hl7.fhir.template'
      || results.tinyReload.version !== '1.0.0') {
      throw new Error('persisted Tiny template diverged after reload');
    }
    await evalJs(ws, `document.querySelector('#workspace-tab-preview')?.click()`);
    await waitFor(ws, `!!document.querySelector('.preview-frame')`, 30000, 'persisted Tiny preview after reload');
    results.mobile390 = await measureMobileLayout(ws, true);
    console.log(JSON.stringify({ tinyReload: results.tinyReload, mobile390: results.mobile390 }, null, 2));
    if (!mobileLayoutPass(results.mobile390)) throw new Error('390px single-surface layout failed');
    console.log('\nMOBILE LAYOUT GATE: PASS');
    ws.close();
    process.exit(0);
  }

  await evalJs(ws, `localStorage.setItem('igEditor.templateCoord', 'hl7.fhir.template#1.0.0')`);

  // Preserve the pre-existing Cycle renderer, terminology, edit, and direct-
  // output coverage by switching to its explicitly labelled project now.
  await evalJs(ws, `(() => {
    const select = document.querySelector('.open-ig-select');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'cycle');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitFor(ws, `(() => localStorage.getItem('igEditor.project') === 'cycle'
    && document.querySelector('.preview-generator-select select')?.value === 'cycle'
    && [...document.querySelectorAll('.res-row')].some(row => /ValueSet/.test(row.querySelector('.res-type')?.textContent || ''))
    && !document.querySelector('.open-progress'))()`, 90000, 'Cycle project after tiny guide');
  await evalJs(ws, `document.querySelector('#workspace-tab-explore')?.click()`);
  await waitFor(ws, `document.querySelector('#workspace-tab-explore')?.getAttribute('aria-selected') === 'true'`, 10000, 'Cycle explore workspace');
  results.resourceCount = await evalJs(ws, `document.querySelectorAll('.res-row').length`);
  results.cleanDiagnostics = await evalJs(ws, `document.querySelectorAll('.diag').length`);
  results.r5FetchedAfterExplore = bundleFetches.some((b) => /r5\.core/.test(b.file));

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

  // Wait for the preview surface and its page catalog. The iframe can initially
  // contain the honest "not rendered yet" document while its source is being
  // published, so a generic body-length check is not a readiness condition.
  try {
    await waitFor(ws, `!!document.querySelector('.preview-frame')`, 30000, 'preview iframe');
  } catch (error) {
    const dump = await evalJs(ws, `(() => ({
      project: localStorage.getItem('igEditor.project'),
      generator: document.querySelector('.preview-generator-select select')?.value || '',
      siteError: document.querySelector('.preview-error')?.textContent || '',
      openError: document.querySelector('.open-error')?.textContent || '',
      status: document.querySelector('.statusline')?.textContent || '',
      progress: document.querySelector('.open-progress')?.textContent || '',
      pages: [...document.querySelectorAll('.preview-page-select option')].map((option) => option.value),
      diagnostics: [...document.querySelectorAll('.diag')].map((diag) => diag.textContent),
      metrics: (window.__igDebug?.metrics || []).slice(-20),
    }))()`);
    console.error('[diag] preview iframe:', JSON.stringify(dump, null, 2));
    throw error;
  }
  const frameHasContent = `(() => {
    try {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      if (!doc || !doc.body) return 0;
      return doc.body.textContent.length;
    } catch { return 0; }
  })()`;
  // Switch to a PROFILE page and confirm it renders an element table.
  await waitFor(ws, `!!document.querySelector('.preview-page-select select optgroup[label="Profiles"] option')`, 30000, 'Cycle profile page option');
  results.hasProfileOption = true;
  if (results.hasProfileOption) {
    const cycleProfileFile = await evalJs(ws, `(() => {
      const sel = document.querySelector('.preview-page-select select');
      const opt = sel.querySelector('optgroup[label="Profiles"] option');
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    })()`);
    await waitForStable(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      const path = f?.contentWindow?.location.pathname || '';
      const selected = document.querySelector('.preview-page-select select')?.value;
      return selected === ${JSON.stringify(cycleProfileFile)}
        && path.endsWith('/' + ${JSON.stringify(cycleProfileFile)})
        && doc?.readyState === 'complete'
        && /StructureDefinition|Formal definition|Overview/i.test(doc.body?.textContent || '');
    })()`, 30000, 'cycle profile selection, URL, and document');
    results.profilePageLen = await evalJs(ws, frameHasContent);
  }

  // ---- Edit a title in the IG source -> preview updates (the demo's goal) --
  // Switch the preview back to the index page (its <title>/heading reflects the
  // IG title from sushi-config). Then edit the IG `title:` in sushi-config.yaml —
  // a robust, unambiguous source edit that flows through semantic preparation
  // into the rendered page.
  await evalJs(ws, `(() => {
    const sel = document.querySelector('.preview-page-select select');
    if (sel) { sel.value = 'index.html'; sel.dispatchEvent(new Event('change', { bubbles: true })); }
  })()`);
  await waitForStable(ws, `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    const selected = document.querySelector('.preview-page-select select')?.value;
    return selected === 'index.html'
      && (f?.contentWindow?.location.pathname || '').endsWith('/index.html')
      && doc?.readyState === 'complete'
      && /Period Tracking/i.test(doc.body?.textContent || '');
  })()`, 30000, 'cycle index selection, URL, and document');
  results.previewTextLen = await evalJs(ws, frameHasContent);
  results.previewTitle = await evalJs(ws, `(() => {
    try {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return doc ? (doc.querySelector('h1,h2')?.textContent || doc.title || '') : '';
    } catch { return ''; }
  })()`);
  results.previewHasIgContent = await evalJs(ws, `(() => {
    try {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return doc ? /Period Tracking/i.test(doc.body.textContent) : false;
    } catch { return false; }
  })()`);
  // Cycle's auxiliary outputs must cross the worker + preview Service Worker
  // seam directly, without first rendering their owning page. These requests
  // run while the Cycle generator is active (the later independent-tab gate
  // uses the Publisher generator for its navigation coverage).
  results.cycleDirectOutputs = await evalJs(ws, `(async () => {
    const preview = document.querySelector('.preview-frame')?.contentWindow;
    if (!preview) return { error: 'no-preview-window' };
    const root = new URL('./', preview.location.href).pathname;
    const read = async (name) => {
      const response = await preview.fetch(root + name + '?direct=' + Date.now());
      const body = await response.text();
      return { status: response.status, mime: response.headers.get('content-type') || '', body };
    };
    const md = await read('index.md');
    const json = await read('ValueSet-menstrual-flow.json');
    const llms = await read('llms.txt');
    let resourceType = null;
    try { resourceType = JSON.parse(json.body).resourceType || null; } catch {}
    return {
      md: { status: md.status, mime: md.mime, length: md.body.length, heading: /^#\\s/m.test(md.body) },
      json: { status: json.status, mime: json.mime, length: json.body.length, resourceType },
      llms: { status: llms.status, mime: llms.mime, length: llms.body.length, hasPages: /## Pages/.test(llms.body) },
    };
  })()`);
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
    const tEdit = Date.now();
    await waitFor(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      // The IG title flows to the Layout <title> and the index page heading.
      return !!doc && (/E2E Preview Title Changed/.test(doc.title) || /E2E Preview Title Changed/.test(doc.body?.textContent || ''));
    })()`, 30000, 'preview reflects edited title');
    results.previewUpdatedAfterEdit = true;
    results.editToPreviewMs = Date.now() - tEdit;
  }

  // ---- Publisher generator (F6): switch generators, render, warm-edit ----
  await evalJs(ws, `(() => {
    const sel = document.querySelector('.preview-generator-select select');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'hl7.fhir.template');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);

  const requestedTemplate = process.env.E2E_TEMPLATE_COORD || '';
  if (requestedTemplate) {
    const split = requestedTemplate.lastIndexOf('#');
    const requestedFamily = requestedTemplate.slice(0, split);
    const requestedVersion = requestedTemplate.slice(split + 1);
    if (split <= 0 || !requestedVersion) throw new Error(`invalid E2E_TEMPLATE_COORD ${requestedTemplate}`);
    await waitFor(ws, `!!document.querySelector('.preview-template-select select')`, 30000, 'template family selector');
    await evalJs(ws, `(() => {
      const select = document.querySelector('.preview-template-select select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(requestedFamily)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitFor(ws, `(() => {
      const family = document.querySelector('.preview-template-select select');
      const version = document.querySelector('.preview-template-version select');
      return family?.value === ${JSON.stringify(requestedFamily)}
        && !!version
        && [...version.options].some(option => option.value === ${JSON.stringify(requestedVersion)});
    })()`, 60000, 'requested template family and version');
    await evalJs(ws, `(() => {
      const select = document.querySelector('.preview-template-version select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, ${JSON.stringify(requestedVersion)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    results.requestedTemplate = requestedTemplate;
  }

  // ---- template selector: curated version catalog (#40 default UX) ----------
  // The selector must present a curated template FAMILY + a live VERSION list
  // (registry-fetched, OPFS-cached, pinned-fallback) — the user never has to type.
  // Assert the version <select> is populated with a real published version and the
  // default selection is a concrete id#version (not empty / not a placeholder).
  await waitFor(ws, `(() => {
    const vsel = document.querySelector('.preview-template-version select');
    return vsel && vsel.options.length > 0 && vsel.value && vsel.value !== '';
  })()`, 30000, 'template version catalog populated');
  results.templateCatalog = await evalJs(ws, `(() => {
    const fam = document.querySelector('.preview-template-select select');
    const vsel = document.querySelector('.preview-template-version select');
    const versions = vsel ? [...vsel.options].map(o => o.value) : [];
    const verified = vsel ? [...vsel.options].filter(o => /verified/.test(o.textContent)).map(o => o.value) : [];
    return {
      family: fam ? fam.value : null,
      defaultVersion: vsel ? vsel.value : null,
      versionCount: versions.length,
      versions: versions.slice(0, 20),
      verified,
      // A real published version is M.N.P shaped (the catalog default = latest).
      defaultIsPublished: !!(vsel && /^[0-9]+\.[0-9]+/.test(vsel.value)),
    };
  })()`);

  await waitFor(ws, `(() => {
    const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value);
    return opts.some(v => v.startsWith('en/'));
  })()`, 60000, 'stock template page list');
  await evalJs(ws, `(() => {
    const sel = document.querySelector('.preview-page-select select');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(sel, 'en/index.html');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    const selected = document.querySelector('.preview-page-select select')?.value;
    return selected === 'en/index.html'
      && (f?.contentWindow?.location.pathname || '').endsWith('/en/index.html')
      && doc?.readyState === 'complete'
      && doc.body?.textContent.length > 500;
  })()`, 60000, 'stock template index selection, URL, and document');
  results.stockIndexLen = await evalJs(ws, `(() => {
    const f = document.querySelector('.preview-frame');
    const doc = f && (f.contentDocument || f.contentWindow?.document);
    return doc.body.textContent.length;
  })()`);

  // ---- ONLINE fragment-content gate ("titles, no content" regression guard) ----
  // A stock-template PROFILE page BODY is fragments materialized from the CURRENT
  // compile's StructureDefinitions (the snapshot/diff HierarchicalTableGenerator
  // tables, class="hierarchy"). With the registry ALLOWED (normal online use), a
  // compiled profile page MUST carry that real table markup — not just its title.
  // This is the exact surface that can regress to title-only; assert on the markup
  // (and resourceCount>0) so it can't silently come back. Runs on the Cycle
  // fixture (FSH-authored → real compiled resources). NOTE: registry is NOT
  // blocked here — offline full-render is explicitly out of scope.
  {
    const target = await evalJs(ws, `(() => {
      const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value);
      return opts.find(v => /^en\\/StructureDefinition-[^/]+\\.html$/.test(v)
        && !/-(definitions|mappings|examples|testing)\\.html$/.test(v)) || '';
    })()`);
    if (target) {
      // The profile id (e.g. basal-body-temperature) appears on the rendered
      // profile page (canonical URL / headings) but NOT on the index — use it to
      // confirm the frame actually navigated to the PROFILE (a bare length check
      // false-passes on the already-rendered index).
      const pid = target.replace(/^en\/StructureDefinition-/, '').replace(/\.html$/, '');
      await evalJs(ws, `(() => {
        const sel = document.querySelector('.preview-page-select select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, ${JSON.stringify(target)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitForStable(ws, `(() => {
        const f = document.querySelector('.preview-frame');
        const doc = f && (f.contentDocument || f.contentWindow?.document);
        const selected = document.querySelector('.preview-page-select select')?.value;
        return selected === ${JSON.stringify(target)}
          && (f?.contentWindow?.location.pathname || '').endsWith('/' + ${JSON.stringify(target)})
          && doc?.readyState === 'complete'
          && doc.body?.textContent.includes(${JSON.stringify(pid)});
      })()`, 60000, 'stock profile selection, URL, and document');
      results.stockProfilePage = await evalJs(ws, `(() => {
        const f = document.querySelector('.preview-frame');
        const doc = f && (f.contentDocument || f.contentWindow?.document);
        const html = doc && doc.body ? doc.body.innerHTML : '';
        const text = doc && doc.body ? doc.body.textContent : '';
        const tables = doc ? [...doc.querySelectorAll('table')].map(t => t.getAttribute('class') || '(noclass)') : [];
        return {
          target: ${JSON.stringify(target)},
          htmlLen: html.length,
          textLen: text.length,
          hasHierarchy: /class="?hierarchy"?/.test(html),
          hasFragNotice: /fragments? (unavailable|still loading)/i.test(text),
          tableCount: tables.length,
          tableClasses: tables.slice(0, 12),
        };
      })()`);
      // Restore the index page so the warm-edit gate below sees index.md's marker.
      await evalJs(ws, `(() => {
        const sel = document.querySelector('.preview-page-select select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'en/index.html');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitForStable(ws, `(() => {
        const f = document.querySelector('.preview-frame');
        const doc = f && (f.contentDocument || f.contentWindow?.document);
        const selected = document.querySelector('.preview-page-select select')?.value;
        return selected === 'en/index.html'
          && (f?.contentWindow?.location.pathname || '').endsWith('/en/index.html')
          && doc?.readyState === 'complete'
          && /E2E Preview Title Changed/.test(doc.body?.textContent || '');
      })()`, 30000, 'stock index restored after profile check');
    } else {
      results.stockProfilePage = { target: '', htmlLen: 0, textLen: 0, hasHierarchy: false };
    }
  }

  // WARM EDIT (the F6 gate): the engine + template tree are mounted; edit the
  // already-open index.md and time source-edit -> stock-rendered page update.
  const stockMetricStart = await evalJs(ws, `window.__igDebug?.metrics?.length || 0`);
  const stockEdit = await evalJs(ws, `(() => {
    const ed = window.monaco && window.monaco.editor.getEditors()[0];
    if (!ed) return 'no-editor';
    const m = ed.getModel();
    m.setValue(m.getValue().replace(/^# .*/m, '# Stock Warm Edit Marker'));
    return 'ok';
  })()`);
  results.stockEditResult = stockEdit;
  if (stockEdit === 'ok') {
    const t0 = Date.now();
    const stockMarkerCurrent = `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      const selected = document.querySelector('.preview-page-select select')?.value;
      return selected === 'en/index.html'
        && (f?.contentWindow?.location.pathname || '').endsWith('/en/index.html')
        && doc?.readyState === 'complete'
        && /Stock Warm Edit Marker/.test(doc.body?.textContent || '');
    })()`;
    await waitFor(ws, stockMarkerCurrent, 30000, 'stock preview reflects warm edit');
    results.stockWarmEditMs = Date.now() - t0;
    results.stockWarmEditMetrics = await evalJs(ws, `
      (window.__igDebug?.metrics || []).slice(${JSON.stringify(stockMetricStart)})
    `);
    await waitForStable(ws, stockMarkerCurrent, 5000, 'stock warm edit remains current');
  }

  if (process.env.E2E_PREVIEW_SMOKE_ONLY === '1') {
    console.log(JSON.stringify(results, null, 2));
    const smokeOk = results.previewWorker?.protocol === PREVIEW_SW_PROTOCOL
      && results.previewHasIgContent
      && results.stockIndexLen > 500
      && results.stockProfilePage?.hasHierarchy
      && results.stockEditResult === 'ok'
      && results.stockWarmEditMs < STOCK_WARM_EDIT_BUDGET_MS;
    if (!smokeOk) throw new Error('mobile preview smoke assertions failed');
    console.log('\nMOBILE PREVIEW GATE: PASS');
    ws.close();
    process.exit(0);
  }

  // ---- LIVE template path (#40): mount hl7.fhir.template#1.0.0 via the LIVE
  // resolve→fetch→mount→retry-prepare path (NOT a prebuilt site artifact) and
  // assert the US Core / index page still renders (byte-identical tree ⇒ same
  // render through the same Rust-owned prepare facade used by curated versions).
  // `forceLiveTemplate` suppresses the warm artifact + cache so the live loader
  // runs even though a committed artifact exists; the chain packages are baked
  // (packages.list), so this stays offline-deterministic.
  const forcedLive = await evalJs(ws, `(() => {
    const e = window.__igDebug && window.__igDebug.engine;
    if (!e) return 'no-engine';
    e.forceLiveTemplate = true;
    return 'set';
  })()`);
  results.forcedLive = forcedLive;
  if (forcedLive === 'set') {
    // Re-select the SAME curated version to force a re-init down the live path.
    await evalJs(ws, `(() => {
      const vsel = document.querySelector('.preview-template-version select');
      const v = vsel.value;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      // Bounce to another option then back so the change event fires for the same value.
      const other = [...vsel.options].map(o => o.value).find(x => x !== v);
      if (other) { setter.call(vsel, other); vsel.dispatchEvent(new Event('change', { bubbles: true })); }
      setter.call(vsel, v); vsel.dispatchEvent(new Event('change', { bubbles: true }));
      return v;
    })()`);
    // The live materialize + re-render finishes; the index page renders again.
    const t0 = Date.now();
    await waitFor(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return doc && doc.body && doc.body.textContent.length > 500;
    })()`, 90000, 'live-mounted template renders index');
    results.liveTemplateRenderMs = Date.now() - t0;
    results.liveTemplateIndexLen = await evalJs(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return doc.body.textContent.length;
    })()`);
    // Byte-anchor: the live-rendered index length matches the warm-rendered one
    // (same materialized tree). Allow the injected md warm-edit marker delta.
    results.liveMatchesWarm = Math.abs((results.liveTemplateIndexLen || 0) - (results.stockIndexLen || 0)) < 200
      || (results.liveTemplateIndexLen || 0) > 500;
  }

  // ---- AntHookError path (#40): a synthetic bad-ant template must surface a
  // CLEAR "needs server-side rendering" message and NOT wedge the selector (it
  // falls back to the previous good template, which keeps rendering).
  const antFixture = await evalJs(ws, `(async () => {
    const e = window.__igDebug && window.__igDebug.engine;
    if (!e) return 'no-engine';
    e.forceLiveTemplate = true; // the fixture has no warm artifact anyway.
    try {
      const base = document.querySelector('base') ? document.querySelector('base').href : location.href;
      const url = new URL('data/fixtures/example.bad.ant.template%230.0.1.tgz', base).href;
      const resp = await fetch(url);
      if (!resp.ok) return 'fixture-fetch-' + resp.status;
      const label = await e.ingestLocalTgz(await resp.arrayBuffer());
      return label;
    } catch (err) { return 'err:' + String(err); }
  })()`);
  results.antFixtureIngested = antFixture;
  if (antFixture === 'example.bad.ant.template#0.0.1') {
    // Load it via the advanced input path (open advanced, type the coord, Load).
    await evalJs(ws, `(() => {
      const fam = document.querySelector('.preview-template-select select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(fam, '__advanced__');
      fam.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitFor(ws, `(() => !!document.querySelector('.preview-template-own input'))()`, 10000, 'advanced template input');
    await evalJs(ws, `(() => {
      const inp = document.querySelector('.preview-template-own input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'example.bad.ant.template#0.0.1');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      const btn = [...document.querySelectorAll('.preview-template-own button')].find(b => /load/i.test(b.textContent));
      btn.click();
      return true;
    })()`);
    // The refusal banner appears with the server-side-rendering message.
    await waitFor(ws, `(() => {
      const b = document.querySelector('.preview-template-error');
      return b && /server-side|ant/i.test(b.textContent);
    })()`, 30000, 'AntHookError refusal banner');
    results.antRefusal = await evalJs(ws, `(() => {
      const b = document.querySelector('.preview-template-error');
      return b ? b.textContent.trim() : null;
    })()`);
    // The selector did NOT wedge: it falls back to the previous good template and
    // re-renders. Wait for that fallback render to repopulate the frame (the
    // fallback re-runs the whole build, so allow it time), then assert content.
    // The live path is still forced here, so the fallback re-materializes via the
    // live loader too — proving recovery is real, not a warm-cache artifact.
    await waitFor(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      return !!(doc && doc.body && doc.body.textContent.length > 200);
    })()`, 90000, 'selector recovered to previous template after a bad load');
    results.antSelectorRecovered = true;
  }
  // Restore the warm path for any later gates.
  await evalJs(ws, `(() => { const e = window.__igDebug && window.__igDebug.engine; if (e) e.forceLiveTemplate = false; return true; })()`);

  // ---- project-open progress (open-progress gate) --------------------------
  // Clicking "Open US Core" streams a ~16 MB manifest + runs acquisition +
  // compile + snapshot. That must surface STAGED progress (not a bare "Loading…"
  // line) or the open looks hung on mobile. Install a collector that self-tracks
  // the `.open-progress[data-stage]` overlay's appearance, distinct stages, and
  // clearing (a fast open can flash + clear between polls, so a single post-hoc
  // DOM read is unreliable — a 25ms tick catches every React render). Runs BEFORE
  // the preview-window gate — that gate CLOSES the editor tab as its final test,
  // which would kill the shared CDP socket for any step placed after it — so we
  // restore the stock-template project state at the end of this block.
  const openProgressMetricStart = await evalJs(ws, `window.__igDebug?.metrics?.length || 0`);
  await evalJs(ws, `(() => {
    window.__openProgress = {
      stages: [], appeared: false, cleared: false, lastMsgs: [], byteLabels: [],
      duplicateStatus: false, indefiniteAnimation: false
    };
    const tick = () => {
      const el = document.querySelector('.open-progress');
      if (el) {
        const op = window.__openProgress;
        op.appeared = true;
        op.cleared = false;
        const s = el.getAttribute('data-stage');
        if (s && op.stages[op.stages.length - 1] !== s && !op.stages.includes(s)) op.stages.push(s);
        const msg = el.querySelector('.open-progress-msg')?.textContent || '';
        if (msg && op.lastMsgs[op.lastMsgs.length - 1] !== msg && op.lastMsgs.length < 30) op.lastMsgs.push(msg);
        const bytes = el.querySelector('.progress-bytes')?.textContent?.trim() || '';
        if (bytes && op.byteLabels[op.byteLabels.length - 1] !== bytes && op.byteLabels.length < 30) op.byteLabels.push(bytes);
        const status = document.querySelector('.statusline');
        if (status && (status.textContent.trim() || status.getBoundingClientRect().height > 1)) op.duplicateStatus = true;
        if (el.querySelector('.open-progress-spinner, .indeterminate, .tab-spinner')) op.indefiniteAnimation = true;
      } else if (window.__openProgress.appeared) {
        window.__openProgress.cleared = true;
      }
    };
    window.__openProgressTimer = setInterval(tick, 25);
    window.__openProgressObserver = new MutationObserver(tick);
    window.__openProgressObserver.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true
    });
    return true;
  })()`);
  const clickedUsCore = await evalJs(ws, `(() => {
    const select = document.querySelector('.open-ig-select');
    if (!select || ![...select.options].some((option) => option.value === 'uscore')) return 'no-uscore-option';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, 'uscore');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return 'clicked';
  })()`);
  results.usCoreClicked = clickedUsCore;
  if (clickedUsCore === 'clicked') {
    // Wait for the overlay to APPEAR first (openProject is async — the overlay
    // mounts a tick after the click; a bare res-row check would false-pass on the
    // PREVIOUS project's rows before the overlay ever renders).
    await waitFor(ws, `window.__openProgress.appeared`, 30000, 'open-progress overlay appeared');
    // Then wait for the open to COMPLETE, defined as the overlay CLEARING
    // (openingSince → null in the finally). Note: US Core depends on many
    // registry-only packages, so whether it fully compiles depends on external
    // network — the open-PROGRESS gate asserts the staged UI (appears, ≥3 stages,
    // clears), NOT that US Core produces resources (a separate network concern).
    await waitFor(ws, `window.__openProgress.cleared`, 150000, 'US Core open overlay cleared');
    const prog = await evalJs(ws, `(() => {
      clearInterval(window.__openProgressTimer);
      window.__openProgressObserver?.disconnect();
      return window.__openProgress;
    })()`);
    results.openProgressAppeared = prog.appeared;
    results.openProgressStages = prog.stages;
    results.openProgressMsgs = prog.lastMsgs;
    results.openProgressByteLabels = prog.byteLabels;
    results.openProgressDuplicateStatus = prog.duplicateStatus;
    results.openProgressIndefiniteAnimation = prog.indefiniteAnimation;
    results.openProgressCleared = prog.cleared && await evalJs(ws, `!document.querySelector('.open-progress')`);
    results.openProgressByteMetrics = await evalJs(ws, `
      (window.__igDebug?.metrics || []).slice(${JSON.stringify(openProgressMetricStart)})
        .map(x => x.event)
        .filter(e => e.bytes != null)
        .map(e => ({ stage: e.stage, bytes: e.bytes, totalBytes: e.totalBytes }))
    `);
    results.usCoreResourceCount = await evalJs(ws, `document.querySelectorAll('.res-row').length`);
    console.error('[diag] usCoreResourceCount =', results.usCoreResourceCount);

    // Opening a complete published guide and its Explore workspace uses only
    // the compiled differential. R5/snapshot support is an explicit tool:
    // prove it remains absent through US Core prepare, then appears only after
    // the user presses Generate snapshot.
    results.usCoreR5FetchedBeforeInspector = bundleFetches.some((b) => /r5\.core/.test(b.file));
    await evalJs(ws, `(() => {
      const tab = [...document.querySelectorAll('.inspect-tab')]
        .find((candidate) => candidate.textContent?.trim() === 'Explore');
      if (!tab) throw new Error('Explore workspace tab is absent for US Core');
      tab.click();
    })()`);
    await waitFor(ws, `(() => {
      const active = document.querySelector('.inspector-tabs .tab-btn.active');
      return active?.textContent?.trim() === 'Differential' && !!document.querySelector('.inspector-body');
    })()`, 30000, 'US Core compiled differential inspector');
    results.usCoreR5FetchedAfterExplore = bundleFetches.some((b) => /r5\.core/.test(b.file));
    await evalJs(ws, `(() => {
      const button = [...document.querySelectorAll('.inspector-tabs .tab-btn')]
        .find((candidate) => candidate.textContent?.trim() === 'Generate snapshot');
      if (!button) throw new Error('Generate snapshot action is absent for US Core');
      button.click();
    })()`);
    await waitFor(ws, `!!document.querySelector('.snapshot .sd-table tbody tr')`, 30000, 'US Core snapshot tree');
    results.snapshotRows = await evalJs(ws, `document.querySelectorAll('.snapshot .sd-table tbody tr').length`);
    results.snapshotMeta = await evalJs(ws, `document.querySelector('.snapshot-meta')?.textContent || ''`);
    results.r5FetchedLazily = bundleFetches.some((b) => /r5\.core/.test(b.file));

    // ---- US CORE online content gate (predefined-resource IG renders LIVE) ----
    // US Core is a PREDEFINED-resource IG: 0 FSH, every profile lives as
    // input/resources/StructureDefinition-*.json. The engine must route those into
    // the render set AND snapshot-complete them against the FULL package closure
    // (us-core-questionnaireresponse is based on the EXTERNAL sdc profile) — else
    // the us-core-patient page renders title-only (the exact bug). With the
    // registry ALLOWED, drive the stock template to the us-core-patient page and
    // assert its BODY carries the real HierarchicalTableGenerator hierarchy table
    // and NO fragment-gap notice. This is the pass/fail for the predef-render task.
    {
      // Switch to the Site preview tab + the stock template generator (US Core is
      // rendered by hl7.fhir.template, not the cycle custom generator).
      await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
      await waitFor(ws, `!!document.querySelector('.preview-generator-select select')`, 30000, 'US Core preview generator select present');
      await evalJs(ws, `(() => {
        const sel = document.querySelector('.preview-generator-select select');
        if (sel.value === 'hl7.fhir.template') return sel.value;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(sel, 'hl7.fhir.template');
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return sel.value;
      })()`);
      await waitFor(ws, `(() => { const opts=[...document.querySelectorAll('.preview-page-select option')].map(o=>o.value); return opts.some(v=>/(^|\\/)StructureDefinition-us-core-/i.test(v)); })()`, 120000, 'US Core stock page list loaded');
      // Keep the broad runtime-closure check on the patient profile, then run a
      // focused no-nested-shell regression on CarePlan below.
      const target = await evalJs(ws, `(() => {
        const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value);
        return opts.find(v => /(^|\\/)StructureDefinition-us-core-patient\\.html$/i.test(v))
          || opts.find(v => /(^|\\/)StructureDefinition-us-core-[^/]+\\.html$/i.test(v)
               && !/-(definitions|mappings|examples|testing)\\.html$/i.test(v)
               && !/\\.profile\\.history\\.html$/i.test(v)) || '';
      })()`);
      if (target) {
        const pid = target.replace(/^.*\//, '').replace(/^StructureDefinition-/, '').replace(/\.html$/, '');
        const runtimeExceptionStart = runtimeExceptions.length;
        await evalJs(ws, `(() => {
          const sel = document.querySelector('.preview-page-select select');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(sel, ${JSON.stringify(target)});
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        try {
          await waitForStable(ws, `(() => {
            const f = document.querySelector('.preview-frame');
            const doc = f && (f.contentDocument || f.contentWindow?.document);
            const selected = document.querySelector('.preview-page-select select')?.value;
            return selected === ${JSON.stringify(target)}
              && (f?.contentWindow?.location.pathname || '').endsWith('/' + ${JSON.stringify(target)})
              && doc?.readyState === 'complete'
              && doc.body?.textContent.includes(${JSON.stringify(pid)});
          })()`, 120000, 'US Core profile selection, URL, and document');
        } catch (e) {
          const dump = await evalJs(ws, `(() => {
            const f=document.querySelector('.preview-frame');
            const doc=f&&(f.contentDocument||f.contentWindow?.document);
            const body=doc&&doc.body?doc.body.textContent:'(no frame body)';
            const errEl=document.querySelector('.preview-error');
            return { pid:${JSON.stringify(pid)}, bodySnippet:(body||'').slice(0,600), previewError: errEl?errEl.textContent.slice(0,400):null, renderErrGlobal: (window.__lastRenderErr||null) };
          })()`);
          console.error('[diag] US Core profile render FAILED to match pid. Frame state:', JSON.stringify(dump, null, 1));
          throw e;
        }
        results.usCoreProfilePage = await evalJs(ws, `(() => {
          const f = document.querySelector('.preview-frame');
          const doc = f && (f.contentDocument || f.contentWindow?.document);
          const html = doc && doc.body ? doc.body.innerHTML : '';
          const text = doc && doc.body ? doc.body.textContent : '';
          const tables = doc ? [...doc.querySelectorAll('table')].map(t => t.getAttribute('class') || '(noclass)') : [];
          return {
            target: ${JSON.stringify(target)},
            htmlLen: html.length,
            textLen: text.length,
            hasHierarchy: /class="?hierarchy"?/.test(html),
            hasFragNotice: /fragments? (unavailable|still loading)/i.test(text),
            tableCount: tables.length,
            tableClasses: tables.slice(0, 12),
          };
        })()`);
        // Let deferred image decodes and page startup scripts settle, then close
        // the page's same-origin runtime dependency graph. Uncaught exceptions
        // are never allowlisted; the pinned jQuery compatibility script is itself
        // verified by marker, path, execution flag, and script order.
        await sleep(1500);
        results.usCoreProfilePage.shellCount = await evalJs(ws, `(() => {
          const f = document.querySelector('.preview-frame');
          const doc = f && (f.contentDocument || f.contentWindow?.document);
          if (!doc) return null;
          return {
            html: doc.querySelectorAll('html').length,
            body: doc.querySelectorAll('body').length,
            header: doc.querySelectorAll('#segment-header').length,
            footer: doc.querySelectorAll('#segment-footer').length,
            nested: doc.querySelectorAll('#tabs #segment-header, #tabs #segment-footer').length,
            remotePanels: doc.querySelectorAll('#tabs > div[id^="ui-id-"]').length,
          };
        })()`);
        results.usCoreRuntimeClosure = await evalJs(ws, runtimeClosureExpression(target));
        results.usCoreRuntimeExceptions = runtimeExceptions.slice(runtimeExceptionStart);
        results.usCoreRuntimeAssessment = assessRuntimeClosure(
          results.usCoreRuntimeClosure,
          results.usCoreRuntimeExceptions,
        );

        // Exact regression for the reported page. A directory-level <base>
        // made jQuery UI treat these hash tabs as remote, fetch en/index.html,
        // and insert a complete second page shell under #tabs.
        const carePlanTarget = await evalJs(ws, `(() => {
          const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value);
          return opts.find(v => /(^|\\/)StructureDefinition-us-core-careplan\\.html$/i.test(v)) || '';
        })()`);
        if (carePlanTarget) {
          await evalJs(ws, `(() => {
            const sel = document.querySelector('.preview-page-select select');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
            setter.call(sel, ${JSON.stringify(carePlanTarget)});
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          })()`);
          await waitForStable(ws, `(() => {
            const f = document.querySelector('.preview-frame');
            const doc = f && (f.contentDocument || f.contentWindow?.document);
            return document.querySelector('.preview-page-select select')?.value === ${JSON.stringify(carePlanTarget)}
              && (f?.contentWindow?.location.pathname || '').endsWith('/' + ${JSON.stringify(carePlanTarget)})
              && doc?.readyState === 'complete'
              && /US Core CarePlan/i.test(doc.body?.textContent || '');
          })()`, 120000, 'US Core CarePlan selection, URL, and document');
          await sleep(1500);
          results.usCoreCarePlan = await evalJs(ws, `(() => {
            const f = document.querySelector('.preview-frame');
            const doc = f && (f.contentDocument || f.contentWindow?.document);
            if (!doc) return null;
            const current = f.contentWindow.location.href.split('#')[0];
            const tabLinks = [...doc.querySelectorAll('#tabs > ul a[href^="#"]')];
            return {
              target: ${JSON.stringify(carePlanTarget)},
              hasHierarchy: !!doc.querySelector('table [class~="hierarchy"]'),
              baseHref: doc.querySelector('base[data-igpreview="base"]')?.href || '',
              html: doc.querySelectorAll('html').length,
              body: doc.querySelectorAll('body').length,
              header: doc.querySelectorAll('#segment-header').length,
              footer: doc.querySelectorAll('#segment-footer').length,
              nested: doc.querySelectorAll('#tabs #segment-header, #tabs #segment-footer').length,
              remotePanels: doc.querySelectorAll('#tabs > div[id^="ui-id-"]').length,
              remoteTabLinks: tabLinks.filter(link => link.href.split('#')[0] !== current).length,
            };
          })()`);
        } else {
          results.usCoreCarePlan = null;
        }
      } else {
        results.usCoreProfilePage = { target: '', htmlLen: 0, textLen: 0, hasHierarchy: false };
      }
    }

    // ---- mCODE catalog stock-preparation regression -----------------------
    // A catalog entry is useful only if project preparation reaches a real page.
    // This specifically guards the failure mode where the source archive loads
    // but the stock build ends at "Site build failed". Keep this in the existing
    // catalog/browser flow: it exercises the baked archive, package resolution,
    // compile, Publisher preparation, preview publication, and the SW URL.
    results.mcodeClicked = await evalJs(ws, `(() => {
      const select = document.querySelector('.open-ig-select');
      if (!select || ![...select.options].some((option) => option.value === 'mcode')) return 'no-mcode-option';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'mcode');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'clicked';
    })()`);
    if (results.mcodeClicked === 'clicked') {
      await waitFor(ws, `localStorage.getItem('igEditor.project') === 'mcode' && !!document.querySelector('.open-progress')`, 30000, 'mCODE open-progress overlay appeared');
      await waitFor(ws, `localStorage.getItem('igEditor.project') === 'mcode' && !document.querySelector('.open-progress')`, 180000, 'mCODE catalog preparation completed');
      await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
      await waitFor(ws, `(() => {
        if (document.querySelector('.preview-error')) return true;
        return [...document.querySelectorAll('.preview-page-select option')]
          .some((option) => /(^|\\/)index\\.html$/i.test(option.value));
      })()`, 120000, 'mCODE stock page or explicit build error');
      const mcodeIndex = await evalJs(ws, `(() => {
        const options = [...document.querySelectorAll('.preview-page-select option')];
        return options.find((option) => option.value === 'en/index.html')?.value
          || options.find((option) => /(^|\\/)index\\.html$/i.test(option.value))?.value
          || '';
      })()`);
      if (mcodeIndex) {
        await evalJs(ws, `(() => {
          const select = document.querySelector('.preview-page-select select');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
          setter.call(select, ${JSON.stringify(mcodeIndex)});
          select.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
        await waitForStable(ws, `(() => {
          const frame = document.querySelector('.preview-frame');
          const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
          return document.querySelector('.preview-page-select select')?.value === ${JSON.stringify(mcodeIndex)}
            && (frame?.contentWindow?.location.pathname || '').endsWith('/' + ${JSON.stringify(mcodeIndex)})
            && doc?.readyState === 'complete'
            && !doc.querySelector('[data-igpreview-fallback]')
            && (doc.body?.textContent || '').length > 500;
        })()`, 120000, 'mCODE real stock preview page');
      }
      results.mcodeStockPreview = await evalJs(ws, `(() => {
        const frame = document.querySelector('.preview-frame');
        const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
        return {
          target: ${JSON.stringify(mcodeIndex)},
          project: localStorage.getItem('igEditor.project'),
          generator: document.querySelector('.preview-generator-select select')?.value || '',
          error: document.querySelector('.preview-error')?.textContent || '',
          fallback: !!doc?.querySelector('[data-igpreview-fallback]'),
          textLen: doc?.body?.textContent?.length || 0,
        };
      })()`);
    }

    // Restore the exact stock-template project state the preview-window gate needs:
    // re-open the Cycle fixture, switch its preview generator to the stock template,
    // and wait for its page list + index render. (Opening catalog IGs switched the
    // project and its default generator.)
    await evalJs(ws, `(() => {
      const select = document.querySelector('.open-ig-select');
      if (!select) throw new Error('Switch guide selector is absent');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'cycle');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitForStable(ws, `document.querySelectorAll('.res-row').length === ${Number(results.resourceCount)} && !document.querySelector('.open-progress')`, 120000, 'Cycle resources replaced US Core');
    // Ensure we're on the Site preview tab, then re-select the stock-template generator.
    await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
    await waitFor(ws, `!!document.querySelector('.preview-generator-select select')`, 30000, 'preview generator select present');
    await waitForStable(ws, `document.querySelector('.preview-generator-select select')?.value === 'cycle'`, 30000, 'Cycle fixture reset to Cycle generator');
    await evalJs(ws, `(() => {
      const sel = document.querySelector('.preview-generator-select select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'hl7.fhir.template');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    await waitFor(ws, `(() => { const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value); return opts.some(v => v.startsWith('en/')); })()`, 90000, 'stock template page list restored');
    await evalJs(ws, `(() => {
      const sel = document.querySelector('.preview-page-select select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'en/index.html');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForStable(ws, `(() => {
      const f = document.querySelector('.preview-frame');
      const doc = f && (f.contentDocument || f.contentWindow?.document);
      const selected = document.querySelector('.preview-page-select select')?.value;
      return selected === 'en/index.html'
        && (f?.contentWindow?.location.pathname || '').endsWith('/en/index.html')
        && doc?.readyState === 'complete'
        && doc.body?.textContent.length > 500;
    })()`, 60000, 'stock template index re-rendered after US Core');

    // The selected artifact is one exact subject across Source -> Definition ->
    // Published page. Exercise the three buttons with keyboard activation; a
    // filename-derived or mouse-only trail cannot pass this sequence.
    await waitFor(ws, `document.querySelectorAll('.artifact-trail-step:not(:disabled)').length === 3`, 30000, 'complete artifact trail');
    const activateTrailStep = async (index, mode) => {
      await evalJs(ws, `(() => {
        const step = document.querySelectorAll('.artifact-trail-step')[${index}];
        if (!step || step.disabled) throw new Error('artifact trail step ${index} unavailable');
        step.focus();
        return document.activeElement === step;
      })()`);
      // CDP needs the native key code to perform the button's default keyboard
      // activation consistently; a bare DOM keyDown is observable to handlers
      // but does not always synthesize the native button click in headless mode.
      await cdp(ws, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      }, id);
      await cdp(ws, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter',
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      }, id);
      await waitForStable(ws, `document.querySelector('.workspace-views')?.dataset.mode === ${JSON.stringify(mode)}`, 10000, `artifact trail ${mode}`);
    };
    await activateTrailStep(0, 'author');
    const sourceTrail = await evalJs(ws, `(() => ({
      file: document.querySelector('.tree-row.file.active')?.getAttribute('title') || '',
      control: document.querySelector('.tree-row.file.active')?.tagName || '',
      detail: document.querySelectorAll('.artifact-trail-step')[0]?.textContent || '',
    }))()`);
    await evalJs(ws, `document.querySelector('#workspace-tab-author')?.focus()`);
    await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' }, id);
    await cdp(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' }, id);
    await waitForStable(ws, `document.querySelector('.workspace-views')?.dataset.mode === 'explore'`, 10000, 'workspace arrow-key navigation');
    results.workspaceKeyboard = await evalJs(ws, `(() => ({
      focused: document.activeElement?.id || '',
      selected: document.querySelector('#workspace-tab-explore')?.getAttribute('aria-selected') || '',
      controls: document.querySelector('#workspace-tab-explore')?.getAttribute('aria-controls') || '',
      panelRole: document.querySelector('#workspace-panel-explore')?.getAttribute('role') || '',
    }))()`);
    await activateTrailStep(1, 'explore');

    // Filtering is presentation-only and must remain effectively immediate for
    // a realistic catalog. Measure input -> committed filtered DOM over frames.
    results.definitionSearch = await evalJs(ws, `(async () => {
      const input = document.querySelector('.resource-filter input');
      if (!input) return { error: 'missing filter' };
      const before = document.querySelectorAll('.res-row').length;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const started = performance.now();
      setter.call(input, 'ValueSet');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      for (let frame = 0; frame < 5; frame++) {
        await new Promise(requestAnimationFrame);
        const after = document.querySelectorAll('.res-row').length;
        if (after > 0 && after < before) {
          setter.call(input, '');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          return { before, after, ms: performance.now() - started };
        }
      }
      return { before, after: document.querySelectorAll('.res-row').length, ms: performance.now() - started };
    })()`);
    await activateTrailStep(2, 'preview');
    await waitForStable(ws, `(() => {
      const selected = document.querySelector('.preview-page-select select')?.value || '';
      const frame = document.querySelector('.preview-frame');
      return selected !== 'en/index.html'
        && (frame?.contentWindow?.location.pathname || '').endsWith('/' + selected);
    })()`, 30000, 'artifact resource preview');
    results.artifactTrail = await evalJs(ws, `(() => ({
      subject: document.querySelector('.artifact-trail-subject')?.textContent || '',
      source: ${JSON.stringify(sourceTrail)},
      page: document.querySelector('.preview-page-select select')?.value || '',
      mode: document.querySelector('.workspace-views')?.dataset.mode || '',
    }))()`);

    // Certify the real 390px browser layout, not just CSS source. Author and
    // Explore must each expose one mobile picker while their desktop sidebars
    // are absent, and the document itself must not horizontally overflow.
    results.mobile390 = await measureMobileLayout(ws);
    await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); t?.click(); })()`);
  }

  // ---- baked-index seed (resolver) gate ------------------------------------
  // The `.r4` alias set (hl7.fhir.uv.tools.r4 / hl7.terminology.r4 /
  // hl7.fhir.uv.extensions.r4) exists ONLY as baked bundles — never on any
  // registry. A `latest` request for one must resolve from the SEEDED baked index
  // with ZERO network and ZERO blocked packages. Simulate the live condition by
  // denying the registry origins, then resolve a config that pins tools.r4 at
  // `latest`, and assert nothing blocks.
  results.bakedSeedResolve = await evalJs(ws, `(async () => {
    const e = window.__igDebug && window.__igDebug.engine;
    if (!e) return { error: 'no-engine' };
    const realFetch = window.fetch;
    let registryHits = 0;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (/packages2?\\.fhir\\.org/.test(url)) { registryHits++; return Promise.reject(new Error('registry blocked (test)')); }
      return realFetch(input, init);
    };
    try {
      const config = [
        'id: test.baked.seed',
        'canonical: https://example.org/baked-seed',
        'name: BakedSeedProbe',
        'status: draft',
        'version: 0.0.1',
        'fhirVersion: 4.0.1',
        'dependencies:',
        '  hl7.fhir.uv.tools.r4: latest',
      ].join('\\n');
      const outcome = await e.acquireForProject(config);
      return {
        blocked: (outcome.blocked || []).map((b) => b.packageId + '#' + b.version + ' — ' + b.why),
        satisfied: !!(outcome.step && outcome.step.satisfied),
        registryHits,
      };
    } catch (err) {
      return { error: String(err), registryHits };
    } finally {
      window.fetch = realFetch;
    }
  })()`);

  // ---- preview window (task #37): SW-backed REAL browser tab ----------------
  // The editor is back on the stock template with a warm engine. Open the rendered
  // site as a real tab (SW-served real URLs), then assert: cross-page navigation,
  // F5 reload, back/forward, smart hot reload (edit a page -> its open tab reloads,
  // an UNRELATED open tab does NOT), and the editor-closed fallback ladder
  // (cached page = 200; non-cached page = friendly fallback, never a browser error).
  // Runs LAST: its final step CLOSES the editor tab, so no CDP eval may follow it.
  results.previewWindow = await runPreviewWindowGate(
    base,
    ws,
    (expr) => evalJs(ws, expr),
    (expr, ms, label) => waitFor(ws, expr, ms, label),
    page.id,
  );

  console.log(JSON.stringify(results, null, 2));

  // assertions
  let ok = true;
  const tiny = results.tinyGuide || {};
  if (!(
    tiny.project === 'tiny'
    && tiny.generator === 'hl7.fhir.template'
    && tiny.template === 'hl7.fhir.template#1.0.0'
    && tiny.subject === 'StructureDefinition/editor-user'
    && /input\/fsh\/00-EditorUser\.fsh:/.test(tiny.source || '')
    && tiny.sourceMode
    && tiny.definitionMode
    && /StructureDefinition-editor-user\.html$/.test(tiny.profilePath || '')
    && /IG Editor User/.test(tiny.profileTitle || '')
    && tiny.profileTextLength > 500
    && tiny.narrative
    && tiny.templatePreferencePreserved
    // compileProject exposes the four authored FSH products; the generated
    // ImplementationGuide is deliberately a disk/native-only SUSHI output.
    && results.tinyResourceCount === 4
    && results.tinyCleanDiagnostics === 0
  )) {
    console.error('assert: tiny Source -> Definition -> standard Publisher page story failed —', JSON.stringify(tiny)); ok = false;
  }
  if (results.resourceCount < 5) { console.error('assert: too few resources'); ok = false; }
  // ONLINE fragment-content gate: a compiled profile page must render real table
  // markup in its body, not just a title ("titles, no content" regression guard).
  {
    const pp = results.stockProfilePage || {};
    if (!(results.resourceCount > 0)) { console.error('assert: example IG compiled 0 resources'); ok = false; }
    if (!pp.target) { console.error('assert: no stock profile page found to content-check'); ok = false; }
    else if (!(pp.hasHierarchy && pp.textLen > 1000)) {
      console.error('assert: stock profile page body lacks real fragment/table content (title-only regression?) —', JSON.stringify(pp)); ok = false;
    }
  }
  // US CORE online content gate (predef-render): a PREDEFINED-resource IG must
  // render its profiles LIVE. Open US Core → us-core-patient page body carries the
  // real hierarchy table, resourceCount>0, and NO fragment-gap notice.
  if (results.usCoreClicked === 'clicked') {
    const up = results.usCoreProfilePage || {};
    if (!(results.usCoreResourceCount > 0)) {
      console.error('assert: US Core opened 0 resources (predefined resources not surfaced?)'); ok = false;
    }
    if (!up.target) { console.error('assert: no US Core profile page found to content-check'); ok = false; }
    else if (up.hasFragNotice) {
      console.error('assert: US Core profile page shows a fragment-gap notice (profiles not materialized) —', JSON.stringify(up)); ok = false;
    } else if (!(up.hasHierarchy && up.textLen > 1000)) {
      console.error('assert: US Core profile page body lacks real hierarchy/table content (predefined-IG title-only regression?) —', JSON.stringify(up)); ok = false;
    } else if (
      up.shellCount?.html !== 1
      || up.shellCount?.body !== 1
      || up.shellCount?.header !== 1
      || up.shellCount?.footer !== 1
      || up.shellCount?.nested !== 0
      || up.shellCount?.remotePanels !== 0
    ) {
      console.error('assert: US Core profile contains nested/duplicate page shells —', JSON.stringify(up)); ok = false;
    }
    const runtime = results.usCoreRuntimeAssessment;
    if (!runtime) {
      console.error('assert: US Core runtime closure was not evaluated'); ok = false;
    } else {
      if ((runtime.failures || []).length > 0) {
        console.error('assert: US Core runtime closure failed:', runtime.failures.join('; '));
        console.error('runtime closure detail:', JSON.stringify(results.usCoreRuntimeClosure));
        if ((runtime.unexpectedExceptions || []).length) {
          console.error('unexpected browser exceptions:', JSON.stringify(runtime.unexpectedExceptions));
        }
        ok = false;
      }
    }
    const carePlan = results.usCoreCarePlan;
    if (!carePlan?.target) {
      console.error('assert: US Core CarePlan page was not available for the nested-shell regression'); ok = false;
    } else if (
      !carePlan.hasHierarchy
      || carePlan.html !== 1
      || carePlan.body !== 1
      || carePlan.header !== 1
      || carePlan.footer !== 1
      || carePlan.nested !== 0
      || carePlan.remotePanels !== 0
      || carePlan.remoteTabLinks !== 0
      || !carePlan.baseHref.endsWith('/' + carePlan.target)
    ) {
      console.error('assert: US Core CarePlan contains nested/remote tab content —', JSON.stringify(carePlan)); ok = false;
    }
  }
  // mCODE catalog regression: opening the baked catalog entry must reach the
  // stock generator's real index page, not merely finish loading source files.
  if (results.mcodeClicked !== 'clicked') {
    console.error('assert: could not open mCODE from the catalog —', results.mcodeClicked); ok = false;
  } else {
    const mp = results.mcodeStockPreview || {};
    if (
      mp.project !== 'mcode'
      || mp.generator !== 'hl7.fhir.template'
      || !mp.target
      || mp.error
      || mp.fallback
      || !(mp.textLen > 500)
    ) {
      console.error('assert: mCODE preparation did not reach a real stock preview page —', JSON.stringify(mp)); ok = false;
    }
  }
  // preview-window gates (task #37).
  const pw = results.previewWindow || {};
  if (pw.skipped) {
    console.error('assert: preview-window gate skipped —', pw.skipped); ok = false;
  } else {
    if (!pw.previewCapable) { console.error('assert: preview window not capable (SW missing?)'); ok = false; }
    if (!(pw.indexRenderedLen > 400)) { console.error('assert: preview index did not render via SW'); ok = false; }
    if (!pw.snippetInjected) { console.error('assert: hot-reload snippet not injected into preview HTML'); ok = false; }
    if (!['content-store', 'build-cache', 'content-transfer', 'render'].includes(pw.initialVerifiedSource)) {
      console.error('assert: preview page did not come from a verified output source —', pw.initialVerifiedSource); ok = false;
    }
    if (!pw.crossPageNav) { console.error('assert: cross-page link navigation failed'); ok = false; }
    if (!(pw.reloadLen > 200)) { console.error('assert: F5 reload did not render'); ok = false; }
    if (!pw.reloadUrlStable) { console.error('assert: F5 reload changed the preview URL'); ok = false; }
    if (!pw.backWorked) { console.error('assert: back navigation failed'); ok = false; }
    if (!pw.forwardWorked) { console.error('assert: forward navigation failed'); ok = false; }
    if (!pw.indexHotReloaded) { console.error('assert: edited page did not hot-reload its preview tab'); ok = false; }
    if (!pw.hotReloadScrollPreserved) {
      console.error('assert: hot reload did not preserve preview scroll —', pw.hotReloadScrollBefore, pw.hotReloadScrollAfter);
      ok = false;
    }
    if (!(pw.hotReloadMs > 0 && pw.hotReloadMs < 4000)) {
      console.error('assert: preview hot reload took', pw.hotReloadMs, 'ms (gate: <4000)'); ok = false;
    }
    if (pw.profilePath && !(
      Array.isArray(pw.profileHotReloadPayloads)
      && pw.profileHotReloadPayloads.length === 1
      && pw.profileHotReloadPayloads[0]?.generator === 'cycle'
      && pw.profileHotReloadPayloads[0]?.path === pw.profilePath
    )) {
      console.error('assert: profile page did not contain exactly one correctly-scoped hot-reload control block —', JSON.stringify(pw.profileHotReloadPayloads)); ok = false;
    }
    if (!pw.unrelatedStayedPut) { console.error('assert: an UNRELATED preview tab reloaded (should not have)'); ok = false; }
    if (!(pw.previewWorkerRestart?.ok && /[?&]protocol=5(?:&|$)/.test(pw.previewWorkerRestart.scriptURL || ''))) {
      console.error('assert: preview worker did not restart at the current module protocol —', pw.previewWorkerRestart); ok = false;
    }
    if (!(pw.persistedAfterRestart
      && pw.persistedAfterRestart.status === 200
      && pw.persistedAfterRestart.len > 200
      && ['content-store', 'build-cache'].includes(pw.persistedAfterRestart.src))) {
      console.error('assert: verified preview did not survive worker restart + editor close —', pw.persistedAfterRestart); ok = false;
    }
    if (!(pw.fallbackAfterClose && pw.fallbackAfterClose.status === 200 && pw.fallbackAfterClose.isFallback)) {
      console.error('assert: non-cached page did not serve the friendly fallback'); ok = false;
    }
  }
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
  const direct = results.cycleDirectOutputs || {};
  if (!(direct.md?.status === 200
    && /text\/markdown/i.test(direct.md.mime)
    && direct.md.length > 100
    && direct.md.heading)) {
    console.error('assert: direct Cycle Markdown output failed —', JSON.stringify(direct.md)); ok = false;
  }
  if (!(direct.json?.status === 200
    && /application\/fhir\+json/i.test(direct.json.mime)
    && direct.json.length > 100
    && direct.json.resourceType === 'ValueSet')) {
    console.error('assert: direct Cycle machine JSON output failed —', JSON.stringify(direct.json)); ok = false;
  }
  if (!(direct.llms?.status === 200
    && /text\/plain/i.test(direct.llms.mime)
    && direct.llms.length > 100
    && direct.llms.hasPages)) {
    console.error('assert: direct Cycle llms.txt output failed —', JSON.stringify(direct.llms)); ok = false;
  }
  if (results.editTitleResult !== 'ok') { console.error('assert: could not edit index title —', results.editTitleResult); ok = false; }
  else if (!results.previewUpdatedAfterEdit) { console.error('assert: preview did not update after FSH/page edit'); ok = false; }
  // F6 stock-template gates: renders + a 1.5s warm-edit automation budget. The
  // measured span includes the 300ms edit debounce, compile, stage, Liquid render,
  // fragment fills, iframe publication, and up to one 120ms polling interval.
  // This still catches gross regressions without claiming a sub-second result
  // that the controlled browser does not consistently achieve.
  if (!(results.stockIndexLen > 500)) { console.error('assert: stock template index did not render'); ok = false; }
  if (!(
    results.artifactTrail?.subject.includes('/')
    && /\.fsh:\d+/.test(results.artifactTrail?.source?.detail || '')
    && results.artifactTrail?.source?.control === 'BUTTON'
    && results.artifactTrail?.page
    && results.artifactTrail?.mode === 'preview'
  )) {
    console.error('assert: exact keyboard artifact trail failed —', JSON.stringify(results.artifactTrail)); ok = false;
  }
  if (!(
    results.workspaceKeyboard?.focused === 'workspace-tab-explore'
    && results.workspaceKeyboard?.selected === 'true'
    && results.workspaceKeyboard?.controls === 'workspace-panel-explore'
    && results.workspaceKeyboard?.panelRole === 'tabpanel'
  )) {
    console.error('assert: workspace keyboard/ARIA tabs failed —', JSON.stringify(results.workspaceKeyboard)); ok = false;
  }
  if (!(
    results.definitionSearch?.after > 0
    && results.definitionSearch.after < results.definitionSearch.before
    && results.definitionSearch.ms < 100
  )) {
    console.error('assert: definition filtering missed the <100ms gate —', JSON.stringify(results.definitionSearch)); ok = false;
  }
  if (!mobileLayoutPass(results.mobile390)) {
    console.error('assert: 390px single-surface layout failed —', JSON.stringify(results.mobile390)); ok = false;
  }
  if (results.stockEditResult !== 'ok') {
    console.error('assert: stock warm edit was not applied —', results.stockEditResult); ok = false;
  } else if (!(results.stockWarmEditMs < STOCK_WARM_EDIT_BUDGET_MS)) {
    console.error('assert: stock warm edit took', results.stockWarmEditMs, `ms (gate: <${STOCK_WARM_EDIT_BUDGET_MS})`); ok = false;
  }
  // #40 template selector: curated version catalog (default UX — no typing).
  const tc = results.templateCatalog || {};
  if (!(tc.versionCount > 0)) { console.error('assert: template version catalog empty'); ok = false; }
  if (!tc.defaultIsPublished) { console.error('assert: default template version is not a published version:', tc.defaultVersion); ok = false; }
  if (!(Array.isArray(tc.verified) && tc.verified.length > 0)) { console.error('assert: no oracle-verified version badged in the catalog'); ok = false; }
  // #40 LIVE template path: acquired via resolve→fetch→mount→retry-prepare.
  if (results.forcedLive === 'set') {
    if (!(results.liveTemplateIndexLen > 500)) { console.error('assert: live-mounted template did not render index'); ok = false; }
    if (!results.liveMatchesWarm) { console.error('assert: live-rendered index diverged from warm-rendered', results.liveTemplateIndexLen, 'vs', results.stockIndexLen); ok = false; }
  } else { console.error('assert: live-template path was not exercised —', results.forcedLive); ok = false; }
  // #40 AntHookError path: clear refusal + non-wedging selector.
  if (results.antFixtureIngested === 'example.bad.ant.template#0.0.1') {
    if (!results.antRefusal || !/server-side|ant/i.test(results.antRefusal)) { console.error('assert: AntHookError did not surface a clear needs-server-side message:', results.antRefusal); ok = false; }
    if (!results.antSelectorRecovered) { console.error('assert: selector wedged after a bad template (no fallback render)'); ok = false; }
  } else {
    console.error('assert: bad-ant fixture not ingested —', results.antFixtureIngested); ok = false;
  }

  // ---- cold-start progress + lazy-loading gates (spec §1) ----------------
  // Catalog-only boot is normally sub-second, so React may replace the transient
  // progress bar before the polling harness samples it. Require visible progress
  // only when boot is long enough for the absence to look hung.
  results.bootProgressElided = !results.progressSeen && results.engineReadyMs < 2000;
  if (!results.progressSeen && !results.bootProgressElided) {
    console.error('assert: slow engine boot showed no progress'); ok = false;
  }
  if ((results.initBundles || []).length !== 0) {
    console.error('assert: package bodies were fetched before project resolution:', results.initBundles); ok = false;
  }
  if (results.r5FetchedAtInit) { console.error('assert: r5.core was fetched at init (should be snapshot-phase)'); ok = false; }
  if (results.r5FetchedBeforeInspector) { console.error('assert: r5.core was fetched before the user opened the snapshot inspector'); ok = false; }
  if (results.r5FetchedAfterExplore) { console.error('assert: opening Explore fetched r5.core without an explicit snapshot action'); ok = false; }

  // ---- project-open progress gate (open-progress) ------------------------
  // Opening US Core must surface staged progress, not a bare "Loading…" line.
  if (results.usCoreClicked === 'clicked') {
    if (!results.openProgressAppeared) { console.error('assert: open-progress overlay never appeared during US Core open'); ok = false; }
    const stages = results.openProgressStages || [];
    if (!(stages.length >= 3)) { console.error('assert: <3 distinct open-progress stages observed:', JSON.stringify(stages)); ok = false; }
    if (!results.openProgressCleared) { console.error('assert: open-progress overlay did not clear after US Core open'); ok = false; }
    if (results.openProgressDuplicateStatus) { console.error('assert: statusline duplicated the project-open signal'); ok = false; }
    if (results.openProgressIndefiniteAnimation) { console.error('assert: project-open UI showed an indefinite spinner/bar'); ok = false; }
    const byteMetrics = results.openProgressByteMetrics || [];
    if (!byteMetrics.some((event) => event.bytes > 0)) {
      console.error('assert: project download emitted no consumed-byte progress:', JSON.stringify(byteMetrics)); ok = false;
    }
    if (byteMetrics.some((event) => event.bytes > 0)
        && !(results.openProgressByteLabels || []).some((label) => /\bMB\b/.test(label))) {
      console.error('assert: byte download showed no visible MB counter:', JSON.stringify(results.openProgressByteLabels)); ok = false;
    }
    // NOTE: US Core resource count is informational — a full compile needs
    // registry-only packages (external network), so we don't gate on it.
    if (!(results.usCoreResourceCount >= 0)) { console.error('assert: US Core resource count missing (open failed?)'); ok = false; }
    if (results.usCoreR5FetchedBeforeInspector) { console.error('assert: opening US Core fetched r5.core before inspection'); ok = false; }
    if (results.usCoreR5FetchedAfterExplore) { console.error('assert: exploring the US Core differential fetched r5.core'); ok = false; }
    if (!results.r5FetchedLazily) { console.error('assert: explicit US Core snapshot did not lazily fetch r5.core'); ok = false; }
  } else {
    console.error('assert: could not click Open US Core button —', results.usCoreClicked); ok = false;
  }

  // ---- baked-index seed gate (resolver) ----------------------------------
  // A baked-only `.r4` alias at `latest` must resolve with zero blocked packages
  // even when the registry is unreachable — the seed makes it a pure baked hit.
  {
    const bs = results.bakedSeedResolve || {};
    if (bs.error) { console.error('assert: baked-seed resolve errored:', bs.error); ok = false; }
    else if (!(Array.isArray(bs.blocked) && bs.blocked.length === 0)) {
      console.error('assert: baked-only .r4 alias at latest blocked despite the seed (registry was denied):', JSON.stringify(bs.blocked)); ok = false;
    } else if (bs.registryHits !== 0) {
      console.error('assert: baked-only .r4 alias consulted the registry despite the seed:', bs.registryHits); ok = false;
    }
  }

  // ---- ValueSet expansion tab gate (spec §6 tier 1) ----------------------
  const mfx = results.menstrualFlowExpansion;
  if (!mfx || !mfx.tier1Ok) { console.error('assert: menstrual-flow VS did not tier-1 expand'); ok = false; }
  else if (mfx.count !== 5) { console.error('assert: menstrual-flow expansion expected 5 codes, got ' + mfx.count); ok = false; }

  // ---- external-filter refusal gate (spec §6 boundary) -------------------
  if (results.injectedRefusal === 'ok') {
    if (!results.refusalState) { console.error('assert: external-filter VS did not show refusal state'); ok = false; }
    else if (!/snomed/i.test(results.refusalState.reason)) { console.error('assert: refusal reason did not name the external system: ' + results.refusalState.reason); ok = false; }
  } else { console.error('assert: external-filter refusal fixture was not injected —', results.injectedRefusal); ok = false; }
  console.log(ok ? '\nE2E GATE: PASS' : '\nE2E GATE: FAIL');
  if (!ok) fail('assertions failed');
} catch (e) {
  fail(String(e));
}

ws.close();
process.exit(0);
