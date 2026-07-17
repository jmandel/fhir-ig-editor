// Small, deterministic lifecycle core for the browser benchmark. Keeping CDP
// request ownership here makes detach/timeout/close behavior testable without
// launching Chromium or importing the executable benchmark.

export class TerminalCdpError extends Error {}

export class CdpCallTimeoutError extends TerminalCdpError {
  constructor(method, sessionId, phase, limit) {
    super(
      `CDP ${method} timed out after ${limit}ms`
      + ` (session ${sessionId || 'page'}, benchmark phase ${phase})`,
    );
    this.name = 'CdpCallTimeoutError';
  }
}

export class CdpTransportError extends TerminalCdpError {
  constructor(message) {
    super(message);
    this.name = 'CdpTransportError';
  }
}

export class CdpProtocolError extends TerminalCdpError {
  constructor(method, sessionId, error) {
    const detail = error?.data ? ` (${error.data})` : '';
    super(
      `CDP ${method} failed in session ${sessionId || 'page'}: `
      + `${error?.message || 'unknown protocol error'}${detail}`,
    );
    this.name = 'CdpProtocolError';
    this.code = error?.code ?? null;
  }
}

export class CdpNavigationLifecycleError extends TerminalCdpError {
  constructor(message) {
    super(message);
    this.name = 'CdpNavigationLifecycleError';
  }
}

export class CdpSessionDetachedError extends Error {
  constructor(sessionId) {
    super(`Chrome DevTools session detached: ${sessionId}`);
    this.name = 'CdpSessionDetachedError';
  }
}

export function transientCdpFallback(error, fallback) {
  if (error instanceof TerminalCdpError) throw error;
  return fallback;
}

function samePreviewIdentity(left, right) {
  return !!left && !!right
    && left.generator === right.generator
    && left.path === right.path;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** A hidden Author-tab iframe is retained evidence, not a visibility claim. */
export function isRetainedPreviewBinding(previous, current) {
  return samePreviewIdentity(previous, current)
    && current.mounted === true
    && current.fallback === false
    && Number.isSafeInteger(previous.generation)
    && Number.isSafeInteger(current.generation)
    && SHA256.test(previous.contentSha256 || '')
    && SHA256.test(current.contentSha256 || '')
    && current.generation === previous.generation
    && current.contentSha256 === previous.contentSha256;
}

/** Bind a hot update to one exact page and a strictly newer authenticated body. */
export function isExactPreviewSuccessor(previous, current, expected = {}) {
  return samePreviewIdentity(previous, current)
    && current.mounted === true
    && current.fallback === false
    && current.readyState === 'complete'
    && Number.isSafeInteger(previous.generation)
    && Number.isSafeInteger(current.generation)
    && SHA256.test(previous.contentSha256 || '')
    && SHA256.test(current.contentSha256 || '')
    && current.generation > previous.generation
    && current.contentSha256 !== previous.contentSha256
    && (!expected.generator || current.generator === expected.generator)
    && (!expected.path || current.path === expected.path);
}

// Return a page-owned probe that performs the initial catalog selection only
// after the exact document's engine and catalog control exist. Installing this
// before navigation avoids a post-navigation CDP command being stranded on a
// document/context boundary. The benchmark observes the recorded handshake;
// it does not race the page to issue the command.
export function createCatalogSelectionProbe(windowObject, documentObject, projectId) {
  let terminal = false;
  let scheduled = false;
  return function probeCatalogSelection() {
    const trace = windowObject.__igProjectBenchmark;
    if (!trace || terminal || !windowObject.__igDebug?.engine?.initialized) return null;

    const now = windowObject.performance.now();
    trace.milestones.appBootReadyAt ??= now;
    if (windowObject.localStorage.getItem('igEditor.project') === projectId) {
      terminal = true;
      trace.catalogSelection = {
        ...(trace.catalogSelection || {}),
        status: trace.catalogSelection?.status === 'dispatched' ? 'accepted' : 'already-selected',
        projectId,
        acknowledgedAt: now,
      };
      return trace.catalogSelection;
    }
    if (trace.catalogSelection?.status === 'dispatched' || scheduled) {
      return trace.catalogSelection;
    }

    const select = documentObject.querySelector('.open-ig-select');
    const available = select ? [...select.options].map((option) => option.value) : [];
    if (!select) {
      trace.catalogSelection = { status: 'waiting-for-select', projectId, available };
      return trace.catalogSelection;
    }
    if (select.disabled) {
      trace.catalogSelection = { status: 'waiting-for-enabled-select', projectId, available };
      return trace.catalogSelection;
    }
    if (!available.includes(projectId)) {
      trace.catalogSelection = { status: 'waiting-for-option', projectId, available };
      return trace.catalogSelection;
    }

    scheduled = true;
    trace.catalogSelection = {
      status: 'scheduled',
      projectId,
      available,
      scheduledAt: now,
    };
    // MutationObserver can run during React's commit. The next animation frame
    // is the first lifecycle boundary at which the rendered control and its
    // delegated change listener are both committed. This is an event boundary,
    // not a timing guess or retry loop.
    windowObject.requestAnimationFrame(() => {
      scheduled = false;
      const currentTrace = windowObject.__igProjectBenchmark;
      if (!currentTrace || terminal) return;
      const committedSelect = documentObject.querySelector('.open-ig-select');
      const committedAvailable = committedSelect
        ? [...committedSelect.options].map((option) => option.value)
        : [];
      if (!committedSelect || committedSelect.disabled || !committedAvailable.includes(projectId)) {
        currentTrace.catalogSelection = {
          status: !committedSelect
            ? 'waiting-for-select'
            : committedSelect.disabled
              ? 'waiting-for-enabled-select'
              : 'waiting-for-option',
          projectId,
          available: committedAvailable,
        };
        return;
      }
      const requestedAt = windowObject.performance.now();
      currentTrace.catalogSelection = {
        ...currentTrace.catalogSelection,
        status: 'dispatching',
        projectId,
        available: committedAvailable,
        requestedAt,
      };
      try {
        const setter = Object.getOwnPropertyDescriptor(
          windowObject.HTMLSelectElement.prototype,
          'value',
        )?.set;
        if (!setter) throw new Error('HTMLSelectElement.value setter is unavailable');
        setter.call(committedSelect, projectId);
        committedSelect.dispatchEvent(new windowObject.Event('change', { bubbles: true }));
        currentTrace.catalogSelection = {
          ...currentTrace.catalogSelection,
          status: 'dispatched',
          dispatchedAt: windowObject.performance.now(),
        };
      } catch (error) {
        terminal = true;
        currentTrace.catalogSelection = {
          ...currentTrace.catalogSelection,
          status: 'error',
          acknowledgedAt: windowObject.performance.now(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    return trace.catalogSelection;
  };
}

export class CdpPendingCalls {
  constructor(send, defaultTimeoutMs, phase) {
    this.send = send;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.phase = phase;
    this.nextId = 1;
    this.pending = new Map();
    this.transportFailure = null;
  }

  handleResponse(message) {
    if (message.id == null) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new CdpProtocolError(pending.method, pending.sessionId, message.error));
    }
    else pending.resolve(message.result);
    return true;
  }

  call(method, params = {}, sessionId = null, limit = this.defaultTimeoutMs) {
    if (this.transportFailure) return Promise.reject(this.transportFailure);
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new CdpCallTimeoutError(method, sessionId, this.phase(), limit));
      }, limit);
      this.pending.set(id, { resolve, reject, timer, method, sessionId });
      try {
        this.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        const failure = new CdpTransportError(
          `could not send CDP ${method}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.fail(failure);
        reject(failure);
      }
    });
  }

  rejectSession(sessionId, error = new CdpSessionDetachedError(sessionId)) {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  fail(error) {
    if (!this.transportFailure) this.transportFailure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.transportFailure);
    }
    this.pending.clear();
  }
}

// Page.navigate acknowledges that Chromium accepted a navigation. It does not
// prove that the requested loader owns the page's default execution context.
// Keep the small lifecycle join separate from the benchmark so navigation
// events that race ahead of the command response remain observable and
// unit-testable.
export class TopLevelNavigationLifecycle {
  constructor() {
    this.sequence = 0;
    this.frameCommits = [];
    this.currentFrameCommit = new Map();
    this.contexts = new Map();
    this.waiters = new Set();
    this.terminalFailure = null;
  }

  beginNavigation() {
    if (this.terminalFailure) throw this.terminalFailure;
    return Object.freeze({ kind: 'navigate', afterSequence: this.sequence });
  }

  beginReload(activeContext) {
    if (this.terminalFailure) throw this.terminalFailure;
    this.assertActive(activeContext);
    return Object.freeze({
      kind: 'reload',
      afterSequence: this.sequence,
      frameId: activeContext.frameId,
      previousLoaderId: activeContext.loaderId,
    });
  }

  observe(method, params = {}) {
    if (method === 'Page.frameNavigated') {
      const frame = params.frame;
      if (!frame || frame.parentId || !frame.id || !frame.loaderId) return false;
      const commit = Object.freeze({
        sequence: ++this.sequence,
        frameId: frame.id,
        loaderId: frame.loaderId,
        url: frame.url || null,
      });
      this.frameCommits.push(commit);
      if (this.frameCommits.length > 32) this.frameCommits.shift();
      this.currentFrameCommit.set(frame.id, commit);
      this.settleWaiters();
      return true;
    }
    if (method === 'Runtime.executionContextCreated') {
      const context = params.context;
      const frameId = context?.auxData?.frameId;
      if (!context || context.auxData?.isDefault !== true || !frameId) return false;
      const observed = Object.freeze({
        sequence: ++this.sequence,
        contextId: context.id,
        uniqueId: context.uniqueId || null,
        frameId,
      });
      this.contexts.set(context.id, observed);
      this.settleWaiters();
      return true;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      const contextId = params.executionContextId;
      if (contextId == null) return false;
      this.sequence += 1;
      this.contexts.delete(contextId);
      this.settleWaiters();
      return true;
    }
    if (method === 'Runtime.executionContextsCleared') {
      this.sequence += 1;
      this.contexts.clear();
      this.settleWaiters();
      return true;
    }
    return false;
  }

  navigationContext(request, result = {}) {
    const expected = this.expectedNavigation(request, result);
    const commit = this.frameCommits.find((candidate) =>
      candidate.sequence > request.afterSequence
        && candidate.frameId === expected.frameId
        && (expected.loaderId == null
          ? candidate.loaderId !== request.previousLoaderId
          : candidate.loaderId === expected.loaderId));
    if (!commit) return null;
    const currentCommit = this.currentFrameCommit.get(commit.frameId);
    if (currentCommit?.loaderId !== commit.loaderId) {
      throw new CdpNavigationLifecycleError(
        `requested top-level loader ${commit.loaderId} was superseded by `
        + `${currentCommit?.loaderId || 'an unknown loader'}`,
      );
    }
    // Runtime and Page are independent CDP domains. Chrome may announce the
    // new default context immediately before OR after frameNavigated. Associate
    // them at the join using the request boundary and currently-active frame,
    // rather than stamping a context with whichever old loader happened to be
    // current when its event arrived.
    const context = [...this.contexts.values()]
      .filter((candidate) => candidate.sequence > request.afterSequence
        && candidate.frameId === commit.frameId)
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (!context) return null;
    return Object.freeze({
      frameId: commit.frameId,
      loaderId: commit.loaderId,
      contextId: context.contextId,
      uniqueId: context.uniqueId,
      url: commit.url,
    });
  }

  waitForNavigation(request, result, limit, phase) {
    if (this.terminalFailure) return Promise.reject(this.terminalFailure);
    try {
      const context = this.navigationContext(request, result);
      if (context) return Promise.resolve(context);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const waiter = { request, result, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        if (!this.waiters.delete(waiter)) return;
        reject(new CdpNavigationLifecycleError(
          `timed out after ${limit}ms waiting for the requested top-level `
          + `${request.kind} loader and default execution context during ${phase}`,
        ));
      }, limit);
      this.waiters.add(waiter);
      this.settleWaiter(waiter);
    });
  }

  assertActive(context) {
    if (this.terminalFailure) throw this.terminalFailure;
    if (!context) {
      throw new CdpNavigationLifecycleError('no committed top-level execution context is active');
    }
    const observed = this.contexts.get(context.contextId);
    const frame = this.currentFrameCommit.get(context.frameId);
    if (!observed
        || observed.frameId !== context.frameId
        || frame?.loaderId !== context.loaderId) {
      throw new CdpNavigationLifecycleError(
        `top-level execution context ${context.contextId} for loader `
        + `${context.loaderId} is no longer active`,
      );
    }
    return context;
  }

  fail(error) {
    if (!this.terminalFailure) this.terminalFailure = error;
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(this.terminalFailure);
    }
    this.waiters.clear();
  }

  expectedNavigation(request, result) {
    if (request.kind === 'navigate') {
      if (result.errorText) {
        throw new CdpNavigationLifecycleError(`Page.navigate failed: ${result.errorText}`);
      }
      if (result.isDownload) {
        throw new CdpNavigationLifecycleError('Page.navigate became a download');
      }
      if (!result.frameId || !result.loaderId) {
        throw new CdpNavigationLifecycleError(
          'Page.navigate did not identify a new document frame and loader',
        );
      }
      return { frameId: result.frameId, loaderId: result.loaderId };
    }
    if (request.kind === 'reload') {
      return { frameId: request.frameId, loaderId: null };
    }
    throw new CdpNavigationLifecycleError(`unknown navigation request kind ${request.kind}`);
  }

  settleWaiters() {
    for (const waiter of [...this.waiters]) this.settleWaiter(waiter);
  }

  settleWaiter(waiter) {
    let context;
    try {
      context = this.navigationContext(waiter.request, waiter.result);
    } catch (error) {
      this.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.reject(error);
      return;
    }
    if (!context || !this.waiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.resolve(context);
  }
}

/** Setup does not evaluate the throwaway document. Prove only that Chrome's
 * top-level frame committed the exact loader returned by Page.navigate. */
export function isCommittedTopLevelFrame(frameTree, navigation, expectedUrl) {
  const frame = frameTree?.frameTree?.frame;
  return !!frame
    && !!navigation?.frameId
    && !!navigation?.loaderId
    && frame.id === navigation.frameId
    && frame.loaderId === navigation.loaderId
    && frame.url === expectedUrl;
}

export function isWorkerEntry(request) {
  return request.targetType === 'page'
    && request.resourceType === 'Script'
    && /\/assets\/[^/]*\.worker-[^/]+\.js(?:[?#]|$)/u.test(request.url);
}

/** Prove that a page-installed global Network rule reached both ordinary page
 * requests and fetches issued by the engine's dedicated Worker. Chromium does
 * not accept Network emulation commands on dedicated-Worker sessions; the
 * requestExtraInfo rule id is the protocol's per-request application proof. */
export function summarizeAppliedNetworkRuleCoverage(
  networkEvents,
  ruleIds,
  dedicatedWorkerSessions,
  engineWorkerSessions,
) {
  const acceptedRuleIds = new Set(ruleIds);
  const allWorkerSessions = new Set(dedicatedWorkerSessions);
  const workerSessions = new Set(engineWorkerSessions);
  const eligible = networkEvents.filter(requiresAppliedNetworkRuleProof);
  const summarize = (requests) => {
    const proven = requests.filter((request) =>
      acceptedRuleIds.has(request.appliedNetworkConditionsId));
    return {
      eligibleRequestCount: requests.length,
      provenRequestCount: proven.length,
      unprovenRequestCount: requests.length - proven.length,
      appliedRuleIds: [...new Set(proven.map((request) =>
        request.appliedNetworkConditionsId))].sort(),
      unproven: requests.filter((request) =>
        !acceptedRuleIds.has(request.appliedNetworkConditionsId)).map((request) => ({
        phase: request.phase,
        targetType: request.targetType,
        url: request.url,
        appliedNetworkConditionsId: request.appliedNetworkConditionsId || null,
      })),
    };
  };
  return {
    ruleIds: [...acceptedRuleIds].sort(),
    unprofiledWorkerEntries: networkEvents.filter((request) =>
      request.phase !== 'setup' && isWorkerEntry(request)).map((request) => ({
      phase: request.phase,
      url: request.url,
      encodedBytes: request.encodedBytes || 0,
    })),
    page: summarize(eligible.filter((request) => request.targetType === 'page')),
    dedicatedWorker: summarize(eligible.filter((request) =>
      allWorkerSessions.has(request.sessionId))),
    engineWorker: summarize(eligible.filter((request) =>
      workerSessions.has(request.sessionId))),
  };
}

export function requiresAppliedNetworkRuleProof(request) {
  return request.phase !== 'setup'
    && /^https?:/u.test(request.url)
    // Chrome 148 does not attach the page's global rule id to dedicated-Worker
    // main-script loads. Keep those rows visible as an explicit unprofiled
    // class; target attachment or elapsed time is not network-profile proof.
    && !isWorkerEntry(request)
    && !request.fromDiskCache
    && !request.fromServiceWorker
    && !request.fromPrefetchCache
    && !request.servedFromCache;
}

/** Chromium can report a dedicated Worker's request on the Worker session but
 * its requestExtraInfo on the parent page session. Session id is therefore not
 * a valid join key. Join the complete ledgers by raw CDP request id and consume
 * only an unambiguous one-to-one pair; redirects or cross-session id collisions
 * remain deliberately unproven. */
export function reconcileNetworkRuleEvidence(networkEvents, evidenceRows) {
  const requestsById = new Map();
  for (const request of networkEvents) {
    if (request.networkRuleEvidenceConsumed === true) continue;
    const rows = requestsById.get(request.requestId) || [];
    rows.push(request);
    requestsById.set(request.requestId, rows);
  }
  const evidenceById = new Map();
  for (const evidence of evidenceRows) {
    if (evidence.consumed === true) continue;
    const rows = evidenceById.get(evidence.requestId) || [];
    rows.push(evidence);
    evidenceById.set(evidence.requestId, rows);
  }

  let reconciled = 0;
  for (const [requestId, requests] of requestsById) {
    const candidates = evidenceById.get(requestId) || [];
    if (requests.length !== 1 || candidates.length !== 1) continue;
    const request = requests[0];
    const proof = candidates[0];
    if (request.phaseGeneration !== proof.phaseGeneration) continue;
    request.networkRuleEvidenceConsumed = true;
    request.appliedNetworkConditionsId = proof.appliedNetworkConditionsId;
    request.networkRuleEvidenceSessionId = proof.sessionId;
    proof.consumed = true;
    reconciled += 1;
  }
  return reconciled;
}

/** Network.getResponseBody succeeds only after Chrome has retained the complete
 * response. Use that explicit proof for the worker-entry edge where the parent
 * page target omits loadingFinished and no worker target survives long enough
 * to attach or emit a targetDestroyed record. */
export function reconcileCompletedWorkerBody(
  networkRequests,
  key,
  phase,
  now = Date.now(),
) {
  const request = networkRequests.get(key);
  if (!request || !isWorkerEntry(request)) return 0;
  closeWorkerEntry(
    networkRequests,
    key,
    request,
    phase,
    now,
    'network-get-response-body',
  );
  return 1;
}

function closeWorkerEntry(networkRequests, key, request, phase, now, inference) {
  request.completedPhase = phase;
  request.finishedTimestampMs = request.startedTimestampMs
    + Math.max(0, now - request.startedAtEpochMs);
  request.durationMs = Math.max(0, request.finishedTimestampMs - request.startedTimestampMs);
  request.inferredCompletion = inference;
  networkRequests.delete(key);
}

/** Target and Network are independent CDP domains. Join their complete ledgers
 * by exact phase generation and URL, accepting only one unmatched request and
 * one unconsumed dedicated-Worker proof. Completed request rows remain in the
 * ledger so a late target cannot be reused to authenticate a later request. */
export function reconcileWorkerTargetEvidence(
  networkEvents,
  networkRequests,
  targetEvidence,
  phaseGeneration,
  phase,
  now = Date.now(),
) {
  const requestsByUrl = new Map();
  for (const request of networkEvents) {
    if (!isWorkerEntry(request)
        || request.phaseGeneration !== phaseGeneration
        || request.workerTargetPaired === true) continue;
    const rows = requestsByUrl.get(request.url) || [];
    rows.push(request);
    requestsByUrl.set(request.url, rows);
  }
  const targetsByUrl = new Map();
  for (const target of targetEvidence) {
    if (target.type !== 'worker'
        || !target.proof
        || target.proofPhaseGeneration !== phaseGeneration
        || target.entryRequestConsumed === true) continue;
    const rows = targetsByUrl.get(target.proofUrl) || [];
    rows.push(target);
    targetsByUrl.set(target.proofUrl, rows);
  }

  let reconciled = 0;
  for (const [url, requests] of requestsByUrl) {
    const targets = targetsByUrl.get(url) || [];
    if (requests.length !== 1 || targets.length !== 1) continue;
    const request = requests[0];
    const target = targets[0];
    request.workerTargetPaired = true;
    request.workerTargetId = target.targetId;
    target.entryRequestConsumed = true;

    if (networkRequests.get(request.networkKey) === request) {
      const inference = target.proof === 'attached'
        ? 'dedicated-worker-target-attached'
        : 'dedicated-worker-target-destroyed';
      closeWorkerEntry(
        networkRequests,
        request.networkKey,
        request,
        phase,
        now,
        inference,
      );
      if (target.proof === 'destroyed-only') {
        request.failed ||= 'worker terminated before target attachment';
      }
    }
    reconciled += 1;
  }
  return reconciled;
}
