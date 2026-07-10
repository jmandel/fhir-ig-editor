/* FHIR IG Editor — preview Service Worker (task #37).
 *
 * Serves the rendered IG site as a REAL site under `<base>preview/<generator>/...`
 * so the browser's URL bar, links, back/forward, and F5 behave like a real site —
 * because to the browser it IS one. This file is plain JS (no bundler): Vite copies
 * public/ verbatim, so it ships at `<base>preview-sw.js`.
 *
 * SCOPE DISCIPLINE (foolproofing): this SW registers with scope `<base>preview/`
 * and its fetch handler answers ONLY requests whose pathname is under that prefix.
 * Every other request (the editor app shell, /pkg/ wasm, /data/ bundles incl. the
 * %23-encoded .tgz URLs, /src) falls straight through to the network — the SW must
 * NEVER intercept the editor's own traffic. The scope guard is asserted below.
 *
 * ANSWER LADDER (foolproof, three tiers) for a /preview/ request:
 *   (a) Cache API hit  -> return cached response (survives editor-tab close + SW restart).
 *   (b) Live render    -> ask an open editor tab (postMessage over a MessageChannel)
 *                         to render the page / produce the asset; cache write-through; return.
 *   (c) Neither        -> a friendly, self-contained fallback page (never a browser error).
 *
 * LIFECYCLE: skipWaiting() + clients.claim() so the newest SW controls /preview/
 * immediately. Safe because the SW governs ONLY /preview/.
 */

// The registration scope path (e.g. "/fhir-ig-editor/preview/"). Derived from this
// script's own URL: the SW script sits at "<base>preview-sw.js", so its directory IS
// the app base, and the preview root is "<base>preview/".
const BASE = new URL('./', self.location).pathname; // e.g. /fhir-ig-editor/
const PREVIEW_ROOT = BASE + 'preview/'; // e.g. /fhir-ig-editor/preview/
// Must match PREVIEW_SW_PROTOCOL in previewWindow.ts. The editor registers this
// script with `?protocol=3` and refuses an older active worker before publishing.
const PREVIEW_SW_PROTOCOL = 3;

// Cache naming: one cache per compile generation. Keep the last two generations so a
// just-bumped generation (still lazily refilling) can fall back to the previous
// complete one for a page it has not re-rendered yet.
const CACHE_PREFIX = `igpreview:v${PREVIEW_SW_PROTOCOL}::`;
const LEGACY_CACHE_PREFIXES = ['igpreview::', 'igpreview:v2::'];
const KEEP_GENERATIONS = 2;

// The editor tells us the current compile generation via a control message; new
// fetches cache under it. Starts at 0 (unknown) — any editor announcement wins.
let currentGeneration = 0;

// The COMPLETE static asset set for the current generation, pushed by the editor in
// one message (igpreview:provisionAssets). Serving assets from here means ZERO
// per-asset round-trips to the editor's (contended) main thread — the fix for slow
// navigation. Shape: { generation, igId, pagePrefix, assets: Map<key, {mime, bytes}> }.
// Held in memory: if the SW is idle-killed this resets to null and the first asset
// request self-heals by asking the editor to re-provision (see requestReprovision).
let provisioned = null;
let lastReprovisionAsk = 0;

self.addEventListener('install', () => {
  // Take over as the active SW without waiting for old clients to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Activation gates the editor's protocol handshake, so keep it independent
  // of potentially slow Cache Storage enumeration on returning mobile devices.
  // The first generation commit performs the same best-effort pruning.
  event.waitUntil(self.clients.claim());
});

// Control channel from the editor tab: generation bumps + cache pruning.
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'igpreview:commitGeneration' && Array.isArray(msg.assets)) {
    // Atomically install the generation pointer and the asset manifest, then ACK
    // the editor. Until this task completes fetches continue to see the previous
    // pair; they can never observe a new generation with old assets.
    try {
      const assets = new Map();
      for (const asset of msg.assets) {
        assets.set(asset.key, { mime: asset.mime, bytes: asset.bytes });
      }
      provisioned = msg.hasAssetManifest
        ? {
            generation: msg.generation,
            igId: msg.igId,
            pagePrefix: msg.pagePrefix || '',
            assets,
          }
        : null;
      // A browser reload can restart the app's UI counter below a generation
      // retained by the SW, so an acknowledged commit REPLACES rather than only
      // monotonically increases this pointer.
      currentGeneration = msg.generation;
      // The generation/asset pair is installed synchronously. ACK it before
      // Cache Storage pruning: mobile browsers can take seconds to enumerate or
      // delete old caches, but that maintenance is not part of commit atomicity.
      event.ports[0]?.postMessage({
        ok: true,
        generation: currentGeneration,
        protocol: PREVIEW_SW_PROTOCOL,
      });
      event.waitUntil(pruneCaches().catch(() => undefined));
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: String(error), protocol: PREVIEW_SW_PROTOCOL });
    }
    return;
  }
  if (msg.type === 'igpreview:setGeneration' && typeof msg.generation === 'number') {
    if (msg.generation > currentGeneration) currentGeneration = msg.generation;
    event.waitUntil(pruneCaches());
  }
  if (msg.type === 'igpreview:ping') {
    // Reply so the editor can confirm the SW is active + which generation it holds.
    event.ports[0]?.postMessage({
      type: 'igpreview:pong',
      protocol: PREVIEW_SW_PROTOCOL,
      generation: currentGeneration,
    });
  }
  if (msg.type === 'igpreview:provisionAssets' && Array.isArray(msg.assets)) {
    // A re-provision is fire-and-forget. Do not let an older request that was
    // delayed in the client overwrite the manifest installed by a newer atomic
    // generation commit. Zero means this worker was restarted and lost its
    // in-memory generation pointer, in which case the current editor restores it.
    if (typeof msg.generation !== 'number') return;
    if (currentGeneration !== 0 && msg.generation !== currentGeneration) return;
    if (currentGeneration === 0) currentGeneration = msg.generation;
    // Wholesale-replace the asset set for this generation (deterministic, not lazy).
    const assets = new Map();
    for (const a of msg.assets) assets.set(a.key, { mime: a.mime, bytes: a.bytes });
    provisioned = {
      generation: msg.generation,
      igId: msg.igId,
      pagePrefix: msg.pagePrefix || '',
      assets,
    };
  }
});

// ---- provisioned asset serving (no editor round-trip) --------------------------

/** Resolve a request path (the part after `preview/<igId>/`) to a provisioned asset,
 *  mirroring stockAdapter.assetBytes' key normalization EXACTLY so the two agree:
 *  strip leading `../`, strip the page-dir prefix (e.g. `en/`), then try the name,
 *  the `assets/`-stripped name, the `assets/`-prefixed name, and the basename. */
function provisionedAsset(igId, pathAfterIg) {
  const p = provisioned;
  if (!p || p.igId !== igId) return null;
  let n = pathAfterIg.replace(/^(?:\.\.\/)+/, '');
  if (p.pagePrefix && n.startsWith(p.pagePrefix)) n = n.slice(p.pagePrefix.length);
  const key = n.replace(/^assets\//, '');
  const base = key.slice(key.lastIndexOf('/') + 1);
  return (
    p.assets.get(n) || p.assets.get(key) || p.assets.get('assets/' + key) || p.assets.get(base) || null
  );
}

function assetResponse(asset) {
  return new Response(asset.bytes, {
    status: 200,
    headers: { 'Content-Type': asset.mime, 'Cache-Control': 'no-store', 'X-IGPreview-Source': 'provisioned' },
  });
}

/** The SW lost its in-memory asset set (idle-killed) — ask any editor tab to re-push
 *  it. Debounced so a burst of asset misses triggers just one re-provision. */
async function requestReprovision() {
  const now = Date.now();
  if (now - lastReprovisionAsk < 1000) return;
  lastReprovisionAsk = now;
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) {
    if (!new URL(c.url).pathname.startsWith(PREVIEW_ROOT)) c.postMessage({ type: 'igpreview:needAssets' });
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // SCOPE GUARD (assert): only same-origin requests under the preview root are ours.
  // Anything else is the editor app's own traffic — do NOT intercept.
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(PREVIEW_ROOT)) return;
  // Only GET is meaningful for a static-site view.
  if (event.request.method !== 'GET') return;
  event.respondWith(handlePreview(event.request, url));
});

async function handlePreview(request, url) {
  const parsed = parsePreviewPath(url.pathname);

  // (0) Assets: serve from the generation's provisioned set — no editor round-trip,
  // no main-thread contention. This is the fast path for the ~80 static icons/css/js
  // a page pulls, and the whole point of the provisioning design.
  if (parsed && !parsed.isPage) {
    const asset = provisionedAsset(parsed.generator, parsed.path);
    if (asset) return assetResponse(asset);
    // The provisioned set is the COMPLETE asset inventory for this IG's generation.
    // So if it's present for this IG, a miss means the asset genuinely doesn't exist
    // (e.g. tree icons/backgrounds the template package doesn't ship) — answer 404
    // IMMEDIATELY, with NO editor round-trip. Round-tripping ~68 absent images per
    // page (each to the contended main thread) was the whole cause of slow nav.
    if (provisioned && provisioned.igId === parsed.generator) {
      return new Response('', {
        status: 404,
        headers: { 'Cache-Control': 'no-store', 'X-IGPreview-Source': 'absent' },
      });
    }
    // No set at all (SW was idle-killed) — ask the editor to re-push it, and fall
    // through to the legacy render-via-client path for this one request.
    void requestReprovision();
  }

  const gen = currentGeneration;
  // (a) Only a CURRENT-generation cache entry may beat a live render. Falling
  // back to the previous generation before consulting the open editor is what
  // allowed a newly navigated iframe to become permanently stale.
  const current = await cacheMatchCurrent(url.pathname, gen);
  if (current) return current;

  // (b) Live render via an open editor tab.
  if (parsed) {
    const live = await renderViaClient(parsed);
    if (live) {
      // Write-through into the current generation's cache so it survives tab close.
      await cachePut(url.pathname, live.clone(), gen);
      return live;
    }
  }

  // (b2) With no live renderer, an older retained page is still useful for an
  // editor-closed/offline tab. Mark it explicitly as stale for diagnostics.
  const stale = await cacheMatchOlder(url.pathname, gen);
  if (stale) return stale;

  // (c) Friendly fallback — never a browser error page.
  return fallbackResponse(parsed, url);
}

// ---- (a) Cache API -------------------------------------------------------------

function cacheName(gen) {
  return CACHE_PREFIX + gen;
}

async function cacheMatchCurrent(pathname, gen) {
  const cache = await caches.open(cacheName(gen));
  return (await cache.match(pathname)) || null;
}

async function cacheMatchOlder(pathname, gen) {
  const names = (await orderedCacheNames(gen)).filter((name) => name !== cacheName(gen));
  for (const name of names) {
    const cache = await caches.open(name);
    const hit = await cache.match(pathname);
    if (!hit) continue;
    const headers = new Headers(hit.headers);
    headers.set('X-IGPreview-Stale', 'true');
    return new Response(await hit.arrayBuffer(), {
      status: hit.status,
      statusText: hit.statusText,
      headers,
    });
  }
  return null;
}

async function cachePut(pathname, response, gen) {
  try {
    const cache = await caches.open(cacheName(gen || 1));
    await cache.put(pathname, response);
  } catch {
    /* best-effort: a cache write failure must never break serving */
  }
}

/** All igpreview cache names, newest generation first, current gen leading. */
async function orderedCacheNames(gen) {
  const keys = (await caches.keys()).filter((k) => k.startsWith(CACHE_PREFIX));
  const withGen = keys
    .map((k) => ({ k, g: Number(k.slice(CACHE_PREFIX.length)) || 0 }))
    .sort((a, b) => b.g - a.g);
  const ordered = withGen.map((x) => x.k);
  // Ensure the announced current generation is tried first even if empty/new.
  const curName = cacheName(gen);
  return [curName, ...ordered.filter((n) => n !== curName)];
}

/** Keep only the newest KEEP_GENERATIONS caches; delete older ones. */
async function pruneCaches() {
  const allKeys = await caches.keys();
  const keys = allKeys.filter((k) => k.startsWith(CACHE_PREFIX));
  const sorted = keys
    .map((k) => ({ k, g: Number(k.slice(CACHE_PREFIX.length)) || 0 }))
    .sort((a, b) => b.g - a.g);
  const doomed = [
    ...sorted.slice(KEEP_GENERATIONS).map((x) => x.k),
    ...allKeys.filter((key) => LEGACY_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))),
  ];
  await Promise.all(doomed.map((k) => caches.delete(k)));
}

// ---- (b) Live render via an editor client -------------------------------------

/** Parse `<base>preview/<gen>/<rest>` into { generator, path }. */
function parsePreviewPath(pathname) {
  const rest = pathname.slice(PREVIEW_ROOT.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const generator = decodeURIComponent(rest.slice(0, slash));
  const path = decodeURIComponent(rest.slice(slash + 1));
  if (!generator || !path) return null;
  // Is this a page (.html) or an asset? Pages get HTML; everything else is an asset.
  const isPage = path.endsWith('.html') || path.endsWith('/') || path === '';
  return { generator, path: path.endsWith('/') ? path + 'index.html' : path, isPage };
}

/** Ask every editor client to render; take the FIRST answer (newest-gen tabs reply,
 *  but we don't double-answer: the MessageChannel port resolves once). */
async function renderViaClient(parsed) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Only real editor tabs (the app shell), never other preview tabs, can render.
  const editors = clients.filter((c) => {
    const p = new URL(c.url).pathname;
    return !p.startsWith(PREVIEW_ROOT);
  });
  if (editors.length === 0) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    // Timeout so a busy/dead tab can't hang the fetch — fall through to the fallback.
    const timer = setTimeout(() => finish(null), 8000);

    let pending = editors.length;
    for (const client of editors) {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => {
        const d = e.data;
        pending--;
        if (d && d.ok && !settled) {
          clearTimeout(timer);
          const body = d.isBase64 ? base64ToBytes(d.body) : d.body;
          finish(
            new Response(body, {
              status: 200,
              headers: {
                'Content-Type': d.mime || 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-IGPreview-Source': 'live',
              },
            }),
          );
        } else if (pending <= 0) {
          clearTimeout(timer);
          finish(null);
        }
      };
      client.postMessage(
        { type: 'igpreview:render', generator: parsed.generator, path: parsed.path, isPage: parsed.isPage },
        [channel.port2],
      );
    }
  });
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- (c) Friendly fallback -----------------------------------------------------

function fallbackResponse(parsed, url) {
  const isPage = !parsed || parsed.isPage;
  if (!isPage) {
    // Missing asset with no editor open: 404 is fine (images/css degrade gracefully).
    return new Response('asset unavailable — open the editor to render it', {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    });
  }
  const appUrl = BASE;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Preview unavailable — reopen the editor</title>
<meta http-equiv="refresh" content="5">
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f172a;color:#e2e8f0}
  .card{max-width:34rem;padding:2.5rem;text-align:center}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{color:#94a3b8}
  a.btn{display:inline-block;margin-top:1.25rem;padding:.6rem 1.2rem;background:#38bdf8;color:#0f172a;
        border-radius:.5rem;text-decoration:none;font-weight:600}
  code{background:#1e293b;padding:.1rem .35rem;border-radius:.25rem;color:#7dd3fc}
</style></head><body><div class="card" data-igpreview-fallback>
  <h1>This preview page isn't rendered yet</h1>
  <p>The FHIR IG Editor tab that renders this site isn't open (or hasn't rendered
     <code>${escapeHtml(parsed ? parsed.path : url.pathname)}</code> yet).</p>
  <p>Reopen the editor and this page will render automatically. Retrying every 5s…</p>
  <a class="btn" href="${appUrl}">Open the FHIR IG Editor</a>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-IGPreview-Source': 'fallback' },
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
