#!/usr/bin/env node
// Repeatable US Core load benchmark over raw Chrome DevTools Protocol.
//
// The benchmark deliberately clears storage for the target origin, then measures:
//   1. a cold app boot followed by a cold US Core open;
//   2. a hard reload in the same persistent browser profile (OPFS/CAS warm),
//      including prior-preview UI/page and current-ready milestones;
//   3. Cycle -> US Core in the same page/worker (packages already resident).
//
// Recommended one-command local run (launches its own server and Chrome):
//   BASE_PATH=/fhir-ig-editor/ \
//     bash scripts/run-uscore-benchmark.sh app/dist > uscore-benchmark.json
//
// Against an already-running remote-debug Chrome (DESTRUCTIVELY clears storage
// for the supplied origin, so use a disposable Chrome profile):
//   chromium --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=/tmp/ig-bench-profile about:blank
//   CDP_PORT=9222 node scripts/benchmark-uscore.mjs \
//     https://joshuamandel.com/fhir-ig-editor/ > uscore-benchmark.json
//
// Optional environment:
//   BENCH_CPU_THROTTLE=4  CDP CPU throttling rate (default 1)
//   BENCH_MOBILE=1        emulate a 412x915, deviceScaleFactor=3 viewport
//   BENCH_PROFILE_EDIT=1  measure one loaded US Core profile JSON edit through preview
//   BENCH_TIMEOUT_MS=300000 per readiness wait before throttle scaling

const HELP = `Usage:
  CDP_PORT=9222 node scripts/benchmark-uscore.mjs <editor-url>

Produces one machine-readable JSON document on stdout. Progress goes to stderr.
The target origin's cookies, caches, service workers, IndexedDB, and OPFS data
are cleared before the cold phase. Always use a disposable Chrome profile.

For a self-contained local run:
  BASE_PATH=/fhir-ig-editor/ bash scripts/run-uscore-benchmark.sh app/dist
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const targetUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/');
if (!targetUrl.pathname.endsWith('/')) targetUrl.pathname += '/';
const base = targetUrl.href;
const origin = targetUrl.origin;
const cdpPort = Number(process.env.CDP_PORT || 9222);
const cdpHttp = `http://127.0.0.1:${cdpPort}`;
const cpuThrottle = Math.max(1, Number(process.env.BENCH_CPU_THROTTLE || 1));
const baseTimeoutMs = Math.max(30_000, Number(process.env.BENCH_TIMEOUT_MS || 300_000));
const timeoutMs = baseTimeoutMs * cpuThrottle;
const mobile = process.env.BENCH_MOBILE === '1';
const profileEditEnabled = process.env.BENCH_PROFILE_EDIT === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 10) / 10;
const ratio = (n) => Math.round(n * 1000) / 1000;

function progress(message) {
  process.stderr.write(`[uscore-benchmark] ${message}\n`);
}

async function waitForCdp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpHttp}/json/version`);
      if (response.ok) return response.json();
    } catch {
      // Chrome may still be starting.
    }
    await sleep(250);
  }
  throw new Error(`Chrome CDP did not become available at ${cdpHttp}`);
}

class CdpTarget {
  constructor(ws, networkEvents) {
    this.ws = ws;
    this.networkEvents = networkEvents;
    this.nextId = 1;
    this.pending = new Map();
    this.phase = 'setup';
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
  }

  static async connect(wsUrl, networkEvents) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpTarget(ws, networkEvents);
  }

  onMessage(message) {
    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    const params = message.params;
    if (!params) return;
    if (message.method === 'Network.requestWillBeSent') {
      this.networkEvents.push({
        phase: this.phase,
        requestId: params.requestId,
        url: params.request.url,
        resourceType: params.type,
        status: null,
        mimeType: null,
        encodedBytes: 0,
        fromDiskCache: false,
        fromServiceWorker: false,
        fromPrefetchCache: false,
        servedFromCache: false,
      });
      return;
    }
    const request = [...this.networkEvents]
      .reverse()
      .find((entry) => entry.requestId === params.requestId);
    if (!request) return;
    if (message.method === 'Network.requestServedFromCache') {
      request.servedFromCache = true;
    } else if (message.method === 'Network.responseReceived') {
      request.status = params.response.status;
      request.mimeType = params.response.mimeType;
      request.fromDiskCache = !!params.response.fromDiskCache;
      request.fromServiceWorker = !!params.response.fromServiceWorker;
      request.fromPrefetchCache = !!params.response.fromPrefetchCache;
    } else if (message.method === 'Network.loadingFinished') {
      request.encodedBytes = params.encodedDataLength || 0;
    } else if (message.method === 'Network.loadingFailed') {
      request.failed = params.errorText || 'failed';
    }
  }

  call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(`${response.exceptionDetails.text}: ${expression.slice(0, 120)}`);
    }
    return response.result.value;
  }

  async waitFor(expression, label, limit = timeoutMs) {
    const deadline = Date.now() + limit;
    while (Date.now() < deadline) {
      if (await this.evaluate(expression).catch(() => false)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  close() {
    this.ws.close();
  }
}

// Installed before every editor document. It records worker RPCs without
// serializing their (sometimes enormous) arguments and samples visible progress.
const INSTRUMENTATION = String.raw`(() => {
  const trace = window.__usCoreBenchmark = {
    phaseStart: performance.now(),
    operations: [],
    progress: [],
    longTasks: [],
    seenOpenProgress: false,
    milestones: {},
  };
  const originalPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...rest) {
    if (!this.__usCoreBenchmarkWired) {
      this.__usCoreBenchmarkWired = true;
      this.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data.id !== 'number') return;
        const current = window.__usCoreBenchmark;
        const operation = [...current.operations].reverse()
          .find((entry) => entry.id === data.id && entry.end == null);
        if (!operation) return;
        operation.end = performance.now();
        operation.duration = operation.end - operation.start;
        operation.ok = !!data.ok;
        const result = data.result || {};
        operation.engineDuration = result.mountMs ?? result.initMs ?? result.buildMs ?? null;
        operation.newlyMounted = result.newlyMounted || [];
        operation.mounted = result.mounted ?? null;
        operation.inputBytes = result.inputBytes ?? null;
        operation.serializeMs = result.serializeMs ?? null;
        operation.wasmMs = result.wasmMs ?? null;
        operation.preparedMetrics = result.preparedMetrics || null;
        operation.packageStorage = result.packageStorage || null;
        operation.pageCount = Array.isArray(result.pages) ? result.pages.length : result.pages ?? null;
        operation.dataCount = result.data ?? null;
      });
    }
    if (message && typeof message.id === 'number' && message.op) {
      window.__usCoreBenchmark.operations.push({
        id: message.id,
        op: message.op,
        start: performance.now(),
        end: null,
      });
    }
    return originalPostMessage.call(this, message, ...rest);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__usCoreBenchmark.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const sample = () => {
    const open = document.querySelector('.open-progress');
    const startup = document.querySelector('.startup-progress');
    const lazy = document.querySelector('.lazy-progress');
    const element = open || startup || lazy;
    if (open) window.__usCoreBenchmark.seenOpenProgress = true;
    const kind = open ? 'open' : startup ? 'startup' : lazy ? 'lazy' : 'clear';
    const stage = element?.getAttribute('data-stage') || '';
    const message = (
      element?.querySelector('.open-progress-msg')?.textContent || element?.textContent || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 240);
    const signature = kind + '|' + stage + '|' + message;
    const current = window.__usCoreBenchmark;
    const state = document.querySelector('.project-state')?.textContent || '';
    if (!current.milestones.previousPreviewUiAt && state.includes('showing previous preview')) {
      current.milestones.previousPreviewUiAt = performance.now();
    }
    const frame = document.querySelector('iframe.preview-frame');
    try {
      const framePath = frame?.contentWindow?.location?.pathname || '';
      const frameText = frame?.contentDocument?.body?.textContent?.trim() || '';
      if (!current.milestones.previousPreviewPageAt
          && current.milestones.previousPreviewUiAt
          && framePath.includes('/preview/uscore/')
          && frameText.length > 0) {
        current.milestones.previousPreviewPageAt = performance.now();
      }
    } catch {}
    if (!current.milestones.currentReadyAt
        && current.milestones.previousPreviewUiAt
        && state.trim() === 'Ready') {
      current.milestones.currentReadyAt = performance.now();
    }
    if (signature !== current.lastProgressSignature) {
      current.lastProgressSignature = signature;
      current.progress.push({ time: performance.now(), kind, stage, message });
    }
  };
  new MutationObserver(sample).observe(document, {
    subtree: true, childList: true, characterData: true, attributes: true,
  });
  // MutationObserver captures progress transitions immediately. This slow
  // backstop catches elapsed-time-only updates without making the benchmark
  // itself a significant source of main-thread work.
  setInterval(sample, 250);
  sample();
})();`;

function networkSummary(events, phase) {
  const selected = events.filter((event) => event.phase === phase);
  const encodedBytes = selected.reduce((sum, event) => sum + event.encodedBytes, 0);
  const packageLike = selected.filter((event) =>
    /packages\.fhir\.org|packages2\.fhir\.org|\/data\/(?:bundles|uscore)\//.test(event.url),
  );
  return {
    requestCount: selected.length,
    encodedBytes: Math.round(encodedBytes),
    packageLikeEncodedBytes: Math.round(
      packageLike.reduce((sum, event) => sum + event.encodedBytes, 0),
    ),
    cacheServedCount: selected.filter((event) =>
      event.servedFromCache || event.fromDiskCache || event.fromServiceWorker || event.fromPrefetchCache,
    ).length,
    requests: selected.map((event) => ({
      url: event.url.startsWith(base) ? event.url.slice(base.length) : event.url,
      resourceType: event.resourceType,
      status: event.status,
      encodedBytes: Math.round(event.encodedBytes),
      servedFromCache: event.servedFromCache,
      fromDiskCache: event.fromDiskCache,
      fromServiceWorker: event.fromServiceWorker,
      failed: event.failed,
    })),
  };
}

function summarizeOperations(operations) {
  const totals = {};
  for (const operation of operations) {
    const total = totals[operation.op] ||= {
      calls: 0,
      durationMs: 0,
      engineDurationMs: 0,
      inputBytes: 0,
      serializeMs: 0,
      wasmMs: 0,
      preparedColdCalls: 0,
      preparedWarmCalls: 0,
      preparedMixedCalls: 0,
      preparedArtifactBytes: 0,
      preparedMembers: 0,
      preparedIndexedMembers: 0,
      preparedRetainedBlobBytes: 0,
      preparedMaxStagedArtifactBytes: 0,
      preparedJsBatchBytes: 0,
      preparedCompressedRetainedBytes: 0,
      preparedDeclaredRawBytes: 0,
      preparedChunksInflated: 0,
      preparedRawInflatedBytes: 0,
      preparedChunkCacheHits: 0,
      preparedCachedRawBytes: 0,
      preparedMemberBodyCopies: 0,
      preparedDecodeValidatePrepareMs: 0,
      preparedDecodeValidateMs: 0,
      preparedEngineMountMs: 0,
      preparedInputJsonBytes: 0,
      preparedBase64Bytes: 0,
      preparedDecodedSourceBytes: 0,
      preparedNormalizedBytes: 0,
      preparedManifestJsonBytes: 0,
      preparedJsonParseMs: 0,
      preparedBase64DecodeMs: 0,
      preparedNormalizationMs: 0,
      preparedIndexingMs: 0,
      preparedArtifactEncodeMs: 0,
      preparedManifestParseMs: 0,
    };
    total.calls += 1;
    total.durationMs += operation.durationMs || 0;
    total.engineDurationMs += operation.engineDurationMs || 0;
    total.inputBytes += operation.inputBytes || 0;
    total.serializeMs += operation.serializeMs || 0;
    total.wasmMs += operation.wasmMs || 0;
    const prepared = operation.preparedMetrics;
    if (prepared) {
      total.preparedColdCalls += prepared.mode === 'cold-prepare' ? 1 : 0;
      total.preparedWarmCalls += prepared.mode === 'warm-binary' ? 1 : 0;
      total.preparedMixedCalls += prepared.mode === 'mixed' ? 1 : 0;
      total.preparedArtifactBytes += prepared.artifactBytes || 0;
      total.preparedMembers += prepared.preparedMembers || 0;
      total.preparedIndexedMembers += prepared.indexedMembers || 0;
      total.preparedRetainedBlobBytes += prepared.retainedBlobBytes || 0;
      total.preparedMaxStagedArtifactBytes = Math.max(
        total.preparedMaxStagedArtifactBytes,
        prepared.maxStagedArtifactBytes || 0,
      );
      total.preparedJsBatchBytes += prepared.jsBatchBytes || 0;
      total.preparedCompressedRetainedBytes += prepared.compressedRetainedBytes || 0;
      total.preparedDeclaredRawBytes += prepared.declaredRawBytes || 0;
      total.preparedChunksInflated += prepared.chunksInflated || 0;
      total.preparedRawInflatedBytes += prepared.rawInflatedBytes || 0;
      total.preparedChunkCacheHits += prepared.chunkCacheHits || 0;
      total.preparedCachedRawBytes += prepared.cachedRawBytes || 0;
      total.preparedMemberBodyCopies += prepared.memberBodyCopies || prepared.mountMemberBodyCopies || 0;
      total.preparedDecodeValidatePrepareMs += prepared.decodeValidatePrepareMs || 0;
      total.preparedDecodeValidateMs += prepared.decodeValidateMs || 0;
      total.preparedEngineMountMs += prepared.engineMountMs || 0;
      total.preparedInputJsonBytes += prepared.inputJsonBytes || 0;
      total.preparedBase64Bytes += prepared.base64Bytes || 0;
      total.preparedDecodedSourceBytes += prepared.decodedSourceBytes || 0;
      total.preparedNormalizedBytes += prepared.normalizedBytes || 0;
      total.preparedManifestJsonBytes += prepared.manifestJsonBytes || 0;
      total.preparedJsonParseMs += prepared.jsonParseMs || 0;
      total.preparedBase64DecodeMs += prepared.base64DecodeMs || 0;
      total.preparedNormalizationMs += prepared.normalizationMs || 0;
      total.preparedIndexingMs += prepared.indexingMs || 0;
      total.preparedArtifactEncodeMs += prepared.artifactEncodeMs || 0;
      total.preparedManifestParseMs += prepared.manifestParseMs || 0;
    }
  }
  for (const total of Object.values(totals)) {
    total.durationMs = round(total.durationMs);
    total.engineDurationMs = round(total.engineDurationMs);
    total.inputBytes = Math.round(total.inputBytes);
    total.serializeMs = round(total.serializeMs);
    total.wasmMs = round(total.wasmMs);
    total.preparedArtifactBytes = Math.round(total.preparedArtifactBytes);
    total.preparedMembers = Math.round(total.preparedMembers);
    total.preparedIndexedMembers = Math.round(total.preparedIndexedMembers);
    total.preparedRetainedBlobBytes = Math.round(total.preparedRetainedBlobBytes);
    total.preparedMaxStagedArtifactBytes = Math.round(total.preparedMaxStagedArtifactBytes);
    total.preparedJsBatchBytes = Math.round(total.preparedJsBatchBytes);
    total.preparedCompressedRetainedBytes = Math.round(total.preparedCompressedRetainedBytes);
    total.preparedDeclaredRawBytes = Math.round(total.preparedDeclaredRawBytes);
    total.preparedChunksInflated = Math.round(total.preparedChunksInflated);
    total.preparedRawInflatedBytes = Math.round(total.preparedRawInflatedBytes);
    total.preparedChunkCacheHits = Math.round(total.preparedChunkCacheHits);
    total.preparedCachedRawBytes = Math.round(total.preparedCachedRawBytes);
    total.preparedDecodeValidatePrepareMs = round(total.preparedDecodeValidatePrepareMs);
    total.preparedDecodeValidateMs = round(total.preparedDecodeValidateMs);
    total.preparedEngineMountMs = round(total.preparedEngineMountMs);
    total.preparedInputJsonBytes = Math.round(total.preparedInputJsonBytes);
    total.preparedBase64Bytes = Math.round(total.preparedBase64Bytes);
    total.preparedDecodedSourceBytes = Math.round(total.preparedDecodedSourceBytes);
    total.preparedNormalizedBytes = Math.round(total.preparedNormalizedBytes);
    total.preparedManifestJsonBytes = Math.round(total.preparedManifestJsonBytes);
    total.preparedJsonParseMs = round(total.preparedJsonParseMs);
    total.preparedBase64DecodeMs = round(total.preparedBase64DecodeMs);
    total.preparedNormalizationMs = round(total.preparedNormalizationMs);
    total.preparedIndexingMs = round(total.preparedIndexingMs);
    total.preparedArtifactEncodeMs = round(total.preparedArtifactEncodeMs);
    total.preparedManifestParseMs = round(total.preparedManifestParseMs);
  }
  return totals;
}

function summarizeRuntimeMetrics(entries) {
  const totals = {};
  for (const { event } of entries) {
    const total = totals[event.stage] ||= {
      events: 0,
      durationMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      cacheHits: 0,
    };
    total.events += 1;
    total.durationMs += event.durationMs || 0;
    total.inputBytes += event.inputBytes || event.bytes || 0;
    total.outputBytes += event.outputBytes || 0;
    total.cacheHits += event.fromCache ? 1 : 0;
  }
  for (const total of Object.values(totals)) {
    total.durationMs = round(total.durationMs);
    total.inputBytes = Math.round(total.inputBytes);
    total.outputBytes = Math.round(total.outputBytes);
  }
  return totals;
}

async function resetTrace(target) {
  return target.evaluate(`(() => {
    const trace = window.__usCoreBenchmark;
    trace.phaseStart = performance.now();
    trace.operations.length = 0;
    trace.progress.length = 0;
    trace.longTasks.length = 0;
    trace.seenOpenProgress = false;
    trace.milestones = {};
    trace.lastProgressSignature = '';
    if (window.__igDebug?.metrics) window.__igDebug.metrics.length = 0;
    return trace.phaseStart;
  })()`);
}

async function traceSnapshot(target, phaseStart) {
  const raw = await target.evaluate(`(() => {
    const trace = window.__usCoreBenchmark;
    return {
      now: performance.now(),
      operations: trace.operations,
      progress: trace.progress,
      longTasks: trace.longTasks,
      runtimeMetrics: window.__igDebug?.metrics || [],
      engineLifecycle: {
        recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
        preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
        lastCompiledResourceCount: window.__igDebug?.engine?.lastCompiledResourceCount ?? -1,
      },
      milestones: trace.milestones,
      resourceCount: document.querySelectorAll('.res-row').length,
      siteError: document.querySelector('.site-error')?.textContent || '',
    };
  })()`);
  const end = raw.now;
  const milestones = Object.fromEntries(Object.entries(raw.milestones || {})
    .map(([name, at]) => [name, round(at - phaseStart)]));
  const operations = raw.operations.map((operation) => ({
    op: operation.op,
    startMs: round(operation.start - phaseStart),
    durationMs: operation.duration == null ? null : round(operation.duration),
    engineDurationMs:
      operation.engineDuration == null ? null : round(operation.engineDuration),
    ok: operation.ok ?? null,
    mounted: operation.mounted,
    inputBytes: operation.inputBytes,
    serializeMs: operation.serializeMs,
    wasmMs: operation.wasmMs,
    preparedMetrics: operation.preparedMetrics,
    packageStorage: operation.packageStorage,
    newlyMounted: operation.newlyMounted,
    pageCount: operation.pageCount,
    dataCount: operation.dataCount,
  }));
  const progressEntries = raw.progress
    .filter((entry) => entry.time >= phaseStart)
    .map((entry, index, entries) => {
      const next = entries[index + 1]?.time ?? end;
      return {
        kind: entry.kind,
        stage: entry.stage,
        message: entry.message,
        startMs: round(entry.time - phaseStart),
        durationMs: round(Math.max(0, next - entry.time)),
      };
    });
  const longTasks = raw.longTasks.filter((entry) => entry.start >= phaseStart);
  const runtimeMetrics = raw.runtimeMetrics
    .filter((entry) => entry.at >= phaseStart)
    .map((entry) => ({
      atMs: round(entry.at - phaseStart),
      event: entry.event,
    }));
  return {
    durationMs: round(end - phaseStart),
    resourceCount: raw.resourceCount,
    siteError: raw.siteError,
    milestones,
    progress: progressEntries,
    operations,
    operationTotals: summarizeOperations(operations),
    runtimeMetrics,
    engineLifecycle: raw.engineLifecycle,
    stageTotals: summarizeRuntimeMetrics(runtimeMetrics),
    longTasks: {
      count: longTasks.length,
      totalDurationMs: round(longTasks.reduce((sum, entry) => sum + entry.duration, 0)),
      maxDurationMs: round(Math.max(0, ...longTasks.map((entry) => entry.duration))),
    },
  };
}

async function selectCatalogProject(target, id) {
  return target.evaluate(`(() => {
    const select = document.querySelector('.open-ig-select');
    if (!select || ![...select.options].some((option) => option.value === ${JSON.stringify(id)})) {
      return false;
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(id)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

async function waitForProjectOpen(target, id) {
  await target.waitFor(
    `localStorage.getItem('igEditor.project') === ${JSON.stringify(id)} && window.__usCoreBenchmark.seenOpenProgress`,
    `${id} project-open progress to appear`,
  );
  await target.waitFor(
    `!document.querySelector('.open-progress') && document.querySelectorAll('.res-row').length > 100`,
    `${id} project open to complete`,
  );
  // Publication to the preview Service Worker follows the OutputCatalog
  // acknowledgement by a small asynchronous tail. Include it without adding an arbitrary
  // multi-second pad.
  await sleep(250);
}

async function main() {
  const version = await waitForCdp();
  const tabs = await (await fetch(`${cdpHttp}/json/list`)).json();
  const tab = tabs.find((candidate) => candidate.type === 'page');
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP exposes no page target');
  const networkEvents = [];
  const target = await CdpTarget.connect(tab.webSocketDebuggerUrl, networkEvents);
  try {
    await target.call('Page.enable');
    await target.call('Runtime.enable');
    await target.call('Network.enable', {
      maxTotalBufferSize: 128 * 1024 * 1024,
      maxResourceBufferSize: 32 * 1024 * 1024,
    });
    if (cpuThrottle > 1) {
      await target.call('Emulation.setCPUThrottlingRate', { rate: cpuThrottle });
    }
    if (mobile) {
      await target.call('Emulation.setDeviceMetricsOverride', {
        width: 412,
        height: 915,
        deviceScaleFactor: 3,
        mobile: true,
      });
    }

    progress(`clearing ${origin} storage and HTTP cache`);
    target.phase = 'setup';
    await target.call('Page.navigate', { url: 'about:blank' });
    await sleep(250);
    await target.call('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await target.call('Network.clearBrowserCache');
    await target.call('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });

    progress('cold app boot + US Core open');
    target.phase = 'coldStart';
    await target.call('Page.navigate', { url: base });
    await target.waitFor(
      `!!window.__igDebug?.engine?.initialized && !!document.querySelector('.open-ig-select')`,
      'cold engine boot',
    );
    const appBootReadyMs = await target.evaluate('performance.now()');
    if (!(await selectCatalogProject(target, 'uscore'))) {
      throw new Error('US Core is absent from .open-ig-select');
    }
    const usCoreOpenStartMs = await target.evaluate('performance.now()');
    await waitForProjectOpen(target, 'uscore');
    const cold = await traceSnapshot(target, 0);
    cold.appBootReadyMs = round(appBootReadyMs);
    cold.usCoreOpenStartMs = round(usCoreOpenStartMs);
    cold.usCoreOpenDurationMs = round(cold.durationMs - usCoreOpenStartMs);
    cold.network = networkSummary(networkEvents, 'coldStart');

    progress('warm hard reload (same persistent OPFS/CAS)');
    target.phase = 'warmHardReload';
    await target.call('Page.reload', { ignoreCache: false });
    await target.waitFor(
      `window.__usCoreBenchmark?.milestones?.previousPreviewUiAt != null`,
      'previous verified US Core preview pointer',
    );
    // Published guides default to Explore. Activate Preview as soon as the
    // persisted catalog is available so this phase measures the useful prior
    // page, not merely the stale-state badge while an unmounted iframe waits.
    await target.evaluate(`document.querySelector('#workspace-tab-preview')?.click()`);
    await target.waitFor(
      `window.__usCoreBenchmark?.milestones?.previousPreviewPageAt != null`,
      'previous verified US Core preview page',
    );
    await target.waitFor(
      `!!window.__usCoreBenchmark && !!window.__igDebug?.engine?.initialized`,
      'warm engine boot',
    );
    await target.waitFor(
      `window.__usCoreBenchmark.operations.some((entry) => entry.op === 'prepare' && entry.end != null && entry.ok) && window.__usCoreBenchmark.operations.some((entry) => entry.op === 'outputs' && entry.end != null && entry.ok) && document.querySelectorAll('.res-row').length > 100`,
      'warm US Core prepare and OutputCatalog',
    );
    await sleep(250);
    const warm = await traceSnapshot(target, 0);
    warm.network = networkSummary(networkEvents, 'warmHardReload');
    const warmPreparedMount = warm.operationTotals.mountPackages;
    if (!(warmPreparedMount?.preparedWarmCalls > 0)
        || warmPreparedMount.preparedColdCalls !== 0
        || warmPreparedMount.preparedMixedCalls !== 0
        || warmPreparedMount.preparedChunksInflated !== 0
        || warmPreparedMount.preparedRawInflatedBytes !== 0) {
      throw new Error(`warm hard reload did not shallow-mount only authenticated prepared packages: ${JSON.stringify(warmPreparedMount)}`);
    }
    const warmBuild = [...warm.runtimeMetrics].reverse().find(({ event }) =>
      event.stage === 'site-build' && event.metrics?.closureVerifyMs != null);
    const warmClosureVerifyMs = warmBuild?.event?.metrics?.closureVerifyMs;
    if (!Number.isFinite(warmClosureVerifyMs) || warmClosureVerifyMs >= 1_000) {
      throw new Error(`warm hard reload re-expanded package closure instead of verifying retained carriers: ${warmClosureVerifyMs}`);
    }
    const stale = warm.milestones;
    if (!(stale.previousPreviewUiAt >= 0)
        || !(stale.previousPreviewPageAt >= stale.previousPreviewUiAt)
        || !(stale.currentReadyAt >= stale.previousPreviewPageAt)) {
      throw new Error(`stale preview milestones are not ordered before exact Ready: ${JSON.stringify(stale)}`);
    }

    let profileEdit = null;
    if (profileEditEnabled) {
      progress('loaded US Core profile JSON edit -> published page');
      target.phase = 'profileEditSetup';
      await target.evaluate(`(() => {
        document.querySelector('#workspace-tab-preview')?.click();
        const select = document.querySelector('.preview-page-select select');
        const path = 'en/StructureDefinition-us-core-patient.html';
        if (!select || ![...select.options].some((option) => option.value === path)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, path);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      await target.waitFor(
        `(() => {
          const frame = document.querySelector('.preview-frame');
          const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
          return frame?.contentWindow?.location.pathname.endsWith('/en/StructureDefinition-us-core-patient.html')
            && /US Core Patient Profile/.test(doc?.body?.textContent || '');
        })()`,
        'US Core patient page before profile edit',
      );
      const openedSource = await target.evaluate(`(async () => {
        document.querySelector('#workspace-tab-author')?.click();
        const row = document.querySelector('.tree-row.file[title="input/resources/structuredefinition-us-core-patient.json"]');
        if (!row) return 'missing-source-row';
        row.click();
        for (let attempt = 0; attempt < 60; attempt++) {
          const editor = window.monaco?.editor.getEditors()[0];
          if (editor?.getModel()?.getValue().includes('"id": "us-core-patient"')) return 'ok';
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return 'source-model-timeout';
      })()`);
      if (openedSource !== 'ok') throw new Error(`could not open US Core patient source: ${openedSource}`);
      target.phase = 'profileEdit';
      const editStart = await resetTrace(target);
      const edited = await target.evaluate(`(() => {
        const editor = window.monaco?.editor.getEditors()[0];
        const model = editor?.getModel();
        if (!model) return false;
        const before = '"title": "US Core Patient Profile"';
        if (!model.getValue().includes(before)) return false;
        model.setValue(model.getValue().replace(
          before,
          '"title": "US Core Patient Profile Benchmark Edit"',
        ));
        return true;
      })()`);
      if (!edited) throw new Error('could not edit US Core patient title');
      await target.waitFor(
        `(() => {
          const frame = document.querySelector('.preview-frame');
          const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
          return /US Core Patient Profile Benchmark Edit/.test(doc?.body?.textContent || '');
        })()`,
        'edited US Core patient published page',
      );
      profileEdit = await traceSnapshot(target, editStart);
      const firstOperationStartMs = Math.min(
        ...profileEdit.operations
          .map((operation) => operation.startMs)
          .filter((value) => Number.isFinite(value)),
      );
      if (!Number.isFinite(firstOperationStartMs)) {
        throw new Error('profile edit completed without a measured Worker operation');
      }
      profileEdit.explicitDebounceMs = 300;
      profileEdit.firstWorkerOperationMs = round(firstOperationStartMs);
      profileEdit.postDebouncePipelineMs = round(profileEdit.durationMs - firstOperationStartMs);
      profileEdit.network = networkSummary(networkEvents, 'profileEdit');
    }

    progress('preparing same-worker comparison via Cycle');
    target.phase = 'preparation';
    const sameWorkerRecycleBaseline = warm.engineLifecycle.recycleCount;
    if (!(await selectCatalogProject(target, 'cycle'))) {
      throw new Error('Cycle is absent from .open-ig-select');
    }
    await target.waitFor(
      `localStorage.getItem('igEditor.project') === 'cycle'`,
      'Cycle selection',
    );
    await target.waitFor(
      `!document.querySelector('.open-progress') && document.querySelectorAll('.res-row').length > 0 && document.querySelectorAll('.res-row').length < 100`,
      'Cycle project open',
    );
    const cycleLifecycle = await target.evaluate(`(() => ({
      recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
      preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
      lastCompiledResourceCount: window.__igDebug?.engine?.lastCompiledResourceCount ?? -1,
    }))()`);

    progress('same-worker US Core reopen');
    target.phase = 'sameWorkerReopen';
    const sameStart = await resetTrace(target);
    if (!(await selectCatalogProject(target, 'uscore'))) {
      throw new Error('US Core is absent from .open-ig-select');
    }
    await waitForProjectOpen(target, 'uscore');
    const same = await traceSnapshot(target, sameStart);
    same.network = networkSummary(networkEvents, 'sameWorkerReopen');
    const samePrepare = [...same.runtimeMetrics].reverse().find(({ event }) =>
      event.stage === 'site-build' && event.metrics?.siteBuildCacheHit != null);
    const sameMetrics = samePrepare?.event?.metrics || {};
    const sameWorkerContract = {
      recycleBaseline: sameWorkerRecycleBaseline,
      recycleAfterCycle: cycleLifecycle.recycleCount,
      recycleAfter: same.engineLifecycle.recycleCount,
      preparedConfigsAfterCycle: cycleLifecycle.preparedConfigCount,
      preparedConfigsAfterReopen: same.engineLifecycle.preparedConfigCount,
      cycleCompiledResources: cycleLifecycle.lastCompiledResourceCount,
      reopenedCompiledResources: same.engineLifecycle.lastCompiledResourceCount,
      siteBuildCacheHit: sameMetrics.siteBuildCacheHit ?? null,
      skippedPublisherPhases: {
        templateMaterializeMs: sameMetrics.templateMaterializeMs ?? null,
        publisherRuntimeMs: sameMetrics.publisherRuntimeMs ?? null,
        publisherModelMs: sameMetrics.publisherModelMs ?? null,
        renderModelMs: sameMetrics.renderModelMs ?? null,
        outputCatalogMs: sameMetrics.outputCatalogMs ?? null,
      },
    };
    if (sameWorkerContract.recycleAfterCycle !== sameWorkerContract.recycleBaseline
        || sameWorkerContract.recycleAfter !== sameWorkerContract.recycleBaseline
        || sameWorkerContract.preparedConfigsAfterCycle !== 2
        || sameWorkerContract.preparedConfigsAfterReopen !== 2
        || !(sameWorkerContract.cycleCompiledResources > 0)
        || sameWorkerContract.reopenedCompiledResources !== 0
        || sameWorkerContract.siteBuildCacheHit !== 1
        || Object.values(sameWorkerContract.skippedPublisherPhases)
          .some((value) => value !== 0)) {
      throw new Error(`US Core -> Cycle -> US Core did not retain the exact SiteEngine generation: ${JSON.stringify(sameWorkerContract)}`);
    }

    const warmMountMs = (warm.operationTotals.init?.durationMs || 0)
      + (warm.operationTotals.mountPackages?.durationMs || 0);
    const report = {
      schemaVersion: 1,
      benchmark: 'fhir-ig-editor-uscore-loading',
      generatedAt: new Date().toISOString(),
      url: base,
      environment: {
        browser: version.Browser,
        protocolVersion: version['Protocol-Version'],
        userAgent: await target.evaluate('navigator.userAgent'),
        cpuThrottle,
        mobile,
      },
      phases: {
        coldStart: cold,
        warmHardReload: warm,
        ...(profileEdit ? { profileEdit } : {}),
        sameWorkerReopen: same,
      },
      contracts: {
        warmPreparedMount: {
          warmCalls: warmPreparedMount.preparedWarmCalls,
          coldCalls: warmPreparedMount.preparedColdCalls,
          mixedCalls: warmPreparedMount.preparedMixedCalls,
          chunksInflatedAtCommit: warmPreparedMount.preparedChunksInflated,
          rawInflatedBytesAtCommit: warmPreparedMount.preparedRawInflatedBytes,
          closureVerifyMs: warmClosureVerifyMs,
        },
        sameWorkerReopen: sameWorkerContract,
      },
      comparisons: {
        warmToColdRatio: ratio(warm.durationMs / cold.durationMs),
        sameWorkerToWarmRatio: ratio(same.durationMs / warm.durationMs),
        warmPackageInitAndMountMs: round(warmMountMs),
        warmPackageInitAndMountShare: ratio(warmMountMs / warm.durationMs),
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    target.close();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    benchmark: 'fhir-ig-editor-uscore-loading',
    ok: false,
    url: base,
    error: String(error?.stack || error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
