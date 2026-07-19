/** Preview publication is a host for the same immutable site outputs used by
 * finalize. It does not own an adapter, an asset manifest, or renderer state. */

import type {
  ContentRef,
  OutputCatalog,
  OutputDescriptor,
} from '../site/contract';
import { contentStore } from '../storage/contentStore';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
export const PREVIEW_ROOT = `${BASE}preview/`;
const CHANNEL_NAME = 'igpreview';
export const PREVIEW_SW_PROTOCOL = 8;
const PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL = 6;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUTS = 20_000;
const MAX_CATALOG_CHARS = 8 * 1024 * 1024;

export interface PreviewSource {
  igId: string;
  buildId: string;
  catalog: OutputCatalog;
}

export function previewWorkerScriptPath(base = BASE): string {
  return `${base.replace(/\/?$/, '/')}preview-sw.js?protocol=${PREVIEW_SW_COMPAT_ADDRESS_PROTOCOL}`;
}

export function previewUrl(igId: string, pagePath: string): string {
  const ig = encodeURIComponent(igId);
  const path = pagePath.split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_ROOT}${ig}/${path}`;
}

function validContentRef(value: unknown): value is ContentRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Partial<ContentRef>;
  return typeof ref.sha256 === 'string'
    && SHA256.test(ref.sha256)
    && Number.isSafeInteger(ref.byteLength)
    && (ref.byteLength ?? -1) >= 0
    && (ref.mediaType == null || (typeof ref.mediaType === 'string' && !/[\r\n]/.test(ref.mediaType)));
}

/** Catalog paths are URL-relative exact output names. Reject traversal,
 * aliases, query/fragment ambiguity, and duplicate names at publication. */
export function isSafePreviewPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 2_048) return false;
  if (path.startsWith('/') || path.includes('\\') || /[?#\0]/.test(path)) return false;
  const parts = path.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function validatePreviewSource(value: PreviewSource): PreviewSource {
  if (!value || typeof value !== 'object') throw new Error('preview source is required');
  if (typeof value.igId !== 'string' || !value.igId || value.igId.length > 256 || /[\\/\0]/.test(value.igId)) {
    throw new Error('preview IG id is invalid');
  }
  if (typeof value.buildId !== 'string' || !value.buildId || value.buildId.length > 512) {
    throw new Error('preview build id is invalid');
  }
  if (!value.catalog || value.catalog.buildId !== value.buildId || !Array.isArray(value.catalog.outputs)) {
    throw new Error('preview catalog does not belong to its build');
  }
  if (value.catalog.outputs.length > MAX_OUTPUTS) throw new Error('preview catalog is too large');
  const paths = new Set<string>();
  let catalogChars = 0;
  for (const output of value.catalog.outputs) {
    if (!isSafePreviewPath(output.path)) throw new Error(`unsafe preview output path ${String(output.path)}`);
    if (paths.has(output.path)) throw new Error(`duplicate preview output path ${output.path}`);
    paths.add(output.path);
    if (!['page', 'asset', 'auxiliary'].includes(output.kind)) {
      throw new Error(`invalid preview output kind for ${output.path}`);
    }
    if (typeof output.mediaType !== 'string' || !output.mediaType || output.mediaType.length > 256 || /[\r\n]/.test(output.mediaType)) {
      throw new Error(`invalid preview media type for ${output.path}`);
    }
    catalogChars += output.path.length + output.mediaType.length;
    if (catalogChars > MAX_CATALOG_CHARS) throw new Error('preview catalog metadata is too large');
    if (output.content != null && !validContentRef(output.content)) {
      throw new Error(`invalid preview content reference for ${output.path}`);
    }
    if (output.content?.mediaType && output.content.mediaType !== output.mediaType) {
      throw new Error(`preview content media type disagrees for ${output.path}`);
    }
  }
  const outputs = value.catalog.outputs.map((output) => Object.freeze({
    ...output,
    ...(output.content ? { content: Object.freeze({ ...output.content }) } : {}),
  }));
  return Object.freeze({
    igId: value.igId,
    buildId: value.buildId,
    catalog: Object.freeze({ buildId: value.catalog.buildId, outputs: Object.freeze(outputs) }),
  }) as PreviewSource;
}

export function previewContentChanged(before: ContentRef | null, after: ContentRef): boolean {
  return before == null
    || before.sha256 !== after.sha256
    || before.byteLength !== after.byteLength;
}

// ---- Service Worker registration ----------------------------------------------

let swRegistration: ServiceWorkerRegistration | null = null;
let compatibleWorker: ServiceWorker | null = null;
let swReadyPromise: Promise<ServiceWorker | null> | null = null;

export type PreviewRetryScheduler = (retry: () => void) => () => void;

const schedulePreviewRetry: PreviewRetryScheduler = (retry) => {
  const handle = globalThis.setTimeout(retry, 1_000);
  return () => globalThis.clearTimeout(handle);
};

export function isCompatiblePreviewWorkerPong(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pong = value as { type?: unknown; protocol?: unknown };
  return pong.type === 'igpreview:pong' && pong.protocol === PREVIEW_SW_PROTOCOL;
}

/** Semantic protocol negotiation has no elapsed deadline. The exact Worker
 * either answers, becomes redundant, or fails its message channel. */
export function previewWorkerProtocol(
  worker: ServiceWorker,
  scheduleRetry: PreviewRetryScheduler = schedulePreviewRetry,
): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let settled = false;
    let channel: MessagePort | null = null;
    let cancelRetry: (() => void) | null = null;
    const finish = (protocol: number | null) => {
      if (settled) return;
      settled = true;
      cancelRetry?.();
      channel?.close();
      worker.removeEventListener('statechange', stateChanged);
      resolve(protocol);
    };
    function stateChanged() {
      if (worker.state === 'redundant') finish(null);
    }
    const attempt = () => {
      cancelRetry = null;
      if (settled) return;
      channel?.close();
      const next = new MessageChannel();
      channel = next.port1;
      next.port1.onmessage = (event) => {
        finish(isCompatiblePreviewWorkerPong(event.data) ? PREVIEW_SW_PROTOCOL : null);
      };
      next.port1.onmessageerror = () => {
        next.port1.close();
        if (channel === next.port1) channel = null;
      };
      try {
        worker.postMessage({ type: 'igpreview:ping', protocol: PREVIEW_SW_PROTOCOL }, [next.port2]);
      } catch {
        finish(null);
        return;
      }
      cancelRetry = scheduleRetry(attempt);
    };
    worker.addEventListener('statechange', stateChanged);
    if (worker.state === 'redundant') {
      finish(null);
      return;
    }
    attempt();
  });
}

export async function waitForCompatiblePreviewWorker(
  registration: Pick<
    ServiceWorkerRegistration,
    | 'active' | 'installing' | 'waiting'
  >,
  desiredScriptUrl: string,
): Promise<ServiceWorker> {
  // A waiting/installing update at the stable compatibility URL is newer than
  // the active implementation at that same URL. Semantic ping decides after
  // activation; URL equality alone never does.
  const candidate = [registration.waiting, registration.installing, registration.active]
    .find((worker) => worker?.scriptURL === desiredScriptUrl && worker.state !== 'redundant');
  if (!candidate) {
    throw new Error(`preview Service Worker protocol ${PREVIEW_SW_PROTOCOL} did not install`);
  }
  const activated = candidate.state === 'activated'
    ? candidate
    : await new Promise<ServiceWorker>((resolve, reject) => {
    const stateChanged = () => {
      if (candidate.state === 'activated') {
        candidate.removeEventListener('statechange', stateChanged);
        resolve(candidate);
      } else if (candidate.state === 'redundant') {
        candidate.removeEventListener('statechange', stateChanged);
        reject(new Error(`preview Service Worker protocol ${PREVIEW_SW_PROTOCOL} became redundant`));
      }
    };
    candidate.addEventListener('statechange', stateChanged);
    // Close the event-listener race if activation happened between selection
    // and subscription.
    if (candidate.state === 'activated' || candidate.state === 'redundant') {
      stateChanged();
    }
  });
  if (await previewWorkerProtocol(activated) !== PREVIEW_SW_PROTOCOL) {
    throw new Error(`preview Service Worker does not implement protocol ${PREVIEW_SW_PROTOCOL}`);
  }
  return activated;
}

async function registerCompatiblePreviewWorker(): Promise<ServiceWorker> {
  const scriptPath = previewWorkerScriptPath();
  const desiredScriptUrl = new URL(scriptPath, window.location.href).href;
  const options: RegistrationOptions = { scope: PREVIEW_ROOT, updateViaCache: 'none', type: 'module' };
  swRegistration = await navigator.serviceWorker.register(scriptPath, options);
  try {
    return await waitForCompatiblePreviewWorker(swRegistration, desiredScriptUrl);
  } catch (firstError) {
    console.warn('[igpreview] replacing incompatible preview Service Worker:', firstError);
    await swRegistration.unregister();
    swRegistration = await navigator.serviceWorker.register(scriptPath, options);
    return waitForCompatiblePreviewWorker(swRegistration, desiredScriptUrl);
  }
}

export async function ensurePreviewServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  if (compatibleWorker?.state === 'activated') return true;
  if (swReadyPromise) return (await swReadyPromise) !== null;
  const pending = registerCompatiblePreviewWorker().then(
    (worker) => {
      compatibleWorker = worker;
      return worker;
    },
    (error) => {
      console.warn('[igpreview] SW registration failed; preview disabled:', error);
      compatibleWorker = null;
      return null;
    },
  );
  swReadyPromise = pending;
  try {
    return (await pending) !== null;
  } finally {
    if (swReadyPromise === pending) swReadyPromise = null;
  }
}

async function activePreviewWorker(): Promise<ServiceWorker | null> {
  if (!(await ensurePreviewServiceWorker())) return null;
  return compatibleWorker?.state === 'activated' ? compatibleWorker : null;
}

export interface PersistedPreviewPublication {
  generation: number;
  source: PreviewSource;
}

/** Read the Service Worker's already-validated immutable pointer. This is a
 * presentation fast path, not a derivation cache hit: callers must keep it
 * visibly stale until prepare reproduces a current closed SiteBuild. */
export async function previewWorkerPublication(
  worker: ServiceWorker,
  igId: string,
  scheduleRetry: PreviewRetryScheduler = schedulePreviewRetry,
): Promise<PersistedPreviewPublication | null> {
  return new Promise<PersistedPreviewPublication | null>((resolve) => {
    let settled = false;
    let channel: MessagePort | null = null;
    let cancelRetry: (() => void) | null = null;
    const finish = (publication: PersistedPreviewPublication | null) => {
      if (settled) return;
      settled = true;
      cancelRetry?.();
      channel?.close();
      worker.removeEventListener('statechange', stateChanged);
      resolve(publication);
    };
    function stateChanged() {
      if (worker.state === 'redundant') finish(null);
    }
    const attempt = () => {
      cancelRetry = null;
      if (settled) return;
      channel?.close();
      const next = new MessageChannel();
      channel = next.port1;
      next.port1.onmessage = (event) => {
        const reply = event.data as Record<string, unknown> | null;
        if (!reply?.ok || reply.protocol !== PREVIEW_SW_PROTOCOL) {
          finish(null);
          return;
        }
        try {
          if (!Number.isSafeInteger(reply.generation) || (reply.generation as number) < 0) {
            throw new Error('invalid persisted preview generation');
          }
          const restored = validatePreviewSource(reply.source as PreviewSource);
          if (restored.igId !== igId) throw new Error('persisted preview belongs to another IG');
          finish({ generation: reply.generation as number, source: restored });
        } catch {
          finish(null);
        }
      };
      next.port1.onmessageerror = () => {
        next.port1.close();
        if (channel === next.port1) channel = null;
      };
      try {
        worker.postMessage({ type: 'igpreview:read', protocol: PREVIEW_SW_PROTOCOL, igId }, [next.port2]);
      } catch {
        finish(null);
        return;
      }
      cancelRetry = scheduleRetry(attempt);
    };
    worker.addEventListener('statechange', stateChanged);
    if (worker.state === 'redundant') {
      finish(null);
      return;
    }
    attempt();
  });
}

/** Restore a previously committed preview before compiler readiness. Ready
 * ContentRefs are still served only after the Service Worker/ContentStore
 * verifies their exact digest and length; unresolved pages may use its equally
 * verified per-build response cache. */
export async function restorePersistedPreviewSource(
  igId: string,
): Promise<PersistedPreviewPublication | null> {
  const worker = await activePreviewWorker();
  if (!worker) return null;
  const publication = await previewWorkerPublication(worker, igId);
  if (!publication || publication.generation < sourceGeneration) return null;
  source = publication.source;
  sourceGeneration = publication.generation;
  lastPublicationOrder = Math.max(lastPublicationOrder, publication.generation);
  return publication;
}

async function commitToPreviewWorker(
  source: PreviewSource,
  generation: number,
  mayCommit: () => boolean,
): Promise<{ generation: number; openPaths: string[] } | null> {
  const sw = await activePreviewWorker();
  if (!mayCommit()) return null;
  if (!sw) throw new Error('compatible preview Service Worker is unavailable');
  const post = (order: number) => postPreviewCommit(sw, source, order, mayCommit);
  let acknowledgement = await post(generation);
  if (acknowledgement.cancelled) return null;
  // A hard reload or wall-clock correction can start below the persisted
  // order. Retry above the worker's authenticated pointer; never weaken the
  // worker's stale-write rejection.
  if (acknowledgement.errorCode === 'stale-generation'
    && Number.isSafeInteger(acknowledgement.generation)
    && mayCommit()) {
    acknowledgement = await post((acknowledgement.generation as number) + 1);
    if (acknowledgement.cancelled) return null;
  }
  if (acknowledgement.ok && Number.isSafeInteger(acknowledgement.generation)) {
    if (!Array.isArray(acknowledgement.openPaths)
      || !acknowledgement.openPaths.every(isSafePreviewPath)) {
      throw new Error('preview Service Worker returned invalid open preview paths');
    }
    return {
      generation: acknowledgement.generation as number,
      openPaths: [...new Set(acknowledgement.openPaths as string[])],
    };
  }
  throw new Error(String(acknowledgement.error || 'preview Service Worker rejected publication'));
}

function newCommitId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Send one commit through an acknowledged lifecycle. Neither acceptance nor
 * durable CacheStorage work has a wall-clock deadline. Reposting one immutable
 * commit id is both an idempotent status query and crash recovery: a restarted
 * Worker either replays the durable result or performs the still-missing write. */
export function postPreviewCommit(
  worker: ServiceWorker,
  source: PreviewSource,
  generation: number,
  mayContinue: () => boolean = () => true,
  scheduleRetry: PreviewRetryScheduler = schedulePreviewRetry,
  replacementWorker: () => Promise<ServiceWorker | null> = activePreviewWorker,
): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const commitId = newCommitId();
    const channels = new Set<MessagePort>();
    let currentWorker = worker;
    let settled = false;
    let reacquiring = false;
    let cancelRetry: (() => void) | null = null;
    const cleanup = () => {
      cancelRetry?.();
      cancelRetry = null;
      for (const channel of channels) channel.close();
      channels.clear();
      currentWorker.removeEventListener('statechange', stateChanged);
    };
    const finish = (result: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    function stateChanged() {
      if (currentWorker.state !== 'redundant' || settled) return;
      for (const channel of channels) channel.close();
      channels.clear();
      cancelRetry?.();
      cancelRetry = scheduleRetry(attempt);
    }
    const attempt = () => {
      cancelRetry = null;
      if (settled) return;
      if (!mayContinue()) {
        finish({ cancelled: true });
        return;
      }
      if (currentWorker.state === 'redundant') {
        if (reacquiring) return;
        reacquiring = true;
        void replacementWorker().then((next) => {
          reacquiring = false;
          if (settled) return;
          if (!next) {
            cancelRetry = scheduleRetry(attempt);
            return;
          }
          currentWorker.removeEventListener('statechange', stateChanged);
          currentWorker = next;
          currentWorker.addEventListener('statechange', stateChanged);
          attempt();
        }, () => {
          reacquiring = false;
          if (!settled) cancelRetry = scheduleRetry(attempt);
        });
        return;
      }
      // Only the newest status channel is needed. Reposting the same immutable
      // id attaches this attempt to the same in-flight/durable operation.
      for (const prior of channels) prior.close();
      channels.clear();
      const channel = new MessageChannel();
      const port = channel.port1;
      channels.add(port);
      let accepted = false;
      port.onmessage = (event) => {
        const reply = (event.data || {}) as Record<string, unknown>;
        if (reply.type === 'igpreview:accepted'
          && reply.protocol === PREVIEW_SW_PROTOCOL
          && reply.commitId === commitId) {
          accepted = true;
          return;
        }
        if (!accepted) {
          fail(new Error('preview Service Worker returned a result before accepting publication'));
          return;
        }
        if (reply.type === 'igpreview:pending'
          && reply.protocol === PREVIEW_SW_PROTOCOL
          && reply.commitId === commitId) {
          port.close();
          channels.delete(port);
          return;
        }
        if (reply.type !== 'igpreview:complete'
          || reply.protocol !== PREVIEW_SW_PROTOCOL
          || reply.commitId !== commitId) {
          fail(new Error('preview Service Worker returned an invalid publication result'));
          return;
        }
        finish(reply);
      };
      port.onmessageerror = () => {
        port.close();
        channels.delete(port);
      };
      try {
        currentWorker.postMessage({
          type: 'igpreview:commit',
          protocol: PREVIEW_SW_PROTOCOL,
          commitId,
          generation,
          source,
        }, [channel.port2]);
      } catch (error) {
        if ((currentWorker.state as ServiceWorkerState) === 'redundant') {
          stateChanged();
          return;
        }
        fail(error);
        return;
      }
      cancelRetry = scheduleRetry(attempt);
    };
    currentWorker.addEventListener('statechange', stateChanged);
    attempt();
  });
}

// ---- Immutable publication + live unresolved-output responder -----------------

type RenderOutput = (buildId: string, path: string) => Promise<ContentRef>;
let renderOutput: RenderOutput | null = null;
let source: PreviewSource | null = null;
let sourceGeneration = 0;
let lastPublicationOrder = 0;
let channel: BroadcastChannel | null = null;
let responderWired = false;
const resolvedRefs = new Map<string, ContentRef>();

function descriptor(catalog: OutputCatalog, path: string): OutputDescriptor | null {
  return catalog.outputs.find((output) => output.path === path) ?? null;
}

function resolvedKey(build: PreviewSource, path: string): string {
  return `${build.buildId}\u0000${path}`;
}

async function resolveRef(build: PreviewSource, path: string): Promise<ContentRef | null> {
  const output = descriptor(build.catalog, path);
  if (!output) return null;
  if (output.content) return output.content;
  const known = resolvedRefs.get(resolvedKey(build, path));
  if (known) return known;
  if (!renderOutput) return null;
  const content = await renderOutput(build.buildId, path);
  if (content.mediaType !== output.mediaType || !validContentRef(content)) {
    throw new Error(`renderer returned an invalid output for ${path}`);
  }
  resolvedRefs.set(resolvedKey(build, path), content);
  return content;
}

export function wirePreviewResponder(render: RenderOutput): void {
  renderOutput = render;
  if (responderWired) return;
  responderWired = true;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const message = event.data;
      const port = event.ports[0];
      if (!port) return;
      if (message?.type === 'igpreview:render') void answerRender(message, port);
      if (message?.type === 'igpreview:content') void answerContent(message, port);
    });
  }
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
}

function previewResponder(message: Record<string, unknown>, port: MessagePort) {
  const requestId = message.protocol === PREVIEW_SW_PROTOCOL
    && typeof message.requestId === 'string'
    && message.requestId.length <= 160
    ? message.requestId
    : null;
  return {
    accept() {
      if (!requestId) return;
      port.postMessage({ type: 'igpreview:accepted', protocol: PREVIEW_SW_PROTOCOL, requestId });
    },
    complete(result: Record<string, unknown>, transfer: Transferable[]) {
      port.postMessage(requestId ? {
        type: 'igpreview:complete',
        protocol: PREVIEW_SW_PROTOCOL,
        requestId,
        ok: true,
        ...result,
      } : { ok: true, ...result }, transfer);
    },
    fail(error?: unknown) {
      port.postMessage(requestId ? {
        type: 'igpreview:failed',
        protocol: PREVIEW_SW_PROTOCOL,
        requestId,
        ok: false,
        ...(error == null ? {} : { error: String(error) }),
      } : {
        ok: false,
        ...(error == null ? {} : { error: String(error) }),
      });
    },
  };
}

async function answerRender(message: Record<string, unknown>, port: MessagePort): Promise<void> {
  const responder = previewResponder(message, port);
  try {
    const current = source;
    if (!current
      || message.igId !== current.igId
      || message.buildId !== current.buildId
      || !isSafePreviewPath(message.path)) {
      responder.fail();
      return;
    }
    const output = descriptor(current.catalog, message.path);
    // Ready outputs are never requested from the editor. Refuse them here too,
    // making the SW's OPFS path the only ready-output path.
    if (!output || output.content || !renderOutput) {
      responder.fail();
      return;
    }
    responder.accept();
    // Hot-reload comparison may already have rendered this exact immutable
    // build/path. Resolve through the shared ref seam so serving the refreshed
    // page does not invoke the renderer a second time.
    const content = await resolveRef(current, output.path);
    if (!content) throw new Error('renderer output is unavailable');
    const body = await contentStore.get(content);
    if (!body) throw new Error('rendered output is absent from ContentStore');
    responder.complete({ path: output.path, mediaType: output.mediaType, content, body }, [body]);
  } catch (error) {
    responder.fail(error);
  }
}

async function answerContent(message: Record<string, unknown>, port: MessagePort): Promise<void> {
  const responder = previewResponder(message, port);
  try {
    const current = source;
    if (!current
      || message.igId !== current.igId
      || message.buildId !== current.buildId
      || !isSafePreviewPath(message.path)) {
      responder.fail();
      return;
    }
    const output = descriptor(current.catalog, message.path);
    const requested = message.content;
    if (!output?.content
      || !validContentRef(requested)
      || requested.sha256 !== output.content.sha256
      || requested.byteLength !== output.content.byteLength) {
      responder.fail();
      return;
    }
    responder.accept();
    const body = await contentStore.get(output.content);
    if (!body) throw new Error('output is absent from ContentStore');
    responder.complete({
      path: output.path,
      mediaType: output.mediaType,
      content: output.content,
      body,
    }, [body]);
  } catch (error) {
    responder.fail(error);
  }
}

export async function publishPreviewSource(
  next: PreviewSource,
  generation: number,
  mayCommit: () => boolean = () => true,
): Promise<boolean> {
  const published = validatePreviewSource(next);
  if (!mayCommit()) return false;
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid preview generation');
  const previous = source;
  // UI counters restart on a hard reload. Publication order is deliberately
  // process-independent and has no role in cache/content identity.
  const order = Math.max(Date.now(), generation, lastPublicationOrder + 1);
  const committed = await commitToPreviewWorker(published, order, mayCommit);
  if (committed == null) return false;
  // Once the Service Worker acknowledges the durable pointer, mirror that
  // exact authority locally even if a newer edit revoked the UI lease during
  // the write. Returning false still prevents the superseded generation from
  // changing React state; the next build will advance both authorities again.
  const stillCurrent = mayCommit();
  lastPublicationOrder = committed.generation;
  source = published;
  sourceGeneration = committed.generation;
  if (stillCurrent && previous && previous.igId === published.igId) {
    void refreshOpenPreviews(previous, published, committed.generation, committed.openPaths);
  }
  return stillCurrent;
}

async function refreshOpenPreviews(
  previous: PreviewSource,
  next: PreviewSource,
  generation: number,
  paths: readonly string[],
): Promise<void> {
  if (!channel || source !== next || sourceGeneration !== generation) return;
  for (const path of paths) {
    try {
      const [before, after] = await Promise.all([resolveRef(previous, path), resolveRef(next, path)]);
      if (source !== next || sourceGeneration !== generation) return;
      if (after && previewContentChanged(before, after)) {
        channel.postMessage({ type: 'reload', generator: next.igId, generation, paths: [path] });
      }
    } catch {
      // A removed/non-renderable path remains on its last verified response.
    }
  }
}
