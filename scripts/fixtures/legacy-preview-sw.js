import { preparePreviewHtml } from './preview-controls.js';

/* Immutable FHIR IG preview host. The worker persists only an authenticated
 * build/catalog pointer. Canonical output bytes live in the shared ContentStore;
 * HTML controls are added to the response and never alter renderer identity. */

const BASE = new URL('./', self.location).pathname;
const PREVIEW_ROOT = BASE + 'preview/';
const PREVIEW_SW_PROTOCOL = 6;
// Protocol 6 removes the redundant build handle: buildId is the only lifecycle
// address. Older verified pointers are accepted and normalized on next commit.
const PREVIEW_STORAGE_SCHEMA = 4;
const STATE_CACHE = `igpreview-state:v${PREVIEW_STORAGE_SCHEMA}`;
const OUTPUT_CACHE_PREFIX = `igpreview-output:v${PREVIEW_STORAGE_SCHEMA}:`;
const LEGACY_CACHE_PREFIXES = ['igpreview::', 'igpreview:v2::', 'igpreview:v3::'];
const OPFS_DIR = 'fhir-ig-editor-content-v1';
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUTS = 20_000;
const MAX_CATALOG_CHARS = 8 * 1024 * 1024;

const publications = new Map();
let commitTail = Promise.resolve();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'igpreview:ping') {
    event.ports[0]?.postMessage({ type: 'igpreview:pong', protocol: PREVIEW_SW_PROTOCOL });
    return;
  }
  if (message.type === 'igpreview:read') {
    const port = event.ports[0];
    const read = (async () => {
      if (typeof message.igId !== 'string' || !message.igId || message.igId.length > 256 || /[\\/\0]/.test(message.igId)) {
        throw new Error('invalid preview IG id');
      }
      const publication = publications.get(message.igId) || await readPublication(message.igId);
      if (!publication) {
        port?.postMessage({ ok: false, protocol: PREVIEW_SW_PROTOCOL, errorCode: 'not-found' });
        return;
      }
      // readPublication re-runs the same validation as commit. Return the
      // declarative pointer only; response bytes remain behind the verified
      // ContentStore/build-cache read path below.
      port?.postMessage({
        ok: true,
        protocol: PREVIEW_SW_PROTOCOL,
        generation: publication.generation,
        source: publication.source,
      });
    })();
    event.waitUntil(read.catch((error) => {
      port?.postMessage({ ok: false, protocol: PREVIEW_SW_PROTOCOL, error: String(error) });
    }));
    return;
  }
  if (message.type !== 'igpreview:commit') return;
  const port = event.ports[0];
  const commit = commitTail.then(async () => {
    try {
      const publication = validatePublication(message.source, message.generation);
      const existing = publications.get(publication.source.igId)
        || await readPublication(publication.source.igId);
      if (existing && publication.generation <= existing.generation) {
        port?.postMessage({
          ok: false,
          protocol: PREVIEW_SW_PROTOCOL,
          errorCode: 'stale-generation',
          error: `stale preview generation ${publication.generation}`,
          generation: existing.generation,
        });
        return;
      }
      await writePublication(publication);
      publications.set(publication.source.igId, publication);
      port?.postMessage({ ok: true, protocol: PREVIEW_SW_PROTOCOL, generation: publication.generation });
    } catch (error) {
      port?.postMessage({ ok: false, protocol: PREVIEW_SW_PROTOCOL, error: String(error) });
    }
  });
  commitTail = commit.catch(() => undefined);
  // The acknowledgement above is independent of potentially slow cache
  // enumeration; lifetime extension still makes old generation caches go away.
  event.waitUntil(commit.then(() => pruneLegacyCaches()).catch(() => undefined));
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

function validatePublication(source, generation) {
  if (!source || typeof source !== 'object') throw new Error('preview source is required');
  if (typeof source.igId !== 'string' || !source.igId || source.igId.length > 256 || /[\\/\0]/.test(source.igId)) {
    throw new Error('invalid preview IG id');
  }
  if (typeof source.buildId !== 'string' || !source.buildId || source.buildId.length > 512) {
    throw new Error('invalid preview build id');
  }
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('invalid preview generation');
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
  try {
    const cache = await caches.open(STATE_CACHE);
    const response = await cache.match(stateRequest(igId));
    if (!response) return null;
    const stored = await response.json();
    const publication = validatePublication(stored.source, stored.generation);
    publications.set(igId, publication);
    return publication;
  } catch {
    return null;
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
    if (transferred) {
      await writeRenderedCache(publication.source.buildId, parsed.path, output, transferred.ref, transferred.bytes);
      return outputResponse(transferred.bytes, output, parsed, publication.generation, 'content-transfer', transferred.ref);
    }
    return unavailableOutput(parsed, output);
  }

  // A previous successful render of this immutable build is reusable after a
  // Service Worker restart. The cached body is canonical and re-verified.
  const cached = await readRenderedCache(publication.source.buildId, parsed.path, output);
  if (cached) return outputResponse(cached.bytes, output, parsed, publication.generation, 'build-cache', cached.ref);

  // Assets and auxiliary files must be complete in the catalog. Only an
  // explicitly unresolved page is allowed to invoke its retained Build.
  if (output.kind !== 'page') return unavailableOutput(parsed, output);
  const rendered = await requestFromEditor(publication, output, 'igpreview:render');
  if (rendered) {
    await writeRenderedCache(publication.source.buildId, parsed.path, output, rendered.ref, rendered.bytes);
    return outputResponse(rendered.bytes, output, parsed, publication.generation, 'render', rendered.ref);
  }
  return unavailableOutput(parsed, output);
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
  try {
    const cache = await caches.open(buildCacheName(buildId));
    const response = await cache.match(outputCacheRequest(path));
    if (!response) return null;
    const sha256 = response.headers.get('X-Content-Sha256');
    const declaredLength = Number(response.headers.get('X-Content-Length'));
    const bytes = await response.arrayBuffer();
    if (!SHA256.test(sha256 || '') || declaredLength !== bytes.byteLength) return null;
    if (response.headers.get('Content-Type') !== output.mediaType) return null;
    return await sha256Hex(bytes) === sha256
      ? { bytes, ref: { sha256, byteLength: declaredLength, mediaType: output.mediaType } }
      : null;
  } catch {
    return null;
  }
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

async function requestFromEditor(publication, output, type) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const editors = clients.filter((client) => !new URL(client.url).pathname.startsWith(PREVIEW_ROOT));
  if (!editors.length) return null;
  return new Promise((resolve) => {
    let settled = false;
    let pending = editors.length;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8_000);
    for (const client of editors) {
      const channel = new MessageChannel();
      channel.port1.onmessage = async (event) => {
        const reply = event.data;
        if (reply?.ok
          && reply.path === output.path
          && reply.mediaType === output.mediaType
          && safeRef(reply.content)
          && (!output.content
            || (reply.content.sha256 === output.content.sha256
              && reply.content.byteLength === output.content.byteLength))
          && reply.body instanceof ArrayBuffer
          && reply.body.byteLength === reply.content.byteLength
          && await sha256Hex(reply.body) === reply.content.sha256) {
          finish({ ref: reply.content, bytes: reply.body });
          return;
        }
        pending--;
        if (pending <= 0) finish(null);
      };
      client.postMessage({
        type,
        igId: publication.source.igId,
        buildId: publication.source.buildId,
        path: output.path,
        ...(output.content ? { content: output.content } : {}),
      }, [channel.port2]);
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

function unavailableOutput(parsed, output) {
  if (output?.kind === 'page' || (!output && /(?:\.html|\/$)/i.test(parsed.path))) {
    return fallbackResponse(parsed, new URL(`${PREVIEW_ROOT}${encodeURIComponent(parsed.igId)}/${parsed.path}`, self.location));
  }
  return new Response('output unavailable', { status: 404, headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-IGPreview-Source': 'unavailable',
  } });
}

function fallbackResponse(parsed, url) {
  const requested = escapeHtml(parsed?.path || url.pathname);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview unavailable</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}.card{max-width:34rem;padding:2.5rem;text-align:center}p{color:#94a3b8}a{color:#7dd3fc}</style></head><body><div class="card" data-igpreview-fallback><h1>Preview output unavailable</h1><p>No verified output can currently serve <code>${requested}</code>.</p><p><a href="${BASE}">Open the FHIR IG Editor</a></p></div></body></html>`;
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-IGPreview-Source': 'fallback',
  } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

async function pruneLegacyCaches() {
  const names = await caches.keys();
  await Promise.all(names
    .filter((name) => LEGACY_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map((name) => caches.delete(name)));
}
