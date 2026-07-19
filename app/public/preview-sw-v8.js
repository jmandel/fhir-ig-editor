import { preparePreviewHtml } from './preview-controls-v8.js';

/* Immutable FHIR IG preview host. The worker persists only an authenticated
 * build/catalog pointer. Canonical output bytes live in the shared ContentStore;
 * HTML controls are added to the response and never alter renderer identity. */

const BASE = new URL('./', self.location).pathname;
const PREVIEW_ROOT = BASE + 'preview/';
const PREVIEW_SW_PROTOCOL = 8;
// Protocol 8 makes commits idempotently recoverable and binds unresolved work
// to one exact WindowClient. Work duration itself is never a failure.
const PREVIEW_STORAGE_SCHEMA = 6;
const STATE_CACHE = `igpreview-state:v${PREVIEW_STORAGE_SCHEMA}`;
const OUTPUT_CACHE_PREFIX = `igpreview-output:v${PREVIEW_STORAGE_SCHEMA}:`;
const LEGACY_STATE_CACHES = ['igpreview-state:v5', 'igpreview-state:v4'];
const LEGACY_OUTPUT_CACHE_PREFIXES = ['igpreview-output:v5:', 'igpreview-output:v4:'];
const OBSOLETE_CACHE_PREFIXES = [
  'igpreview::',
  'igpreview:v2::',
  'igpreview:v3::',
];
const OPFS_DIR = 'fhir-ig-editor-content-v1';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUTS = 20_000;
const MAX_CATALOG_CHARS = 8 * 1024 * 1024;
const OWNER_LIVENESS_POLL_MS = 1_000;

const publications = new Map();
// One record owns each in-flight commit. Completed records retain only their
// small result until the caller's next status poll; their source/catalog
// closure is released. At most one unclaimed completion is kept per IG.
const commitRequests = new Map();
let commitTail = Promise.resolve();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'igpreview:ping') {
    // Protocol-6 clients send no requested protocol and require a protocol-6
    // pong. Current clients request 8 explicitly and verify the executed code.
    const protocol = message.protocol === PREVIEW_SW_PROTOCOL ? PREVIEW_SW_PROTOCOL : 6;
    event.ports[0]?.postMessage({ type: 'igpreview:pong', protocol });
    return;
  }
  if (message.type === 'igpreview:read') {
    const port = event.ports[0];
    const responseProtocol = message.protocol === PREVIEW_SW_PROTOCOL ? PREVIEW_SW_PROTOCOL : 6;
    const read = (async () => {
      if (typeof message.igId !== 'string' || !message.igId || message.igId.length > 256 || /[\\/\0]/.test(message.igId)) {
        throw new Error('invalid preview IG id');
      }
      const publication = publications.get(message.igId) || await readPublication(message.igId);
      if (!publication) {
        port?.postMessage({ ok: false, protocol: responseProtocol, errorCode: 'not-found' });
        return;
      }
      // readPublication re-runs the same validation as commit. Return the
      // declarative pointer only; response bytes remain behind the verified
      // ContentStore/build-cache read path below.
      port?.postMessage({
        ok: true,
        protocol: responseProtocol,
        generation: publication.generation,
        source: publication.source,
      });
    })();
    event.waitUntil(read.catch((error) => {
      port?.postMessage({ ok: false, protocol: responseProtocol, error: String(error) });
    }));
    return;
  }
  if (message.type !== 'igpreview:commit') return;
  const port = event.ports[0];
  const legacyProtocol = message.commitId == null;
  const commitId = legacyProtocol
    ? `legacy-${event.source?.id || 'unknown'}-${String(message.generation)}`
    : message.commitId;
  const ownerClientId = event.source?.url
    && !new URL(event.source.url).pathname.startsWith(PREVIEW_ROOT)
    ? event.source.id
    : null;
  const completePort = (result) => {
    if (legacyProtocol) {
      const { type: _type, commitId: _commitId, ...legacy } = result;
      port?.postMessage({ ...legacy, protocol: 6 });
    } else {
      port?.postMessage(result);
    }
  };
  const retained = typeof commitId === 'string' ? commitRequests.get(commitId) : null;
  if (retained) {
    if (!legacyProtocol) {
      port?.postMessage({
        type: 'igpreview:accepted',
        protocol: PREVIEW_SW_PROTOCOL,
        commitId,
      });
    }
    if (retained.status === 'complete') {
      completePort(retained.result);
      commitRequests.delete(commitId);
    } else if (legacyProtocol) {
      // Deployed protocol-6 clients issue one request and require its terminal
      // reply. Current protocol-8 polling never adds waiters here.
      event.waitUntil(retained.promise.then(completePort));
    } else {
      port?.postMessage({
        type: 'igpreview:pending',
        protocol: PREVIEW_SW_PROTOCOL,
        commitId,
      });
    }
    return;
  }
  const commit = commitTail.then(async () => {
    try {
      const publication = validatePublication(
        message.source,
        message.generation,
        ownerClientId,
        commitId,
        legacyProtocol ? 6 : PREVIEW_SW_PROTOCOL,
      );
      const existing = publications.get(publication.source.igId)
        || await readPublication(publication.source.igId);
      if (existing?.commitId === publication.commitId) {
        if (existing.generation !== publication.generation
          || existing.source.buildId !== publication.source.buildId) {
          throw new Error('preview commit id was reused for different content');
        }
        const openPaths = await livePreviewPaths(publication.source.igId);
        return {
          type: 'igpreview:complete',
          ok: true,
          protocol: PREVIEW_SW_PROTOCOL,
          commitId: publication.commitId,
          generation: existing.generation,
          openPaths,
        };
      }
      if (existing && publication.generation <= existing.generation) {
        return {
          type: 'igpreview:complete',
          ok: false,
          protocol: PREVIEW_SW_PROTOCOL,
          commitId: publication.commitId,
          errorCode: 'stale-generation',
          error: `stale preview generation ${publication.generation}`,
          generation: existing.generation,
        };
      }
      await writePublication(publication);
      publications.set(publication.source.igId, publication);
      await removeMigratedLegacyPublication(existing);
      const openPaths = await livePreviewPaths(publication.source.igId);
      return {
        type: 'igpreview:complete',
        ok: true,
        protocol: PREVIEW_SW_PROTOCOL,
        commitId: publication.commitId,
        generation: publication.generation,
        openPaths,
      };
    } catch (error) {
      return {
        type: 'igpreview:complete',
        ok: false,
        protocol: PREVIEW_SW_PROTOCOL,
        commitId: typeof commitId === 'string' ? commitId : null,
        error: String(error),
      };
    }
  });
  const commitRecord = {
    status: 'pending',
    promise: commit,
    igId: typeof message.source?.igId === 'string' ? message.source.igId : null,
  };
  if (typeof commitId === 'string') commitRequests.set(commitId, commitRecord);
  commitTail = commit.catch(() => undefined);
  if (!legacyProtocol) {
    port?.postMessage({
      type: 'igpreview:accepted',
      protocol: PREVIEW_SW_PROTOCOL,
      commitId,
    });
  }
  // The acknowledgement above is independent of potentially slow durable
  // work. Exactly this initial port may await completion; duplicate/status
  // requests return pending immediately and never add another waiter.
  event.waitUntil(commit.then(async (result) => {
    completePort(result);
    if (legacyProtocol) {
      if (commitRequests.get(commitId) === commitRecord) commitRequests.delete(commitId);
    } else if (commitRequests.get(commitId) === commitRecord) {
      for (const [priorId, prior] of commitRequests) {
        if (priorId !== commitId && prior.status === 'complete' && prior.igId === commitRecord.igId) {
          commitRequests.delete(priorId);
        }
      }
      // Replace the promise-bearing record so a finished operation cannot
      // retain its source/catalog closure while waiting for one status poll.
      commitRequests.set(commitId, { status: 'complete', result, igId: commitRecord.igId });
    }
    if (result.ok) await pruneObsoleteCaches();
  }).catch(() => undefined));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREVIEW_ROOT)) return;
  if (event.request.method !== 'GET') return;
  event.respondWith(handlePreview(url));
});

function safePath(path) {
  if (typeof path !== 'string' || !path || path.length > 2048) return false;
  if (path.startsWith('/') || path.includes('\\') || /[?#\0]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function safeRef(value) {
  return !!value
    && typeof value === 'object'
    && typeof value.sha256 === 'string'
    && SHA256.test(value.sha256)
    && Number.isSafeInteger(value.byteLength)
    && value.byteLength >= 0
    && (value.mediaType == null || (typeof value.mediaType === 'string' && !/[\r\n]/.test(value.mediaType)));
}

export function validatePublication(source, generation, ownerClientId, commitId, responderProtocol = PREVIEW_SW_PROTOCOL) {
  if (!source || typeof source !== 'object') throw new Error('preview source is required');
  if (typeof source.igId !== 'string' || !source.igId || source.igId.length > 256 || /[\\/\0]/.test(source.igId)) {
    throw new Error('invalid preview IG id');
  }
  if (typeof source.buildId !== 'string' || !source.buildId || source.buildId.length > 512) {
    throw new Error('invalid preview build id');
  }
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid preview generation');
  if (typeof ownerClientId !== 'string' || !ownerClientId || ownerClientId.length > 512) {
    throw new Error('preview publication has no valid WindowClient owner');
  }
  if (typeof commitId !== 'string' || !/^[A-Za-z0-9_-]{8,160}$/.test(commitId)) {
    throw new Error('preview publication has no valid commit id');
  }
  if (responderProtocol !== 6 && responderProtocol !== PREVIEW_SW_PROTOCOL) {
    throw new Error('preview publication has an unsupported responder protocol');
  }
  if (!source.catalog || source.catalog.buildId !== source.buildId || !Array.isArray(source.catalog.outputs)) {
    throw new Error('preview catalog does not belong to its build');
  }
  if (source.catalog.outputs.length > MAX_OUTPUTS) throw new Error('preview catalog is too large');
  const paths = new Set();
  let catalogChars = 0;
  for (const output of source.catalog.outputs) {
    if (!output || !safePath(output.path) || paths.has(output.path)) {
      throw new Error(`unsafe or duplicate preview path ${String(output?.path)}`);
    }
    paths.add(output.path);
    if (!['page', 'asset', 'auxiliary'].includes(output.kind)) throw new Error('invalid output kind');
    if (typeof output.mediaType !== 'string' || !output.mediaType || output.mediaType.length > 256 || /[\r\n]/.test(output.mediaType)) {
      throw new Error('invalid output media type');
    }
    catalogChars += output.path.length + output.mediaType.length;
    if (catalogChars > MAX_CATALOG_CHARS) throw new Error('preview catalog metadata is too large');
    if (output.content != null && !safeRef(output.content)) throw new Error('invalid output ContentRef');
    if (output.content?.mediaType && output.content.mediaType !== output.mediaType) {
      throw new Error('output ContentRef media type disagrees');
    }
  }
  // Copy only the contract fields. This keeps the persisted pointer declarative
  // even if an untrusted message carries prototypes or unrelated values.
  return {
    generation,
    ownerClientId,
    commitId,
    responderProtocol,
    source: {
      igId: source.igId,
      buildId: source.buildId,
      catalog: {
        buildId: source.catalog.buildId,
        outputs: source.catalog.outputs.map((output) => ({
          path: output.path,
          kind: output.kind,
          mediaType: output.mediaType,
          ...(output.content ? { content: {
            sha256: output.content.sha256,
            byteLength: output.content.byteLength,
            ...(output.content.mediaType ? { mediaType: output.content.mediaType } : {}),
          } } : {}),
        })),
      },
    },
  };
}

function stateRequest(igId) {
  return new Request(new URL(`__igpreview_state__/${encodeURIComponent(igId)}`, self.registration.scope));
}

async function writePublication(publication) {
  const cache = await caches.open(STATE_CACHE);
  await cache.put(stateRequest(publication.source.igId), new Response(JSON.stringify(publication), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  }));
}

async function readPublication(igId) {
  let available;
  try {
    available = new Set(await caches.keys());
  } catch {
    return null;
  }
  const candidates = [STATE_CACHE, ...LEGACY_STATE_CACHES]
    .filter((name) => available.has(name));
  for (const cacheName of candidates) {
    try {
      const cache = await caches.open(cacheName);
      const response = await cache.match(stateRequest(igId));
      if (!response) continue;
      const stored = await response.json();
      const legacy = cacheName !== STATE_CACHE;
      const ownerClientId = legacy && (typeof stored.ownerClientId !== 'string' || !stored.ownerClientId)
        ? 'legacy-cache-without-owner'
        : stored.ownerClientId;
      const commitId = legacy && (typeof stored.commitId !== 'string' || !stored.commitId)
        ? `legacy-v${cacheName.endsWith('v5') ? '5' : '4'}-${stored.generation}`
        : stored.commitId;
      const publication = validatePublication(
        stored.source,
        stored.generation,
        ownerClientId,
        commitId,
        legacy ? 6 : stored.responderProtocol,
      );
      // Schema 4 had no single responder owner. Its ready ContentRefs and
      // authenticated rendered cache remain useful, but unresolved work must
      // wait for a fresh publication rather than selecting an arbitrary tab.
      if (legacy && ownerClientId === 'legacy-cache-without-owner') publication.ownerClientId = null;
      if (legacy) publication.legacyStateCache = cacheName;
      publications.set(igId, publication);
      return publication;
    } catch {
      // An invalid newer pointer cannot make a separately validated older
      // verified publication disappear during a rolling deployment.
    }
  }
  return null;
}

async function removeMigratedLegacyPublication(publication) {
  if (!publication?.legacyStateCache || !LEGACY_STATE_CACHES.includes(publication.legacyStateCache)) return;
  try {
    const state = await caches.open(publication.legacyStateCache);
    await state.delete(stateRequest(publication.source.igId));
    const schema = publication.legacyStateCache.endsWith('v5') ? 'v5' : 'v4';
    await caches.delete(`igpreview-output:${schema}:${encodeURIComponent(publication.source.buildId)}`);
  } catch {
    // The schema-6 pointer is already durable. Stale compatible data is safe
    // to retain and will be retried on a later same-IG publication.
  }
}

function parsePreviewPath(pathname) {
  const rest = pathname.slice(PREVIEW_ROOT.length);
  const slash = rest.indexOf('/');
  if (slash < 1) return null;
  try {
    const igId = decodeURIComponent(rest.slice(0, slash));
    let path = decodeURIComponent(rest.slice(slash + 1));
    if (path.endsWith('/')) path += 'index.html';
    if (!igId || !safePath(path)) return null;
    return { igId, path };
  } catch {
    return null;
  }
}

/** Derive the current preview pages from the Service Worker's controlled
 * WindowClients. There is no registration protocol to drop or replay: closed
 * documents are absent, and duplicate tabs collapse to one render path. */
export function previewPathsForClients(clients, igId, origin) {
  const paths = new Set();
  for (const client of clients) {
    try {
      const url = new URL(client.url);
      if (url.origin !== origin || !url.pathname.startsWith(PREVIEW_ROOT)) continue;
      const parsed = parsePreviewPath(url.pathname);
      if (parsed?.igId === igId) paths.add(parsed.path);
    } catch {
      // A malformed or concurrently destroyed client is not a live preview.
    }
  }
  return [...paths].sort();
}

async function livePreviewPaths(igId) {
  try {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: false });
    return previewPathsForClients(windows, igId, self.location.origin);
  } catch {
    // Open-path discovery is a hot-reload optimization. It must never turn an
    // already durable publication into a reported commit failure.
    return [];
  }
}

async function handlePreview(url) {
  const parsed = parsePreviewPath(url.pathname);
  if (!parsed) return fallbackResponse(null, url);
  const publication = publications.get(parsed.igId) || await readPublication(parsed.igId);
  if (!publication) return fallbackResponse(parsed, url);
  const output = publication.source.catalog.outputs.find((candidate) => candidate.path === parsed.path);
  if (!output) return unavailableOutput(parsed, null);

  // Complete outputs bypass the editor and survive both editor and worker exits.
  if (output.content) {
    const bytes = await readContent(output.content);
    if (bytes) return outputResponse(bytes, output, parsed, publication.generation, 'content-store', output.content);
    const cached = await readRenderedCache(publication.source.buildId, parsed.path, output);
    if (cached) return outputResponse(cached.bytes, output, parsed, publication.generation, 'build-cache', cached.ref);
    const transferred = await requestFromEditor(publication, output, 'igpreview:content');
    if (transferred?.bytes) {
      await writeRenderedCache(publication.source.buildId, parsed.path, output, transferred.ref, transferred.bytes);
      return outputResponse(transferred.bytes, output, parsed, publication.generation, 'content-transfer', transferred.ref);
    }
    return unavailableOutput(parsed, output, transferred?.error);
  }

  // A previous successful render of this immutable build is reusable after a
  // Service Worker restart. The cached body is canonical and re-verified.
  const cached = await readRenderedCache(publication.source.buildId, parsed.path, output);
  if (cached) return outputResponse(cached.bytes, output, parsed, publication.generation, 'build-cache', cached.ref);

  // Assets and auxiliary files must be complete in the catalog. Only an
  // explicitly unresolved page is allowed to invoke its retained Build.
  if (output.kind !== 'page') return unavailableOutput(parsed, output);
  const rendered = await requestFromEditor(publication, output, 'igpreview:render');
  if (rendered?.bytes) {
    await writeRenderedCache(publication.source.buildId, parsed.path, output, rendered.ref, rendered.bytes);
    return outputResponse(rendered.bytes, output, parsed, publication.generation, 'render', rendered.ref);
  }
  return unavailableOutput(parsed, output, rendered?.error);
}

async function contentDirectory() {
  try {
    const root = await self.navigator.storage.getDirectory();
    return await root.getDirectoryHandle(OPFS_DIR, { create: false });
  } catch {
    return null;
  }
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readContent(ref) {
  if (!safeRef(ref)) return null;
  const dir = await contentDirectory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(ref.sha256);
    const bytes = await (await handle.getFile()).arrayBuffer();
    if (bytes.byteLength !== ref.byteLength || await sha256Hex(bytes) !== ref.sha256) return null;
    return bytes;
  } catch {
    return null;
  }
}

function buildCacheName(buildId) {
  return OUTPUT_CACHE_PREFIX + encodeURIComponent(buildId);
}

function outputCacheRequest(path) {
  return new Request(new URL(`__igpreview_output__/${encodeURIComponent(path)}`, self.registration.scope));
}

async function readRenderedCache(buildId, path, output) {
  const names = [
    buildCacheName(buildId),
    ...LEGACY_OUTPUT_CACHE_PREFIXES.map((prefix) => prefix + encodeURIComponent(buildId)),
  ];
  let available;
  try {
    available = new Set(await caches.keys());
  } catch {
    return null;
  }
  for (const name of names) {
    if (!available.has(name)) continue;
    try {
      const cache = await caches.open(name);
      const response = await cache.match(outputCacheRequest(path));
      if (!response) continue;
      const sha256 = response.headers.get('X-Content-Sha256');
      const declaredLength = Number(response.headers.get('X-Content-Length'));
      const bytes = await response.arrayBuffer();
      if (!SHA256.test(sha256 || '') || declaredLength !== bytes.byteLength) continue;
      if (response.headers.get('Content-Type') !== output.mediaType) continue;
      if (await sha256Hex(bytes) === sha256) {
        return { bytes, ref: { sha256, byteLength: declaredLength, mediaType: output.mediaType } };
      }
    } catch {
      // Try the next independently authenticated cache generation.
    }
  }
  return null;
}

async function writeRenderedCache(buildId, path, output, ref, bytes) {
  try {
    const cache = await caches.open(buildCacheName(buildId));
    await cache.put(outputCacheRequest(path), new Response(bytes.slice(0), { headers: {
      'Content-Type': output.mediaType,
      'X-Content-Sha256': ref.sha256,
      'X-Content-Length': String(ref.byteLength),
    } }));
  } catch {
    // OPFS remains authoritative; output-cache publication is best effort.
  }
}

export async function requestFromEditor(publication, output, type, policy = {}) {
  if (typeof publication.ownerClientId !== 'string' || !publication.ownerClientId) {
    return { error: 'this verified preview predates exact editor ownership; rebuild to render unresolved pages' };
  }
  let owner;
  try {
    owner = await self.clients.get(publication.ownerClientId);
  } catch {
    return { error: 'the editor owning this preview is unavailable' };
  }
  if (!owner) return { error: 'the editor owning this preview is no longer open' };
  const pollMs = policy.pollMs ?? OWNER_LIVENESS_POLL_MS;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let accepted = false;
    let processing = false;
    let livenessPoll = null;
    const channel = new MessageChannel();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (livenessPoll != null) clearTimeout(livenessPoll);
      channel.port1.close();
      resolve(value);
    };
    const pollLiveness = async () => {
      if (settled) return;
      try {
        const liveOwner = await self.clients.get(publication.ownerClientId);
        if (!liveOwner && !processing) {
          finish({ error: 'the editor owning this preview closed during rendering' });
          return;
        }
      } catch {
        // A failed liveness observation is not evidence that valid work failed.
      }
      if (!settled && !processing) {
        livenessPoll = setTimeout(pollLiveness, pollMs);
      }
    };
    channel.port1.onmessage = async (event) => {
      const reply = event.data;
      if (settled) return;
      if (publication.responderProtocol === 6) {
        if (reply?.ok
          && reply.path === output.path
          && reply.mediaType === output.mediaType
          && safeRef(reply.content)
          && (!output.content
            || (reply.content.sha256 === output.content.sha256
              && reply.content.byteLength === output.content.byteLength))
          && reply.body instanceof ArrayBuffer
          && reply.body.byteLength === reply.content.byteLength) {
          processing = true;
          if (await sha256Hex(reply.body) === reply.content.sha256) {
            finish({ ref: reply.content, bytes: reply.body });
            return;
          }
        }
        processing = false;
        finish(typeof reply?.error === 'string' && reply.error.trim()
          ? { error: reply.error.trim() }
          : null);
        return;
      }
      if (reply?.type === 'igpreview:accepted'
        && reply.protocol === PREVIEW_SW_PROTOCOL
        && reply.requestId === requestId) {
        accepted = true;
        return;
      }
      if (reply?.type === 'igpreview:complete'
        && reply.protocol === PREVIEW_SW_PROTOCOL
        && reply.requestId === requestId
        && accepted
        && reply.ok
        && reply.path === output.path
        && reply.mediaType === output.mediaType
        && safeRef(reply.content)
        && (!output.content
          || (reply.content.sha256 === output.content.sha256
            && reply.content.byteLength === output.content.byteLength))
        && reply.body instanceof ArrayBuffer
        && reply.body.byteLength === reply.content.byteLength) {
        processing = true;
        if (await sha256Hex(reply.body) === reply.content.sha256) {
          finish({ ref: reply.content, bytes: reply.body });
          return;
        }
      }
      processing = false;
      finish(typeof reply?.error === 'string' && reply.error.trim()
        ? { error: reply.error.trim() }
        : null);
    };
    channel.port1.onmessageerror = () => {
      finish({ error: 'the editor preview response could not be read' });
    };
    livenessPoll = setTimeout(pollLiveness, pollMs);
    try {
      owner.postMessage({
        type,
        protocol: PREVIEW_SW_PROTOCOL,
        requestId,
        igId: publication.source.igId,
        buildId: publication.source.buildId,
        path: output.path,
        ...(output.content ? { content: output.content } : {}),
      }, [channel.port2]);
    } catch {
      finish({ error: 'the editor preview owner disappeared before accepting' });
    }
  });
}

function outputResponse(bytes, output, parsed, generation, source, content) {
  let body = bytes;
  if (output.kind === 'page' && /(?:text\/html|application\/xhtml\+xml)/i.test(output.mediaType)) {
    const html = new TextDecoder().decode(bytes);
    body = new TextEncoder().encode(preparePreviewHtml(
      html,
      PREVIEW_ROOT,
      parsed.igId,
      parsed.path,
      generation,
      content.sha256,
    ));
  }
  return new Response(body, { status: 200, headers: {
    'Content-Type': output.mediaType,
    'Cache-Control': 'no-store',
    'X-IGPreview-Source': source,
    'X-Content-Sha256': content.sha256,
  } });
}

function unavailableOutput(parsed, output, error) {
  if (output?.kind === 'page' || (!output && /(?:\.html|\/$)/i.test(parsed.path))) {
    return fallbackResponse(
      parsed,
      new URL(`${PREVIEW_ROOT}${encodeURIComponent(parsed.igId)}/${parsed.path}`, self.location),
      error,
    );
  }
  return new Response('output unavailable', { status: 404, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-IGPreview-Source': 'unavailable',
  } });
}

function fallbackResponse(parsed, url, error) {
  const requested = escapeHtml(parsed?.path || url.pathname);
  const details = typeof error === 'string' && error.trim()
    ? `<details><summary>Why rendering failed</summary><pre>${escapeHtml(error.trim().slice(0, 4_000))}</pre></details>`
    : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview unavailable</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}.card{max-width:34rem;padding:2.5rem;text-align:center}p{color:#94a3b8}a{color:#7dd3fc}button{font:inherit;padding:.6rem 1rem;border:1px solid #38bdf8;border-radius:.4rem;background:#0c4a6e;color:#e0f2fe;cursor:pointer}details{text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#fca5a5}</style></head><body><div class="card" data-igpreview-fallback><h1>Preview output unavailable</h1><p>No verified output can currently serve <code>${requested}</code>.</p>${details}<p>This response is not cached. Retry after the editor finishes, or return to the editor for details.</p><p><button type="button" onclick="location.reload()">Retry preview</button></p><p><a href="${BASE}">Open the FHIR IG Editor</a></p></div></body></html>`;
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-IGPreview-Source': 'fallback',
  } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function pruneObsoleteCaches() {
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => OBSOLETE_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => caches.delete(name)));
}
