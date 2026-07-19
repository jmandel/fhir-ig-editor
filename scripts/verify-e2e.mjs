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
const PREVIEW_SW_PROTOCOL = 8;
const PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL = 6;
const requestedCpuThrottle = Number(process.env.E2E_CPU_THROTTLE || 0);
const requestedTimeoutScale = Number(process.env.E2E_TIMEOUT_SCALE || 1);
if (!Number.isFinite(requestedTimeoutScale) || requestedTimeoutScale < 1) {
  throw new Error('E2E_TIMEOUT_SCALE must be a finite number >= 1');
}
const mixedTransportSetting = process.env.E2E_REQUIRE_MIXED_PREPARED_TRANSPORT ?? '1';
if (mixedTransportSetting !== '0' && mixedTransportSetting !== '1') {
  throw new Error('E2E_REQUIRE_MIXED_PREPARED_TRANSPORT must be 0 or 1');
}
const requireMixedPreparedTransport = mixedTransportSetting === '1';
const timeoutScale = Math.max(1, requestedCpuThrottle, requestedTimeoutScale);
// Preserve the release budget on normal CI. An explicitly throttled functional
// run scales the wall-clock allowance with the emulated CPU slowdown.
// End-to-end source edit -> rebuilt/published iframe. The exact private-reuse
// gates below are separately asserted through their metrics; 2s leaves normal
// browser scheduling headroom while still failing a lost-reuse regression (~3s).
const STOCK_WARM_EDIT_BUDGET_MS = 2000 * timeoutScale;

function assessWarmEditMetrics(events) {
  const event = [...(events || [])]
    .reverse()
    .map((entry) => entry?.event)
    .find((event) => event?.operation === 'prepare'
      && event?.stage === 'site-build'
      && event.metrics);
  const metrics = event?.metrics;
  return {
    metrics: metrics || null,
    durationMs: event?.durationMs ?? null,
    ok: Boolean(metrics
      && Number.isFinite(metrics.compileProjectMs)
      && metrics.compileProjectMs >= 0
      && Number.isFinite(metrics.rustPrepareTotalMs)
      && metrics.rustPrepareTotalMs >= 0
      && Number.isFinite(event?.durationMs)
      && event.durationMs >= 0),
  };
}

function assessStartupTimeline(events) {
  const required = [
    'app.bootstrap',
    'app.react.commit',
    'workspace.repository-open',
    'workspace.open',
    'engine.manifest.fetch',
    'engine.manifest.parse',
    'engine.worker.module',
    'engine.wasm.glue-import',
    'engine.wasm.fetch',
    'engine.wasm.download',
    'engine.wasm.compile',
    'engine.wasm.instantiate-and-start',
    'engine.session.construct',
    'engine.session.init',
    'engine.init.rpc',
    'engine.startup',
    'engine.ready',
  ];
  const byPhase = new Map();
  for (const entry of events || []) {
    if (!entry?.phase) continue;
    const values = byPhase.get(entry.phase) || [];
    values.push(entry);
    byPhase.set(entry.phase, values);
  }
  const missing = required.filter((phase) => (byPhase.get(phase)?.length ?? 0) !== 1);
  const invalid = required.filter((phase) => {
    const event = byPhase.get(phase)?.[0];
    return !event
      || !Number.isFinite(event.startMs)
      || event.startMs < 1_000_000_000_000
      || (event.durationMs != null
        && (!Number.isFinite(event.durationMs) || event.durationMs < 0));
  });
  const event = (phase) => byPhase.get(phase)?.[0];
  const end = (phase) => (event(phase)?.startMs ?? Number.NaN)
    + (event(phase)?.durationMs ?? 0);
  const ordered = [
    ['engine.wasm.glue-import', 'engine.wasm.fetch'],
    ['engine.wasm.compile', 'engine.wasm.instantiate-and-start'],
    ['engine.wasm.instantiate-and-start', 'engine.session.construct'],
    ['engine.session.construct', 'engine.session.init'],
    ['engine.session.init', 'engine.ready'],
  ].every(([before, after]) => end(before) <= (event(after)?.startMs ?? Number.NaN) + 2);
  const wasmFetch = event('engine.wasm.fetch');
  const wasmCompile = event('engine.wasm.compile');
  return {
    ok: missing.length === 0
      && invalid.length === 0
      && ordered
      && (wasmFetch?.inputBytes ?? 0) > 1_000_000
      && wasmCompile?.metrics?.streaming === 1,
    missing,
    invalid,
    ordered,
    wasmInputBytes: wasmFetch?.inputBytes ?? null,
    wasmTransferBytes: wasmFetch?.metrics?.transferBytes ?? null,
    wasmFromCache: wasmFetch?.fromCache ?? null,
  };
}

async function cdp(ws, method, params = {}, id = { n: 1 }) {
  return new Promise((resolve, reject) => {
    const msgId = id.n++;
    const limit = 120_000 * timeoutScale;
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      ws.removeEventListener('close', onClose);
      ws.removeEventListener('error', onError);
    };
    const onMsg = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === msgId) {
        cleanup();
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`CDP target closed during ${method}`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`CDP target failed during ${method}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`CDP ${method} timed out after ${limit}ms`));
    }, limit);
    ws.addEventListener('message', onMsg);
    ws.addEventListener('close', onClose, { once: true });
    ws.addEventListener('error', onError, { once: true });
    try {
      ws.send(JSON.stringify({ id: msgId, method, params }));
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
const id = { n: 1 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connectWebSocket(url, label = 'CDP target') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      cleanup();
      socket.close();
      reject(new Error(`${label} did not open within 30000ms`));
    }, 30_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('close', onClose);
      socket.removeEventListener('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`${label} closed before opening`));
    };
    const onError = () => {
      cleanup();
      reject(new Error(`${label} failed before opening`));
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('close', onClose, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

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

async function measureExclusivePreviewBoundary(ws) {
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }, id);
  const wide = await evalJs(ws, `(async () => {
    const authorTab = document.querySelector('#workspace-tab-author');
    const previewPanel = document.querySelector('#workspace-panel-preview');
    const frame = document.querySelector('.preview-frame');
    if (!authorTab || !previewPanel || !frame) return { error: 'missing workspace control' };
    authorTab.click();
    for (let step = 0; step < 4; step++) await new Promise(requestAnimationFrame);
    frame.focus();
    window.__exclusivePreviewBoundaryFrame = frame;
    return {
      width: innerWidth,
      previewHidden: !!previewPanel.hidden,
      previewRole: previewPanel.getAttribute('role') || '',
      frameFocused: document.activeElement === frame,
    };
  })()`);
  await cdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width: 1199,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  }, id);
  const result = await evalJs(ws, `(async () => {
    const settle = async () => {
      for (let frame = 0; frame < 4; frame++) await new Promise(requestAnimationFrame);
    };
    const authorTab = document.querySelector('#workspace-tab-author');
    const previewTab = document.querySelector('#workspace-tab-preview');
    const baselineFrame = window.__exclusivePreviewBoundaryFrame;
    delete window.__exclusivePreviewBoundaryFrame;
    if (!authorTab || !previewTab || !baselineFrame) return { error: 'missing workspace control' };
    authorTab.click();
    await settle();
    const authorPanel = document.querySelector('#workspace-panel-author');
    const previewPanel = document.querySelector('#workspace-panel-preview');
    const author = {
      selected: authorTab.getAttribute('aria-selected'),
      role: authorPanel?.getAttribute('role') || '',
      hidden: !!authorPanel?.hidden,
      previewHidden: !!previewPanel?.hidden,
      previewRole: previewPanel?.getAttribute('role') || '',
      visibleWorkspaces: [...document.querySelectorAll('.workspace-view')]
        .filter((view) => !view.hidden).length,
      frameCount: document.querySelectorAll('.preview-frame').length,
      sameFrame: document.querySelector('.preview-frame') === baselineFrame,
      focusRestoredToSelectedTab: document.activeElement === authorTab,
    };
    previewTab.click();
    await settle();
    const previewRect = previewPanel?.getBoundingClientRect();
    const preview = {
      selected: previewTab.getAttribute('aria-selected'),
      hidden: !!previewPanel?.hidden,
      role: previewPanel?.getAttribute('role') || '',
      visibleWorkspaces: [...document.querySelectorAll('.workspace-view')]
        .filter((view) => !view.hidden).length,
      frameCount: document.querySelectorAll('.preview-frame').length,
      sameFrame: document.querySelector('.preview-frame') === baselineFrame,
      width: previewRect?.width || 0,
    };
    return { width: innerWidth, wide: ${JSON.stringify(wide)}, author, preview };
  })()`);
  await cdp(ws, 'Emulation.clearDeviceMetricsOverride', {}, id);
  return result;
}

function exclusivePreviewBoundaryPass(result) {
  return result?.width === 1199
    && result.wide?.width === 1440
    && !result.wide?.previewHidden
    && result.wide?.previewRole === 'region'
    && result.wide?.frameFocused
    && result.author?.selected === 'true'
    && result.author?.role === 'tabpanel'
    && !result.author?.hidden
    && result.author?.previewHidden
    && result.author?.previewRole === 'tabpanel'
    && result.author?.visibleWorkspaces === 1
    && result.author?.frameCount === 1
    && result.author?.sameFrame
    && result.author?.focusRestoredToSelectedTab
    && result.preview?.selected === 'true'
    && !result.preview?.hidden
    && result.preview?.role === 'tabpanel'
    && result.preview?.visibleWorkspaces === 1
    && result.preview?.frameCount === 1
    && result.preview?.sameFrame
    && result.preview?.width >= 1198;
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
    const measureProgress = () => {
      const fixture = document.createElement('div');
      fixture.className = 'open-progress';
      fixture.dataset.stage = 'lazy-fetch';
      fixture.style.cssText = 'position:fixed;left:0;right:0;top:0;visibility:hidden;pointer-events:none';
      fixture.innerHTML = [
        '<div class="open-progress-bar"><div class="open-progress-fill"></div></div>',
        '<div class="open-progress-line">',
        '<span class="open-progress-heading"><span class="open-progress-stage">Loading profile dependencies</span></span>',
        '<span class="open-progress-msg">Loading (profile dependency) hl7.fhir.uv.extensions.r4#5.3.0…</span>',
        '<span class="progress-bytes" data-empty="true">&nbsp;</span>',
        '<span class="open-progress-elapsed">9s</span>',
        '</div>',
      ].join('');
      document.body.appendChild(fixture);
      const bytes = fixture.querySelector('.progress-bytes');
      const samples = [null, '0.00 / 0.74 MB', '0.52 / 0.74 MB', '10.0 / 120.0 MB'];
      const heights = samples.map((label) => {
        bytes.textContent = label || '\u00a0';
        if (label) bytes.removeAttribute('data-empty');
        else bytes.setAttribute('data-empty', 'true');
        return fixture.getBoundingClientRect().height;
      });
      const overflow = fixture.scrollWidth > fixture.clientWidth + 1;
      fixture.remove();
      return { heights, range: Math.max(...heights) - Math.min(...heights), overflow };
    };
    const progress = measureProgress();
    const measureNarrowBusyTabs = () => {
      const fixture = document.createElement('nav');
      fixture.className = 'inspect-tabs workspace-tabs';
      fixture.style.cssText = 'position:fixed;left:0;top:0;width:320px;visibility:hidden;pointer-events:none';
      fixture.innerHTML = [
        '<button class="inspect-tab active">Author</button>',
        '<button class="inspect-tab">Explore<span class="tab-busy">Preparing</span></button>',
        '<button class="inspect-tab">Site preview<span class="tab-busy">Building</span></button>',
      ].join('');
      document.body.appendChild(fixture);
      const result = {
        clientWidth: fixture.clientWidth,
        scrollWidth: fixture.scrollWidth,
        overflow: fixture.scrollWidth > fixture.clientWidth + 1,
        widths: [...fixture.querySelectorAll('.inspect-tab')]
          .map((tab) => tab.getBoundingClientRect().width),
      };
      fixture.remove();
      return result;
    };
    const narrowBusyTabs = measureNarrowBusyTabs();
    const mode = (name) => document.getElementById('workspace-tab-' + name);
    const tabReachability = () => Object.fromEntries(['author', 'explore', 'preview'].map((name) => {
      const button = mode(name);
      if (!button) return [name, { present: false }];
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return [name, {
        present: true,
        left: rect.left,
        right: rect.right,
        width: rect.width,
        withinViewport: rect.left >= -1 && rect.right <= innerWidth + 1,
        hitTarget: hit === button || button.contains(hit),
      }];
    }));
    const tabs = tabReachability();
    const selectMode = async (name) => {
      const button = mode(name);
      if (!button) throw new Error('missing workspace tab ' + name);
      const rect = button.getBoundingClientRect();
      const target = document.elementFromPoint(
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
      );
      if (!target || !(target === button || button.contains(target))) {
        throw new Error('workspace tab is not physically reachable: ' + name
          + ' rect=' + JSON.stringify({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom })
          + ' hit=' + (target ? target.tagName + '.' + target.className : 'null'));
      }
      target.click();
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
      progress,
      tabs,
      narrowBusyTabs,
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
    && ['author', 'explore', 'preview'].every((name) => result.tabs?.[name]?.withinViewport
      && result.tabs?.[name]?.hitTarget
      && result.tabs?.[name]?.width >= 44)
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
    && result.progress?.range < 1
    && !result.progress?.overflow
    && result.narrowBusyTabs?.clientWidth === 320
    && !result.narrowBusyTabs?.overflow
    && result.narrowBusyTabs?.widths?.every((width) => width >= 44)
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
  const tabConn = (wsUrl) => connectWebSocket(wsUrl, 'preview-tab CDP target');
  function tabCdp(tws, method, params = {}) {
    return cdp(tws, method, params, { get n() { return tabMsgId; }, set n(value) { tabMsgId = value; } });
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
    // Re-announce both pages before installing the test stamps. The committed
    // preview has one exact editor owner and no responder timeout window to
    // outwait; each page already carries the generation/content identity that
    // its hello message compares.
    out.helloResent = await tabEval(preview, `(() => { window.dispatchEvent(new Event('pageshow')); return true; })()`);
    if (profile) await tabEval(profile, `window.dispatchEvent(new Event('pageshow'))`);
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
    out.hotReloadLayoutBefore = await tabEval(preview, `({
      scrollY,
      scrollHeight: document.documentElement.scrollHeight,
      innerHeight,
      maxScrollY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
    })`);
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
    // /json/new calls leave the most recently opened preview tab foregrounded;
    // foreground the editor so scheduling reflects an active authoring session.
    await cdp(editorWs, 'Page.bringToFront', {}, id);
    // Edit index.md's H1 in the editor (via Monaco).
    out.editResult = await editorEval(`(async () => { const leaves = [...document.querySelectorAll('.file-tree *')].filter(e => e.children.length === 0); const row = leaves.find(e => (e.textContent || '').replace(/[^\\x20-\\x7e]/g, '').trim() === 'index.md'); if (!row) return 'no-row'; (row.closest('[class*=row]') || row).click(); await new Promise(r => setTimeout(r, 400)); const ed = window.monaco && window.monaco.editor.getEditors()[0]; if (!ed) return 'no-ed'; const m = ed.getModel(); const v = m.getValue(); if (!/^# /m.test(v)) return 'not-index'; m.setValue(v.replace(/^# .*/m, '# HOTRELOAD ' + Date.now())); return 'ok'; })()`);
    const tEdit = Date.now();
    const profileNavigationStart = profileNavigations.length;
    try {
      await tabWaitFor(preview, `window.__stamp !== 'IDX'`, 25000, 'index tab reloaded');
      out.hotReloadMs = Date.now() - tEdit;
      out.hotReloadFetch = await tabEval(preview, `(async () => {
        const response = await fetch(location.pathname);
        const text = await response.text();
        return {
          hasMarker: /HOTRELOAD/.test(text),
          source: response.headers.get('X-IGPreview-Source'),
          sha256: response.headers.get('X-Content-Sha256'),
          length: text.length,
          heading: document.querySelector('h1')?.textContent || '',
          control: [...document.querySelectorAll('script[data-igpreview="hot-reload"]')]
            .map((script) => script.textContent.match(/var me=(\\{.*?\\});/)?.[1] || ''),
        };
      })()`);
      out.indexHotReloaded = out.hotReloadFetch.hasMarker;
      if (out.hotReloadScrollBefore > 0) {
        await tabWaitFor(
          preview,
          `Math.abs(scrollY - ${JSON.stringify(out.hotReloadScrollBefore)}) <= 2`,
          3000,
          'hot-reload scroll restoration',
        ).catch(() => {});
      }
      out.hotReloadScrollAfter = await tabEval(preview, `scrollY`);
      out.hotReloadLayoutAfter = await tabEval(preview, `({
        scrollY,
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight,
        maxScrollY: Math.max(0, document.documentElement.scrollHeight - innerHeight),
      })`);
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
      const script = new URL('preview-sw.js?protocol=${PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL}', location.href).href;
      const registration = await navigator.serviceWorker.register(script, {
        scope,
        type: 'module',
        updateViaCache: 'none',
      });
      const candidate = registration.installing || registration.waiting || registration.active;
      if (!candidate) return { ok: false, state: null };
      if (candidate.state !== 'activated') await new Promise((resolve, reject) => {
        candidate.addEventListener('statechange', () => {
          if (candidate.state === 'activated') resolve();
          if (candidate.state === 'redundant') reject(new Error('replacement preview Worker became redundant'));
        });
      });
      return {
        ok: candidate.scriptURL === script,
        scriptURL: candidate.scriptURL,
        state: candidate.state,
      };
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
const page = targets?.find((t) => t.type === 'page');
if (!page?.webSocketDebuggerUrl) {
  throw new Error(`CDP exposes no page target at ${cdpHttp}`);
}
const ws = await connectWebSocket(page.webSocketDebuggerUrl, 'editor CDP target');

// Capture console + page errors for debugging.
const logs = [];
const runtimeExceptions = [];
// Bundle .tgz fetches, in order — drives the target-release gate. R4 snapshots
// must stay within the resolved R4 closure; r5.core is an on-demand candidate
// only for an actual R5 guide.
const bundleFetches = [];
const optionalEditorFetches = [];
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
    const asset = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    if (/^(?:CodeEditor|ResourceJson|monacoSetup|editor\.worker|json\.worker)-.*\.js$/.test(asset)) {
      optionalEditorFetches.push({ asset, at: Date.now() });
    }
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

const results = { requireMixedPreparedTransport };
function fail(msg) {
  console.error('FAIL:', msg);
  console.error('--- page logs ---\n' + logs.join('\n'));
  process.exit(1);
}

async function waitForOptionalEditorAsset(pattern, label) {
  const deadline = Date.now() + 30000 * timeoutScale;
  while (Date.now() < deadline) {
    const match = optionalEditorFetches.find(({ asset }) => pattern.test(asset));
    if (match) return match;
    await sleep(25);
  }
  throw new Error(`did not observe optional editor asset ${label}`);
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
  results.optionalEditorBeforeProject = [...optionalEditorFetches];
  if (results.optionalEditorBeforeProject.length !== 0) {
    throw new Error(`welcome screen eagerly loaded optional editor assets: ${JSON.stringify(results.optionalEditorBeforeProject)}`);
  }
  results.startupTimeline = await evalJs(ws, `(() => {
    const origin = performance.timeOrigin;
    return (window.__igDebug?.metrics || [])
      .map((entry) => entry.event)
      .filter((event) => event.phase && (
        event.phase.startsWith('app.')
        || event.phase.startsWith('workspace.')
        || event.phase.startsWith('engine.')
      ))
      .map((event) => ({
        ...event,
        relativeStartMs: event.startMs == null ? null : event.startMs - origin,
        relativeEndMs: event.startMs == null ? null : event.startMs - origin + (event.durationMs || 0),
      }));
  })()`);
  results.startupTimelineAssessment = assessStartupTimeline(results.startupTimeline);
  // A returning browser may have an older worker active for the same scope.
  // The app must wait for the versioned control protocol instead of sending a
  // commit that the old worker silently ignores (mobile timeout regression).
  // Engine readiness and installation of this separately scoped worker are
  // independent. A remote origin can expose that race even when loopback CI
  // cannot, so wait for activation before testing the protocol handshake.
  await waitFor(ws, `(async () => {
    const scope = new URL('preview/', location.href).href;
    const registration = await navigator.serviceWorker.getRegistration(scope);
    return registration?.active?.state === 'activated';
  })()`, 30000, 'preview Service Worker activation');
  results.previewWorker = await evalJs(ws, `(() => {
    const scope = new URL('preview/', location.href).href;
    return navigator.serviceWorker.getRegistration(scope).then(registration => new Promise(resolve => {
      const worker = registration && registration.active;
      if (!worker) { resolve({ error: 'no-active-worker' }); return; }
      const channel = new MessageChannel();
      channel.port1.onmessage = event => resolve({
        scriptURL: worker.scriptURL,
        addressProtocol: Number(new URL(worker.scriptURL).searchParams.get('protocol')),
        protocol: event.data?.protocol,
        state: worker.state,
      });
      worker.postMessage({ type: 'igpreview:ping', protocol: ${PREVIEW_SW_PROTOCOL} }, [channel.port2]);
    }));
  })()`);
  const protocolPattern = new RegExp(`[?&]protocol=${PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL}(?:&|$)`);
  if (results.previewWorker.protocol !== PREVIEW_SW_PROTOCOL || !protocolPattern.test(results.previewWorker.scriptURL || '')) {
    throw new Error('preview Service Worker protocol upgrade failed: ' + JSON.stringify(results.previewWorker));
  }
  if (process.env.PREINSTALL_LEGACY_PREVIEW_SW === '1') {
    results.legacyPreviewAfterTakeover = await evalJs(ws, `(async () => {
      const url = ${JSON.stringify(new URL('preview/legacy-fixture/en/index.html', base).href)};
      const frame = document.createElement('iframe');
      frame.id = 'legacy-takeover-preview';
      frame.src = url;
      document.body.append(frame);
      await new Promise((resolve, reject) => {
        frame.addEventListener('load', resolve, { once: true });
        frame.addEventListener('error', () => reject(new Error('legacy takeover navigation failed')), { once: true });
      });
      const response = await frame.contentWindow.fetch(url);
      const body = await response.text();
      return {
        status: response.status,
        source: response.headers.get('X-IGPreview-Source'),
        preserved: body.includes('verified protocol-6 preview'),
        caches: (await caches.keys()).filter(name => /igpreview-(?:state|output):v4/.test(name)).sort(),
      };
    })()`);
    if (results.legacyPreviewAfterTakeover.status !== 200
      || results.legacyPreviewAfterTakeover.source !== 'build-cache'
      || !results.legacyPreviewAfterTakeover.preserved) {
      throw new Error('protocol-6 verified preview did not survive protocol-8 takeover: '
        + JSON.stringify(results.legacyPreviewAfterTakeover));
    }
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
  const tinyOpenStarted = performance.now();
  await evalJs(ws, `document.querySelector('.welcome-card button').click()`);

  // 3. Wait for compile to finish (build status shows a ms value + resources).
  await waitFor(ws, `!!document.querySelector('.res-row')`, 60000, 'compiled resources');
  await sleep(400);
  await waitForOptionalEditorAsset(/^CodeEditor-/, 'CodeEditor');
  await waitForOptionalEditorAsset(/^monacoSetup-/, 'monacoSetup');
  await waitForOptionalEditorAsset(/^editor\.worker-/, 'editor.worker');
  results.optionalEditorAfterAuthor = [...optionalEditorFetches];
  if (results.optionalEditorAfterAuthor.some(({ asset }) => /^(?:ResourceJson|json\.worker)-/.test(asset))) {
    throw new Error(`Author eagerly loaded the JSON viewer: ${JSON.stringify(results.optionalEditorAfterAuthor)}`);
  }
  results.resourceCount = await evalJs(ws, `document.querySelectorAll('.res-row').length`);
  results.buildMs = await evalJs(
    ws,
    `(document.querySelectorAll('.bs-val')[2]?.textContent||'').trim()`,
  );
  results.cleanDiagnostics = await evalJs(ws, `document.querySelectorAll('.diag').length`);
  results.r5FetchedBeforeInspector = bundleFetches.some((b) => /r5\.core/.test(b.file));

  // 4. Explore opens the already-compiled differential. The R4 workspace and
  //    its full-definition snapshot must never inject an R5 core package.
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
  results.optionalEditorAfterDifferential = [...optionalEditorFetches];
  if (results.optionalEditorAfterDifferential.some(({ asset }) => /^(?:ResourceJson|json\.worker)-/.test(asset))) {
    throw new Error(`Differential eagerly loaded the JSON viewer: ${JSON.stringify(results.optionalEditorAfterDifferential)}`);
  }

  await evalJs(ws, `document.querySelector('#inspector-tab-json')?.click()`);
  await waitFor(
    ws,
    `window.monaco?.editor.getModels().some((model) => model.uri.path.includes('/__view__/')) === true`,
    30000,
    'compiled JSON Monaco model',
  );
  await waitForOptionalEditorAsset(/^ResourceJson-/, 'ResourceJson');
  await waitForOptionalEditorAsset(/^json\.worker-/, 'json.worker');
  results.optionalEditorAfterJson = [...optionalEditorFetches];
  await evalJs(ws, `document.querySelector('#inspector-tab-differential')?.click()`);
  await waitFor(
    ws,
    `document.querySelector('.inspector-tabs .tab-btn.active')?.textContent?.trim() === 'Differential'`,
    10000,
    'return from JSON to differential',
  );

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
  // Explore intentionally becomes useful as soon as compilation returns,
  // before the complete site catalog is published. Wait for that independent
  // third consequence rather than relying on the old UI behavior that kept
  // Explore blank until siteBuilding became false.
  await waitFor(ws, `(() => {
    const published = document.querySelectorAll('.artifact-trail-step')[2];
    return !document.querySelector('#workspace-tab-preview .tab-busy')
      && !!published
      && !published.disabled;
  })()`, 60000, 'tiny published consequence ready');
  if (process.env.PREINSTALL_LEGACY_PREVIEW_SW === '1') {
    results.legacyPreviewAfterOtherGuide = await evalJs(ws, `(async () => {
      const frame = document.querySelector('#legacy-takeover-preview');
      if (!frame?.contentWindow) throw new Error('legacy takeover client disappeared');
      const response = await frame.contentWindow.fetch(${JSON.stringify(new URL('preview/legacy-fixture/en/index.html', base).href)});
      const body = await response.text();
      return {
        status: response.status,
        source: response.headers.get('X-IGPreview-Source'),
        preserved: body.includes('verified protocol-6 preview'),
      };
    })()`);
    if (results.legacyPreviewAfterOtherGuide.status !== 200
      || results.legacyPreviewAfterOtherGuide.source !== 'build-cache'
      || !results.legacyPreviewAfterOtherGuide.preserved) {
      throw new Error('publishing Tiny erased another IG\'s protocol-6 preview: '
        + JSON.stringify(results.legacyPreviewAfterOtherGuide));
    }
  }
  results.tinyReadyMs = performance.now() - tinyOpenStarted;
  results.tinyCompileMs = await evalJs(
    ws,
    `(document.querySelectorAll('.bs-val')[2]?.textContent||'').trim()`,
  );
  results.packageBatchProgress = await evalJs(ws, `(() => (window.__igDebug?.metrics || [])
    .map((entry) => entry.event)
    .filter((event) => /(?:(?:Loading|Loaded) \\d+ of \\d+|Located \\d+) dependencies/.test(event.message || ''))
    .map((event) => ({ message: event.message, bytes: event.bytes ?? null, totalBytes: event.totalBytes ?? null })))()`);
  results.tinyColdBinaryMounts = await evalJs(ws, `(() => (window.__igDebug?.metrics || [])
    .map((entry) => entry.event)
    .filter((event) => event.stage === 'bundle-mount' && event.metrics?.preparedColdPrepare === 1)
    .map((event) => ({
      inputJsonBytes: event.metrics?.preparedInputJsonBytes ?? null,
      base64Bytes: event.metrics?.preparedBase64Bytes ?? null,
      workerSerializeMs: event.metrics?.workerSerializeMs ?? null,
    })))()`);
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

  // A semantic successor must remain a complete navigable site, not only a
  // successfully replaced profile page. Reproduce the reported sequence:
  // edit the open profile, then follow its real TOC and Artifacts links.
  results.tinyStructuralNavigation = await evalJs(ws, `(async () => {
    const frame = document.querySelector('.preview-frame');
    const win = frame?.contentWindow;
    const doc = win?.document;
    const editor = window.monaco?.editor.getEditors()[0];
    if (!win || !doc || !editor) return { error: 'profile-or-editor-unavailable' };
    const profilePath = win.location.pathname;
    const digest = async () => {
      const response = await win.fetch(profilePath);
      const bytes = await response.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map(value => value.toString(16).padStart(2, '0')).join('');
      return { hash, source: response.headers.get('X-IGPreview-Source') };
    };
    const before = await digest();
    win.__tinySemanticStamp = 'old';
    const model = editor.getModel();
    const source = model.getValue();
    if (!source.includes('* name.given 1..* MS')) {
      return { error: 'expected-cardinality-not-found', profilePath };
    }
    model.setValue(source.replace('* name.given 1..* MS', '* name.given 2..* MS'));
    return { profilePath, before };
  })()`);
  if (!results.tinyStructuralNavigation?.error) {
    await waitFor(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      return frame?.contentWindow?.location.pathname === ${JSON.stringify(results.tinyStructuralNavigation.profilePath)}
        && frame?.contentWindow?.__tinySemanticStamp !== 'old'
        && doc?.readyState === 'complete'
        && !doc.querySelector('[data-igpreview-fallback]')
        && /Name used while exploring the editor/.test(doc.body?.textContent || '');
    })()`, 30000, 'tiny semantic profile successor');
    results.tinyStructuralNavigation.after = await evalJs(ws, `(async () => {
      const frame = document.querySelector('.preview-frame');
      const win = frame?.contentWindow;
      const response = await win.fetch(win.location.pathname);
      const bytes = await response.arrayBuffer();
      return {
        hash: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
          .map(value => value.toString(16).padStart(2, '0')).join(''),
        source: response.headers.get('X-IGPreview-Source'),
      };
    })()`);
    results.tinyStructuralNavigation.catalog = await evalJs(ws, `(() => {
      const values = [...document.querySelectorAll('.preview-page-select option')]
        .map(option => option.value).filter(Boolean);
      return {
        toc: values.includes('en/toc.html'),
        artifacts: values.includes('en/artifacts.html'),
        templateInternals: values.filter(value => value.startsWith('template/')),
      };
    })()`);
    results.tinyStructuralNavigation.tocClick = await evalJs(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const win = frame?.contentWindow;
      const doc = win?.document;
      const link = [...(doc?.querySelectorAll('a[href]') || [])].find(candidate =>
        /\\/en\\/toc\\.html$/.test(new URL(candidate.getAttribute('href'), win.location.href).pathname));
      if (!link) return false;
      link.click();
      return true;
    })()`);
    await waitFor(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      return /\\/en\\/toc\\.html$/.test(frame?.contentWindow?.location.pathname || '')
        && doc?.readyState === 'complete'
        && !doc.querySelector('[data-igpreview-fallback]')
        && /Table of Contents/.test(doc.body?.textContent || '')
        && /IG Editor User/.test(doc.body?.textContent || '');
    })()`, 30000, 'tiny TOC after semantic successor');
    results.tinyStructuralNavigation.toc = await evalJs(ws, `(async () => {
      const frame = document.querySelector('.preview-frame');
      const win = frame?.contentWindow;
      const doc = win?.document;
      const response = await win.fetch(win.location.pathname);
      await response.arrayBuffer();
      const link = [...doc.querySelectorAll('a[href]')].find(candidate =>
        /\\/en\\/artifacts\\.html$/.test(new URL(candidate.getAttribute('href'), win.location.href).pathname));
      if (link) link.click();
      return {
        source: response.headers.get('X-IGPreview-Source'),
        fallback: !!doc.querySelector('[data-igpreview-fallback]'),
        artifactsClick: !!link,
      };
    })()`);
    await waitFor(ws, `(() => {
      const frame = document.querySelector('.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      return /\\/en\\/artifacts\\.html$/.test(frame?.contentWindow?.location.pathname || '')
        && doc?.readyState === 'complete'
        && !doc.querySelector('[data-igpreview-fallback]')
        && /Artifacts Summary/.test(doc.body?.textContent || '')
        && /IG Editor User/.test(doc.body?.textContent || '');
    })()`, 30000, 'tiny artifacts after semantic successor');
    results.tinyStructuralNavigation.artifacts = await evalJs(ws, `(async () => {
      const frame = document.querySelector('.preview-frame');
      const win = frame?.contentWindow;
      const doc = win?.document;
      const response = await win.fetch(win.location.pathname);
      await response.arrayBuffer();
      return {
        source: response.headers.get('X-IGPreview-Source'),
        fallback: !!doc.querySelector('[data-igpreview-fallback]'),
        textLength: doc.body?.textContent?.length || 0,
      };
    })()`);
  }
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
  results.tinyGuide.queryNavigation = await evalJs(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const narrative = doc?.querySelector('#segment-content');
    const menu = [...(doc?.querySelectorAll('li.dropdown') || [])]
      .find(item => /Live queries/.test(item.querySelector('.dropdown-toggle')?.textContent || ''));
    return {
      indexTable: !!narrative?.querySelector('a[href$="sql-table.html"]'),
      indexLiquid: !!narrative?.querySelector('a[href$="sql-liquid.html"]'),
      menuTable: !!menu?.querySelector('ul.dropdown-menu a[href$="sql-table.html"]'),
      menuLiquid: !!menu?.querySelector('ul.dropdown-menu a[href$="sql-liquid.html"]'),
    };
  })()`);

  await waitFor(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    return !!select && Array.from(select.options).some(candidate => /(?:^|\\/)sql-table\\.html$/.test(candidate.value));
  })()`, 10000, 'tiny SQL table page option');
  await evalJs(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    const option = select && Array.from(select.options).find(candidate => /(?:^|\\/)sql-table\\.html$/.test(candidate.value));
    if (!select || !option) throw new Error('tiny SQL table page is absent');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-sql-table');
    return root?.querySelectorAll('table tr').length === 4
      && /Author/.test(root?.textContent || '')
      && /Explore/.test(root?.textContent || '')
      && /Site preview/.test(root?.textContent || '');
  })()`, 30000, 'tiny direct SQL result');
  results.tinyGuide.sqlTable = await evalJs(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-sql-table');
    return {
      rows: root?.querySelectorAll('table tr').length || 0,
      cells: root?.querySelectorAll('table td').length || 0,
      values: [...(root?.querySelectorAll('table tr') || [])].slice(1)
        .map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent?.trim() || '')),
      leakedDirective: /\\{%|\\{\\{/.test(doc?.body?.textContent || ''),
    };
  })()`);

  await evalJs(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    const option = select && Array.from(select.options).find(candidate => /(?:^|\\/)sql-liquid\\.html$/.test(candidate.value));
    if (!select || !option) throw new Error('tiny SQL + Liquid page is absent');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-from-sql');
    return root?.querySelectorAll('li').length === 3
      && /3 editor views/.test(doc?.body?.textContent || '')
      && /Author/.test(root?.textContent || '')
      && /Explore/.test(root?.textContent || '')
      && /Site preview/.test(root?.textContent || '');
  })()`, 30000, 'tiny SQL data consumed by Liquid');
  results.tinyGuide.sqlLiquid = await evalJs(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-from-sql');
    return {
      rows: root?.querySelectorAll('li').length || 0,
      countText: /3 editor views/.test(doc?.body?.textContent || ''),
      values: [...(root?.querySelectorAll('li') || [])].map(item => item.textContent?.trim() || ''),
      leakedDirective: /\\{%|\\{\\{/.test(doc?.body?.textContent || ''),
    };
  })()`);

  // The SQL snapshot is current-build input, not a one-time fixture. Edit the
  // FSH CodeSystem while the SQL+Liquid page is selected, observe that selected
  // page update, then restore A and require A again.
  await evalJs(ws, `document.querySelector('#workspace-tab-author')?.click()`);
  await waitFor(ws, `document.querySelector('#workspace-tab-author')?.getAttribute('aria-selected') === 'true'`, 10000, 'Tiny SQL source author workspace');
  const sqlEditStarted = Date.now();
  results.tinyGuide.sqlEdit = await evalJs(ws, `(() => {
    const select = document.querySelector('.mobile-picker select');
    const path = [...(select?.options || [])]
      .map(option => option.value)
      .find(value => /(?:^|\\/)04-EditorStages\\.fsh$/.test(value));
    if (!select || !path) return { status: 'no-source' };
    select.value = path;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { status: 'selected', path };
  })()`);
  await waitFor(ws, `window.monaco?.editor.getModels().some((model) => /04-EditorStages\\.fsh$/.test(model.uri.path)) === true`, 30000, 'Tiny SQL CodeSystem model');
  const sqlEditApplied = await evalJs(ws, `(() => {
    const model = window.monaco?.editor.getModels()
      .find((candidate) => /04-EditorStages\\.fsh$/.test(candidate.uri.path));
    if (!model) return 'no-model';
    const before = '* #preview "Site preview" "Read the pages generated from those definitions."';
    const after = '* #preview "Live preview" "Watch this page regenerate from the current definitions."';
    const source = model.getValue();
    if (!source.includes(before)) return 'source-mismatch';
    window.__tinySqlOriginal = source;
    model.setValue(source.replace(before, after));
    return 'ok';
  })()`);
  if (sqlEditApplied !== 'ok') throw new Error(`Tiny SQL edit failed: ${sqlEditApplied}`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-from-sql');
    return root?.querySelectorAll('li').length === 3
      && /3 editor views/.test(doc?.body?.textContent || '')
      && /Live preview/.test(root?.textContent || '')
      && /Watch this page regenerate from the current definitions\./.test(root?.textContent || '');
  })()`, 30000, 'Tiny FSH edit reaches SQL + Liquid page');
  results.tinyGuide.sqlEdit = {
    ...results.tinyGuide.sqlEdit,
    status: 'updated',
    elapsedMs: Date.now() - sqlEditStarted,
  };
  await evalJs(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    const option = select && Array.from(select.options).find(candidate => /(?:^|\\/)sql-table\\.html$/.test(candidate.value));
    if (!select || !option) throw new Error('tiny SQL table page is absent after edit');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-sql-table');
    return root?.querySelectorAll('table tr').length === 4
      && /Live preview/.test(root?.textContent || '')
      && /Watch this page regenerate from the current definitions\./.test(root?.textContent || '');
  })()`, 30000, 'Tiny FSH edit reaches direct SQL table page');
  results.tinyGuide.sqlEdit.directRows = await evalJs(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    return doc?.querySelectorAll('#editor-stages-sql-table table tr').length || 0;
  })()`);
  await evalJs(ws, `(() => {
    const select = document.querySelector('.preview-page-select select');
    const option = select && Array.from(select.options).find(candidate => /(?:^|\\/)sql-liquid\\.html$/.test(candidate.value));
    if (!select || !option) throw new Error('tiny SQL + Liquid page is absent after edit');
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-from-sql');
    return root?.querySelectorAll('li').length === 3
      && /3 editor views/.test(doc?.body?.textContent || '')
      && /Live preview/.test(root?.textContent || '')
      && /Watch this page regenerate from the current definitions\./.test(root?.textContent || '');
  })()`, 30000, 'Tiny SQL + Liquid page remains current after direct SQL check');
  const sqlRestoreStarted = Date.now();
  const sqlRestoreApplied = await evalJs(ws, `(() => {
    const model = window.monaco?.editor.getModels()
      .find((candidate) => /04-EditorStages\\.fsh$/.test(candidate.uri.path));
    if (!model || typeof window.__tinySqlOriginal !== 'string') return 'no-model';
    model.setValue(window.__tinySqlOriginal);
    delete window.__tinySqlOriginal;
    return 'ok';
  })()`);
  if (sqlRestoreApplied !== 'ok') throw new Error(`Tiny SQL restore failed: ${sqlRestoreApplied}`);
  await waitForStable(ws, `(() => {
    const frame = document.querySelector('.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const root = doc?.querySelector('#editor-stages-from-sql');
    return root?.querySelectorAll('li').length === 3
      && /3 editor views/.test(doc?.body?.textContent || '')
      && /Site preview/.test(root?.textContent || '')
      && !/Live preview/.test(root?.textContent || '');
  })()`, 30000, 'Tiny SQL A-B-A restoration');
  results.tinyGuide.sqlEdit.restoreElapsedMs = Date.now() - sqlRestoreStarted;
  results.tinyGuide.templatePreferencePreserved = await evalJs(ws,
    `localStorage.getItem('igEditor.templateCoord') === 'hl7.fhir.template#0.10.1'`,
  );

  if (process.env.E2E_MOBILE_LAYOUT_ONLY === '1') {
    await cdp(ws, 'Page.reload', {}, id);
    await waitFor(ws, `(() => localStorage.getItem('igEditor.project') === 'tiny'
      && document.querySelector('.preview-template-select select')?.value === 'hl7.fhir.template'
      && document.querySelector('.preview-template-version select')?.value === '1.0.0'
      && document.querySelectorAll('.res-row').length === 5)()`, 60000, 'persisted Tiny template after reload');
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
    console.log(JSON.stringify({
      tinyReadyMs: results.tinyReadyMs,
      tinyCompileMs: results.tinyCompileMs,
      packageBatchProgress: results.packageBatchProgress,
      tinyColdBinaryMounts: results.tinyColdBinaryMounts,
      tinyReload: results.tinyReload,
      mobile390: results.mobile390,
    }, null, 2));
    if (!results.packageBatchProgress.some((event) => /of [2-9] dependencies/.test(event.message))
      || results.packageBatchProgress.some((event) => event.totalBytes != null)) {
      throw new Error('parallel package progress was not presented as one honest aggregate');
    }
    if (results.packageBatchProgress.some((event) => /^Loaded /.test(event.message))
      || results.tinyColdBinaryMounts.length === 0
      || results.tinyColdBinaryMounts.some((event) => event.inputJsonBytes !== 0
        || event.base64Bytes !== 0
        || event.workerSerializeMs !== 0)) {
      throw new Error('Tiny cold packages did not stay compressed/binary through Worker preparation');
    }
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
    await waitFor(ws, `[...document.querySelectorAll('.res-row')]
      .some(r => /e2e-external-filter|E2EExternalFilter/i.test(r.textContent || ''))`,
      15000, 'external-filter ValueSet compiled');
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
  //    something with an unresolvable insert rule, and let the latest-only build run.
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
  results.diagnosticNavigation = await evalJs(ws, `(async () => {
    const details = document.querySelector('details.problems');
    if (details) details.open = true;
    const diagnostic = [...document.querySelectorAll('.diag')]
      .find((candidate) => candidate.textContent?.includes('NoSuchRuleSet'));
    const source = diagnostic?.querySelector('button.diag-source');
    const definition = [...(diagnostic?.querySelectorAll('.diag-actions button') || [])]
      .find((button) => button.textContent?.trim() === 'Definition');
    const before = {
      sourceControl: source?.tagName || '',
      hasDefinition: Boolean(definition),
    };
    source?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterSource = {
      mode: document.querySelector('.workspace-views')?.dataset.mode || '',
      subject: document.querySelector('.artifact-trail-subject')?.textContent || '',
      file: document.querySelector('.tree-row.file.active')?.getAttribute('title') || '',
      drawerOpen: Boolean(details?.open),
    };
    if (details) details.open = true;
    const refreshed = [...document.querySelectorAll('.diag')]
      .find((candidate) => candidate.textContent?.includes('NoSuchRuleSet'));
    const refreshedDefinition = [...(refreshed?.querySelectorAll('.diag-actions button') || [])]
      .find((button) => button.textContent?.trim() === 'Definition');
    refreshedDefinition?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const afterDefinition = {
      mode: document.querySelector('.workspace-views')?.dataset.mode || '',
      subject: document.querySelector('.artifact-trail-subject')?.textContent || '',
      drawerOpen: Boolean(details?.open),
    };
    if (details) details.open = true;
    const publishedDiagnostic = [...document.querySelectorAll('.diag')]
      .find((candidate) => candidate.textContent?.includes('NoSuchRuleSet'));
    const published = [...(publishedDiagnostic?.querySelectorAll('.diag-actions button') || [])]
      .find((button) => /published page/i.test(button.textContent || ''));
    published?.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      ...before,
      hasPublished: Boolean(published),
      afterSource,
      afterDefinition,
      afterPublished: {
        mode: document.querySelector('.workspace-views')?.dataset.mode || '',
        subject: document.querySelector('.artifact-trail-subject')?.textContent || '',
        page: document.querySelector('.preview-page-select select')?.value || '',
        drawerOpen: Boolean(details?.open),
      },
    };
  })()`);

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
    results.stockWarmReuse = assessWarmEditMetrics(results.stockWarmEditMetrics);
    await waitForStable(ws, stockMarkerCurrent, 5000, 'stock warm edit remains current');
  }

  if (process.env.E2E_PREVIEW_SMOKE_ONLY === '1') {
    console.log(JSON.stringify(results, null, 2));
    const smokeOk = results.previewWorker?.protocol === PREVIEW_SW_PROTOCOL
      && results.previewHasIgContent
      && results.stockIndexLen > 500
      && results.stockProfilePage?.hasHierarchy
      && results.stockEditResult === 'ok'
      && results.stockWarmReuse?.ok
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
      window.__antRefusalCapture = null;
      window.__antRefusalObserver?.disconnect();
      const capture = () => {
        const message = document.querySelector('.preview-template-error')?.textContent?.trim() || '';
        if (/server-side|ant/i.test(message)) window.__antRefusalCapture = message;
      };
      window.__antRefusalObserver = new MutationObserver(capture);
      window.__antRefusalObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      capture();
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
    await waitFor(ws, `(() => !!window.__antRefusalCapture)()`, 30000, 'AntHookError refusal banner');
    results.antRefusal = await evalJs(ws, `window.__antRefusalCapture`);
    await evalJs(ws, `window.__antRefusalObserver?.disconnect()`);
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
      duplicateStatus: false, indefiniteAnimation: false, pendingDefinitions: false
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
        if (['bundle-fetch', 'registry-fetch', 'lazy-fetch'].includes(s)) {
          const profileStat = [...document.querySelectorAll('.overview-stat')]
            .find((stat) => stat.querySelector('span')?.textContent?.trim() === 'profiles');
          const picker = document.querySelector('.explore-workspace .mobile-picker select');
          const waiting = document.querySelector('.overview-problems.is-pending');
          if (profileStat?.querySelector('strong')?.textContent?.trim() === '…'
              && picker?.disabled
              && /waiting for compilation/i.test(waiting?.textContent || '')) {
            op.pendingDefinitions = true;
          }
        }
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
    results.openProgressPendingDefinitions = prog.pendingDefinitions;
    results.openProgressCleared = prog.cleared && await evalJs(ws, `!document.querySelector('.open-progress')`);
    results.openProgressByteMetrics = await evalJs(ws, `
      (window.__igDebug?.metrics || []).slice(${JSON.stringify(openProgressMetricStart)})
        .map(x => x.event)
        .filter(e => e.bytes != null)
        .map(e => ({ stage: e.stage, bytes: e.bytes, totalBytes: e.totalBytes }))
    `);
    results.mixedPreparedTransport = await evalJs(ws, `(() => {
      const events = (window.__igDebug?.metrics || [])
        .slice(${JSON.stringify(openProgressMetricStart)}).map((entry) => entry.event);
      const preparedHits = [...new Set(events
        .filter((event) => event.stage === 'bundle-cache-hit' && event.label)
        .map((event) => event.label))];
      const refetched = [...new Set(events
        .filter((event) => ['bundle-fetch', 'lazy-fetch'].includes(event.stage)
          && preparedHits.includes(event.label))
        .map((event) => event.label))];
      const mixedMounts = events.filter((event) => event.stage === 'bundle-mount'
        && event.metrics?.preparedMixed === 1).length;
      return { preparedHits, refetched, mixedMounts };
    })()`);
    results.usCoreResourceCount = await evalJs(ws, `document.querySelectorAll('.res-row').length`);
    console.error('[diag] usCoreResourceCount =', results.usCoreResourceCount);

    // Opening a complete published guide and its Explore workspace uses only
    // the compiled differential. R5/snapshot support is an explicit tool:
    // prove it remains absent through US Core prepare, then appears only after
    // the user requests the full definition (FHIR snapshot).
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
        .find((candidate) => candidate.textContent?.trim() === 'Full definition');
      if (!button) throw new Error('Full definition action is absent for US Core');
      button.click();
    })()`);
    await waitFor(ws, `!!document.querySelector('.snapshot .sd-table tbody tr')`, 30000, 'US Core snapshot tree');
    results.snapshotRows = await evalJs(ws, `document.querySelectorAll('.snapshot .sd-table tbody tr').length`);
    results.snapshotMeta = await evalJs(ws, `document.querySelector('.snapshot-meta')?.textContent || ''`);
    results.r5FetchedForR4Snapshot = bundleFetches.some((b) => /r5\.core/.test(b.file));

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

          results.usCoreStructuralNavigation = await evalJs(ws, `(() => {
            const frame = document.querySelector('.preview-frame');
            const win = frame?.contentWindow;
            const doc = win?.document;
            const values = [...document.querySelectorAll('.preview-page-select option')]
              .map(option => option.value).filter(Boolean);
            const link = [...(doc?.querySelectorAll('a[href]') || [])].find(candidate =>
              /\\/en\\/toc\\.html$/.test(new URL(candidate.getAttribute('href'), win.location.href).pathname));
            if (link) link.click();
            return {
              catalogToc: values.includes('en/toc.html'),
              catalogArtifacts: values.includes('en/artifacts.html'),
              tocClick: !!link,
            };
          })()`);
          await waitFor(ws, `(() => {
            const frame = document.querySelector('.preview-frame');
            const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
            return /\\/en\\/toc\\.html$/.test(frame?.contentWindow?.location.pathname || '')
              && doc?.readyState === 'complete'
              && !doc.querySelector('[data-igpreview-fallback]')
              && /Table of Contents/.test(doc.body?.textContent || '');
          })()`, 30000, 'US Core TOC from CarePlan profile');
          Object.assign(results.usCoreStructuralNavigation, await evalJs(ws, `(async () => {
            const frame = document.querySelector('.preview-frame');
            const win = frame?.contentWindow;
            const doc = win?.document;
            const response = await win.fetch(win.location.pathname);
            await response.arrayBuffer();
            const link = [...doc.querySelectorAll('a[href]')].find(candidate =>
              /\\/en\\/artifacts\\.html$/.test(new URL(candidate.getAttribute('href'), win.location.href).pathname));
            if (link) link.click();
            return {
              tocSource: response.headers.get('X-IGPreview-Source'),
              tocFallback: !!doc.querySelector('[data-igpreview-fallback]'),
              artifactsClick: !!link,
            };
          })()`));
          await waitFor(ws, `(() => {
            const frame = document.querySelector('.preview-frame');
            const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
            return /\\/en\\/artifacts\\.html$/.test(frame?.contentWindow?.location.pathname || '')
              && doc?.readyState === 'complete'
              && !doc.querySelector('[data-igpreview-fallback]')
              && /Artifacts Summary/.test(doc.body?.textContent || '');
          })()`, 30000, 'US Core Artifacts from TOC');
          Object.assign(results.usCoreStructuralNavigation, await evalJs(ws, `(async () => {
            const frame = document.querySelector('.preview-frame');
            const win = frame?.contentWindow;
            const doc = win?.document;
            const response = await win.fetch(win.location.pathname);
            await response.arrayBuffer();
            return {
              artifactsSource: response.headers.get('X-IGPreview-Source'),
              artifactsFallback: !!doc.querySelector('[data-igpreview-fallback]'),
              artifactsTextLength: doc.body?.textContent?.length || 0,
            };
          })()`));
        } else {
          results.usCoreCarePlan = null;
          results.usCoreStructuralNavigation = null;
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
    results.engineLifecycleBeforeMcode = await evalJs(ws, `(() => ({
      preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
      recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
    }))()`);
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
    results.engineLifecycleAfterMcode = await evalJs(ws, `(() => ({
      preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
      recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
    }))()`);

    // ---- Authored structural-page precedence (Genomics) -------------------
    // This guide deliberately supplies input/pages/artifacts.md, including a
    // SQL-to-Liquid query. It must replace only the generated artifacts
    // default while the ordinary verified catalog and TOC remain intact.
    results.genomicsClicked = await evalJs(ws, `(() => {
      const select = document.querySelector('.open-ig-select');
      if (!select || ![...select.options].some((option) => option.value === 'genomics')) return 'no-genomics-option';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'genomics');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return 'clicked';
    })()`);
    if (results.genomicsClicked === 'clicked') {
      await waitFor(ws, `localStorage.getItem('igEditor.project') === 'genomics' && !!document.querySelector('.open-progress')`, 30000, 'Genomics open-progress overlay appeared');
      await waitFor(ws, `localStorage.getItem('igEditor.project') === 'genomics' && !document.querySelector('.open-progress')`, 180000, 'Genomics preparation completed');
      await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
      await waitFor(ws, `(() => [...document.querySelectorAll('.preview-page-select option')]
        .some((option) => option.value === 'en/artifacts.html'))()`, 120000, 'Genomics authored artifacts page in catalog');
      await evalJs(ws, `(() => {
        const select = document.querySelector('.preview-page-select select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'en/artifacts.html');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitForStable(ws, `(() => {
        const frame = document.querySelector('.preview-frame');
        const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
        return /\\/preview\\/genomics\\/en\\/artifacts\\.html$/.test(frame?.contentWindow?.location.pathname || '')
          && doc?.readyState === 'complete'
          && !doc.querySelector('[data-igpreview-fallback]')
          && /Abstract Profiles/.test(doc.body?.textContent || '')
          && /Operation Definitions/.test(doc.body?.textContent || '');
      })()`, 120000, 'Genomics authored SQL artifacts page rendered');
      results.genomicsAuthoredArtifacts = await evalJs(ws, `(async () => {
        const frame = document.querySelector('.preview-frame');
        const win = frame?.contentWindow;
        const doc = win?.document;
        const response = await win.fetch(win.location.pathname);
        await response.arrayBuffer();
        return {
          project: localStorage.getItem('igEditor.project'),
          catalogToc: [...document.querySelectorAll('.preview-page-select option')]
            .some((option) => option.value === 'en/toc.html'),
          source: response.headers.get('X-IGPreview-Source'),
          fallback: !!doc.querySelector('[data-igpreview-fallback]'),
          rawSql: /{%\\s*sql(?:ToData)?/.test(doc.documentElement?.textContent || ''),
          textLength: doc.body?.textContent?.length || 0,
        };
      })()`);
      await evalJs(ws, `(() => {
        const select = document.querySelector('.preview-page-select select');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, 'en/toc.html');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitForStable(ws, `(() => {
        const frame = document.querySelector('.preview-frame');
        const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
        return /\\/preview\\/genomics\\/en\\/toc\\.html$/.test(frame?.contentWindow?.location.pathname || '')
          && doc?.readyState === 'complete'
          && !doc.querySelector('[data-igpreview-fallback]')
          && /Table of Contents/.test(doc.body?.textContent || '');
      })()`, 120000, 'Genomics generated TOC rendered beside authored artifacts');
      Object.assign(results.genomicsAuthoredArtifacts, await evalJs(ws, `(async () => {
        const frame = document.querySelector('.preview-frame');
        const win = frame?.contentWindow;
        const doc = win?.document;
        const response = await win.fetch(win.location.pathname);
        await response.arrayBuffer();
        return {
          tocSource: response.headers.get('X-IGPreview-Source'),
          tocFallback: !!doc.querySelector('[data-igpreview-fallback]'),
        };
      })()`));
    }

    // Restore the exact stock-template project state the preview-window gate needs:
    // re-open the Cycle fixture, switch its preview generator to the stock template,
    // and wait for its page list + index render. (Opening catalog IGs switched the
    // project and its default generator.)
    results.engineLifecycleBeforeCycle = await evalJs(ws, `(() => ({
      preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
      lastCompiledResourceCount: window.__igDebug?.engine?.lastCompiledResourceCount ?? -1,
      recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
    }))()`);
    console.error('[diag] engine lifecycle before Cycle =', results.engineLifecycleBeforeCycle);
    await evalJs(ws, `(() => {
      const select = document.querySelector('.open-ig-select');
      if (!select) throw new Error('Switch guide selector is absent');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'cycle');
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await waitForStable(ws, `localStorage.getItem('igEditor.project') === 'cycle' && !document.querySelector('.open-progress')`, 120000, 'Cycle project replaced catalog guide');
    // Resource rows only exist while Explore is mounted. The catalog checks above
    // intentionally leave the single-surface UI on Site preview, so assert the
    // compiled Cycle resources after selecting their owning surface instead of
    // treating an unmounted inspector as a project-open race.
    await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/explore/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
    try {
      await waitForStable(ws, `(() => localStorage.getItem('igEditor.project') === 'cycle'
        && [...document.querySelectorAll('.res-row')]
          .some(row => /ValueSet/.test(row.querySelector('.res-type')?.textContent || '')))()`, 30000, 'Cycle compiled resources restored');
    } catch (error) {
      const dump = await evalJs(ws, `(() => ({
        project: localStorage.getItem('igEditor.project'),
        mode: document.querySelector('.workspace-views')?.dataset.mode || '',
        rows: [...document.querySelectorAll('.res-row')].slice(0, 20).map(row => row.textContent?.trim() || ''),
        state: document.querySelector('.project-state')?.textContent || '',
        openError: document.querySelector('.open-error')?.textContent || '',
        previewError: document.querySelector('.preview-error')?.textContent || '',
        status: document.querySelector('.statusline')?.textContent || '',
        progress: document.querySelector('.open-progress')?.textContent || '',
        diagnostics: [...document.querySelectorAll('.diag')].slice(0, 20).map(diag => diag.textContent || ''),
        metrics: (window.__igDebug?.metrics || []).slice(-30),
        lifecycle: {
          preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
          lastCompiledResourceCount: window.__igDebug?.engine?.lastCompiledResourceCount ?? -1,
          recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
        },
      }))()`);
      console.error('[diag] Cycle reopen after catalog guides:', JSON.stringify(dump, null, 2));
      throw error;
    }

    // The Cycle index was edited twice before switching through US Core and
    // mCODE; the stock warm-edit marker is the final authored value.
    // Prove that selecting A after B/C reopens A's mutable workspace rather
    // than reinstalling its catalog archive, then reload the editor and prove
    // the same dirty bytes survive OPFS restoration.
    const readCycleWorkspaceMarker = async (label) => {
      await evalJs(ws, `document.querySelector('#workspace-tab-author')?.click()`);
      await waitForStable(
        ws,
        `document.querySelector('#workspace-tab-author')?.getAttribute('aria-selected') === 'true'`,
        10000,
        `${label}: Author workspace`,
      );
      const outcome = await evalJs(ws, `(async () => {
        const leaves = [...document.querySelectorAll('.file-tree *')]
          .filter(element => element.children.length === 0);
        const row = leaves.find(element =>
          (element.textContent || '').replace(/[^\\x20-\\x7e]/g, '').trim() === 'index.md');
        if (!row) return { error: 'no-index-row' };
        (row.closest('[class*=row]') || row).click();
        await new Promise(resolve => setTimeout(resolve, 400));
        const editor = window.monaco?.editor.getEditors()[0];
        const value = editor?.getModel()?.getValue() || '';
        return {
          marker: /# Stock Warm Edit Marker/m.test(value),
          prefix: value.slice(0, 120),
        };
      })()`);
      return outcome;
    };
    results.workspaceDirtyAfterABA = await readCycleWorkspaceMarker('Cycle A -> B/C -> A');

    await cdp(ws, 'Page.reload', {}, id);
    await waitForStable(
      ws,
      `localStorage.getItem('igEditor.project') === 'cycle'
        && !!window.__igDebug?.engine
        && !!document.querySelector('.project-overview')`,
      120000,
      'Cycle dirty workspace after editor reload',
    );
    results.workspaceDirtyAfterReload = await readCycleWorkspaceMarker('Cycle reload');

    // Ensure we're on the Site preview tab, then re-select the stock-template generator.
    await evalJs(ws, `(() => { const t=[...document.querySelectorAll('.inspect-tab')].find(x=>/preview/i.test(x.textContent||'')); if(t) t.click(); return true; })()`);
    await waitFor(ws, `!!document.querySelector('.preview-generator-select select')`, 30000, 'preview generator select present');
    await waitForStable(ws, `document.querySelector('.preview-generator-select select')?.value === 'cycle'`, 30000, 'Cycle fixture reset to Cycle generator');
    await evalJs(ws, `(() => {
      window.__e2ePublisherMetricStart = window.__igDebug?.metrics?.length || 0;
      const sel = document.querySelector('.preview-generator-select select');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, 'hl7.fhir.template');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    // A prior verified page/catalog is intentionally visible while rebuilding.
    // Require this exact Publisher generation to finish before the independent
    // window test, or stale-but-valid content can satisfy the page-list wait.
    await waitForStable(ws, `(() => {
      const generator = document.querySelector('.preview-generator-select select');
      const opts = [...document.querySelectorAll('.preview-page-select option')].map(o => o.value);
      const currentEvents = (window.__igDebug?.metrics || [])
        .slice(window.__e2ePublisherMetricStart || 0)
        .map((entry) => entry.event);
      return generator?.value === 'hl7.fhir.template'
        && !document.querySelector('#workspace-tab-preview .tab-busy')
        && !document.querySelector('.preview-error')
        && currentEvents.some((event) => event.phase === 'preview.publish')
        && opts.some(v => v.startsWith('en/'));
    })()`, 90000, 'current stock template page list restored');
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

    // A narrative page has no exact FHIR subject, so selecting it must clear
    // the prior artifact trail rather than claiming an unrelated definition.
    results.narrativePageClearsTrail = await evalJs(ws, `(() => ({
      empty: !!document.querySelector('.artifact-trail-empty'),
      subject: document.querySelector('.artifact-trail-subject')?.textContent || '',
    }))()`);
    await evalJs(ws, `(() => {
      const row = [...document.querySelectorAll('.res-row')].find((candidate) =>
        candidate.querySelector('.res-type')?.textContent === 'StructureDefinition'
        && candidate.querySelector('.res-id')?.textContent === 'period-tracking-bundle');
      if (!row) throw new Error('exact artifact row unavailable');
      row.click();
    })()`);

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
      const current = await evalJs(ws, `(() => {
        const steps = [...document.querySelectorAll('.artifact-trail-step')];
        const selected = steps.filter((step) => step.getAttribute('aria-current') === 'step');
        return { count: selected.length, index: steps.indexOf(selected[0]) };
      })()`);
      results.trailCurrents = [...(results.trailCurrents || []), current];
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

    // The wide companion switches off at the exact 1200px boundary. Prove the
    // already-mounted iframe returns to the ordinary one-visible-tab contract
    // at 1199px before exercising the narrower phone layout.
    results.exclusivePreview1199 = await measureExclusivePreviewBoundary(ws);

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
  // `latest`, and assert nothing blocks. This must run before the synthetic
  // registry gate below switches the single-scope observation cache to its fake
  // registry source.
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

  // ---- typed next-registry + atomic Worker mount gate ----------------------
  // Exercise the complete production seam rather than composing its unit-test
  // halves: registry transport -> transferred TGZ -> typed Worker rejection ->
  // next registry -> the same resolver-indexed Rust ticket -> one commit. Hold a
  // sibling package after it has staged so resolveProject can prove staged bytes
  // remain invisible until the complete transaction commits.
  results.registryTgzRetry = await evalJs(ws, `(async () => {
    const engine = window.__igDebug && window.__igDebug.engine;
    if (!engine) return { error: 'no-engine' };
    const retryLabel = 'e2e.registry.retry#1.0.0';
    const siblingLabel = 'e2e.registry.sibling#1.0.0';
    const registryOne = 'https://registry-one.invalid';
    const registryTwo = 'https://registry-two.invalid';
    const retryFixtureUrl = ${JSON.stringify(new URL('data/fixtures/e2e.registry.retry%231.0.0.tgz', base).href)};
    const siblingFixtureUrl = ${JSON.stringify(new URL('data/fixtures/e2e.registry.sibling%231.0.0.tgz', base).href)};
    const deadlineMs = ${JSON.stringify(30_000 * timeoutScale)};
    const realFetch = window.fetch;
    const events = [];
    const requests = [];
    let acquisition = null;
    let acquisitionOutcome = null;

    const deferred = () => {
      let resolve;
      const promise = new Promise((accept) => { resolve = accept; });
      return { promise, resolve };
    };
    const within = async (promise, label) => {
      let timer;
      try {
        return await Promise.race([
          promise,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('timed out waiting for ' + label)), deadlineMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const labelsFrom = (requestsToLabel) => (requestsToLabel || [])
      .map((request) => request.package_id + '#' + request.version);
    const retrySecondRequested = deferred();
    const releaseRetrySecond = deferred();
    const releaseSiblingFirst = deferred();
    const siblingStaged = deferred();
    let midpoint = null;

    try {
      const loadFixture = async (url) => {
        const response = await realFetch(url);
        if (!response.ok) throw new Error('fixture fetch failed: ' + url + ' -> ' + response.status);
        return response.arrayBuffer();
      };
      const [retryBytes, siblingBytes] = await Promise.all([
        loadFixture(retryFixtureUrl),
        loadFixture(siblingFixtureUrl),
      ]);
      const config = [
        'id: test.registry.retry',
        'canonical: https://example.org/registry-retry',
        'name: RegistryRetryProbe',
        'status: draft',
        'version: 0.0.1',
        'fhirVersion: 4.0.1',
        'dependencies:',
        '  hl7.fhir.uv.tools.r4: 1.1.2',
        '  hl7.terminology.r4: 7.2.0',
        '  hl7.fhir.uv.extensions.r4: 5.3.0',
        '  e2e.registry.retry: 1.0.0',
        '  e2e.registry.sibling: 1.0.0',
      ].join('\\n');
      const source = {
        registries: [registryOne, registryTwo],
        proxy: '',
        sourceKey: JSON.stringify([[registryOne, registryTwo], '']),
      };
      const initial = await within(engine.resolveStep(config), 'initial resolver step');
      const initialMissing = labelsFrom(initial.missing);
      if (initialMissing.length !== 2
          || !initialMissing.includes(retryLabel)
          || !initialMissing.includes(siblingLabel)) {
        throw new Error('retry fixture expected exactly two missing packages, got ' + JSON.stringify(initialMissing));
      }

      const response = (bytes) => new Response(bytes.slice(0), {
        status: 200,
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': 'application/gzip',
        },
      });
      const retryFirst = registryOne + '/e2e.registry.retry/1.0.0';
      const retrySecond = registryTwo + '/e2e.registry.retry/1.0.0';
      const siblingFirst = registryOne + '/e2e.registry.sibling/1.0.0';
      const siblingSecond = registryTwo + '/e2e.registry.sibling/1.0.0';
      window.fetch = async (input, init) => {
        const url = input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : String(input);
        if (!url.startsWith(registryOne + '/') && !url.startsWith(registryTwo + '/')) {
          return realFetch(input, init);
        }
        requests.push(url);
        if (url === retryFirst) {
          const invalid = new TextEncoder().encode('http-200-but-not-a-tgz');
          return response(invalid.buffer);
        }
        if (url === retrySecond) {
          retrySecondRequested.resolve();
          await within(releaseRetrySecond.promise, 'release of retry registry response');
          return response(retryBytes);
        }
        if (url === siblingFirst) {
          await within(releaseSiblingFirst.promise, 'release of sibling registry response');
          return response(siblingBytes);
        }
        if (url === siblingSecond) {
          throw new Error('sibling package unexpectedly reached the second registry');
        }
        throw new Error('unexpected test-registry request: ' + url);
      };

      acquisition = engine.acquireForProject(config, (event) => {
        events.push(event);
        if (event.phase === 'package.stage' && event.label === siblingLabel) {
          siblingStaged.resolve();
        }
      }, source);
      acquisitionOutcome = acquisition.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      const waitForGate = async (gate, label) => {
        const winner = await within(Promise.race([
          gate.then(() => ({ kind: 'gate' })),
          acquisitionOutcome.then((outcome) => ({ kind: 'acquisition', outcome })),
        ]), label);
        if (winner.kind === 'gate') return;
        if (!winner.outcome.ok) throw winner.outcome.error;
        throw new Error('acquisition completed before ' + label);
      };
      await waitForGate(retrySecondRequested.promise, 'typed next-registry request');
      releaseSiblingFirst.resolve();
      await waitForGate(siblingStaged.promise, 'sibling package staging');

      // The real Worker has staged the sibling at its resolver slot. The Rust
      // package generation must nevertheless expose neither candidate yet.
      midpoint = await within(engine.resolveStep(config), 'mid-transaction resolver step');
      releaseRetrySecond.resolve();
      const settled = await within(acquisitionOutcome, 'registry retry acquisition');
      if (!settled.ok) throw settled.error;
      const outcome = settled.value;
      const finalStep = await within(engine.resolveStep(config), 'final resolver step');
      const countPhase = (phase) => events.filter((event) => event.phase === phase).length;
      return {
        initialMissing,
        requests,
        requestCounts: {
          retryFirst: requests.filter((url) => url === retryFirst).length,
          retrySecond: requests.filter((url) => url === retrySecond).length,
          siblingFirst: requests.filter((url) => url === siblingFirst).length,
          siblingSecond: requests.filter((url) => url === siblingSecond).length,
        },
        stageOrder: events
          .filter((event) => event.phase === 'package.stage')
          .map((event) => event.label),
        prepareCount: countPhase('package.prepare'),
        commitCount: countPhase('package.commit'),
        transactionCount: countPhase('package.mount.transaction'),
        mountRpcCount: countPhase('package.mount.rpc'),
        midpointMissing: labelsFrom(midpoint.missing),
        midpointContext: labelsFrom(midpoint.context_closure),
        outcomeMounted: outcome.mounted,
        finalSatisfied: finalStep.satisfied,
        finalMissing: labelsFrom(finalStep.missing),
      };
    } catch (error) {
      return {
        error: String(error),
        requests,
        stages: events.filter((event) => event.phase === 'package.stage').map((event) => event.label),
        midpointMissing: labelsFrom(midpoint?.missing),
      };
    } finally {
      releaseSiblingFirst.resolve();
      releaseRetrySecond.resolve();
      window.fetch = realFetch;
      if (acquisitionOutcome) {
        await within(acquisitionOutcome, 'failed acquisition cleanup').catch(() => undefined);
      }
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
    && tiny.queryNavigation?.indexTable
    && tiny.queryNavigation?.indexLiquid
    && tiny.queryNavigation?.menuTable
    && tiny.queryNavigation?.menuLiquid
    && tiny.sqlTable?.rows === 4
    && tiny.sqlTable?.cells === 12
    && JSON.stringify(tiny.sqlTable?.values) === JSON.stringify([
      ['author', 'Author', 'Edit the FSH source that defines the guide.'],
      ['explore', 'Explore', 'Inspect the compiled FHIR definitions.'],
      ['preview', 'Site preview', 'Read the pages generated from those definitions.'],
    ])
    && tiny.sqlTable?.leakedDirective === false
    && tiny.sqlLiquid?.rows === 3
    && tiny.sqlLiquid?.countText === true
    && JSON.stringify(tiny.sqlLiquid?.values) === JSON.stringify([
      'Author (author) — Edit the FSH source that defines the guide.',
      'Explore (explore) — Inspect the compiled FHIR definitions.',
      'Site preview (preview) — Read the pages generated from those definitions.',
    ])
    && tiny.sqlLiquid?.leakedDirective === false
    && tiny.sqlEdit?.status === 'updated'
    && /04-EditorStages\.fsh$/.test(tiny.sqlEdit?.path || '')
    && Number.isFinite(tiny.sqlEdit?.elapsedMs)
    && Number.isFinite(tiny.sqlEdit?.restoreElapsedMs)
    && tiny.templatePreferencePreserved
    // prepare exposes the five authored FSH products; the generated
    // ImplementationGuide is deliberately a disk/native-only SUSHI output.
    && results.tinyResourceCount === 5
    && results.tinyCleanDiagnostics === 0
  )) {
    console.error('assert: tiny Source -> Definition -> standard Publisher page story failed —', JSON.stringify(tiny)); ok = false;
  }
  {
    const structural = results.tinyStructuralNavigation || {};
    const verifiedSources = new Set(['content-store', 'build-cache', 'content-transfer', 'render']);
    if (structural.error
      || structural.before?.hash === structural.after?.hash
      || !verifiedSources.has(structural.after?.source)
      || !structural.catalog?.toc
      || !structural.catalog?.artifacts
      || structural.catalog?.templateInternals?.length !== 0
      || !structural.tocClick
      || structural.toc?.fallback
      || !verifiedSources.has(structural.toc?.source)
      || !structural.toc?.artifactsClick
      || structural.artifacts?.fallback
      || !verifiedSources.has(structural.artifacts?.source)
      || !(structural.artifacts?.textLength > 100)) {
      console.error('assert: semantic profile edit did not retain navigable verified TOC/artifacts outputs —', JSON.stringify(structural)); ok = false;
    }
  }
  if (!results.packageBatchProgress.some((event) => /of [2-9] dependencies/.test(event.message))
    || results.packageBatchProgress.some((event) => event.totalBytes != null || /^Loaded /.test(event.message))) {
    console.error('assert: Tiny package progress was not one truthful aggregate —', JSON.stringify(results.packageBatchProgress)); ok = false;
  }
  if (results.tinyColdBinaryMounts.length === 0
    || results.tinyColdBinaryMounts.some((event) => event.inputJsonBytes !== 0
      || event.base64Bytes !== 0
      || event.workerSerializeMs !== 0)) {
    console.error('assert: Tiny cold package carriers expanded through JS JSON/base64 —', JSON.stringify(results.tinyColdBinaryMounts)); ok = false;
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
    const structural = results.usCoreStructuralNavigation;
    const verifiedSources = new Set(['content-store', 'build-cache', 'content-transfer', 'render']);
    if (
      !structural?.catalogToc
      || !structural?.catalogArtifacts
      || !structural?.tocClick
      || !structural?.artifactsClick
      || !verifiedSources.has(structural?.tocSource)
      || !verifiedSources.has(structural?.artifactsSource)
      || structural?.tocFallback !== false
      || structural?.artifactsFallback !== false
      || structural?.artifactsTextLength < 500
    ) {
      console.error('assert: US Core profile -> TOC -> Artifacts reached missing/unverified output —', JSON.stringify(structural)); ok = false;
    }
  }
  {
    const genomics = results.genomicsAuthoredArtifacts || {};
    const verifiedSources = new Set(['content-store', 'build-cache', 'content-transfer', 'render']);
    if (results.genomicsClicked !== 'clicked'
      || genomics.project !== 'genomics'
      || !genomics.catalogToc
      || !verifiedSources.has(genomics.source)
      || !verifiedSources.has(genomics.tocSource)
      || genomics.fallback
      || genomics.tocFallback
      || genomics.rawSql
      || !(genomics.textLength > 1000)) {
      console.error('assert: Genomics authored SQL artifacts page did not override only its structural default —', JSON.stringify({ clicked: results.genomicsClicked, genomics })); ok = false;
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
    const before = results.engineLifecycleBeforeMcode || {};
    const after = results.engineLifecycleAfterMcode || {};
    if (after.recycleCount !== before.recycleCount + 1 || after.preparedConfigCount !== 1) {
      console.error('assert: direct US Core -> mCODE did not recycle exactly once before the heavy successor —', JSON.stringify({ before, after })); ok = false;
    }
  }
  if (!results.workspaceDirtyAfterABA?.marker) {
    console.error('assert: dirty Cycle workspace did not survive A -> B/C -> A —', JSON.stringify(results.workspaceDirtyAfterABA)); ok = false;
  }
  if (!results.workspaceDirtyAfterReload?.marker) {
    console.error('assert: dirty Cycle workspace did not survive editor reload —', JSON.stringify(results.workspaceDirtyAfterReload)); ok = false;
  }
  if (!results.narrativePageClearsTrail?.empty || results.narrativePageClearsTrail?.subject) {
    console.error('assert: narrative page retained an unrelated artifact trail —', JSON.stringify(results.narrativePageClearsTrail)); ok = false;
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
    const restartProtocolPattern = new RegExp(`[?&]protocol=${PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL}(?:&|$)`);
    if (!(pw.previewWorkerRestart?.ok && restartProtocolPattern.test(pw.previewWorkerRestart.scriptURL || ''))) {
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
  if (!(
    results.diagnosticNavigation?.sourceControl === 'BUTTON'
    && results.diagnosticNavigation?.hasDefinition
    && results.diagnosticNavigation?.hasPublished
    && results.diagnosticNavigation?.afterSource?.mode === 'author'
    && /e2e-broken/i.test(results.diagnosticNavigation?.afterSource?.subject || '')
    && !results.diagnosticNavigation?.afterSource?.drawerOpen
    && results.diagnosticNavigation?.afterDefinition?.mode === 'explore'
    && /e2e-broken/i.test(results.diagnosticNavigation?.afterDefinition?.subject || '')
    && !results.diagnosticNavigation?.afterDefinition?.drawerOpen
    && results.diagnosticNavigation?.afterPublished?.mode === 'preview'
    && /e2e-broken/i.test(results.diagnosticNavigation?.afterPublished?.subject || '')
    && /StructureDefinition-e2e-broken\.html$/i.test(results.diagnosticNavigation?.afterPublished?.page || '')
    && !results.diagnosticNavigation?.afterPublished?.drawerOpen
  )) {
    console.error('assert: exact diagnostic navigation failed —', JSON.stringify(results.diagnosticNavigation)); ok = false;
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
  // F6 stock-template gates: renders + a 2s warm-edit automation budget. The
  // measured span includes latest-only scheduling, compile, canonical Publisher
  // preparation/render, fragment fills, iframe publication, and observer latency.
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
  if (!(results.trailCurrents?.length === 3
    && results.trailCurrents.every((current, index) => current.count === 1 && current.index === index))) {
    console.error('assert: artifact trail current-step semantics failed —', JSON.stringify(results.trailCurrents)); ok = false;
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
  if (!exclusivePreviewBoundaryPass(results.exclusivePreview1199)) {
    console.error('assert: 1199px exclusive preview boundary failed —', JSON.stringify(results.exclusivePreview1199)); ok = false;
  }
  if (results.stockEditResult !== 'ok') {
    console.error('assert: stock warm edit was not applied —', results.stockEditResult); ok = false;
  } else if (!(results.stockWarmEditMs < STOCK_WARM_EDIT_BUDGET_MS)) {
    console.error('assert: stock warm edit took', results.stockWarmEditMs, `ms (gate: <${STOCK_WARM_EDIT_BUDGET_MS})`); ok = false;
  }
  if (!results.stockWarmReuse?.ok) {
    console.error('assert: stock warm edit did not report stable compile/prepare spans —', JSON.stringify(results.stockWarmReuse)); ok = false;
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
  if (!results.startupTimelineAssessment?.ok) {
    console.error('assert: startup timeline incomplete or invalid:', JSON.stringify({
      assessment: results.startupTimelineAssessment,
      timeline: results.startupTimeline,
    }));
    ok = false;
  }
  if ((results.initBundles || []).length !== 0) {
    console.error('assert: package bodies were fetched before project resolution:', results.initBundles); ok = false;
  }
  if (results.r5FetchedAtInit) { console.error('assert: r5.core was fetched at init for an R4 guide'); ok = false; }
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
    if (!results.openProgressPendingDefinitions) {
      console.error('assert: pending compilation was presented as empty/zero definitions'); ok = false;
    }
    const byteMetrics = results.openProgressByteMetrics || [];
    if (!byteMetrics.some((event) => event.bytes > 0)) {
      console.error('assert: project download emitted no consumed-byte progress:', JSON.stringify(byteMetrics)); ok = false;
    }
    if (byteMetrics.some((event) => event.bytes > 0)
        && !(results.openProgressByteLabels || []).some((label) => /\bMB\b/.test(label))) {
      console.error('assert: byte download showed no visible MB counter:', JSON.stringify(results.openProgressByteLabels)); ok = false;
    }
    const mixed = results.mixedPreparedTransport || {};
    if (requireMixedPreparedTransport
        && !(mixed.preparedHits?.length > 0 && mixed.mixedMounts > 0)) {
      console.error('assert: US Core did not exercise a mixed warm/cold atomic package mount:', JSON.stringify(mixed)); ok = false;
    }
    if (mixed.refetched?.length) {
      console.error('assert: mixed package mount re-fetched prepared baked packages:', JSON.stringify(mixed)); ok = false;
    }
    // NOTE: US Core resource count is informational — a full compile needs
    // registry-only packages (external network), so we don't gate on it.
    if (!(results.usCoreResourceCount >= 0)) { console.error('assert: US Core resource count missing (open failed?)'); ok = false; }
    if (results.usCoreR5FetchedBeforeInspector) { console.error('assert: opening US Core fetched r5.core before inspection'); ok = false; }
    if (results.usCoreR5FetchedAfterExplore) { console.error('assert: exploring the US Core differential fetched r5.core'); ok = false; }
    if (results.r5FetchedForR4Snapshot) { console.error('assert: explicit US Core R4 snapshot injected r5.core'); ok = false; }
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

  // ---- typed next-registry + atomic Worker mount gate --------------------
  {
    const retry = results.registryTgzRetry || {};
    const expectedLabels = ['e2e.registry.retry#1.0.0', 'e2e.registry.sibling#1.0.0'];
    const sameMembers = (actual) => Array.isArray(actual)
      && actual.length === expectedLabels.length
      && expectedLabels.every((label) => actual.includes(label));
    if (retry.error) {
      console.error('assert: typed registry retry gate errored:', retry.error, JSON.stringify(retry)); ok = false;
    } else if (!sameMembers(retry.initialMissing)) {
      console.error('assert: registry retry fixture did not begin as the exact missing pair:', JSON.stringify(retry)); ok = false;
    } else if (!(retry.requestCounts?.retryFirst === 1
        && retry.requestCounts.retrySecond === 1
        && retry.requestCounts.siblingFirst === 1
        && retry.requestCounts.siblingSecond === 0
        && retry.requests?.length === 3)) {
      console.error('assert: registry carrier request sequence was not first-reject/next-registry:', JSON.stringify(retry)); ok = false;
    } else if (!(Array.isArray(retry.stageOrder)
        && retry.stageOrder.length === 2
        && retry.stageOrder[0] === 'e2e.registry.sibling#1.0.0'
        && retry.stageOrder[1] === 'e2e.registry.retry#1.0.0'
        && retry.prepareCount === 2)) {
      console.error('assert: valid carriers did not stage once in the controlled arrival order:', JSON.stringify(retry)); ok = false;
    } else if (!(sameMembers(retry.midpointMissing)
        && expectedLabels.every((label) => !retry.midpointContext?.includes(label)))) {
      console.error('assert: staged package leaked into resolver state before commit:', JSON.stringify(retry)); ok = false;
    } else if (!(retry.commitCount === 1
        && retry.transactionCount === 1
        && retry.mountRpcCount === 1
        && JSON.stringify(retry.outcomeMounted) === JSON.stringify(retry.initialMissing))) {
      console.error('assert: registry retry did not produce one resolver-ordered atomic commit:', JSON.stringify(retry)); ok = false;
    } else if (!(retry.finalSatisfied === true
        && expectedLabels.every((label) => !retry.finalMissing?.includes(label)))) {
      console.error('assert: registry retry closure was not satisfied after commit:', JSON.stringify(retry)); ok = false;
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
