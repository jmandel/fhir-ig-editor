/** Preview publication is a host for the same immutable site outputs used by
 * finalize. It does not own an adapter, an asset manifest, or renderer state. */

import type {
  BuildHandle,
  ContentRef,
  OutputCatalog,
  OutputDescriptor,
  RenderedOutput,
} from '../site/contract';
import { contentStore } from '../storage/contentStore';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
export const PREVIEW_ROOT = `${BASE}preview/`;
const CHANNEL_NAME = 'igpreview';
export const PREVIEW_SW_PROTOCOL = 4;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUTS = 20_000;
const MAX_CATALOG_CHARS = 8 * 1024 * 1024;
const PREVIEW_CLIENT_TTL_MS = 5 * 60_000;

export interface PreviewSource {
  igId: string;
  handle: BuildHandle;
  buildId: string;
  catalog: OutputCatalog;
}

export function previewWorkerScriptPath(base = BASE): string {
  return `${base.replace(/\/?$/, '/')}preview-sw.js?protocol=${PREVIEW_SW_PROTOCOL}`;
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
  if (typeof value.handle !== 'string' || !value.handle || value.handle.length > 512) {
    throw new Error('preview build handle is invalid');
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
    handle: value.handle,
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

export function isCompatiblePreviewWorkerPong(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pong = value as { type?: unknown; protocol?: unknown };
  return pong.type === 'igpreview:pong' && pong.protocol === PREVIEW_SW_PROTOCOL;
}

export async function previewWorkerProtocol(
  worker: Pick<ServiceWorker, 'postMessage'>,
  timeoutMs = 1_500,
): Promise<number | null> {
  const channel = new MessageChannel();
  return new Promise<number | null>((resolve) => {
    let settled = false;
    const finish = (protocol: number | null) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      channel.port1.close();
      resolve(protocol);
    };
    const timer = globalThis.setTimeout(() => finish(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      finish(isCompatiblePreviewWorkerPong(event.data) ? PREVIEW_SW_PROTOCOL : null);
    };
    try {
      worker.postMessage({ type: 'igpreview:ping' }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

export interface PreviewWorkerWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  pingTimeoutMs?: number;
}

export async function waitForCompatiblePreviewWorker(
  registration: Pick<ServiceWorkerRegistration, 'active' | 'update'>,
  desiredScriptUrl: string,
  options: PreviewWorkerWaitOptions = {},
): Promise<ServiceWorker> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const pingTimeoutMs = options.pingTimeoutMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;
  void registration.update().catch(() => undefined);
  while (Date.now() < deadline) {
    const active = registration.active;
    if (
      active?.state === 'activated'
      && active.scriptURL === desiredScriptUrl
      && (await previewWorkerProtocol(active, pingTimeoutMs)) === PREVIEW_SW_PROTOCOL
    ) return active;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
  throw new Error(`preview Service Worker protocol ${PREVIEW_SW_PROTOCOL} did not activate`);
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
    return waitForCompatiblePreviewWorker(swRegistration, desiredScriptUrl, { timeoutMs: 20_000 });
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

async function commitToPreviewWorker(
  source: PreviewSource,
  generation: number,
  mayCommit: () => boolean,
): Promise<number | null> {
  const sw = await activePreviewWorker();
  if (!mayCommit()) return null;
  if (!sw) throw new Error('compatible preview Service Worker is unavailable');
  const post = (order: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = globalThis.setTimeout(() => {
      channel.port1.close();
      reject(new Error('preview Service Worker commit acknowledgement timed out'));
    }, 12_000);
    channel.port1.onmessage = (event) => {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      resolve(event.data || {});
    };
    try {
      sw.postMessage({ type: 'igpreview:commit', generation: order, source }, [channel.port2]);
    } catch (error) {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      reject(error);
    }
  });
  let acknowledgement = await post(generation);
  // A hard reload or wall-clock correction can start below the persisted
  // order. Retry above the worker's authenticated pointer; never weaken the
  // worker's stale-write rejection.
  if (acknowledgement.errorCode === 'stale-generation'
    && Number.isSafeInteger(acknowledgement.generation)
    && mayCommit()) {
    acknowledgement = await post((acknowledgement.generation as number) + 1);
  }
  if (acknowledgement.ok && Number.isSafeInteger(acknowledgement.generation)) {
    return acknowledgement.generation as number;
  }
  throw new Error(String(acknowledgement.error || 'preview Service Worker rejected publication'));
}

// ---- Immutable publication + live unresolved-output responder -----------------

type RenderOutput = (handle: BuildHandle, path: string) => Promise<RenderedOutput>;
let renderOutput: RenderOutput | null = null;
let source: PreviewSource | null = null;
let sourceGeneration = 0;
let lastPublicationOrder = 0;
let channel: BroadcastChannel | null = null;
let responderWired = false;
const resolvedRefs = new Map<string, ContentRef>();

export interface PreviewClientRegistration {
  igId: string;
  path: string;
  lastSeen: number;
}

const openPreviews = new Map<string, PreviewClientRegistration>();

export function registeredPreviewPaths(
  registry: ReadonlyMap<string, PreviewClientRegistration>,
  igId: string,
  now = Date.now(),
): string[] {
  return [...new Set([...registry.values()]
    .filter((client) => client.igId === igId && now - client.lastSeen <= PREVIEW_CLIENT_TTL_MS)
    .map((client) => client.path))];
}

function registerPreviewPath(clientId: string, igId: string, path: string): void {
  const now = Date.now();
  openPreviews.set(clientId, { igId, path, lastSeen: now });
  for (const [id, client] of openPreviews) {
    if (now - client.lastSeen > PREVIEW_CLIENT_TTL_MS) openPreviews.delete(id);
  }
}

function descriptor(catalog: OutputCatalog, path: string): OutputDescriptor | null {
  return catalog.outputs.find((output) => output.path === path) ?? null;
}

function resolvedKey(build: PreviewSource, path: string): string {
  return `${build.handle}\u0000${build.buildId}\u0000${path}`;
}

async function resolveRef(build: PreviewSource, path: string): Promise<ContentRef | null> {
  const output = descriptor(build.catalog, path);
  if (!output) return null;
  if (output.content) return output.content;
  const known = resolvedRefs.get(resolvedKey(build, path));
  if (known) return known;
  if (!renderOutput) return null;
  const rendered = await renderOutput(build.handle, path);
  if (rendered.path !== path || rendered.mediaType !== output.mediaType || !validContentRef(rendered.content)) {
    throw new Error(`renderer returned an invalid output for ${path}`);
  }
  resolvedRefs.set(resolvedKey(build, path), rendered.content);
  return rendered.content;
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
    channel.onmessage = (event) => {
      const message = event.data;
      if (message?.type !== 'hello'
        || typeof message.clientId !== 'string'
        || typeof message.generator !== 'string'
        || !isSafePreviewPath(message.path)) return;
      registerPreviewPath(message.clientId, message.generator, message.path);
      const current = source;
      if (current && current.igId === message.generator) {
        const announcedSha = typeof message.contentSha256 === 'string' && SHA256.test(message.contentSha256)
          ? message.contentSha256
          : null;
        void resolveRef(current, message.path).then((latest) => {
          if (source !== current || !latest || latest.sha256 === announcedSha) return;
          channel?.postMessage({
            type: 'reload',
            generator: current.igId,
            generation: sourceGeneration,
            paths: [message.path],
          });
        }).catch(() => undefined);
      }
    };
    channel.postMessage({ type: 'who' });
  } catch {
    channel = null;
  }
}

async function answerRender(message: Record<string, unknown>, port: MessagePort): Promise<void> {
  try {
    const current = source;
    if (!current
      || message.igId !== current.igId
      || message.handle !== current.handle
      || message.buildId !== current.buildId
      || !isSafePreviewPath(message.path)) {
      port.postMessage({ ok: false });
      return;
    }
    const output = descriptor(current.catalog, message.path);
    // Ready outputs are never requested from the editor. Refuse them here too,
    // making the SW's OPFS path the only ready-output path.
    if (!output || output.content || !renderOutput) {
      port.postMessage({ ok: false });
      return;
    }
    const rendered = await renderOutput(current.handle, output.path);
    if (rendered.path !== output.path || rendered.mediaType !== output.mediaType || !validContentRef(rendered.content)) {
      throw new Error('renderer output does not match catalog');
    }
    resolvedRefs.set(resolvedKey(current, output.path), rendered.content);
    const body = await contentStore.get(rendered.content);
    if (!body) throw new Error('rendered output is absent from ContentStore');
    port.postMessage(
      { ok: true, path: rendered.path, mediaType: rendered.mediaType, content: rendered.content, body },
      [body],
    );
  } catch (error) {
    port.postMessage({ ok: false, error: String(error) });
  }
}

async function answerContent(message: Record<string, unknown>, port: MessagePort): Promise<void> {
  try {
    const current = source;
    if (!current
      || message.igId !== current.igId
      || message.handle !== current.handle
      || message.buildId !== current.buildId
      || !isSafePreviewPath(message.path)) {
      port.postMessage({ ok: false });
      return;
    }
    const output = descriptor(current.catalog, message.path);
    const requested = message.content;
    if (!output?.content
      || !validContentRef(requested)
      || requested.sha256 !== output.content.sha256
      || requested.byteLength !== output.content.byteLength) {
      port.postMessage({ ok: false });
      return;
    }
    const body = await contentStore.get(output.content);
    if (!body) throw new Error('output is absent from ContentStore');
    port.postMessage(
      { ok: true, path: output.path, mediaType: output.mediaType, content: output.content, body },
      [body],
    );
  } catch (error) {
    port.postMessage({ ok: false, error: String(error) });
  }
}

export async function publishPreviewSource(
  next: PreviewSource,
  generation: number,
  mayCommit: () => boolean = () => true,
): Promise<boolean> {
  const published = validatePreviewSource(next);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid preview generation');
  const previous = source;
  // UI counters restart on a hard reload. Publication order is deliberately
  // process-independent and has no role in cache/content identity.
  const order = Math.max(Date.now(), generation, lastPublicationOrder + 1);
  const committedOrder = await commitToPreviewWorker(published, order, mayCommit);
  if (committedOrder == null || !mayCommit()) return false;
  lastPublicationOrder = committedOrder;
  source = published;
  sourceGeneration = committedOrder;
  if (previous && previous.igId === published.igId) {
    void refreshOpenPreviews(previous, published, committedOrder);
  }
  return true;
}

async function refreshOpenPreviews(
  previous: PreviewSource,
  next: PreviewSource,
  generation: number,
): Promise<void> {
  if (!channel || source !== next || sourceGeneration !== generation) return;
  for (const path of registeredPreviewPaths(openPreviews, next.igId)) {
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
