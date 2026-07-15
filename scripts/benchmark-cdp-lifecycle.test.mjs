import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CdpCallTimeoutError,
  CdpNavigationLifecycleError,
  CdpPendingCalls,
  CdpProtocolError,
  CdpSessionDetachedError,
  CdpTransportError,
  TopLevelNavigationLifecycle,
  createCatalogSelectionProbe,
  isCommittedTopLevelFrame,
  reconcileCompletedWorkerBody,
  reconcileNetworkRuleEvidence,
  reconcileWorkerTargetEvidence,
  requiresAppliedNetworkRuleProof,
  summarizeAppliedNetworkRuleCoverage,
  transientCdpFallback,
} from './benchmark-cdp-lifecycle.mjs';

test('setup frame proof binds the exact top-level loader without requiring a runtime context', () => {
  const navigation = { frameId: 'frame-1', loaderId: 'loader-2' };
  const committed = {
    frameTree: { frame: { id: 'frame-1', loaderId: 'loader-2', url: 'about:blank' } },
  };
  assert.equal(isCommittedTopLevelFrame(committed, navigation, 'about:blank'), true);
  assert.equal(isCommittedTopLevelFrame(committed, { ...navigation, loaderId: 'old' }, 'about:blank'), false);
  assert.equal(isCommittedTopLevelFrame(committed, navigation, 'https://example.test/'), false);
  assert.equal(isCommittedTopLevelFrame({}, navigation, 'about:blank'), false);
});

test('page-owned catalog selection waits for readiness and dispatches exactly once', () => {
  let now = 10;
  class FakeSelect {
    constructor() {
      this.options = [];
      this.events = [];
      this.selectedValue = '';
    }

    dispatchEvent(event) {
      this.events.push(event);
      return true;
    }
  }
  Object.defineProperty(FakeSelect.prototype, 'value', {
    set(value) { this.selectedValue = value; },
  });
  class FakeEvent {
    constructor(type, options) {
      this.type = type;
      this.bubbles = options?.bubbles === true;
    }
  }
  const select = new FakeSelect();
  select.disabled = true;
  const frames = [];
  let storedProject = null;
  const windowObject = {
    __igProjectBenchmark: { milestones: {}, catalogSelection: null },
    __igDebug: { engine: { initialized: false } },
    performance: { now: () => now++ },
    localStorage: { getItem: () => storedProject },
    HTMLSelectElement: FakeSelect,
    Event: FakeEvent,
    requestAnimationFrame: (callback) => frames.push(callback),
  };
  const documentObject = { querySelector: () => select };
  const probe = createCatalogSelectionProbe(windowObject, documentObject, 'tiny');

  assert.equal(probe(), null);
  windowObject.__igDebug.engine.initialized = true;
  assert.equal(probe().status, 'waiting-for-enabled-select');
  select.disabled = false;
  assert.equal(probe().status, 'waiting-for-option');
  select.options.push({ value: 'tiny' });
  assert.equal(probe().status, 'scheduled');
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(windowObject.__igProjectBenchmark.catalogSelection.status, 'dispatched');
  assert.equal(windowObject.__igProjectBenchmark.catalogSelection.projectId, 'tiny');
  assert.equal(select.selectedValue, 'tiny');
  assert.equal(select.events.length, 1);
  assert.equal(select.events[0].type, 'change');
  assert.equal(select.events[0].bubbles, true);
  assert.equal(windowObject.__igProjectBenchmark.milestones.appBootReadyAt, 10);
  assert.equal(probe().status, 'dispatched');
  storedProject = 'tiny';
  assert.equal(probe().status, 'accepted');
  assert.equal(probe(), null);
  assert.equal(select.events.length, 1);
});

test('page-owned catalog selection acknowledges a persisted project without redispatch', () => {
  class FakeSelect {}
  Object.defineProperty(FakeSelect.prototype, 'value', { set() {} });
  const select = new FakeSelect();
  select.options = [{ value: 'ips' }];
  select.dispatchEvent = () => assert.fail('persisted selection must not be redispatched');
  const windowObject = {
    __igProjectBenchmark: { milestones: {}, catalogSelection: null },
    __igDebug: { engine: { initialized: true } },
    performance: { now: () => 42 },
    localStorage: { getItem: () => 'ips' },
    HTMLSelectElement: FakeSelect,
    Event,
  };
  const probe = createCatalogSelectionProbe(
    windowObject,
    { querySelector: () => select },
    'ips',
  );
  assert.equal(probe().status, 'already-selected');
  assert.equal(probe(), null);
});

function request(url, startedAtEpochMs = 1_000) {
  return {
    phase: 'sameWorkerReopen',
    completedPhase: null,
    targetType: 'page',
    resourceType: 'Script',
    url,
    startedAtEpochMs,
    startedTimestampMs: 10,
    finishedTimestampMs: null,
    durationMs: null,
    phaseGeneration: 7,
    networkKey: 'page:1',
  };
}

function workerTarget(url, overrides = {}) {
  return {
    targetId: 'target-1',
    type: 'worker',
    url,
    proof: 'attached',
    proofUrl: url,
    proofPhase: 'sameWorkerReopen',
    proofPhaseGeneration: 7,
    entryRequestConsumed: false,
    terminal: false,
    ...overrides,
  };
}

test('detaching one session immediately settles only its pending calls', async () => {
  const sent = [];
  const rpc = new CdpPendingCalls((message) => sent.push(message), 1_000, () => 'edit');
  const worker = rpc.call('Runtime.getHeapUsage', {}, 'worker-1');
  const page = rpc.call('Runtime.evaluate', { expression: '1' });

  rpc.rejectSession('worker-1');
  await assert.rejects(worker, CdpSessionDetachedError);
  assert.equal(rpc.pending.size, 1);

  rpc.handleResponse({ id: sent[1].id, result: { result: { value: 1 } } });
  await assert.doesNotReject(page);
  assert.equal(rpc.pending.size, 0);
});

test('an active CDP call times out with method, session, and phase evidence', async () => {
  const rpc = new CdpPendingCalls(() => {}, 10, () => 'coldStart');
  await assert.rejects(
    rpc.call('Runtime.getHeapUsage', {}, 'engine-worker'),
    (error) => error instanceof CdpCallTimeoutError
      && /Runtime\.getHeapUsage/u.test(error.message)
      && /engine-worker/u.test(error.message)
      && /coldStart/u.test(error.message),
  );
  assert.equal(rpc.pending.size, 0);
});

test('transport failure rejects every outstanding call and all successors', async () => {
  const rpc = new CdpPendingCalls(() => {}, 1_000, () => 'warmHardReload');
  const one = rpc.call('Runtime.evaluate');
  const two = rpc.call('Runtime.getHeapUsage', {}, 'worker-2');
  const failure = new CdpTransportError('socket closed');
  rpc.fail(failure);
  await assert.rejects(one, (error) => error === failure);
  await assert.rejects(two, (error) => error === failure);
  await assert.rejects(rpc.call('Page.navigate'), (error) => error === failure);
});

test('protocol command failures are terminal instead of readiness retry values', async () => {
  const sent = [];
  const rpc = new CdpPendingCalls((message) => sent.push(message), 1_000, () => 'coldStart');
  const evaluation = rpc.call('Runtime.evaluate');
  rpc.handleResponse({
    id: sent[0].id,
    error: { code: -32000, message: 'Execution context was destroyed.' },
  });
  await assert.rejects(evaluation, (error) => {
    assert.ok(error instanceof CdpProtocolError);
    assert.throws(() => transientCdpFallback(error, false), (caught) => caught === error);
    return true;
  });
});

test('navigation joins events that arrive before the Page.navigate response', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  const request = lifecycle.beginNavigation();
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: {
      id: 42,
      uniqueId: 'context-1',
      auxData: { isDefault: true, frameId: 'frame-1' },
    },
  });

  const context = await lifecycle.waitForNavigation(
    request,
    { frameId: 'frame-1', loaderId: 'loader-1' },
    100,
    'coldStart',
  );
  assert.deepEqual(context, {
    frameId: 'frame-1',
    loaderId: 'loader-1',
    contextId: 42,
    uniqueId: 'context-1',
    url: 'https://example.test/',
  });
  assert.equal(lifecycle.assertActive(context), context);
});

test('navigation joins a default context announced before its frame commit', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'old-loader', url: 'https://example.test/old' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 1, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  const request = lifecycle.beginNavigation();

  lifecycle.observe('Runtime.executionContextCreated', {
    context: {
      id: 2,
      uniqueId: 'new-context',
      auxData: { isDefault: true, frameId: 'frame-1' },
    },
  });
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'new-loader', url: 'https://example.test/new' },
  });

  const context = await lifecycle.waitForNavigation(
    request,
    { frameId: 'frame-1', loaderId: 'new-loader' },
    100,
    'coldStart',
  );
  assert.deepEqual(context, {
    frameId: 'frame-1',
    loaderId: 'new-loader',
    contextId: 2,
    uniqueId: 'new-context',
    url: 'https://example.test/new',
  });
  assert.equal(lifecycle.assertActive(context), context);
});

test('navigation ignores old and subframe contexts until the exact loader commits', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'old-loader', url: 'https://example.test/old' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 1, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  const request = lifecycle.beginNavigation();
  lifecycle.observe('Page.frameNavigated', {
    frame: {
      id: 'subframe-1',
      parentId: 'frame-1',
      loaderId: 'subframe-loader',
      url: 'https://example.test/frame',
    },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 2, auxData: { isDefault: true, frameId: 'subframe-1' } },
  });
  assert.equal(
    lifecycle.navigationContext(request, { frameId: 'frame-1', loaderId: 'new-loader' }),
    null,
  );

  const committed = lifecycle.waitForNavigation(
    request,
    { frameId: 'frame-1', loaderId: 'new-loader' },
    100,
    'coldStart',
  );
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'new-loader', url: 'https://example.test/new' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 3, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  assert.equal((await committed).contextId, 3);
});

test('reload requires a new loader on the active top-level frame', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  const initialRequest = lifecycle.beginNavigation();
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 1, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  const initial = lifecycle.navigationContext(
    initialRequest,
    { frameId: 'frame-1', loaderId: 'loader-1' },
  );
  const reload = lifecycle.beginReload(initial);
  assert.equal(lifecycle.navigationContext(reload), null);
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'loader-2', url: 'https://example.test/' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 2, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  assert.equal(lifecycle.navigationContext(reload).loaderId, 'loader-2');
});

test('destroyed navigation contexts fail closed with a terminal error', () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  const request = lifecycle.beginNavigation();
  lifecycle.observe('Page.frameNavigated', {
    frame: { id: 'frame-1', loaderId: 'loader-1', url: 'https://example.test/' },
  });
  lifecycle.observe('Runtime.executionContextCreated', {
    context: { id: 1, auxData: { isDefault: true, frameId: 'frame-1' } },
  });
  const context = lifecycle.navigationContext(
    request,
    { frameId: 'frame-1', loaderId: 'loader-1' },
  );
  lifecycle.observe('Runtime.executionContextDestroyed', { executionContextId: 1 });
  assert.throws(
    () => lifecycle.assertActive(context),
    (error) => {
      assert.ok(error instanceof CdpNavigationLifecycleError);
      assert.throws(() => transientCdpFallback(error, false), (caught) => caught === error);
      return true;
    },
  );
});

test('Page.navigate without an exact new-document loader fails closed', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  await assert.rejects(
    lifecycle.waitForNavigation(
      lifecycle.beginNavigation(),
      { frameId: 'frame-1' },
      100,
      'coldStart',
    ),
    CdpNavigationLifecycleError,
  );
});

test('transport failure immediately terminates a pending navigation join', async () => {
  const lifecycle = new TopLevelNavigationLifecycle();
  const navigation = lifecycle.waitForNavigation(
    lifecycle.beginNavigation(),
    { frameId: 'frame-1', loaderId: 'loader-1' },
    1_000,
    'coldStart',
  );
  const failure = new CdpTransportError('socket closed during navigation');
  lifecycle.fail(failure);
  await assert.rejects(navigation, (error) => error === failure);
  assert.throws(() => lifecycle.beginNavigation(), (error) => error === failure);
});

test('request then attachment joins one exact Worker entry', () => {
  const url = 'https://example.test/assets/engine.worker-a.js';
  const row = request(url);
  const requests = new Map([['page:1', row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [workerTarget(url)], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(requests.size, 0);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-attached');
});

test('attachment then request joins through the same complete ledgers', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const target = workerTarget(url);
  const events = [];
  const requests = new Map();
  assert.equal(reconcileWorkerTargetEvidence(
    events, requests, [target], 7, 'sameWorkerReopen', 1_500,
  ), 0);
  const row = request(url);
  events.push(row);
  requests.set(row.networkKey, row);
  assert.equal(reconcileWorkerTargetEvidence(
    events, requests, [target], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-attached');
  assert.equal(target.entryRequestConsumed, true);
});

test('attached proof survives destruction before the delayed request', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const target = workerTarget(url, { terminal: true });
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [target], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-attached');
  assert.equal(row.failed, undefined);
});

test('destroyed-only proof closes a delayed request as failed', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const target = workerTarget(url, { proof: 'destroyed-only', terminal: true });
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [target], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-destroyed');
  assert.match(row.failed, /terminated before target attachment/);
});

test('request then destroyed-only proof uses the same join', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const events = [row];
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    events, requests, [], 7, 'sameWorkerReopen', 1_500,
  ), 0);
  assert.equal(reconcileWorkerTargetEvidence(
    events,
    requests,
    [workerTarget(url, { proof: 'destroyed-only', terminal: true })],
    7,
    'sameWorkerReopen',
    2_000,
  ), 1);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-destroyed');
});

test('detachment does not erase an already-observed attachment proof', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const detachedEvidence = workerTarget(url, { terminal: true });
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [detachedEvidence], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(row.inferredCompletion, 'dedicated-worker-target-attached');
});

test('consumed target evidence cannot authenticate a second request', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const target = workerTarget(url, { entryRequestConsumed: true, terminal: true });
  const row = request(url);
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [target], 7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.size, 1);
});

test('one target cannot close two same-URL worker requests', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const first = request(url);
  const second = { ...request(url, 1_001), networkKey: 'page:2' };
  const requests = new Map([[first.networkKey, first], [second.networkKey, second]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [first, second], requests, [workerTarget(url)], 7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.size, 2);
});

test('one normally completed row still makes a second same-URL request ambiguous', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const first = request(url);
  first.completedPhase = 'sameWorkerReopen';
  const second = { ...request(url, 1_250), networkKey: 'page:2' };
  const requests = new Map([[second.networkKey, second]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [first, second], requests, [workerTarget(url)], 7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.has(second.networkKey), true);
});

test('two target proofs leave one exact request open as ambiguous', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const requests = new Map([[row.networkKey, row]]);
  const targets = [
    workerTarget(url),
    workerTarget(url, { targetId: 'target-2', proof: 'destroyed-only', terminal: true }),
  ];
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, targets, 7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.size, 1);
});

test('an old phase generation cannot close a later request', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [workerTarget(url, { proofPhaseGeneration: 6 })],
    7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.size, 1);
});

test('an exact-URL non-worker target cannot close a worker entry', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  const requests = new Map([[row.networkKey, row]]);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], requests, [workerTarget(url, { type: 'page' })],
    7, 'sameWorkerReopen', 2_000,
  ), 0);
  assert.equal(requests.size, 1);
});

test('a normally completed request consumes one later exact target proof', () => {
  const url = 'https://example.test/assets/editor.worker-a.js';
  const row = request(url);
  row.completedPhase = 'sameWorkerReopen';
  const target = workerTarget(url);
  assert.equal(reconcileWorkerTargetEvidence(
    [row], new Map(), [target], 7, 'sameWorkerReopen', 2_000,
  ), 1);
  assert.equal(target.entryRequestConsumed, true);
  assert.equal(row.inferredCompletion, undefined);
});

test('a completed response-body proof closes only its exact worker entry', () => {
  const worker = request('https://example.test/assets/editor.worker-a.js');
  const ordinary = request('https://example.test/assets/app-a.js');
  const requests = new Map([
    ['page:worker', worker],
    ['page:ordinary', ordinary],
  ]);

  assert.equal(
    reconcileCompletedWorkerBody(requests, 'page:ordinary', 'sameWorkerReopen', 2_000),
    0,
  );
  assert.equal(
    reconcileCompletedWorkerBody(requests, 'page:worker', 'sameWorkerReopen', 2_000),
    1,
  );
  assert.equal(requests.has('page:worker'), false);
  assert.equal(requests.has('page:ordinary'), true);
  assert.equal(worker.inferredCompletion, 'network-get-response-body');
});

test('network-rule coverage uses request proof across page and Worker sessions', () => {
  const common = {
    phase: 'coldStart',
    url: 'https://example.test/file',
    fromDiskCache: false,
    fromServiceWorker: false,
    fromPrefetchCache: false,
    servedFromCache: false,
    appliedNetworkConditionsId: 'rule-1',
  };
  const coverage = summarizeAppliedNetworkRuleCoverage([
    { ...common, targetType: 'page', sessionId: null },
    { ...common, targetType: 'worker', sessionId: 'engine-1' },
    { ...common, targetType: 'worker', sessionId: 'editor-1' },
    { ...common, phase: 'setup', targetType: 'page', appliedNetworkConditionsId: null },
    { ...common, targetType: 'page', fromDiskCache: true, appliedNetworkConditionsId: null },
  ], ['rule-1'], ['engine-1', 'editor-1'], ['engine-1']);
  assert.deepEqual(coverage.page, {
    eligibleRequestCount: 1,
    provenRequestCount: 1,
    unprovenRequestCount: 0,
    appliedRuleIds: ['rule-1'],
    unproven: [],
  });
  assert.equal(coverage.engineWorker.eligibleRequestCount, 1);
  assert.equal(coverage.engineWorker.provenRequestCount, 1);
  assert.equal(coverage.dedicatedWorker.provenRequestCount, 2);
});

test('network-rule coverage fails evidence closed on missing or foreign rule ids', () => {
  const coverage = summarizeAppliedNetworkRuleCoverage([
    {
      phase: 'coldStart',
      targetType: 'page',
      sessionId: null,
      url: 'https://example.test/app.js',
      appliedNetworkConditionsId: null,
    },
    {
      phase: 'coldStart',
      targetType: 'worker',
      sessionId: 'engine-1',
      url: 'https://example.test/core.tgz',
      appliedNetworkConditionsId: 'other-rule',
    },
  ], ['rule-1'], ['engine-1'], ['engine-1']);
  assert.equal(coverage.page.unprovenRequestCount, 1);
  assert.equal(coverage.engineWorker.unprovenRequestCount, 1);
});

test('network-rule evidence joins a Worker request to page-session ExtraInfo', () => {
  const request = { requestId: '42.7', sessionId: 'worker-1' };
  const proof = {
    requestId: '42.7',
    sessionId: null,
    appliedNetworkConditionsId: 'rule-1',
    consumed: false,
    phaseGeneration: 4,
  };
  request.phaseGeneration = 4;
  assert.equal(reconcileNetworkRuleEvidence([request], [proof]), 1);
  assert.equal(request.appliedNetworkConditionsId, 'rule-1');
  assert.equal(request.networkRuleEvidenceSessionId, null);
  assert.equal(proof.consumed, true);
});

test('network-rule evidence joins ExtraInfo observed before its request', () => {
  const proof = {
    requestId: '42.8',
    sessionId: null,
    appliedNetworkConditionsId: 'rule-1',
    consumed: false,
    phaseGeneration: 4,
  };
  assert.equal(reconcileNetworkRuleEvidence([], [proof]), 0);
  const request = { requestId: '42.8', sessionId: 'worker-1', phaseGeneration: 4 };
  assert.equal(reconcileNetworkRuleEvidence([request], [proof]), 1);
});

test('network-rule evidence remains unconsumed on request-id ambiguity', () => {
  const first = { requestId: 'shared', sessionId: 'worker-1', phaseGeneration: 4 };
  const second = { requestId: 'shared', sessionId: 'page', phaseGeneration: 4 };
  const proof = {
    requestId: 'shared',
    sessionId: null,
    appliedNetworkConditionsId: 'rule-1',
    consumed: false,
    phaseGeneration: 4,
  };
  assert.equal(reconcileNetworkRuleEvidence([first, second], [proof]), 0);
  assert.equal(proof.consumed, false);
  assert.equal(first.appliedNetworkConditionsId, undefined);
});

test('consumed network-rule evidence cannot prove a later reused id', () => {
  const first = { requestId: '42.9', sessionId: 'worker-1', phaseGeneration: 4 };
  const proof = {
    requestId: '42.9',
    sessionId: null,
    appliedNetworkConditionsId: 'rule-1',
    consumed: false,
    phaseGeneration: 4,
  };
  assert.equal(reconcileNetworkRuleEvidence([first], [proof]), 1);
  const second = { requestId: '42.9', sessionId: 'worker-2', phaseGeneration: 5 };
  assert.equal(reconcileNetworkRuleEvidence([first, second], [proof]), 0);
  assert.equal(second.appliedNetworkConditionsId, undefined);
});

test('network-rule evidence from an old phase cannot prove a reused request id', () => {
  const request = { requestId: 'reused', phaseGeneration: 5 };
  const proof = {
    requestId: 'reused',
    phaseGeneration: 4,
    appliedNetworkConditionsId: 'rule-1',
    consumed: false,
  };
  assert.equal(reconcileNetworkRuleEvidence([request], [proof]), 0);
  assert.equal(proof.consumed, false);
});

test('network-rule eligibility excludes setup and cache-owned responses', () => {
  const base = { phase: 'coldStart', url: 'https://example.test/file' };
  assert.equal(requiresAppliedNetworkRuleProof(base), true);
  assert.equal(requiresAppliedNetworkRuleProof({ ...base, phase: 'setup' }), false);
  assert.equal(requiresAppliedNetworkRuleProof({ ...base, fromDiskCache: true }), false);
  assert.equal(requiresAppliedNetworkRuleProof({ ...base, fromServiceWorker: true }), false);
  assert.equal(requiresAppliedNetworkRuleProof({ ...base, servedFromCache: true }), false);
  assert.equal(requiresAppliedNetworkRuleProof({
    ...base,
    targetType: 'page',
    resourceType: 'Script',
    url: 'https://example.test/assets/engine.worker-hash.js',
  }), false);
});
