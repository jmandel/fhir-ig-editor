#!/usr/bin/env node
// Repeatable project load benchmark over raw Chrome DevTools Protocol.
//
// The benchmark deliberately clears storage for the target origin, then measures:
//   1. a cold app boot followed by a cold catalog-project open;
//   2. a hard reload in the same persistent browser profile (OPFS/CAS warm),
//      including prior-preview UI/page and current-ready milestones;
//   3. Cycle -> project in the same page/worker (packages already resident).
//
// Recommended one-command local run (launches its own server and Chrome):
//   BASE_PATH=/fhir-ig-editor/ \
//     BENCH_PROJECT=mcode bash scripts/run-project-benchmark.sh app/dist > project-benchmark.json
//
// Against an already-running remote-debug Chrome (DESTRUCTIVELY clears storage
// for the supplied origin, so use a disposable Chrome profile):
//   chromium --headless=new --remote-debugging-port=9222 \
//     --user-data-dir=/tmp/ig-bench-profile about:blank
//   CDP_PORT=9222 BENCH_PROJECT=mcode node scripts/benchmark-project.mjs \
//     https://joshuamandel.com/fhir-ig-editor/ > project-benchmark.json
//
// Optional environment:
//   BENCH_CPU_THROTTLE=4  page-target-only CDP CPU slowdown (default 1)
//   BENCH_CHROME_CPU_QUOTA_PERCENT=25
//                         whole disposable Chrome process-tree CPU quota;
//                         use run-project-benchmark.sh to apply it
//   BENCH_MOBILE=1        emulate a 412x915, deviceScaleFactor=3 viewport
//   BENCH_WIDE_PREVIEW=1  emulate 1440x900 and keep the activated Preview
//                         visibly docked while Author/Explore remains selected
//   BENCH_EDIT=0          skip the project's representative edit (default 1)
//   BENCH_TIMEOUT_MS=300000 per readiness wait before throttle scaling

import { readFile } from 'node:fs/promises';
import {
  CdpPendingCalls,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
  TopLevelNavigationLifecycle,
  createCatalogSelectionProbe,
  isExactPreviewSuccessor,
  isRetainedPreviewBinding,
  isCommittedTopLevelFrame,
  reconcileWorkerTargetEvidence,
  reconcileCompletedWorkerBody,
  reconcileNetworkRuleEvidence,
  isWorkerEntry,
  summarizeAppliedNetworkRuleCoverage,
  requiresAppliedNetworkRuleProof,
  transientCdpFallback,
} from './benchmark-cdp-lifecycle.mjs';

const HELP = `Usage:
  CDP_PORT=9222 node scripts/benchmark-project.mjs <editor-url>

Produces one machine-readable JSON document on stdout. Progress goes to stderr.
The target origin's cookies, caches, service workers, IndexedDB, and OPFS data
are cleared before the cold phase. Always use a disposable Chrome profile.

For a self-contained local run:
  BASE_PATH=/fhir-ig-editor/ BENCH_PROJECT=mcode bash scripts/run-project-benchmark.sh app/dist
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const targetUrl = new URL(process.argv[2] || 'http://127.0.0.1:4173/');
if (!targetUrl.pathname.endsWith('/')) targetUrl.pathname += '/';
const base = targetUrl.href;
const origin = targetUrl.origin;
function positiveSafeInteger(name, fallback, minimum = 1) {
  const raw = process.env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || String(value) !== raw.trim()) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return value;
}

function booleanSetting(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value !== '0' && value !== '1') throw new Error(`${name} must be 0 or 1`);
  return value === '1';
}

const cdpPort = positiveSafeInteger('CDP_PORT', 9222);
const cdpHttp = `http://127.0.0.1:${cdpPort}`;
const cpuThrottle = Number(process.env.BENCH_CPU_THROTTLE || 1);
if (!Number.isFinite(cpuThrottle) || cpuThrottle < 1) {
  throw new Error('BENCH_CPU_THROTTLE must be a finite number >= 1');
}
const chromeCpuQuotaText = process.env.BENCH_CHROME_CPU_QUOTA_PERCENT?.trim() || '';
const chromeCpuQuotaPercent = chromeCpuQuotaText === '' ? null : Number(chromeCpuQuotaText);
const chromeCpuQuotaApplied = process.env.BENCH_CHROME_CPU_QUOTA_APPLIED?.trim() || null;
const chromeCpuQuotaUnit = process.env.BENCH_CHROME_CPU_QUOTA_UNIT?.trim() || null;
if (chromeCpuQuotaPercent != null
    && (!Number.isSafeInteger(chromeCpuQuotaPercent)
      || chromeCpuQuotaPercent <= 0
      || chromeCpuQuotaPercent > 100)) {
  throw new Error('BENCH_CHROME_CPU_QUOTA_PERCENT must be an integer from 1 through 100');
}
if (chromeCpuQuotaPercent != null && cpuThrottle !== 1) {
  throw new Error('BENCH_CPU_THROTTLE and BENCH_CHROME_CPU_QUOTA_PERCENT are mutually exclusive');
}
if (chromeCpuQuotaPercent != null && !chromeCpuQuotaApplied) {
  throw new Error('whole-Chrome CPU quota was requested but not applied; use run-project-benchmark.sh');
}
if (chromeCpuQuotaPercent == null && chromeCpuQuotaApplied) {
  throw new Error('BENCH_CHROME_CPU_QUOTA_APPLIED is set without a requested quota');
}
const baseTimeoutMs = positiveSafeInteger('BENCH_TIMEOUT_MS', 300_000, 30_000);
const timeoutScale = Math.max(
  cpuThrottle,
  chromeCpuQuotaPercent == null ? 1 : 100 / chromeCpuQuotaPercent,
);
const timeoutMs = Math.ceil(baseTimeoutMs * timeoutScale);
if (!Number.isSafeInteger(timeoutMs)) throw new Error('scaled BENCH_TIMEOUT_MS exceeds safe integer range');
const baseCdpCallTimeoutMs = positiveSafeInteger('BENCH_CDP_CALL_TIMEOUT_MS', 60_000, 1_000);
const cdpCallTimeoutMs = Math.ceil(baseCdpCallTimeoutMs * timeoutScale);
if (!Number.isSafeInteger(cdpCallTimeoutMs)) {
  throw new Error('scaled BENCH_CDP_CALL_TIMEOUT_MS exceeds safe integer range');
}
const mobile = booleanSetting('BENCH_MOBILE', '0');
const widePreview = booleanSetting('BENCH_WIDE_PREVIEW', '0');
if (mobile && widePreview) {
  throw new Error('BENCH_MOBILE and BENCH_WIDE_PREVIEW are mutually exclusive');
}
const legacyEdit = process.env.BENCH_PROFILE_EDIT;
if (legacyEdit != null && process.env.BENCH_EDIT != null && legacyEdit !== process.env.BENCH_EDIT) {
  throw new Error('BENCH_EDIT and legacy BENCH_PROFILE_EDIT disagree');
}
const editEnabled = booleanSetting(
  'BENCH_EDIT',
  process.env.BENCH_EDIT ?? legacyEdit ?? '1',
);
const projectId = process.env.BENCH_PROJECT || 'uscore';
const networkProfile = process.env.BENCH_NETWORK_PROFILE || 'none';
const NETWORK_PROFILES = {
  none: null,
  'fast-4g': {
    offline: false,
    latency: 150,
    downloadThroughput: 200_000,
    uploadThroughput: 93_750,
    connectionType: 'cellular4g',
  },
  'slow-4g': {
    offline: false,
    latency: 400,
    downloadThroughput: 50_000,
    uploadThroughput: 50_000,
    connectionType: 'cellular4g',
  },
};
if (!Object.hasOwn(NETWORK_PROFILES, networkProfile)) {
  throw new Error(`unknown BENCH_NETWORK_PROFILE ${networkProfile}`);
}

// Representative edits are data, not branches in the benchmark pipeline. Each
// scenario exercises an ordinary authored source channel and proves that the
// requested published page actually changes.
const EDIT_SCENARIOS = {
  tiny: {
    sourceKind: 'fsh',
    scheduling: 'leading-latest-only',
    sourcePath: 'input/fsh/00-EditorUser.fsh',
    previewPath: 'en/StructureDefinition-editor-user.html',
    before: 'Name used while exploring the editor',
    after: 'Name used while benchmarking the editor',
  },
  ips: {
    sourceKind: 'fsh',
    scheduling: 'leading-latest-only',
    sourcePath: 'input/fsh/profiles/PatientUvIps.fsh',
    previewPath: 'en/StructureDefinition-Patient-uv-ips.html',
    before: 'Title: "Patient (IPS)"',
    after: 'Title: "Patient (IPS) Benchmark Edit"',
    expectedPreviewText: 'Patient (IPS) Benchmark Edit',
  },
  uscore: {
    sourceKind: 'json',
    scheduling: 'leading-latest-only',
    sourcePath: 'input/resources/structuredefinition-us-core-patient.json',
    previewPath: 'en/StructureDefinition-us-core-patient.html',
    before: '"title": "US Core Patient Profile"',
    after: '"title": "US Core Patient Profile Benchmark Edit"',
    expectedPreviewText: 'US Core Patient Profile Benchmark Edit',
  },
  mcode: {
    sourceKind: 'prose',
    scheduling: 'leading-latest-only',
    sourcePath: 'input/pagecontent/StructureDefinition-mcode-cancer-patient-intro.md',
    previewPath: 'en/StructureDefinition-mcode-cancer-patient.html',
    before: '### Conformance',
    after: '### Conformance Benchmark Edit',
    expectedPreviewText: 'Conformance Benchmark Edit',
  },
};
const editScenario = editEnabled ? EDIT_SCENARIOS[projectId] : null;
if (editEnabled && !editScenario) {
  throw new Error(`BENCH_EDIT=1 has no representative edit descriptor for ${projectId}`);
}

const runnerProvenance = {
  artifact: {
    sha256: process.env.BENCH_ARTIFACT_SHA256 || null,
    fileCount: Number(process.env.BENCH_ARTIFACT_FILE_COUNT || 0) || null,
    byteLength: Number(process.env.BENCH_ARTIFACT_BYTE_LENGTH || 0) || null,
  },
  host: {
    os: process.env.BENCH_HOST_OS || null,
    kernel: process.env.BENCH_HOST_KERNEL || null,
    architecture: process.env.BENCH_HOST_ARCH || null,
    cpuModel: process.env.BENCH_HOST_CPU_MODEL || null,
    logicalCpuCount: Number(process.env.BENCH_HOST_LOGICAL_CPUS || 0) || null,
    memoryBytes: Number(process.env.BENCH_HOST_MEMORY_BYTES || 0) || null,
  },
  runner: {
    revision: process.env.BENCH_RUNNER_REVISION || null,
    dirty: process.env.BENCH_RUNNER_DIRTY === '1',
    recipeSha256: process.env.BENCH_RUNNER_RECIPE_SHA256 || null,
    runtime: process.env.BENCH_RUNTIME_VERSION || null,
    chromeBinarySha256: process.env.BENCH_CHROME_BINARY_SHA256 || null,
  },
};
if (!runnerProvenance.runner.recipeSha256) {
  throw new Error('runner did not provide BENCH_RUNNER_RECIPE_SHA256');
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (n) => Math.round(n * 10) / 10;
const ratio = (n) => Math.round(n * 1000) / 1000;

function progress(message) {
  process.stderr.write(`[project-benchmark:${projectId}] ${message}\n`);
}

async function processMemoryReceipt() {
  const path = process.env.BENCH_PROCESS_MEMORY_FILE;
  if (!path) return { available: false, reason: 'runner did not provide a process sampler' };
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return {
      ...value,
      available: value.available === true,
      semantics: '100ms runner sampling of the disposable Chrome process tree/cgroup; observed peak, not allocator high-water accounting',
    };
  } catch (error) {
    return { available: false, reason: `could not read runner sample: ${error.message}` };
  }
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
  constructor(ws, networkEvents, memoryEvents) {
    this.ws = ws;
    this.networkEvents = networkEvents;
    this.memoryEvents = memoryEvents;
    this.sessions = new Map();
    this.sessionEvidence = [];
    this.targetInfoById = new Map();
    this.networkRequests = new Map();
    this.networkRuleEvidence = [];
    this.lastNetworkActivityAt = Date.now();
    this.phase = 'setup';
    this.phaseGeneration = 0;
    this.phaseStartedAtEpochMs = Date.now();
    this.pageLifecycle = new TopLevelNavigationLifecycle();
    this.pageContext = null;
    this.rpc = new CdpPendingCalls(
      (message) => this.ws.send(JSON.stringify(message)),
      cdpCallTimeoutMs,
      () => this.phase,
    );
    this.memorySampleId = 0;
    this.memorySamplingPromise = null;
    this.memoryTimer = null;
    this.networkConditions = NETWORK_PROFILES[networkProfile];
    this.networkRuleIds = new Set();
    ws.addEventListener('message', (event) => this.onMessage(JSON.parse(event.data)));
    ws.addEventListener('close', () => this.failTransport('Chrome DevTools WebSocket closed'));
    ws.addEventListener('error', () => this.failTransport('Chrome DevTools WebSocket failed'));
  }

  static async connect(wsUrl, networkEvents, memoryEvents) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpTarget(ws, networkEvents, memoryEvents);
  }

  onMessage(message) {
    if (this.rpc.handleResponse(message)) return;
    const params = message.params;
    if (!params) return;
    if (!message.sessionId) this.pageLifecycle.observe(message.method, params);
    if (message.method === 'Target.targetCreated'
        || message.method === 'Target.targetInfoChanged') {
      const evidence = this.targetInfoById.get(params.targetInfo.targetId) || {
        targetId: params.targetInfo.targetId,
        observedPhase: this.phase,
        observedPhaseGeneration: this.phaseGeneration,
        proof: null,
        entryRequestConsumed: false,
        terminal: false,
      };
      evidence.type = params.targetInfo.type;
      evidence.url = params.targetInfo.url;
      if (!evidence.proof) {
        evidence.observedPhase = this.phase;
        evidence.observedPhaseGeneration = this.phaseGeneration;
      }
      this.targetInfoById.set(evidence.targetId, evidence);
      return;
    }
    if (message.method === 'Target.targetDestroyed') {
      const evidence = this.targetInfoById.get(params.targetId);
      if (evidence) {
        if (!evidence.proof) {
          evidence.proof = 'destroyed-only';
          evidence.proofUrl = evidence.url;
          evidence.proofPhase = evidence.observedPhase;
          evidence.proofPhaseGeneration = evidence.observedPhaseGeneration;
        }
        evidence.terminal = true;
        evidence.destroyedAtEpochMs = Date.now();
        for (const [sessionId, session] of this.sessions) {
          if (session.targetId !== params.targetId) continue;
          this.rpc.rejectSession(sessionId, new CdpSessionDetachedError(sessionId));
          this.sessions.delete(sessionId);
        }
        this.reconcileWorkerTargets(evidence.destroyedAtEpochMs);
      }
      return;
    }
    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = params;
      const attachedAtEpochMs = Date.now();
      const evidence = this.targetInfoById.get(targetInfo.targetId) || {
        targetId: targetInfo.targetId,
        observedPhase: this.phase,
        observedPhaseGeneration: this.phaseGeneration,
        proof: null,
        entryRequestConsumed: false,
      };
      evidence.sessionId = sessionId;
      evidence.type = targetInfo.type;
      evidence.url = targetInfo.url;
      evidence.attachedAtEpochMs = attachedAtEpochMs;
      evidence.proof = 'attached';
      evidence.proofUrl = targetInfo.url;
      evidence.proofPhase = this.phase;
      evidence.proofPhaseGeneration = this.phaseGeneration;
      evidence.terminal = false;
      evidence.runtimeEnabled = false;
      evidence.networkEnabled = false;
      evidence.networkConditionsApplied = false;
      evidence.resumed = false;
      evidence.errors = [];
      this.targetInfoById.set(evidence.targetId, evidence);
      this.sessions.set(sessionId, evidence);
      this.sessionEvidence.push(evidence);
      // Chromium may emit requestWillBeSent/responseReceived for a dedicated
      // Worker's entry script on the parent page target but omit the matching
      // loadingFinished there once the request becomes the Worker target. A
      // successful attachment proves that exact entry script completed far
      // enough to instantiate the target; close that cross-target request and
      // retain the inference explicitly rather than leaving a false in-flight
      // request at every phase boundary.
      this.reconcileWorkerTargets(attachedAtEpochMs);
      this.lastNetworkActivityAt = attachedAtEpochMs;
      void this.configureSession(sessionId, evidence).catch((error) => {
        progress(`could not instrument ${targetInfo.type} target: ${error.message}`);
      });
      return;
    }
    if (message.method === 'Target.detachedFromTarget') {
      this.rpc.rejectSession(params.sessionId, new CdpSessionDetachedError(params.sessionId));
      this.sessions.delete(params.sessionId);
      return;
    }
    if (message.method === 'Network.requestWillBeSent') {
      this.lastNetworkActivityAt = Date.now();
      const key = this.networkKey(message.sessionId, params.requestId);
      const redirected = this.networkRequests.get(key);
      if (redirected) {
        redirected.redirected = true;
        redirected.completedPhase = this.phase;
        redirected.responseTimestampMs = params.timestamp * 1000;
        redirected.finishedTimestampMs = params.timestamp * 1000;
        redirected.durationMs = Math.max(0, redirected.finishedTimestampMs - redirected.startedTimestampMs);
        redirected.status = params.redirectResponse?.status ?? redirected.status;
      }
      const startedAtEpochMs = Number.isFinite(params.wallTime)
        ? params.wallTime * 1000
        : Date.now();
      const request = {
        phase: this.phase,
        phaseGeneration: this.phaseGeneration,
        completedPhase: null,
        sessionId: message.sessionId || null,
        targetType: this.sessions.get(message.sessionId)?.type || 'page',
        targetUrl: this.sessions.get(message.sessionId)?.url || base,
        requestId: params.requestId,
        networkKey: key,
        url: params.request.url,
        resourceType: params.type,
        startedTimestampMs: params.timestamp * 1000,
        startedAtEpochMs,
        phaseOffsetMs: startedAtEpochMs - this.phaseStartedAtEpochMs,
        responseTimestampMs: null,
        finishedTimestampMs: null,
        durationMs: null,
        status: null,
        mimeType: null,
        encodedBytes: 0,
        fromDiskCache: false,
        fromServiceWorker: false,
        fromPrefetchCache: false,
        servedFromCache: false,
        appliedNetworkConditionsId: null,
      };
      this.networkEvents.push(request);
      this.networkRequests.set(key, request);
      reconcileNetworkRuleEvidence(this.networkEvents, this.networkRuleEvidence);
      this.releaseProvenTerminalNetworkRequests();
      // Target and Network are independent CDP domains, so attachment can be
      // delivered before the parent-page request event. Replay the same exact,
      // unambiguous join against active Workers owned by the same benchmark
      // phase. Cross-domain delivery time and Network.wallTime are not a causal
      // clock; phase ownership plus one-use evidence closes both event orders.
      this.reconcileWorkerTargets(Date.now());
      return;
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') {
      this.lastNetworkActivityAt = Date.now();
      this.networkRuleEvidence.push({
        requestId: params.requestId,
        sessionId: message.sessionId || null,
        appliedNetworkConditionsId: params.appliedNetworkConditionsId || null,
        phaseGeneration: this.phaseGeneration,
        consumed: false,
      });
      reconcileNetworkRuleEvidence(this.networkEvents, this.networkRuleEvidence);
      this.releaseProvenTerminalNetworkRequests();
      return;
    }
    const key = this.networkKey(message.sessionId, params.requestId);
    const request = this.networkRequests.get(key);
    if (!request) return;
    if (message.method === 'Network.requestServedFromCache') {
      this.lastNetworkActivityAt = Date.now();
      request.servedFromCache = true;
    } else if (message.method === 'Network.responseReceived') {
      this.lastNetworkActivityAt = Date.now();
      request.responseTimestampMs = params.timestamp * 1000;
      request.status = params.response.status;
      request.mimeType = params.response.mimeType;
      request.responseTiming = params.response.timing || null;
      request.fromDiskCache = !!params.response.fromDiskCache;
      request.fromServiceWorker = !!params.response.fromServiceWorker;
      request.fromPrefetchCache = !!params.response.fromPrefetchCache;
      request.encodedBytes = Math.max(
        request.encodedBytes,
        Number(params.response.encodedDataLength) || 0,
      );
    } else if (message.method === 'Network.loadingFinished') {
      this.lastNetworkActivityAt = Date.now();
      request.encodedBytes = params.encodedDataLength || 0;
      request.completedPhase = this.phase;
      request.finishedTimestampMs = params.timestamp * 1000;
      request.durationMs = Math.max(0, request.finishedTimestampMs - request.startedTimestampMs);
      this.releaseTerminalNetworkRequest(key, request);
    } else if (message.method === 'Network.loadingFailed') {
      this.lastNetworkActivityAt = Date.now();
      request.failed = params.errorText || 'failed';
      request.completedPhase = this.phase;
      request.finishedTimestampMs = params.timestamp * 1000;
      request.durationMs = Math.max(0, request.finishedTimestampMs - request.startedTimestampMs);
      this.releaseTerminalNetworkRequest(key, request);
    }
  }

  networkKey(sessionId, requestId) {
    return `${sessionId || 'page'}:${requestId}`;
  }

  call(method, params = {}, sessionId = null, limit = cdpCallTimeoutMs) {
    return this.rpc.call(method, params, sessionId, limit);
  }

  failTransport(message) {
    const failure = new CdpTransportError(message);
    this.rpc.fail(failure);
    this.pageLifecycle.fail(failure);
  }

  releaseTerminalNetworkRequest(key, request) {
    if (!this.networkConditions
        || !requiresAppliedNetworkRuleProof(request)
        || this.networkRuleIds.has(request.appliedNetworkConditionsId)) {
      this.networkRequests.delete(key);
    }
  }

  retainUnprovenTerminalNetworkRequests() {
    if (!this.networkConditions) return;
    for (const request of this.networkEvents) {
      if (request.completedPhase == null
          || !requiresAppliedNetworkRuleProof(request)
          || this.networkRuleIds.has(request.appliedNetworkConditionsId)) continue;
      this.networkRequests.set(request.networkKey, request);
    }
  }

  releaseProvenTerminalNetworkRequests() {
    if (!this.networkConditions) return;
    for (const [key, request] of this.networkRequests) {
      if (request.completedPhase == null
          || !requiresAppliedNetworkRuleProof(request)
          || !this.networkRuleIds.has(request.appliedNetworkConditionsId)) continue;
      this.networkRequests.delete(key);
    }
  }

  async navigate(url) {
    const request = this.pageLifecycle.beginNavigation();
    this.pageContext = null;
    const result = await this.call('Page.navigate', { url });
    this.pageContext = await this.pageLifecycle.waitForNavigation(
      request,
      result,
      cdpCallTimeoutMs,
      this.phase,
    );
    return result;
  }

  async reload(params = {}) {
    const active = this.pageLifecycle.assertActive(this.pageContext);
    const request = this.pageLifecycle.beginReload(active);
    this.pageContext = null;
    const result = await this.call('Page.reload', {
      ...params,
      // Bind the command to the loader whose replacement we are measuring.
      // Chromium rejects a stale loader instead of reloading a different page.
      loaderId: active.loaderId,
    });
    this.pageContext = await this.pageLifecycle.waitForNavigation(
      request,
      result,
      cdpCallTimeoutMs,
      this.phase,
    );
    return result;
  }

  async retireProbeDocument() {
    this.pageContext = null;
    const expectedUrl = 'about:blank';
    const result = await this.call('Page.navigate', { url: expectedUrl });
    if (result.errorText || result.isDownload || !result.frameId || !result.loaderId) {
      throw new Error(`could not retire benchmark probe document: ${JSON.stringify(result)}`);
    }
    const deadline = Date.now() + cdpCallTimeoutMs;
    while (Date.now() < deadline) {
      const frameTree = await this.call('Page.getFrameTree');
      if (isCommittedTopLevelFrame(frameTree, result, expectedUrl)) return result;
      await sleep(25);
    }
    throw new Error(
      `timed out after ${cdpCallTimeoutMs}ms waiting for the setup frame to commit `
      + `${result.loaderId}`,
    );
  }

  async configureSession(sessionId, evidence) {
    try {
      await this.call('Runtime.enable', {}, sessionId);
      evidence.runtimeEnabled = true;
      await this.call('Network.enable', {
        maxTotalBufferSize: 128 * 1024 * 1024,
        maxResourceBufferSize: 32 * 1024 * 1024,
      }, sessionId);
      evidence.networkEnabled = true;
      // Chromium rejects Network emulation commands on dedicated-Worker
      // sessions. The page's global request rule applies to related Workers;
      // requestWillBeSentExtraInfo later proves that application per request.
    } catch (error) {
      evidence.errors.push(String(error?.message || error));
      throw error;
    } finally {
      try {
        await this.call('Runtime.runIfWaitingForDebugger', {}, sessionId);
        evidence.resumed = true;
      } catch (error) {
        evidence.errors.push(`resume: ${String(error?.message || error)}`);
      }
    }
  }

  setPhase(phase) {
    this.phase = phase;
    this.phaseGeneration += 1;
    this.phaseStartedAtEpochMs = Date.now();
  }

  reconcileWorkerTargets(now = Date.now()) {
    const reconciled = reconcileWorkerTargetEvidence(
      this.networkEvents,
      this.networkRequests,
      this.targetInfoById.values(),
      this.phaseGeneration,
      this.phase,
      now,
    );
    this.retainUnprovenTerminalNetworkRequests();
    if (reconciled > 0) this.lastNetworkActivityAt = now;
    return reconciled;
  }

  async reconcileCompletedWorkerBodies(minimumAgeMs) {
    const now = Date.now();
    let reconciled = 0;
    for (const [key, request] of [...this.networkRequests]) {
      if (!isWorkerEntry(request)
          || request.responseTimestampMs == null
          || now - request.startedAtEpochMs < minimumAgeMs) continue;
      try {
        await this.call(
          'Network.getResponseBody',
          { requestId: request.requestId },
          request.sessionId,
          Math.min(cdpCallTimeoutMs, 10_000),
        );
      } catch (error) {
        // "No resource with given identifier" means only that this optional
        // proof is unavailable; keep the request open for its ordinary terminal
        // event. Transport/timeouts remain terminal benchmark failures.
        if (error instanceof CdpProtocolError) continue;
        throw error;
      }
      reconciled += reconcileCompletedWorkerBody(
        this.networkRequests,
        key,
        this.phase,
        Date.now(),
      );
    }
    if (reconciled > 0) this.lastNetworkActivityAt = Date.now();
    this.retainUnprovenTerminalNetworkRequests();
    return reconciled;
  }

  /** The initial probe document is outside every measured phase. Chromium can
   * cancel its implicit favicon request while navigating to about:blank without
   * emitting loadingFailed/loadingFinished on the old page Network domain. Mark
   * only those setup requests terminal at the explicit setup boundary; measured
   * phases continue to fail closed on every open request. */
  retireSetupRequests() {
    const now = Date.now();
    let retired = 0;
    for (const [key, request] of this.networkRequests) {
      if (request.phase !== 'setup') continue;
      request.completedPhase = 'setup';
      request.finishedTimestampMs = request.startedTimestampMs
        + Math.max(0, now - request.startedAtEpochMs);
      request.durationMs = Math.max(0, request.finishedTimestampMs - request.startedTimestampMs);
      request.inferredCompletion = 'explicit-setup-boundary';
      request.failed ||= 'probe document retired before measurement';
      this.networkRequests.delete(key);
      retired += 1;
    }
    if (retired > 0) this.lastNetworkActivityAt = now;
    return retired;
  }

  async drainNetwork(phase, quietMs = 250, limit = timeoutMs) {
    const started = Date.now();
    const deadline = started + limit;
    let reportedPending = false;
    while (Date.now() < deadline) {
      const pending = [...this.networkRequests.values()];
      const quietForMs = Date.now() - this.lastNetworkActivityAt;
      if (quietForMs >= quietMs) {
        const minimumAgeMs = Math.max(2_000, quietMs * 4);
        const reconciled = this.reconcileWorkerTargets()
          + await this.reconcileCompletedWorkerBodies(minimumAgeMs);
        if (reconciled > 0) {
          await sleep(quietMs);
          continue;
        }
      }
      if (pending.length === 0 && quietForMs >= quietMs) {
        return {
          phase,
          durationMs: Date.now() - started,
          quietMs,
          pendingAtEnd: 0,
        };
      }
      if (!reportedPending && Date.now() - started >= 2_000 && pending.length > 0) {
        reportedPending = true;
        progress(`waiting for ${phase} network drain: ${JSON.stringify(pending.map((request) => ({
          startedPhase: request.phase,
          resourceType: request.resourceType,
          targetType: request.targetType,
          requestId: request.requestId,
          phaseGeneration: request.phaseGeneration,
          completedPhase: request.completedPhase,
          appliedNetworkConditionsId: request.appliedNetworkConditionsId,
          ruleEvidence: this.networkRuleEvidence.filter((evidence) =>
            evidence.requestId === request.requestId).map((evidence) => ({
            phaseGeneration: evidence.phaseGeneration,
            appliedNetworkConditionsId: evidence.appliedNetworkConditionsId,
            consumed: evidence.consumed,
          })),
          url: request.url,
        })))}`);
      }
      await sleep(25);
    }
    const pending = [...this.networkRequests.values()].map((request) => ({
      startedPhase: request.phase,
      url: request.url,
      targetType: request.targetType,
    }));
    throw new Error(`timeout draining ${phase} network requests: ${JSON.stringify(pending)}`);
  }

  startMemorySampling(intervalMs = 250) {
    if (this.memoryTimer) return;
    const sample = () => { void this.sampleMemory(); };
    this.memoryTimer = setInterval(sample, intervalMs);
    sample();
  }

  async sampleMemory() {
    if (this.memorySamplingPromise) return this.memorySamplingPromise;
    const sampleId = ++this.memorySampleId;
    const at = Date.now();
    const phase = this.phase;
    const targets = [
      { sessionId: null, targetId: 'page', type: 'page', url: base },
      ...[...this.sessions].map(([sessionId, target]) => ({ sessionId, ...target })),
    ];
    const sampling = (async () => {
      const results = await Promise.all(targets.map(async (target) => {
        const usage = await this.call('Runtime.getHeapUsage', {}, target.sessionId).catch((error) => {
          // A transient Monaco worker may disappear between the target snapshot
          // and this call. Detach is terminal for that session-scoped request,
          // but not a benchmark failure. Active page/engine timeouts still fail.
          if (target.sessionId
              && (error instanceof CdpSessionDetachedError
                || !this.sessions.has(target.sessionId))) return null;
          throw error;
        });
        return { target, usage };
      }));
      for (const { target, usage } of results) {
        if (!usage) continue;
        this.memoryEvents.push({
          kind: 'target',
          sampleId,
          at,
          phase,
          targetId: target.targetId,
          targetType: target.type,
          url: target.url,
          usedSize: usage.usedSize || 0,
          totalSize: usage.totalSize || 0,
          backingStorageSize: usage.backingStorageSize || 0,
        });
      }
      this.memoryEvents.push({
        kind: 'sample',
        sampleId,
        at,
        phase,
        expectedTargetCount: targets.length,
        respondingTargetCount: results.filter(({ usage }) => usage).length,
      });
    })();
    this.memorySamplingPromise = sampling;
    try {
      await sampling;
    } finally {
      if (this.memorySamplingPromise === sampling) this.memorySamplingPromise = null;
    }
  }

  async captureMemorySample() {
    if (this.memorySamplingPromise) await this.memorySamplingPromise;
    await this.sampleMemory();
  }

  async stopMemorySampling() {
    if (this.memoryTimer) clearInterval(this.memoryTimer);
    this.memoryTimer = null;
    if (this.memorySamplingPromise) await this.memorySamplingPromise;
  }

  async evaluate(expression) {
    const context = this.pageLifecycle.assertActive(this.pageContext);
    const response = await this.call('Runtime.evaluate', {
      expression,
      contextId: context.contextId,
      // Every benchmark expression is synchronous. Asking Runtime to await a
      // non-Promise adds an unnecessary cross-domain continuation and has been
      // observed to strand a command under whole-Chrome CPU throttling.
      awaitPromise: false,
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
      if (await this.evaluate(expression).catch((error) => transientCdpFallback(error, false))) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  close() {
    this.failTransport('Chrome DevTools target closed by benchmark');
    this.ws.close();
  }
}

// Installed before every editor document. It records worker RPCs without
// serializing their (sometimes enormous) arguments and samples visible progress.
const INSTRUMENTATION = String.raw`(() => {
  const benchmarkProject = ${JSON.stringify(projectId)};
  const trace = window.__igProjectBenchmark = {
    phaseStart: performance.now(),
    operations: [],
    progress: [],
    longTasks: [],
    seenOpenProgress: false,
    milestones: {},
    catalogSelection: null,
  };
  const ensureCatalogSelection = (${createCatalogSelectionProbe.toString()})(
    window,
    document,
    benchmarkProject,
  );
  let nextWorkerId = 0;
  const originalPostMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function(message, ...rest) {
    if (!this.__igProjectBenchmarkWired) {
      this.__igProjectBenchmarkWired = true;
      this.__igProjectBenchmarkWorkerId = ++nextWorkerId;
      this.addEventListener('message', (event) => {
        const data = event.data;
        if (!data || typeof data.id !== 'number') return;
        const current = window.__igProjectBenchmark;
        const operation = [...current.operations].reverse()
          .find((entry) => entry.workerId === this.__igProjectBenchmarkWorkerId
            && entry.id === data.id && entry.end == null);
        if (!operation) return;
        operation.end = performance.now();
        operation.duration = operation.end - operation.start;
        operation.ok = !!data.ok;
        const result = data.result || {};
        const events = Array.isArray(result.events) ? result.events : [];
        const eventMetrics = Object.assign({}, ...events.map((entry) => entry.metrics || {}));
        operation.events = events;
        const aligned = events.filter((entry) => Number.isFinite(entry.startMs));
        operation.eventEnvelopeDuration = aligned.length > 0
          ? Math.max(...aligned.map((entry) => entry.startMs + (Number(entry.durationMs) || 0)))
            - Math.min(...aligned.map((entry) => entry.startMs))
          : null;
        operation.newlyMounted = result.newlyMounted || [];
        operation.mounted = result.mounted ?? null;
        operation.inputByteObservations = events
          .filter((entry) => Number(entry.inputBytes) > 0)
          .map((entry) => ({ phase: entry.phase || null, inputBytes: Number(entry.inputBytes) }));
        // BuildEvents may be nested observations of the same carrier. Only a
        // single owning observation is safe to aggregate without double count.
        operation.inputBytes = operation.inputByteObservations.length === 1
          ? operation.inputByteObservations[0].inputBytes
          : null;
        operation.serializeMs = eventMetrics.workerSerializeMs ?? null;
        operation.wasmMs = eventMetrics.wasmMs ?? null;
        operation.preparedMetrics = Object.keys(eventMetrics).some((key) => key.startsWith('prepared'))
          ? {
              mode: eventMetrics.preparedMixed ? 'mixed'
                : eventMetrics.preparedWarmBinary ? 'warm-binary' : 'cold-prepare',
              added: eventMetrics.preparedAdded,
              artifactBytes: eventMetrics.preparedArtifactBytes,
              preparedMembers: eventMetrics.preparedMembers,
              indexedMembers: eventMetrics.preparedIndexedMembers,
              retainedBlobBytes: eventMetrics.preparedRetainedBlobBytes,
              maxStagedArtifactBytes: eventMetrics.preparedMaxStagedArtifactBytes,
              jsBatchBytes: eventMetrics.preparedJsBatchBytes,
              compressedRetainedBytes: eventMetrics.preparedCompressedRetainedBytes,
              declaredRawBytes: eventMetrics.preparedDeclaredRawBytes,
              chunksInflated: eventMetrics.preparedChunksInflated,
              rawInflatedBytes: eventMetrics.preparedRawInflatedBytes,
              chunkCacheHits: eventMetrics.preparedChunkCacheHits,
              cachedRawBytes: eventMetrics.preparedCachedRawBytes,
              memberBodyCopies: eventMetrics.preparedMemberBodyCopies,
              mountMemberBodyCopies: eventMetrics.preparedMountMemberBodyCopies,
              decodeValidatePrepareMs: eventMetrics.preparedDecodeValidatePrepareMs,
              decodeValidateMs: eventMetrics.preparedDecodeValidateMs,
              engineMountMs: eventMetrics.preparedEngineMountMs,
              inputJsonBytes: eventMetrics.preparedInputJsonBytes,
              base64Bytes: eventMetrics.preparedBase64Bytes,
              decodedSourceBytes: eventMetrics.preparedDecodedSourceBytes,
              normalizedBytes: eventMetrics.preparedNormalizedBytes,
              manifestJsonBytes: eventMetrics.preparedManifestJsonBytes,
              jsonParseMs: eventMetrics.preparedJsonParseMs,
              base64DecodeMs: eventMetrics.preparedBase64DecodeMs,
              normalizationMs: eventMetrics.preparedNormalizationMs,
              indexingMs: eventMetrics.preparedIndexingMs,
              artifactEncodeMs: eventMetrics.preparedArtifactEncodeMs,
              manifestParseMs: eventMetrics.preparedManifestParseMs,
            }
          : null;
        operation.packageStorage = {
          compressedRetainedBytes: eventMetrics.compressedRetainedBytes,
          declaredRawBytes: eventMetrics.declaredRawBytes,
          chunksInflated: eventMetrics.chunksInflated,
          rawInflatedBytes: eventMetrics.rawInflatedBytes,
          cacheHits: eventMetrics.cacheHits,
          cachedRawBytes: eventMetrics.cachedRawBytes,
        };
        operation.pageCount = Array.isArray(result.pages) ? result.pages.length : result.pages ?? null;
        operation.dataCount = result.data ?? null;
      });
    }
    if (message && typeof message.id === 'number' && message.op) {
      const args = Array.isArray(message.args) ? message.args : [];
      const addressedBuildId = [
        'outputs',
        'render',
        'finalize',
      ].includes(message.op)
        && typeof args[0] === 'string' ? args[0] : null;
      const addressedPath = message.op === 'render' && typeof args[1] === 'string'
        ? args[1] : null;
      window.__igProjectBenchmark.operations.push({
        workerId: this.__igProjectBenchmarkWorkerId,
        id: message.id,
        op: message.op,
        buildId: addressedBuildId,
        path: addressedPath,
        start: performance.now(),
        end: null,
      });
    }
    return originalPostMessage.call(this, message, ...rest);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__igProjectBenchmark.longTasks.push({ start: entry.startTime, duration: entry.duration });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  const sample = () => {
    ensureCatalogSelection();
    const open = document.querySelector('.open-progress');
    const startup = document.querySelector('.startup-progress');
    const lazy = document.querySelector('.lazy-progress');
    const element = open || startup || lazy;
    if (open) window.__igProjectBenchmark.seenOpenProgress = true;
    const kind = open ? 'open' : startup ? 'startup' : lazy ? 'lazy' : 'clear';
    const stage = element?.getAttribute('data-stage') || '';
    const message = (
      element?.querySelector('.open-progress-msg')?.textContent || element?.textContent || ''
    ).replace(/\s+/g, ' ').trim().slice(0, 240);
    const signature = kind + '|' + stage + '|' + message;
    const current = window.__igProjectBenchmark;
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
          && framePath.includes('/preview/' + encodeURIComponent(benchmarkProject) + '/')
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
  const started = events.filter((event) => event.phase === phase);
  const completed = events.filter((event) => event.completedPhase === phase);
  const crossedInto = completed.filter((event) => event.phase !== phase);
  const crossedOut = started.filter((event) =>
    event.completedPhase != null && event.completedPhase !== phase);
  const pending = started.filter((event) => event.completedPhase == null);
  const encodedBytes = completed.reduce((sum, event) => sum + event.encodedBytes, 0);
  const packageLike = completed.filter((event) =>
    /packages\.fhir\.org|packages2\.fhir\.org|\/data\//.test(event.url),
  );
  return {
    semantics: 'bytes are attributed to completion phase; started/completed/cross-boundary counts are separate',
    requestCount: started.length,
    startedRequestCount: started.length,
    completedRequestCount: completed.length,
    crossedIntoPhaseCount: crossedInto.length,
    crossedOutOfPhaseCount: crossedOut.length,
    pendingRequestCount: pending.length,
    encodedBytes: Math.round(encodedBytes),
    startedRequestEncodedBytes: Math.round(
      started.reduce((sum, event) => sum + event.encodedBytes, 0),
    ),
    packageLikeEncodedBytes: Math.round(
      packageLike.reduce((sum, event) => sum + event.encodedBytes, 0),
    ),
    cacheServedCount: completed.filter((event) =>
      event.servedFromCache || event.fromDiskCache || event.fromServiceWorker || event.fromPrefetchCache,
    ).length,
    requests: started.map((event) => ({
      url: event.url.startsWith(base) ? event.url.slice(base.length) : event.url,
      resourceType: event.resourceType,
      targetType: event.targetType,
      targetUrl: event.targetUrl.startsWith(base) ? event.targetUrl.slice(base.length) : event.targetUrl,
      status: event.status,
      encodedBytes: Math.round(event.encodedBytes),
      phaseOffsetMs: round(event.phaseOffsetMs),
      responseAfterStartMs: event.responseTimestampMs == null
        ? null
        : round(event.responseTimestampMs - event.startedTimestampMs),
      durationMs: event.durationMs == null ? null : round(event.durationMs),
      completedPhase: event.completedPhase,
      crossedPhaseBoundary: event.completedPhase != null && event.completedPhase !== event.phase,
      inferredCompletion: event.inferredCompletion || null,
      servedFromCache: event.servedFromCache,
      fromDiskCache: event.fromDiskCache,
      fromServiceWorker: event.fromServiceWorker,
      failed: event.failed,
    })),
    crossedIntoPhase: crossedInto.map((event) => ({
      url: event.url.startsWith(base) ? event.url.slice(base.length) : event.url,
      startedPhase: event.phase,
      encodedBytes: Math.round(event.encodedBytes),
      durationMs: event.durationMs == null ? null : round(event.durationMs),
    })),
  };
}

function memorySummary(events, phase, runtimeMetrics = []) {
  const selected = events.filter((event) => event.phase === phase && event.kind === 'target');
  const coverage = events.filter((event) => event.phase === phase && event.kind === 'sample');
  const bySample = new Map();
  for (const event of selected) {
    const aggregate = bySample.get(event.sampleId) || {
      usedSize: 0,
      totalSize: 0,
      backingStorageSize: 0,
    };
    aggregate.usedSize += event.usedSize;
    aggregate.totalSize += event.totalSize;
    aggregate.backingStorageSize += event.backingStorageSize;
    bySample.set(event.sampleId, aggregate);
  }
  const completeSampleIds = new Set(coverage
    .filter((sample) => sample.respondingTargetCount === sample.expectedTargetCount)
    .map((sample) => sample.sampleId));
  const completeSamples = [...bySample]
    .filter(([sampleId]) => completeSampleIds.has(sampleId))
    .map(([, sample]) => sample);
  const observedSamples = completeSamples.length > 0 ? completeSamples : [...bySample.values()];
  const perTarget = new Map();
  for (const event of selected) {
    const key = event.targetId || `${event.targetType}:${event.url}`;
    const target = perTarget.get(key) || {
      targetId: event.targetId,
      targetType: event.targetType,
      url: event.url.startsWith(base) ? event.url.slice(base.length) : event.url,
      sampleCount: 0,
      observedPeakUsedBytes: 0,
      observedPeakTotalBytes: 0,
      observedPeakBackingStorageBytes: 0,
    };
    target.sampleCount += 1;
    target.observedPeakUsedBytes = Math.max(target.observedPeakUsedBytes, event.usedSize);
    target.observedPeakTotalBytes = Math.max(target.observedPeakTotalBytes, event.totalSize);
    target.observedPeakBackingStorageBytes = Math.max(
      target.observedPeakBackingStorageBytes,
      event.backingStorageSize,
    );
    perTarget.set(key, target);
  }
  const expectedResponses = coverage.reduce((sum, sample) => sum + sample.expectedTargetCount, 0);
  const actualResponses = coverage.reduce((sum, sample) => sum + sample.respondingTargetCount, 0);
  return {
    semantics: '250ms polling; maxima are observed, not guaranteed process peaks',
    sampleCount: coverage.length,
    completeSampleCount: completeSamples.length,
    incompleteSampleCount: coverage.length - completeSamples.length,
    targetResponseCoverage: expectedResponses === 0 ? null : ratio(actualResponses / expectedResponses),
    observedPeakUsedBytes: Math.max(0, ...observedSamples.map((sample) => sample.usedSize)),
    observedPeakTotalBytes: Math.max(0, ...observedSamples.map((sample) => sample.totalSize)),
    observedPeakBackingStorageBytes: Math.max(
      0,
      ...observedSamples.map((sample) => sample.backingStorageSize),
    ),
    observedPeakWasmMemoryBytes: Math.max(0, ...runtimeMetrics.map((entry) => (
      entry?.event?.metrics?.wasmMemoryBytes || 0
    ))),
    perTarget: [...perTarget.values()],
  };
}

function instrumentationSummary(target, networkEvents, memoryEvents) {
  const engineWorkers = target.sessionEvidence.filter((entry) =>
    entry.type === 'worker' && /engine\.worker/i.test(entry.url));
  const dedicatedWorkers = target.sessionEvidence.filter((entry) => entry.type === 'worker');
  const engineWorkerSessions = new Set(engineWorkers.map((entry) => entry.sessionId));
  const dedicatedWorkerSessions = new Set(dedicatedWorkers.map((entry) => entry.sessionId));
  const workerWasmRequests = networkEvents.filter((entry) =>
    engineWorkerSessions.has(entry.sessionId) && /\.wasm(?:[?#]|$)/i.test(entry.url));
  const workerMemorySamples = memoryEvents.filter((entry) =>
    entry.kind === 'target'
      && engineWorkers.some((worker) => worker.targetId === entry.targetId));
  const invalidWorkers = engineWorkers.filter((entry) =>
    !entry.runtimeEnabled || !entry.networkEnabled || !entry.resumed);
  const networkRuleCoverage = target.networkConditions
    ? summarizeAppliedNetworkRuleCoverage(
      networkEvents,
      target.networkRuleIds,
      dedicatedWorkerSessions,
      engineWorkerSessions,
    )
    : null;
  const result = {
    autoAttachWaitedForDebugger: true,
    scope: 'page plus related dedicated Workers; unrelated Service Workers are outside target scope',
    cpuControl: chromeCpuQuotaPercent == null
      ? cpuThrottle > 1
        ? `CDP ${cpuThrottle}x slowdown applied to the page target only; dedicated Workers are not CPU-throttled`
        : 'No synthetic CPU slowdown; CDP dedicated Workers are never CPU-throttled'
      : `systemd ${chromeCpuQuotaApplied} quota applied to the whole disposable Chrome process tree`,
    attachedTargets: target.sessionEvidence.map((entry) => ({
      targetId: entry.targetId,
      type: entry.type,
      url: entry.url.startsWith(base) ? entry.url.slice(base.length) : entry.url,
      attachedPhase: entry.attachedPhase,
      runtimeEnabled: entry.runtimeEnabled,
      networkEnabled: entry.networkEnabled,
      networkConditionsAppliedOnSession: false,
      resumed: entry.resumed,
      errors: entry.errors,
    })),
    engineWorkerCount: engineWorkers.length,
    engineWorkerWasmRequestCount: workerWasmRequests.length,
    engineWorkerMemorySampleCount: workerMemorySamples.length,
    networkRuleCoverage,
  };
  if (engineWorkers.length === 0) {
    throw new Error('CDP did not auto-attach an engine Worker');
  }
  if (invalidWorkers.length > 0) {
    throw new Error(`engine Worker instrumentation incomplete: ${JSON.stringify(result)}`);
  }
  if (target.networkConditions
      && (networkRuleCoverage.ruleIds.length !== 1
        || networkRuleCoverage.page.provenRequestCount === 0
        || networkRuleCoverage.page.unprovenRequestCount !== 0
        || networkRuleCoverage.dedicatedWorker.unprovenRequestCount !== 0
        || networkRuleCoverage.engineWorker.provenRequestCount === 0
        || networkRuleCoverage.engineWorker.unprovenRequestCount !== 0)) {
    throw new Error(`network profile application incomplete: ${JSON.stringify(result)}`);
  }
  if (workerWasmRequests.length === 0) {
    throw new Error('CDP observed no Worker-owned WASM request; startup network coverage is incomplete');
  }
  if (workerMemorySamples.length === 0) {
    throw new Error('CDP observed no engine Worker heap sample; memory coverage is incomplete');
  }
  return result;
}

function summarizeOperations(operations) {
  const totals = {};
  for (const operation of operations) {
    const total = totals[operation.op] ||= {
      calls: 0,
      summedDurationMs: 0,
      summedEventEnvelopeDurationMs: 0,
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
    total.summedDurationMs += operation.durationMs || 0;
    total.summedEventEnvelopeDurationMs += operation.eventEnvelopeDurationMs || 0;
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
    total.summedDurationMs = round(total.summedDurationMs);
    total.summedEventEnvelopeDurationMs = round(total.summedEventEnvelopeDurationMs);
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
    const total = totals[event.phase || `stage:${event.stage}`] ||= {
      events: 0,
      summedDurationMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      cacheHits: 0,
    };
    total.events += 1;
    total.summedDurationMs += event.durationMs || 0;
    total.inputBytes += event.inputBytes || event.bytes || 0;
    total.outputBytes += event.outputBytes || 0;
    total.cacheHits += event.fromCache ? 1 : 0;
  }
  for (const total of Object.values(totals)) {
    total.summedDurationMs = round(total.summedDurationMs);
    total.inputBytes = Math.round(total.inputBytes);
    total.outputBytes = Math.round(total.outputBytes);
  }
  return totals;
}

async function resetTrace(target) {
  return target.evaluate(`(() => {
    const trace = window.__igProjectBenchmark;
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

async function traceSnapshot(target, phaseStart, criticalEnd = null) {
  const raw = await target.evaluate(`(() => {
    const trace = window.__igProjectBenchmark;
    return {
      now: performance.now(),
      timeOrigin: performance.timeOrigin,
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
  const observationEnd = raw.now;
  const endpoint = Number.isFinite(criticalEnd) ? criticalEnd : observationEnd;
  const milestones = Object.fromEntries(Object.entries(raw.milestones || {})
    .map(([name, at]) => [name, round(at - phaseStart)]));
  const operations = raw.operations.map((operation) => ({
    workerId: operation.workerId,
    op: operation.op,
    buildId: operation.buildId ?? null,
    path: operation.path ?? null,
    startMs: round(operation.start - phaseStart),
    durationMs: operation.duration == null ? null : round(operation.duration),
    eventEnvelopeDurationMs:
      operation.eventEnvelopeDuration == null ? null : round(operation.eventEnvelopeDuration),
    ok: operation.ok ?? null,
    mounted: operation.mounted,
    inputBytes: operation.inputBytes,
    inputByteObservations: operation.inputByteObservations,
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
      const next = entries[index + 1]?.time ?? endpoint;
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
      eventStartMs: Number.isFinite(entry.event?.startMs)
        ? round(entry.event.startMs - (raw.timeOrigin + phaseStart))
        : null,
      eventEndMs: Number.isFinite(entry.event?.startMs)
        ? round(entry.event.startMs + (Number(entry.event.durationMs) || 0)
          - (raw.timeOrigin + phaseStart))
        : null,
      event: entry.event,
    }));
  const completedOperations = operations.filter((operation) =>
    Number.isFinite(operation.startMs) && Number.isFinite(operation.durationMs));
  const operationEndMs = completedOperations.map((operation) =>
    operation.startMs + operation.durationMs);
  const eventIntervals = runtimeMetrics.filter((entry) =>
    Number.isFinite(entry.eventStartMs) && Number.isFinite(entry.eventEndMs));
  const summedWorkerRpcDurationMs = completedOperations.reduce(
    (sum, operation) => sum + operation.durationMs,
    0,
  );
  const summedRuntimeEventDurationMs = runtimeMetrics.reduce(
    (sum, entry) => sum + (Number(entry.event?.durationMs) || 0),
    0,
  );
  return {
    timingSemantics: 'critical elapsed is the user-visible endpoint; summed work may overlap and must not be read as elapsed time',
    durationMs: round(endpoint - phaseStart),
    criticalElapsedMs: round(endpoint - phaseStart),
    observationElapsedMs: round(observationEnd - phaseStart),
    summedWork: {
      workerRpcDurationMs: round(summedWorkerRpcDurationMs),
      workerRpcEnvelopeMs: completedOperations.length === 0 ? 0 : round(
        Math.max(...operationEndMs) - Math.min(...completedOperations.map((entry) => entry.startMs)),
      ),
      buildEventDurationMs: round(summedRuntimeEventDurationMs),
      buildEventEnvelopeMs: eventIntervals.length === 0 ? 0 : round(
        Math.max(...eventIntervals.map((entry) => entry.eventEndMs))
          - Math.min(...eventIntervals.map((entry) => entry.eventStartMs)),
      ),
      nestedWorkerEventEnvelopeMs: round(completedOperations.reduce(
        (sum, operation) => sum + (operation.eventEnvelopeDurationMs || 0),
        0,
      )),
    },
    resourceCount: raw.resourceCount,
    siteError: raw.siteError,
    milestones,
    progress: progressEntries,
    operations,
    operationTotals: summarizeOperations(operations),
    runtimeMetrics,
    engineLifecycle: raw.engineLifecycle,
    phaseTotals: summarizeRuntimeMetrics(runtimeMetrics),
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

async function waitForProjectOpen(target, id, phaseStart) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await target.evaluate(`(() => {
      const projectState = document.querySelector('.project-state')?.textContent?.trim() || '';
      const openError = document.querySelector('.open-error')?.textContent?.trim() || '';
      const failed = /failed/i.test(projectState) ? projectState : '';
      const published = (window.__igDebug?.metrics || []).some((entry) =>
        entry.at >= ${JSON.stringify(phaseStart)} && entry.event?.phase === 'preview.publish');
      return {
        selected: localStorage.getItem('igEditor.project') === ${JSON.stringify(id)},
        projectState,
        openError,
        failed,
        published,
        opening: !!document.querySelector('.open-progress'),
      };
    })()`).catch((error) => transientCdpFallback(error, null));
    if (state?.openError || state?.failed) {
      throw new Error(`${id} failed before exact preview publication: ${state.openError || state.failed}`);
    }
    if (state?.selected && state.published && state.projectState === 'Ready' && !state.opening) return;
    await sleep(50);
  }
  throw new Error(`timeout waiting for ${id} exact generation Ready after preview Service Worker acknowledgement`);
}

async function capturePreviewBinding(target) {
  return target.evaluate(`(() => {
    const frame = document.querySelector('iframe.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    const payload = frame?.contentWindow?.me;
    const rect = frame?.getBoundingClientRect();
    const style = frame ? getComputedStyle(frame) : null;
    const panel = frame?.closest('.workspace-view');
    const visible = !!frame
      && frame.isConnected
      && !panel?.hidden
      && style?.display !== 'none'
      && style?.visibility !== 'hidden'
      && Number(style?.opacity ?? 1) !== 0
      && (rect?.width || 0) > 0
      && (rect?.height || 0) > 0
      && (rect?.right || 0) > 0
      && (rect?.bottom || 0) > 0
      && (rect?.left || 0) < innerWidth
      && (rect?.top || 0) < innerHeight;
    return {
      generator: typeof payload?.generator === 'string' ? payload.generator : null,
      path: typeof payload?.path === 'string' ? payload.path : null,
      generation: Number.isSafeInteger(payload?.generation) ? payload.generation : null,
      contentSha256: typeof payload?.contentSha256 === 'string' ? payload.contentSha256 : null,
      mounted: !!frame?.isConnected && !!doc,
      visible,
      fallback: !!doc?.querySelector('[data-igpreview-fallback]'),
      readyState: doc?.readyState || null,
      textLength: (doc?.body?.textContent || '').trim().length,
      selected: document.querySelector('.preview-page-select select')?.value || null,
    };
  })()`);
}

async function armPreviewSuccessorPaintProbe(target, id, expectedPath, expectedText, previous) {
  return target.evaluate(`(() => {
    const token = crypto.randomUUID();
    const expected = {
      generator: ${JSON.stringify(id)},
      path: ${JSON.stringify(expectedPath)},
      text: ${JSON.stringify(expectedText)},
      previousGeneration: ${JSON.stringify(previous.generation)},
      previousSha256: ${JSON.stringify(previous.contentSha256)},
    };
    const probe = {
      token,
      armedAt: performance.now(),
      samples: 0,
      firstSuccessorBindingAt: null,
      firstInteractiveAt: null,
      firstCompleteAt: null,
      expectedTextAt: null,
      firstFrameCallbackAt: null,
      secondFrameCallbackAt: null,
      paintOpportunityComplete: false,
      iframeLoadAt: null,
      iframeLoadEvents: 0,
      domGapSamples: 0,
      completed: false,
    };
    window.__igSuccessorPaintProbe = probe;
    const frame = document.querySelector('iframe.preview-frame');
    const onLoad = () => {
      if (window.__igSuccessorPaintProbe !== probe) return;
      probe.iframeLoadAt ??= performance.now();
      probe.iframeLoadEvents++;
    };
    frame?.addEventListener('load', onLoad);
    const sample = () => {
      if (window.__igSuccessorPaintProbe !== probe || probe.completed) {
        frame?.removeEventListener('load', onLoad);
        return;
      }
      probe.samples++;
      const currentFrame = document.querySelector('iframe.preview-frame');
      const doc = currentFrame && (currentFrame.contentDocument || currentFrame.contentWindow?.document);
      const payload = currentFrame?.contentWindow?.me;
      const rect = currentFrame?.getBoundingClientRect();
      const style = currentFrame ? getComputedStyle(currentFrame) : null;
      const panel = currentFrame?.closest('.workspace-view');
      const visible = !!currentFrame
        && currentFrame.isConnected
        && !panel?.hidden
        && style?.display !== 'none'
        && style?.visibility !== 'hidden'
        && Number(style?.opacity ?? 1) !== 0
        && (rect?.width || 0) > 0
        && (rect?.height || 0) > 0;
      const text = doc?.body?.textContent || '';
      const successor = payload?.generator === expected.generator
        && payload?.path === expected.path
        && Number.isSafeInteger(payload?.generation)
        && payload.generation > expected.previousGeneration
        && typeof payload?.contentSha256 === 'string'
        && /^[0-9a-f]{64}$/u.test(payload.contentSha256)
        && payload.contentSha256 !== expected.previousSha256;
      if (successor) {
        const now = performance.now();
        probe.firstSuccessorBindingAt ??= now;
        if (doc?.readyState === 'interactive' || doc?.readyState === 'complete') {
          probe.firstInteractiveAt ??= now;
        }
        if (doc?.readyState === 'complete') probe.firstCompleteAt ??= now;
        if (visible && text.includes(expected.text) && probe.expectedTextAt == null) {
          probe.expectedTextAt = now;
          const raf = currentFrame?.contentWindow?.requestAnimationFrame?.bind(currentFrame.contentWindow)
            || requestAnimationFrame.bind(window);
          raf(() => {
            if (window.__igSuccessorPaintProbe !== probe) return;
            probe.firstFrameCallbackAt = performance.now();
            raf(() => {
              if (window.__igSuccessorPaintProbe !== probe) return;
              probe.secondFrameCallbackAt = performance.now();
              probe.paintOpportunityComplete = true;
            });
          });
        }
        if (probe.paintOpportunityComplete
            && probe.firstCompleteAt != null
            && probe.iframeLoadAt != null) {
          probe.completed = true;
          frame?.removeEventListener('load', onLoad);
          return;
        }
      }
      if (visible && (!doc || text.trim().length === 0)) probe.domGapSamples++;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return token;
  })()`);
}

async function requirePreviewSuccessorPaintProbe(target, token, phaseStart) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await target.evaluate(`(() => {
      const probe = window.__igSuccessorPaintProbe;
      if (!probe || probe.token !== ${JSON.stringify(token)}) return null;
      return {
        samples: probe.samples,
        firstSuccessorBindingAtMs: probe.firstSuccessorBindingAt == null
          ? null : probe.firstSuccessorBindingAt - ${JSON.stringify(phaseStart)},
        firstInteractiveAtMs: probe.firstInteractiveAt == null
          ? null : probe.firstInteractiveAt - ${JSON.stringify(phaseStart)},
        firstCompleteAtMs: probe.firstCompleteAt == null
          ? null : probe.firstCompleteAt - ${JSON.stringify(phaseStart)},
        expectedTextAtMs: probe.expectedTextAt == null
          ? null : probe.expectedTextAt - ${JSON.stringify(phaseStart)},
        firstFrameCallbackAtMs: probe.firstFrameCallbackAt == null
          ? null : probe.firstFrameCallbackAt - ${JSON.stringify(phaseStart)},
        secondFrameCallbackAtMs: probe.secondFrameCallbackAt == null
          ? null : probe.secondFrameCallbackAt - ${JSON.stringify(phaseStart)},
        iframeLoadAtMs: probe.iframeLoadAt == null
          ? null : probe.iframeLoadAt - ${JSON.stringify(phaseStart)},
        iframeLoadEvents: probe.iframeLoadEvents,
        domGapSamples: probe.domGapSamples,
        completed: probe.completed,
      };
    })()`).catch((error) => transientCdpFallback(error, null));
    if (probe?.completed && Number.isFinite(probe.secondFrameCallbackAtMs)) {
      return Object.fromEntries(Object.entries(probe).map(([key, value]) => [
        key,
        typeof value === 'number' && key.endsWith('Ms') ? round(value) : value,
      ]));
    }
    await sleep(5);
  }
  throw new Error('timeout waiting for exact successor paint opportunity');
}

async function armWidePreviewContinuityProbe(target, previous) {
  return target.evaluate(`(() => {
    const frame = document.querySelector('iframe.preview-frame');
    const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
    if (!frame || !doc?.body) throw new Error('wide preview continuity has no baseline iframe');
    const maxScroll = Math.max(0, doc.documentElement.scrollHeight - frame.clientHeight);
    frame.contentWindow.scrollTo(0, Math.min(320, maxScroll));
    const token = crypto.randomUUID();
    const probe = {
      token,
      frame,
      baselineHistoryLength: frame.contentWindow.history.length,
      baselineHref: frame.contentWindow.location.href,
      baselineHistoryStateJson: JSON.stringify(frame.contentWindow.history.state),
      baselineScrollY: frame.contentWindow.scrollY,
      samples: 0,
      maximumPreviewIframeCount: 0,
      sameIframeNode: true,
      primaryWorkspaceStayedSelected: true,
      previousVerifiedVisibleDuringBuild: true,
      successorObserved: false,
      stopped: false,
    };
    window.__igWidePreviewContinuityProbe = probe;
    const visible = (candidate) => {
      const rect = candidate?.getBoundingClientRect();
      const style = candidate ? getComputedStyle(candidate) : null;
      const panel = candidate?.closest('.workspace-view');
      return !!candidate
        && candidate.isConnected
        && !panel?.hidden
        && style?.display !== 'none'
        && style?.visibility !== 'hidden'
        && Number(style?.opacity ?? 1) !== 0
        && (rect?.width || 0) > 0
        && (rect?.height || 0) > 0
        && (rect?.right || 0) > 0
        && (rect?.bottom || 0) > 0
        && (rect?.left || 0) < innerWidth
        && (rect?.top || 0) < innerHeight;
    };
    const sample = () => {
      if (window.__igWidePreviewContinuityProbe !== probe || probe.stopped) return;
      probe.samples++;
      const frames = [...document.querySelectorAll('iframe.preview-frame')];
      probe.maximumPreviewIframeCount = Math.max(probe.maximumPreviewIframeCount, frames.length);
      const current = frames[0];
      if (frames.length !== 1 || current !== frame || !frame.isConnected) {
        probe.sameIframeNode = false;
      }
      if (document.querySelector('#workspace-tab-author')?.getAttribute('aria-selected') !== 'true') {
        probe.primaryWorkspaceStayedSelected = false;
      }
      const currentDoc = frame.contentDocument || frame.contentWindow?.document;
      const payload = frame.contentWindow?.me;
      const previousStillExact = payload?.generator === ${JSON.stringify(previous.generator)}
        && payload?.path === ${JSON.stringify(previous.path)}
        && payload?.generation === ${JSON.stringify(previous.generation)}
        && payload?.contentSha256 === ${JSON.stringify(previous.contentSha256)};
      if (!previousStillExact) probe.successorObserved = true;
      if (!visible(frame) || !(currentDoc?.body?.textContent || '').trim()) {
        probe.previousVerifiedVisibleDuringBuild = false;
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    return token;
  })()`);
}

async function finishWidePreviewContinuityProbe(target, token) {
  return target.evaluate(`(() => {
    const probe = window.__igWidePreviewContinuityProbe;
    if (!probe || probe.token !== ${JSON.stringify(token)}) {
      throw new Error('wide preview continuity probe token mismatch');
    }
    probe.stopped = true;
    const frame = document.querySelector('iframe.preview-frame');
    const payload = frame?.contentWindow?.me;
    const previewRect = frame?.closest('.preview-workspace')?.getBoundingClientRect();
    const primaryRect = document.querySelector('.author-workspace:not([hidden])')
      ?.getBoundingClientRect();
    const result = {
      samples: probe.samples,
      sameIframeNode: probe.sameIframeNode && frame === probe.frame,
      maximumPreviewIframeCount: probe.maximumPreviewIframeCount,
      previousVerifiedVisibleDuringBuild: probe.previousVerifiedVisibleDuringBuild,
      successorObserved: probe.successorObserved,
      primaryWorkspaceStayedSelected: probe.primaryWorkspaceStayedSelected,
      currentUrlStateAndHistoryLengthPreserved: !!frame
        && frame.contentWindow.location.href === probe.baselineHref
        && JSON.stringify(frame.contentWindow.history.state) === probe.baselineHistoryStateJson
        && frame.contentWindow.history.length === probe.baselineHistoryLength,
      baselineHref: probe.baselineHref,
      successorHref: frame?.contentWindow?.location.href || null,
      baselineHistoryLength: probe.baselineHistoryLength,
      successorHistoryLength: frame?.contentWindow?.history.length ?? null,
      baselineHistoryStateJson: probe.baselineHistoryStateJson ?? null,
      successorHistoryStateJson: frame
        ? (JSON.stringify(frame.contentWindow.history.state) ?? null)
        : null,
      scrollPreserved: !!frame
        && Math.abs(frame.contentWindow.scrollY - probe.baselineScrollY) <= 2,
      baselineScrollY: probe.baselineScrollY,
      successor: {
        generator: payload?.generator || null,
        path: payload?.path || null,
        generation: Number.isSafeInteger(payload?.generation) ? payload.generation : null,
        contentSha256: payload?.contentSha256 || null,
      },
      layout: {
        viewportWidth: innerWidth,
        primaryWidth: primaryRect?.width || 0,
        previewWidth: previewRect?.width || 0,
        sideBySide: !!primaryRect && !!previewRect
          && primaryRect.right <= previewRect.left + 1
          && primaryRect.top < previewRect.bottom
          && previewRect.top < primaryRect.bottom,
      },
    };
    delete window.__igWidePreviewContinuityProbe;
    return result;
  })()`);
}

async function requirePreviewPage(target, id, phaseStart, options = {}) {
  const expectedPath = options.path || null;
  const expectedText = options.expectedText || null;
  const requireRender = options.requireRender === true;
  const requirePageLoad = options.requirePageLoad !== false;
  const previousBinding = options.previousBinding || null;
  const activatePreview = options.activatePreview !== false;
  await target.evaluate(`(() => {
    if (${JSON.stringify(activatePreview)}) {
      document.querySelector('#workspace-tab-preview')?.click();
    }
    const expected = ${JSON.stringify(expectedPath)};
    if (!expected) return;
    const select = document.querySelector('.preview-page-select select');
    if (!select || ![...select.options].some((option) => option.value === expected)) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, expected);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await target.evaluate(`(() => {
      const frame = document.querySelector('iframe.preview-frame');
      const doc = frame && (frame.contentDocument || frame.contentWindow?.document);
      const path = frame?.contentWindow?.location?.pathname || '';
      const text = doc?.body?.textContent || '';
      const expectedPath = ${JSON.stringify(expectedPath)};
      const expectedText = ${JSON.stringify(expectedText)};
      const payload = frame?.contentWindow?.me;
      const rect = frame?.getBoundingClientRect();
      const style = frame ? getComputedStyle(frame) : null;
      const panel = frame?.closest('.workspace-view');
      const binding = {
        generator: typeof payload?.generator === 'string' ? payload.generator : null,
        path: typeof payload?.path === 'string' ? payload.path : null,
        generation: Number.isSafeInteger(payload?.generation) ? payload.generation : null,
        contentSha256: typeof payload?.contentSha256 === 'string' ? payload.contentSha256 : null,
        mounted: !!frame?.isConnected && !!doc,
        visible: !!frame
          && frame.isConnected
          && !panel?.hidden
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && Number(style?.opacity ?? 1) !== 0
          && (rect?.width || 0) > 0
          && (rect?.height || 0) > 0,
        fallback: !!doc?.querySelector('[data-igpreview-fallback]'),
        readyState: doc?.readyState || null,
      };
      const pageLoaded = (window.__igDebug?.metrics || []).some((entry) =>
        entry.at >= ${JSON.stringify(phaseStart)} && entry.event?.phase === 'preview.page-load'
          && (!expectedPath || entry.event?.label === expectedPath));
      const operations = window.__igProjectBenchmark?.operations || [];
      const rendered = operations.some((entry) =>
        entry.start >= ${JSON.stringify(phaseStart)}
          && entry.end != null
          && entry.ok === true
          && entry.op === 'render');
      const exactRender = [...operations].reverse().find((entry) =>
          entry.start >= ${JSON.stringify(phaseStart)}
            && entry.op === 'render'
            && entry.path === expectedPath
            && entry.end != null
            && entry.ok === true);
      const publicationBuildId = exactRender?.buildId || null;
      const exactRendered = !!exactRender;
      return {
        binding,
        path,
        readyState: doc?.readyState || null,
        textLength: text.trim().length,
        hasExpectedText: !expectedText || text.includes(expectedText),
        pathMatches: path.includes('/preview/' + encodeURIComponent(${JSON.stringify(id)}) + '/')
          && (!expectedPath || path.endsWith('/' + expectedPath)),
        pageLoaded,
        rendered,
        exactRendered,
        publicationBuildId,
        siteError: document.querySelector('.site-error')?.textContent?.trim() || '',
      };
    })()`).catch((error) => transientCdpFallback(error, null));
    if (state?.siteError) throw new Error(`${id} preview failed: ${state.siteError}`);
    const exactSuccessor = !previousBinding || isExactPreviewSuccessor(
      previousBinding,
      state?.binding,
      { generator: id, path: expectedPath },
    );
    if (state?.pathMatches
        && state.readyState === 'complete'
        && state.textLength > 0
        && state.hasExpectedText
        && exactSuccessor
        && (!previousBinding || state.binding.visible === true)
        && (!requirePageLoad || state.pageLoaded)
        && (!requireRender || (previousBinding ? state.exactRendered : state.rendered))) {
      const at = await target.evaluate('performance.now()');
      await target.evaluate(`(() => {
        const trace = window.__igProjectBenchmark;
        if (trace && trace.milestones.firstPreviewPageAt == null) {
          trace.milestones.firstPreviewPageAt = performance.now();
        }
      })()`);
      return { ...state, at, atMs: round(at - phaseStart) };
    }
    await sleep(25);
  }
  throw new Error(
    `timeout waiting for ${id} actual preview ${requirePageLoad ? 'page load' : 'hot update'}${requireRender ? ' and first render' : ''}`,
  );
}

async function main() {
  const version = await waitForCdp();
  const tabs = await (await fetch(`${cdpHttp}/json/list`)).json();
  const tab = tabs.find((candidate) => candidate.type === 'page');
  if (!tab?.webSocketDebuggerUrl) throw new Error('CDP exposes no page target');
  const networkEvents = [];
  const memoryEvents = [];
  const target = await CdpTarget.connect(tab.webSocketDebuggerUrl, networkEvents, memoryEvents);
  try {
    await target.call('Page.enable');
    await target.call('Runtime.enable');
    await target.call('Network.enable', {
      maxTotalBufferSize: 128 * 1024 * 1024,
      maxResourceBufferSize: 32 * 1024 * 1024,
    });
    // Target destruction is the only terminal proof for a dedicated Worker
    // that exits before auto-attachment. Detach alone can mean reattachment and
    // must never close a network request.
    await target.call('Target.setDiscoverTargets', { discover: true });
    await target.call('Target.setAutoAttach', {
      autoAttach: true,
      // A running Worker can fetch/compile WASM before Network/Runtime domains
      // are enabled. Pause every related target until configureSession records
      // and applies the requested instrumentation, then resume it explicitly.
      waitForDebuggerOnStart: true,
      flatten: true,
      // The preview Service Worker must remain free to acknowledge publication;
      // pausing it while the page waits for that acknowledgement deadlocks the
      // measured endpoint. Only dedicated Workers are part of this benchmark's
      // engine/WASM observation scope.
      filter: [
        { type: 'worker', exclude: false },
        { exclude: true },
      ],
    });
    if (target.networkConditions) {
      const rule = await target.call('Network.emulateNetworkConditionsByRule', {
        // Chromium 148 still requires the deprecated top-level field even
        // though each matched condition carries its own offline value.
        offline: target.networkConditions.offline,
        matchedNetworkConditions: [{
          urlPattern: '',
          ...target.networkConditions,
        }],
      });
      if (!Array.isArray(rule.ruleIds) || rule.ruleIds.length !== 1 || !rule.ruleIds[0]) {
        throw new Error(`Chrome returned invalid network rule ids: ${JSON.stringify(rule)}`);
      }
      target.networkRuleIds = new Set(rule.ruleIds);
      await target.call('Network.overrideNetworkState', target.networkConditions);
    }
    target.startMemorySampling();
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
    } else if (widePreview) {
      await target.call('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
    }

    progress(`clearing ${origin} storage and HTTP cache`);
    target.setPhase('setup');
    await target.retireProbeDocument();
    target.retireSetupRequests();
    await target.drainNetwork('setup');
    await target.call('Storage.clearDataForOrigin', { origin, storageTypes: 'all' });
    await target.call('Network.clearBrowserCache');
    await target.call('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION });

    progress(`cold app boot + ${projectId} open`);
    target.setPhase('coldStart');
    await target.navigate(base);
    progress('cold top-level loader and default execution context committed');
    await target.waitFor(
      `!!window.__igDebug?.engine?.initialized && !!document.querySelector('.open-ig-select')`,
      'cold engine boot',
    );
    progress('cold engine ready; awaiting page-owned catalog selection acknowledgement');
    await target.waitFor(
      `['accepted', 'already-selected', 'error'].includes(`
        + `window.__igProjectBenchmark?.catalogSelection?.status)`,
      'page-owned catalog selection acknowledgement',
    );
    const initialSelection = await target.evaluate(`({
      ...window.__igProjectBenchmark.catalogSelection,
      appBootReadyAt: window.__igProjectBenchmark.milestones.appBootReadyAt,
    })`);
    if (initialSelection.status === 'error') {
      throw new Error(`${projectId} page-owned selection failed: ${initialSelection.error}`);
    }
    const appBootReadyMs = initialSelection.appBootReadyAt;
    const projectOpenStartMs = initialSelection.requestedAt;
    if (!Number.isFinite(appBootReadyMs) || !Number.isFinite(projectOpenStartMs)) {
      throw new Error(`invalid page-owned selection timing: ${JSON.stringify(initialSelection)}`);
    }
    progress(`cold ${projectId} selection accepted by the committed app`);
    await waitForProjectOpen(target, projectId, projectOpenStartMs);
    const coldPage = await requirePreviewPage(target, projectId, 0, { requireRender: true });
    const coldNetworkDrain = await target.drainNetwork('coldStart');
    const cold = await traceSnapshot(target, 0, coldPage.at);
    cold.firstPreviewPage = coldPage;
    delete cold.firstPreviewPage.at;
    cold.networkDrain = coldNetworkDrain;
    cold.appBootReadyMs = round(appBootReadyMs);
    cold.projectOpenStartMs = round(projectOpenStartMs);
    cold.projectOpenDurationMs = round(cold.criticalElapsedMs - projectOpenStartMs);
    cold.network = networkSummary(networkEvents, 'coldStart');
    if (cold.network.pendingRequestCount !== 0
        || cold.network.crossedIntoPhaseCount !== 0
        || cold.network.crossedOutOfPhaseCount !== 0) {
      throw new Error(`coldStart network did not close at its boundary: ${JSON.stringify(cold.network)}`);
    }
    await target.captureMemorySample();
    cold.memory = memorySummary(memoryEvents, 'coldStart', cold.runtimeMetrics);

    progress('warm hard reload (same persistent OPFS/CAS)');
    target.setPhase('warmHardReload');
    await target.reload({ ignoreCache: false });
    progress('warm top-level loader and default execution context committed');
    await target.waitFor(
      `window.__igProjectBenchmark?.milestones?.previousPreviewUiAt != null`,
      `previous verified ${projectId} preview pointer`,
    );
    // Published guides default to Explore. Activate Preview as soon as the
    // persisted catalog is available so this phase measures the useful prior
    // page, not merely the stale-state badge while an unmounted iframe waits.
    await target.evaluate(`document.querySelector('#workspace-tab-preview')?.click()`);
    await target.waitFor(
      `window.__igProjectBenchmark?.milestones?.previousPreviewPageAt != null`,
      `previous verified ${projectId} preview page`,
    );
    await target.waitFor(
      `!!window.__igProjectBenchmark && !!window.__igDebug?.engine?.initialized`,
      'warm engine boot',
    );
    await waitForProjectOpen(target, projectId, 0);
    const warmPage = await requirePreviewPage(target, projectId, 0);
    const warmNetworkDrain = await target.drainNetwork('warmHardReload');
    const warm = await traceSnapshot(target, 0, warmPage.at);
    warm.firstPreviewPage = warmPage;
    delete warm.firstPreviewPage.at;
    warm.networkDrain = warmNetworkDrain;
    warm.network = networkSummary(networkEvents, 'warmHardReload');
    if (warm.network.pendingRequestCount !== 0
        || warm.network.crossedIntoPhaseCount !== 0
        || warm.network.crossedOutOfPhaseCount !== 0) {
      throw new Error(`warmHardReload network did not close at its boundary: ${JSON.stringify(warm.network)}`);
    }
    await target.captureMemorySample();
    warm.memory = memorySummary(memoryEvents, 'warmHardReload', warm.runtimeMetrics);
    // The indexed transaction exposes preparation per slot and the aggregate
    // authenticated-carrier proof on its one atomic commit. Older frozen
    // receipts used one whole-array `mountPackages` call; retain that fallback
    // only so the historical schema remains readable.
    const warmPreparedMount = warm.operationTotals.commitPackageMount
      ?? warm.operationTotals.mountPackages;
    if (!(warmPreparedMount?.preparedWarmCalls > 0)
        || warmPreparedMount.preparedColdCalls !== 0
        || warmPreparedMount.preparedMixedCalls !== 0
        || warmPreparedMount.preparedChunksInflated !== 0
        || warmPreparedMount.preparedRawInflatedBytes !== 0) {
      throw new Error(`warm hard reload did not shallow-mount only authenticated prepared packages: ${JSON.stringify(warmPreparedMount)}`);
    }
    const warmBuild = [...warm.runtimeMetrics].reverse().find(({ event }) =>
      event.stage === 'site-build' && event.metrics?.rustPrepareTotalMs != null);
    const warmRustPrepareMs = warmBuild?.event?.metrics?.rustPrepareTotalMs;
    if (!Number.isFinite(warmRustPrepareMs)) {
      throw new Error(`warm hard reload did not report the stable Rust prepare span: ${warmRustPrepareMs}`);
    }
    const stale = warm.milestones;
    if (!(stale.previousPreviewUiAt >= 0)
        || !(stale.previousPreviewPageAt >= stale.previousPreviewUiAt)
        || !(stale.currentReadyAt >= stale.previousPreviewPageAt)) {
      throw new Error(`stale preview milestones are not ordered before exact Ready: ${JSON.stringify(stale)}`);
    }

    let representativeEdit = null;
    if (editScenario) {
      progress(`${editScenario.sourceKind} edit ${editScenario.sourcePath} -> ${editScenario.previewPath}`);
      target.setPhase('representativeEditSetup');
      await requirePreviewPage(target, projectId, 0, { path: editScenario.previewPath });
      const previousPreviewBinding = await capturePreviewBinding(target);
      if (previousPreviewBinding.generator !== projectId
          || previousPreviewBinding.path !== editScenario.previewPath
          || previousPreviewBinding.mounted !== true
          || previousPreviewBinding.visible !== true
          || previousPreviewBinding.fallback !== false
          || previousPreviewBinding.readyState !== 'complete'
          || !Number.isSafeInteger(previousPreviewBinding.generation)
          || !/^[0-9a-f]{64}$/u.test(previousPreviewBinding.contentSha256 || '')) {
        throw new Error(
          `representative edit has no exact verified visible baseline: ${JSON.stringify(previousPreviewBinding)}`,
        );
      }
      if (widePreview) {
        await target.evaluate(`(() => {
          window.__igWidePreviewBaselineFrame = document.querySelector('iframe.preview-frame');
          return !!window.__igWidePreviewBaselineFrame;
        })()`);
      }
      const selectedSource = await target.evaluate(`(() => {
        document.querySelector('#workspace-tab-author')?.click();
        const select = document.querySelector('#workspace-panel-author .mobile-picker select');
        const path = ${JSON.stringify(editScenario.sourcePath)};
        if (!select || ![...select.options].some((option) => option.value === path)) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        setter.call(select, path);
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      if (!selectedSource) {
        throw new Error(`could not select representative source ${editScenario.sourcePath}`);
      }
      await target.waitFor(
        `window.monaco?.editor.getEditors()[0]?.getModel()?.getValue()
          .includes(${JSON.stringify(editScenario.before)}) === true`,
        `Monaco model for ${editScenario.sourcePath}`,
      );
      const retainedBeforeEdit = await capturePreviewBinding(target);
      if (!isRetainedPreviewBinding(previousPreviewBinding, retainedBeforeEdit)
          || retainedBeforeEdit.visible !== widePreview) {
        throw new Error(
          `Author mode did not retain the exact ${widePreview ? 'visible' : 'hidden'} preview: ${JSON.stringify(retainedBeforeEdit)}`,
        );
      }
      let widePreviewBaseline = null;
      if (widePreview) {
        widePreviewBaseline = await target.evaluate(`(() => {
          const frame = document.querySelector('iframe.preview-frame');
          const preview = frame?.closest('.preview-workspace')?.getBoundingClientRect();
          const primary = document.querySelector('.author-workspace:not([hidden])')
            ?.getBoundingClientRect();
          return {
            sameIframeNode: frame === window.__igWidePreviewBaselineFrame,
            iframeCount: document.querySelectorAll('iframe.preview-frame').length,
            authorSelected: document.querySelector('#workspace-tab-author')
              ?.getAttribute('aria-selected') === 'true',
            previewRole: frame?.closest('.preview-workspace')?.getAttribute('role') || '',
            viewportWidth: innerWidth,
            primaryWidth: primary?.width || 0,
            previewWidth: preview?.width || 0,
            sideBySide: !!primary && !!preview
              && primary.right <= preview.left + 1
              && primary.top < preview.bottom
              && preview.top < primary.bottom,
          };
        })()`);
        if (!widePreviewBaseline.sameIframeNode
            || widePreviewBaseline.iframeCount !== 1
            || !widePreviewBaseline.authorSelected
            || widePreviewBaseline.previewRole !== 'region'
            || widePreviewBaseline.viewportWidth !== 1440
            || widePreviewBaseline.primaryWidth < 720
            || widePreviewBaseline.previewWidth < 420
            || !widePreviewBaseline.sideBySide) {
          throw new Error(`wide preview baseline is invalid: ${JSON.stringify(widePreviewBaseline)}`);
        }
      }
      await target.drainNetwork('representativeEditSetup');
      target.setPhase('representativeEdit');
      const editStart = await resetTrace(target);
      const continuityProbeToken = widePreview
        ? await armWidePreviewContinuityProbe(target, previousPreviewBinding)
        : null;
      const paintProbeToken = await armPreviewSuccessorPaintProbe(
        target,
        projectId,
        editScenario.previewPath,
        editScenario.expectedPreviewText || editScenario.after,
        previousPreviewBinding,
      );
      const edited = await target.evaluate(`(() => {
        const editor = window.monaco?.editor.getEditors()[0];
        const model = editor?.getModel();
        if (!model) return { ok: false, reason: 'no-model' };
        const before = ${JSON.stringify(editScenario.before)};
        const after = ${JSON.stringify(editScenario.after)};
        const value = model.getValue();
        const occurrences = value.split(before).length - 1;
        if (occurrences !== 1) return { ok: false, reason: 'occurrences', occurrences };
        model.setValue(value.replace(before, after));
        return { ok: true, occurrences };
      })()`);
      if (!edited?.ok) throw new Error(`could not apply representative edit: ${JSON.stringify(edited)}`);
      const editedPage = await requirePreviewPage(target, projectId, editStart, {
        path: editScenario.previewPath,
        expectedText: editScenario.expectedPreviewText || editScenario.after,
        requireRender: true,
        previousBinding: previousPreviewBinding,
        // Generation replacement intentionally refreshes the existing document
        // through the preview channel without assigning iframe.src, preserving
        // scroll/history. A navigation load here would be a regression; require
        // the newly rendered text instead.
        requirePageLoad: false,
        activatePreview: !widePreview,
      });
      const successorPaint = await requirePreviewSuccessorPaintProbe(
        target,
        paintProbeToken,
        editStart,
      );
      const widePreviewContinuity = continuityProbeToken
        ? await finishWidePreviewContinuityProbe(target, continuityProbeToken)
        : null;
      if (widePreviewContinuity && (!widePreviewContinuity.sameIframeNode
          || widePreviewContinuity.maximumPreviewIframeCount !== 1
          || !widePreviewContinuity.previousVerifiedVisibleDuringBuild
          || !widePreviewContinuity.successorObserved
          || !widePreviewContinuity.primaryWorkspaceStayedSelected
          || !widePreviewContinuity.currentUrlStateAndHistoryLengthPreserved
          || !widePreviewContinuity.scrollPreserved
          || widePreviewContinuity.layout.viewportWidth !== 1440
          || widePreviewContinuity.layout.primaryWidth < 720
          || widePreviewContinuity.layout.previewWidth < 420
          || !widePreviewContinuity.layout.sideBySide
          || widePreviewContinuity.successor.generation !== editedPage.binding.generation
          || widePreviewContinuity.successor.contentSha256
            !== editedPage.binding.contentSha256)) {
        throw new Error(`wide preview continuity failed: ${JSON.stringify(widePreviewContinuity)}`);
      }
      const editNetworkDrain = await target.drainNetwork('representativeEdit');
      representativeEdit = await traceSnapshot(target, editStart, editedPage.at);
      representativeEdit.firstPreviewPage = editedPage;
      delete representativeEdit.firstPreviewPage.at;
      representativeEdit.networkDrain = editNetworkDrain;
      representativeEdit.scenario = editScenario;
      representativeEdit.previewBindings = {
        previousVisible: previousPreviewBinding,
        retainedWhileAuthoring: retainedBeforeEdit,
        successorVisible: editedPage.binding,
        continuityClaim: widePreview
          ? 'one exact prior iframe remained visible beside Author until atomic successor handoff'
          : 'exact prior page retained but hidden in Author; exact successor visible after activating Preview',
        continuouslyVisible: widePreview,
        widePreviewBaseline,
        widePreviewContinuity,
      };
      const successorBuildId = editedPage.publicationBuildId;
      const canonicalRender = representativeEdit.operations.find((operation) =>
        operation.op === 'render'
          && operation.buildId === successorBuildId
          && operation.path === editScenario.previewPath
          && operation.ok === true);
      const canonicalRenderEvent = representativeEdit.runtimeMetrics.find((entry) =>
        entry.event?.phase === 'site.render'
          && entry.event?.buildId === successorBuildId
          && entry.event?.label === editScenario.previewPath);
      if (!successorBuildId || !canonicalRender || !canonicalRenderEvent) {
        throw new Error(`representative edit lacks an exact render operation: ${JSON.stringify({
          successorBuildId,
          canonicalRender,
          canonicalRenderEvent,
        })}`);
      }
      representativeEdit.selectedPagePipeline = {
        mode: 'canonical-render',
        buildId: successorBuildId,
        path: editScenario.previewPath,
        render: {
          startMs: canonicalRenderEvent.eventStartMs,
          endMs: canonicalRenderEvent.eventEndMs,
          durationMs: canonicalRenderEvent.event.durationMs,
        },
        readyAtMs: representativeEdit.milestones.currentReadyAt ?? null,
        firstSuccessorBindingAtMs: successorPaint.firstSuccessorBindingAtMs,
        expectedTextAtMs: successorPaint.expectedTextAtMs,
        firstPaintOpportunityAtMs: successorPaint.secondFrameCallbackAtMs,
        documentCompleteAtMs: successorPaint.firstCompleteAtMs,
        iframeLoadAtMs: successorPaint.iframeLoadAtMs,
        successorVisibleAtMs: editedPage.atMs,
      };
      representativeEdit.successorPaint = successorPaint;
      const firstOperationStartMs = Math.min(
        ...representativeEdit.operations
          .map((operation) => operation.startMs)
          .filter((value) => Number.isFinite(value)),
      );
      if (!Number.isFinite(firstOperationStartMs)) {
        throw new Error('representative edit completed without a measured Worker operation');
      }
      representativeEdit.explicitDebounceMs = 0;
      representativeEdit.scheduling = editScenario.scheduling;
      representativeEdit.firstWorkerOperationMs = round(firstOperationStartMs);
      representativeEdit.postSchedulingPipelineMs = round(
        representativeEdit.criticalElapsedMs - firstOperationStartMs,
      );
      representativeEdit.network = networkSummary(networkEvents, 'representativeEdit');
      if (representativeEdit.network.pendingRequestCount !== 0
          || representativeEdit.network.crossedIntoPhaseCount !== 0
          || representativeEdit.network.crossedOutOfPhaseCount !== 0) {
        throw new Error(
          `representativeEdit network did not close at its boundary: ${JSON.stringify(representativeEdit.network)}`,
        );
      }
      await target.captureMemorySample();
      representativeEdit.memory = memorySummary(
        memoryEvents,
        'representativeEdit',
        representativeEdit.runtimeMetrics,
      );
    }

    progress('preparing same-worker comparison via Cycle');
    target.setPhase('cyclePreparation');
    const sameWorkerRecycleBaseline = warm.engineLifecycle.recycleCount;
    const cycleStart = await resetTrace(target);
    if (!(await selectCatalogProject(target, 'cycle'))) {
      throw new Error('Cycle is absent from .open-ig-select');
    }
    await waitForProjectOpen(target, 'cycle', cycleStart);
    const cycleReadyAt = await target.evaluate('performance.now()');
    const cycleNetworkDrain = await target.drainNetwork('cyclePreparation');
    const cyclePreparation = await traceSnapshot(target, cycleStart, cycleReadyAt);
    cyclePreparation.networkDrain = cycleNetworkDrain;
    cyclePreparation.network = networkSummary(networkEvents, 'cyclePreparation');
    if (cyclePreparation.network.pendingRequestCount !== 0
        || cyclePreparation.network.crossedIntoPhaseCount !== 0
        || cyclePreparation.network.crossedOutOfPhaseCount !== 0) {
      throw new Error(
        `cyclePreparation network did not close at its boundary: ${JSON.stringify(cyclePreparation.network)}`,
      );
    }
    await target.captureMemorySample();
    cyclePreparation.memory = memorySummary(
      memoryEvents,
      'cyclePreparation',
      cyclePreparation.runtimeMetrics,
    );
    const cycleLifecycle = await target.evaluate(`(() => ({
      recycleCount: window.__igDebug?.engine?.recycleCount ?? -1,
      preparedConfigCount: window.__igDebug?.engine?.preparedConfigs?.length ?? -1,
      lastCompiledResourceCount: window.__igDebug?.engine?.lastCompiledResourceCount ?? -1,
    }))()`);

    progress(`same-worker ${projectId} reopen`);
    target.setPhase('sameWorkerReopen');
    const sameStart = await resetTrace(target);
    if (!(await selectCatalogProject(target, projectId))) {
      throw new Error(`${projectId} is absent from .open-ig-select`);
    }
    await waitForProjectOpen(target, projectId, sameStart);
    const samePage = await requirePreviewPage(target, projectId, sameStart);
    progress(`same-worker ${projectId} exact preview ready; draining network`);
    const sameNetworkDrain = await target.drainNetwork('sameWorkerReopen');
    progress(`same-worker ${projectId} network drained; capturing trace`);
    const same = await traceSnapshot(target, sameStart, samePage.at);
    same.firstPreviewPage = samePage;
    delete same.firstPreviewPage.at;
    same.networkDrain = sameNetworkDrain;
    same.network = networkSummary(networkEvents, 'sameWorkerReopen');
    if (same.network.pendingRequestCount !== 0
        || same.network.crossedIntoPhaseCount !== 0
        || same.network.crossedOutOfPhaseCount !== 0) {
      throw new Error(`sameWorkerReopen network did not close at its boundary: ${JSON.stringify(same.network)}`);
    }
    progress(`same-worker ${projectId} trace captured; sampling memory`);
    await target.captureMemorySample();
    progress(`same-worker ${projectId} memory sampled`);
    same.memory = memorySummary(memoryEvents, 'sameWorkerReopen', same.runtimeMetrics);
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
      initialCompiledResources: cold.engineLifecycle.lastCompiledResourceCount,
      reopenedCompiledResources: same.engineLifecycle.lastCompiledResourceCount,
      siteBuildCacheHit: sameMetrics.siteBuildCacheHit ?? null,
    };
    if (sameWorkerContract.recycleAfterCycle !== sameWorkerContract.recycleBaseline
        || sameWorkerContract.recycleAfter !== sameWorkerContract.recycleBaseline
        || sameWorkerContract.preparedConfigsAfterCycle !== 2
        || sameWorkerContract.preparedConfigsAfterReopen !== 2
        || !(sameWorkerContract.cycleCompiledResources > 0)
        || sameWorkerContract.reopenedCompiledResources !== sameWorkerContract.initialCompiledResources
        || sameWorkerContract.siteBuildCacheHit !== 1) {
      throw new Error(`${projectId} -> Cycle -> ${projectId} did not retain the exact SiteEngine generation: ${JSON.stringify(sameWorkerContract)}`);
    }

    const warmMountMs = (warm.operationTotals.init?.summedDurationMs || 0)
      + (warm.operationTotals.stagePackageMount?.summedDurationMs || 0)
      + (warm.operationTotals.commitPackageMount?.summedDurationMs
        ?? warm.operationTotals.mountPackages?.summedDurationMs
        ?? 0);
    await target.stopMemorySampling();
    const instrumentation = instrumentationSummary(target, networkEvents, memoryEvents);
    instrumentation.processMemory = await processMemoryReceipt();
    const engineProvenance = await target.evaluate(`(() => {
      const engine = window.__igDebug?.engine;
      const status = document.querySelector('.build-status .bs-group:first-child .bs-val');
      return {
        commit: engine?.engineCommit || null,
        display: status?.textContent?.trim() || null,
        engine: status?.getAttribute('title') || null,
      };
    })()`);
    if (!engineProvenance.commit || engineProvenance.commit === 'unknown') {
      throw new Error(`engine provenance is unavailable: ${JSON.stringify(engineProvenance)}`);
    }
    const exactNetworkConditions = NETWORK_PROFILES[networkProfile];
    const report = {
      schemaVersion: 3,
      benchmark: 'fhir-ig-editor-project-loading',
      ok: true,
      generatedAt: new Date().toISOString(),
      url: base,
      environment: {
        browser: version.Browser,
        protocolVersion: version['Protocol-Version'],
        userAgent: await target.evaluate('navigator.userAgent'),
        executionClass: process.env.BENCH_EXECUTION_CLASS || 'custom',
        cpuThrottle,
        cpuThrottleScope: 'page-target-only',
        processCpuQuotaPercent: chromeCpuQuotaPercent,
        chromeProcessCpuQuota: chromeCpuQuotaPercent == null ? null : {
          requestedPercent: chromeCpuQuotaPercent,
          appliedSystemdValue: chromeCpuQuotaApplied,
          unit: chromeCpuQuotaUnit,
          scope: 'whole-disposable-Chrome-process-tree',
        },
        mobile,
        widePreview,
        networkProfile,
        networkProfileScope: exactNetworkConditions == null
          ? null
          : 'page requests and dedicated-Worker subresource requests; '
            + 'dedicated-Worker main scripts are explicitly unprofiled by Chromium 148',
        networkConditions: exactNetworkConditions == null ? null : {
          latencyMs: exactNetworkConditions.latency,
          downloadBytesPerSecond: exactNetworkConditions.downloadThroughput,
          uploadBytesPerSecond: exactNetworkConditions.uploadThroughput,
          connectionType: exactNetworkConditions.connectionType,
        },
        timeout: {
          baseMs: baseTimeoutMs,
          scale: timeoutScale,
          effectiveMs: timeoutMs,
          baseCdpCallMs: baseCdpCallTimeoutMs,
          effectiveCdpCallMs: cdpCallTimeoutMs,
          scaledBy: chromeCpuQuotaPercent == null
            ? (cpuThrottle > 1 ? 'page-cpu-throttle' : 'none')
            : 'whole-process-cpu-quota',
        },
        projectId,
        editEnabled,
      },
      provenance: {
        ...runnerProvenance,
        engine: engineProvenance,
      },
      instrumentation,
      phases: {
        coldStart: cold,
        warmHardReload: warm,
        ...(representativeEdit ? { representativeEdit } : {}),
        cyclePreparation,
        sameWorkerReopen: same,
      },
      contracts: {
        cacheScenarios: {
          coldStart: 'empty-origin-storage-and-http-cache',
          warmHardReload: 'persistent-opfs-cas-and-http-cache',
          cyclePreparation: 'same-worker-first-external-renderer-capability',
          sameWorkerReopen: 'retained-runtime-generation',
        },
        firstPreview: {
          coldPageLoaded: coldPage.pageLoaded,
          coldRenderObserved: coldPage.rendered,
          warmPageLoaded: warmPage.pageLoaded,
          sameWorkerPageLoaded: samePage.pageLoaded,
        },
        ...(representativeEdit ? {
          representativeEdit: {
            sourceKind: editScenario.sourceKind,
            sourcePath: editScenario.sourcePath,
            previewPath: editScenario.previewPath,
            pageLoaded: representativeEdit.firstPreviewPage.pageLoaded,
            hotUpdateObserved: representativeEdit.firstPreviewPage.hasExpectedText,
            renderObserved: representativeEdit.firstPreviewPage.rendered,
            exactRenderObserved: representativeEdit.firstPreviewPage.exactRendered,
            renderBuildId: representativeEdit.firstPreviewPage.publicationBuildId,
            previousPreviewRetained: isRetainedPreviewBinding(
              representativeEdit.previewBindings.previousVisible,
              representativeEdit.previewBindings.retainedWhileAuthoring,
            ),
            previousPreviewContinuouslyVisible: representativeEdit.previewBindings.continuouslyVisible,
            exactSuccessorVisible: isExactPreviewSuccessor(
              representativeEdit.previewBindings.previousVisible,
              representativeEdit.previewBindings.successorVisible,
              { generator: projectId, path: editScenario.previewPath },
            ) && representativeEdit.previewBindings.successorVisible.visible === true,
          },
        } : {}),
        warmPreparedMount: {
          warmCalls: warmPreparedMount.preparedWarmCalls,
          coldCalls: warmPreparedMount.preparedColdCalls,
          mixedCalls: warmPreparedMount.preparedMixedCalls,
          chunksInflatedAtCommit: warmPreparedMount.preparedChunksInflated,
          rawInflatedBytesAtCommit: warmPreparedMount.preparedRawInflatedBytes,
          rustPrepareMs: warmRustPrepareMs,
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
    await target.stopMemorySampling();
    target.close();
  }
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 3,
    benchmark: 'fhir-ig-editor-project-loading',
    projectId,
    ok: false,
    url: base,
    error: String(error?.stack || error),
  }, null, 2)}\n`);
  process.exitCode = 1;
});
