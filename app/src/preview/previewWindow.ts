// Preview-window plumbing (task #37): the editor-tab side of the "Open site in a
// new window" feature. Owns:
//   - Service-Worker registration (scope `<base>preview/`) + capability probe.
//   - The RENDER RESPONDER: answers the SW's MessageChannel render/asset requests
//     for the currently-selected generator via its adapter (tier b of the ladder).
//   - HTML rewriting for preview-served pages: a <base> so relative asset refs
//     resolve under the preview path, plus a tiny, clearly-marked hot-reload +
//     stale-banner client snippet.
//   - HOT RELOAD coordination over a BroadcastChannel: open preview tabs announce
//     their path; on each new compile generation the editor re-renders those pages,
//     byte-compares, and reloads ONLY the tabs whose page actually changed.
//
// FOOLPROOFING: no SW support / registration failure -> capable=false; the caller
// disables the button and keeps the in-pane preview. The BroadcastChannel snippet
// fails silent if the channel is gone (editor closed -> the tab just stays static;
// the SW tiers still serve it).

import type { SiteGeneratorAdapter } from '../adapters/types';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
export const PREVIEW_ROOT = `${BASE}preview/`;
const CHANNEL_NAME = 'igpreview';

/** Bump this whenever the editor/SW control-message contract changes
 * incompatibly. The version is part of the script URL so an already-installed
 * worker cannot remain active merely because a browser reuses a cached
 * `preview-sw.js` registration during a rolling deployment. */
export const PREVIEW_SW_PROTOCOL = 3;

export function previewWorkerScriptPath(base = BASE): string {
  return `${base.replace(/\/?$/, '/')}preview-sw.js?protocol=${PREVIEW_SW_PROTOCOL}`;
}

/** Build the real preview URL for a page under a generator. */
export function previewUrl(generatorId: string, pagePath: string): string {
  const gen = encodeURIComponent(generatorId);
  // Encode each path segment but keep the slashes (real nested URLs).
  const path = pagePath.split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_ROOT}${gen}/${path}`;
}

// ---- SW registration -----------------------------------------------------------

let swRegistration: ServiceWorkerRegistration | null = null;
let compatibleWorker: ServiceWorker | null = null;
let swReadyPromise: Promise<ServiceWorker | null> | null = null;

export function isCompatiblePreviewWorkerPong(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const pong = value as { type?: unknown; protocol?: unknown };
  return pong.type === 'igpreview:pong' && pong.protocol === PREVIEW_SW_PROTOCOL;
}

/** Probe one worker over the same MessageChannel mechanism used by commits.
 * Legacy workers either ignore this message or reply without `protocol`; both
 * are deliberately incompatible instead of being allowed to swallow a newer
 * commit message without acknowledging it. */
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

/** Wait for the worker at the desired versioned script URL, not merely any
 * active worker for this scope. This is exported so the old-active/new-app
 * rolling-deployment case can be tested without a browser-global singleton. */
export async function waitForCompatiblePreviewWorker(
  registration: Pick<ServiceWorkerRegistration, 'active' | 'update'>,
  desiredScriptUrl: string,
  options: PreviewWorkerWaitOptions = {},
): Promise<ServiceWorker> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const pingTimeoutMs = options.pingTimeoutMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;
  // `register()` normally starts the update itself. An explicit update closes
  // the throttled/cached-registration case seen on returning mobile browsers.
  void registration.update().catch(() => undefined);
  while (Date.now() < deadline) {
    const active = registration.active;
    if (
      active?.state === 'activated' &&
      active.scriptURL === desiredScriptUrl &&
      (await previewWorkerProtocol(active, pingTimeoutMs)) === PREVIEW_SW_PROTOCOL
    ) {
      return active;
    }
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, pollMs));
  }
  throw new Error(`preview Service Worker protocol ${PREVIEW_SW_PROTOCOL} did not activate`);
}

async function registerCompatiblePreviewWorker(): Promise<ServiceWorker> {
  const scriptPath = previewWorkerScriptPath();
  const desiredScriptUrl = new URL(scriptPath, window.location.href).href;
  const options: RegistrationOptions = {
    scope: PREVIEW_ROOT,
    updateViaCache: 'none',
  };
  swRegistration = await navigator.serviceWorker.register(scriptPath, options);
  try {
    return await waitForCompatiblePreviewWorker(swRegistration, desiredScriptUrl);
  } catch (firstError) {
    // A stale incompatible registration should normally be replaced by the
    // versioned register above. Some mobile browsers retain it through the
    // update window; unregistering the scope is the bounded recovery. Cache API
    // page bytes are independent of the registration and remain available.
    console.warn('[igpreview] replacing incompatible preview Service Worker:', firstError);
    await swRegistration.unregister();
    swRegistration = await navigator.serviceWorker.register(scriptPath, options);
    return waitForCompatiblePreviewWorker(swRegistration, desiredScriptUrl, { timeoutMs: 20_000 });
  }
}

/** Register the preview SW (idempotent). Returns whether preview windows are
 *  supported in this browser/context (false in private windows without SW, etc.). */
export async function ensurePreviewServiceWorker(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) {
    return false;
  }
  if (compatibleWorker?.state === 'activated') return true;
  if (swReadyPromise) return (await swReadyPromise) !== null;
  const pending = registerCompatiblePreviewWorker().then(
    (worker) => {
      compatibleWorker = worker;
      return worker;
    },
    (e) => {
      console.warn('[igpreview] SW registration failed; preview disabled:', e);
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

/** Tell the active SW the current compile generation (drives cache naming + prune). */
export async function announceGenerationToSW(generation: number): Promise<void> {
  try {
    const sw = await activePreviewWorker();
    sw?.postMessage({ type: 'igpreview:setGeneration', generation });
  } catch {
    /* best-effort */
  }
}

async function activePreviewWorker(): Promise<ServiceWorker | null> {
  if (!(await ensurePreviewServiceWorker())) return null;
  return compatibleWorker?.state === 'activated' ? compatibleWorker : null;
}

async function postToPreviewWorker(
  message: Record<string, unknown>,
  transfer: Transferable[] = [],
  mayCommit: () => boolean = () => true,
): Promise<boolean> {
  const sw = await activePreviewWorker();
  // The worker lookup is an await point. A project/generator request can revoke
  // the build while registration is resolving; do not send that obsolete
  // generation afterward.
  if (!mayCommit()) return false;
  if (!sw) throw new Error('compatible preview Service Worker is unavailable');
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(
      () => {
        channel.port1.close();
        reject(new Error('preview Service Worker commit acknowledgement timed out'));
      },
      12_000,
    );
    channel.port1.onmessage = (event) => {
      if (event.data?.ok) {
        globalThis.clearTimeout(timer);
        channel.port1.close();
        resolve();
      } else {
        globalThis.clearTimeout(timer);
        channel.port1.close();
        reject(new Error(event.data?.error || 'preview Service Worker rejected generation'));
      }
    };
    try {
      sw.postMessage(message, [channel.port2, ...transfer]);
    } catch (error) {
      globalThis.clearTimeout(timer);
      channel.port1.close();
      reject(error);
    }
  });
  return true;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Push the CURRENT generation's COMPLETE static asset set to the SW in one message,
 *  so the SW serves every asset (the ~80 table icons/css/js a page pulls) itself —
 *  no per-asset round-trip to this tab's main thread (the thing that made navigation
 *  slow). Deterministic + generation-keyed (a recompile pushes a fresh set), so it is
 *  NOT a lazy cache guessing at staleness. Bytes ride as transferables (zero-copy). */
export async function provisionAssetsToSW(src: PreviewSource): Promise<void> {
  try {
    if (!src.adapter.assetManifest) return;
    const sw = await activePreviewWorker();
    if (!sw) return;
    const { pagePrefix, assets } = src.adapter.assetManifest();
    const entries = Object.entries(assets).map(([key, a]) => ({
      key,
      mime: a.mime,
      bytes: base64ToArrayBuffer(a.b64),
    }));
    sw.postMessage(
      { type: 'igpreview:provisionAssets', generation: src.generation, igId: src.igId, pagePrefix, assets: entries },
      entries.map((e) => e.bytes), // transfer the ArrayBuffers (neuters our copies; we re-decode on re-provision)
    );
  } catch {
    /* best-effort: the SW just falls back to per-asset serving until next provision */
  }
}

// ---- HTML rewriting for preview-served pages -----------------------------------

/** The injected client snippet: reports this tab's path to the editor and reloads
 *  itself when the editor announces its page changed. Clearly marked; fails silent. */
function hotReloadSnippet(generatorId: string, pagePath: string, generation: number): string {
  const payload = JSON.stringify({ generator: generatorId, path: pagePath, generation });
  // Kept intentionally small + defensive. `data-igpreview` marks it as injected.
  return `<script data-igpreview="hot-reload">(function(){try{
  var me=${payload};
  // A prepared page can be composed into another rendered shell. A control
  // block is authoritative only at its own URL; a stale nested block must not
  // subscribe or react to another page's reload message.
  var here;try{here=decodeURIComponent(location.pathname);}catch(e){here=location.pathname;}
  if(!here.endsWith('/'+me.path))return;
  var controlKey=me.generator+'\\n'+me.path;
  if(window.__igpreviewHotReloadKey===controlKey)return;
  window.__igpreviewHotReloadKey=controlKey;
  var mine=document.currentScript;
  var root=document.body||document.documentElement;
  var prune=function(){root.querySelectorAll('script[data-igpreview="hot-reload"]').forEach(function(s){if(s!==mine)s.remove();});};
  prune();
  // Some page runtimes compose prepared HTML after this block has executed.
  // Keep the one URL-authoritative control block invariant even for those late
  // body insertions. Do not observe/remove jQuery's temporary HEAD script: its
  // evaluator owns that node and removes it synchronously after execution.
  var observer=new MutationObserver(prune);
  observer.observe(root,{childList:true,subtree:true});
  window.addEventListener('pagehide',function(){observer.disconnect();},{once:true});
  var ch=new BroadcastChannel(${JSON.stringify(CHANNEL_NAME)});
  var clientId;try{
    clientId=sessionStorage.getItem('igpreview:client-id');
    if(!clientId){clientId=(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);sessionStorage.setItem('igpreview:client-id',clientId);}
  }catch(e){clientId=Date.now().toString(36)+Math.random().toString(36).slice(2);}
  var say=function(){try{ch.postMessage({type:'hello',clientId:clientId,generator:me.generator,path:me.path,generation:me.generation});}catch(e){}};
  ch.onmessage=function(ev){var d=ev.data;if(!d)return;
    if(d.type==='reload'&&d.generator===me.generator&&d.generation>=me.generation&&Array.isArray(d.paths)&&d.paths.indexOf(me.path)>=0){
      // Our page changed in a newer generation -> reload (browser restores scroll).
      location.reload();
    }
    if(d.type==='who')say();
  };
  say();
  // Re-announce when the tab regains focus (editor may have (re)opened meanwhile).
  window.addEventListener('pageshow',say);
}catch(e){/* channel gone: stay static, tiers still serve us */}})();</script>`;
}

/** A minimal, clearly-marked banner shown when the served page is from a stale
 *  generation and a fresher render is available. Non-invasive; auto-dismisses on reload. */
function staleBannerSnippet(): string {
  return `<div data-igpreview="stale-banner" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;
  font:13px/1.4 system-ui,sans-serif;background:#fef9c3;color:#713f12;padding:.4rem .8rem;
  border-top:1px solid #eab308;text-align:center">A newer version of this page is available — reloading…</div>`;
}

/** Rewrite a rendered page for preview serving: inject <base> (so the adapter's
 *  asset refs resolve under the preview path) + the hot-reload snippet. */
export function preparePreviewHtml(
  rawHtml: string,
  generatorId: string,
  pagePath: string,
  generation: number,
  opts?: { stale?: boolean },
): string {
  // This boundary is deliberately idempotent. A cached/prepared page can be fed
  // through the responder again; retaining its old control block would make one
  // document listen as two different paths and reload on an unrelated edit.
  let out = rawHtml
    .replace(/<script\b[^>]*data-igpreview=["']hot-reload["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<div\b[^>]*data-igpreview=["']stale-banner["'][^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<base\b[^>]*data-igpreview=["']base["'][^>]*>/gi, '');
  // <base>: use the page's FULL preview URL. Relative assets still resolve
  // against its containing directory, while fragment-only links such as
  // `#tabs-key` resolve to this exact document. A directory base makes jQuery
  // UI classify those anchors as remote tabs; it then AJAX-loads `index.html`
  // and inserts a complete second site shell into the tab panel.
  const baseHref = previewUrl(generatorId, pagePath);
  const baseTag = `<base data-igpreview="base" href="${baseHref}">`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
  else out = `${baseTag}${out}`;

  const inject = hotReloadSnippet(generatorId, pagePath, generation) + (opts?.stale ? staleBannerSnippet() : '');
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${inject}</body>`);
  else out += inject;
  return out;
}

// ---- render responder + hot-reload coordinator ---------------------------------

export interface PreviewSource {
  /** The IG id — the URL-scheme KEY (`preview/<igId>/<path>`). Content is identified
   *  by the IG, so the SAME URL works embedded (iframe src) and external (new tab),
   *  and IGs with overlapping page names never collide. */
  igId: string;
  /** The generator id whose adapter is currently initialized in this editor tab. */
  generatorId: string;
  adapter: SiteGeneratorAdapter;
  /** The current compile generation (monotonic). */
  generation: number;
}

export interface PreviewAssetTransfer {
  key: string;
  mime: string;
  bytes: ArrayBuffer;
}

type PreviewWorkerPost = (
  message: Record<string, unknown>,
  transfer?: Transferable[],
  mayCommit?: () => boolean,
) => Promise<boolean>;

/** Commit the optimized generation+asset pair, but preserve correctness when a
 * mobile worker cannot accept the large transfer promptly. The fallback is a
 * small generation-only commit; assets remain available through the existing
 * live responder and may be provisioned again after UI publication. */
export async function commitPreviewGenerationWithFallback(
  next: Pick<PreviewSource, 'generation' | 'igId'>,
  pagePrefix: string,
  entries: PreviewAssetTransfer[],
  hasAssetManifest: boolean,
  mayCommit: () => boolean,
  post: PreviewWorkerPost = postToPreviewWorker,
): Promise<{ committed: boolean; fullAssetsCommitted: boolean; fullAssetError?: unknown }> {
  try {
    const committed = await post(
      {
        type: 'igpreview:commitGeneration',
        generation: next.generation,
        igId: next.igId,
        pagePrefix,
        hasAssetManifest,
        assets: entries,
      },
      entries.map((entry) => entry.bytes),
      mayCommit,
    );
    return { committed, fullAssetsCommitted: true };
  } catch (fullAssetError) {
    if (!mayCommit()) return { committed: false, fullAssetsCommitted: false, fullAssetError };
    const committed = await post(
      {
        type: 'igpreview:commitGeneration',
        generation: next.generation,
        igId: next.igId,
        pagePrefix,
        hasAssetManifest: false,
        assets: [],
      },
      [],
      mayCommit,
    );
    return { committed, fullAssetsCommitted: false, fullAssetError };
  }
}

/** Live source, updated by the editor as the selected generator / generation changes. */
let source: PreviewSource | null = null;

const CACHE_PREFIX = `igpreview:v${PREVIEW_SW_PROTOCOL}::`;

/** Cache search law for hot-reload comparison: never inspect a generation newer
 * than the page set that was current before publication. */
export function previewCacheCandidates(available: string[], generation: number): string[] {
  const exact = `${CACHE_PREFIX}${generation}`;
  return [
    ...(available.includes(exact) ? [exact] : []),
    ...available
      .filter((key) => {
        if (!key.startsWith(CACHE_PREFIX) || key === exact) return false;
        return (Number(key.slice(CACHE_PREFIX.length)) || 0) <= generation;
      })
      .sort((a, b) => (Number(b.slice(CACHE_PREFIX.length)) || 0) - (Number(a.slice(CACHE_PREFIX.length)) || 0)),
  ];
}

export interface PreviewClientRegistration {
  igId: string;
  path: string;
  lastSeen: number;
}

/** One current path per live preview browsing context. A stable client id means
 * navigating a tab replaces its old path instead of accumulating every page it
 * has ever visited. The IG key still prevents cross-project publication. */
const openPreviews = new Map<string, PreviewClientRegistration>();
const PREVIEW_CLIENT_TTL_MS = 5 * 60_000;

export function registeredPreviewPaths(
  registry: ReadonlyMap<string, PreviewClientRegistration>,
  igId: string,
  now = Date.now(),
): string[] {
  return [...new Set(
    [...registry.values()]
      .filter((client) => client.igId === igId && now - client.lastSeen <= PREVIEW_CLIENT_TTL_MS)
      .map((client) => client.path),
  )];
}

function registerPreviewPath(clientId: string, igId: string, path: string): void {
  const now = Date.now();
  openPreviews.set(clientId, { igId, path, lastSeen: now });
  for (const [id, client] of openPreviews) {
    if (now - client.lastSeen > PREVIEW_CLIENT_TTL_MS) openPreviews.delete(id);
  }
}

/** The full preview URL pathname for a page under the current source's generator. */
function pagePathname(generatorId: string, page: string): string {
  return new URL(previewUrl(generatorId, page), self.location.origin).pathname;
}

/** Read the page bytes from the generation that was current before publication.
 * Looking in the newest cache is racy: the embedded iframe can render the new
 * page before this comparison, making an old external tab appear up to date. */
async function readCachedPage(pathname: string, generation: number): Promise<string | null> {
  if (typeof caches === 'undefined') return null;
  const available = await caches.keys();
  const keys = previewCacheCandidates(available, generation);
  for (const k of keys) {
    const c = await caches.open(k);
    const hit = await c.match(pathname);
    if (hit) return hit.text();
  }
  return null;
}

/** Write fresh bytes into the current generation's cache (so a reloaded tab gets
 *  the new render straight from tier a). */
async function writeCachedPage(pathname: string, html: string, generation: number): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const c = await caches.open(`${CACHE_PREFIX}${generation}`);
    await c.put(
      pathname,
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-IGPreview-Source': 'refresh' } }),
    );
  } catch {
    /* best-effort */
  }
}

let channel: BroadcastChannel | null = null;
let responderWired = false;

/** Point the responder at the currently-selected generator + generation. Call on
 *  every adapter (re)init. Kicks off a smart hot-reload pass for open preview tabs. */
export async function publishPreviewSource(
  next: PreviewSource,
  mayCommit: () => boolean = () => true,
): Promise<boolean> {
  const prevGen = source?.generation ?? -1;
  const manifest = next.adapter.assetManifest?.();
  const entries = manifest
    ? Object.entries(manifest.assets).map(([key, asset]) => ({
        key,
        mime: asset.mime,
        bytes: base64ToArrayBuffer(asset.b64),
      }))
    : [];

  // One acknowledged message atomically advances BOTH the generation pointer and
  // its complete asset manifest. The UI does not navigate an iframe to the new
  // build until this resolves, so first-load asset requests cannot race an older
  // provisioned set.
  const commit = await commitPreviewGenerationWithFallback(
    next,
    manifest?.pagePrefix ?? '',
    entries,
    !!manifest,
    mayCommit,
  );
  if (!commit.committed) return false;
  if (!commit.fullAssetsCommitted) {
    // A large stock-template asset transfer can exceed a mobile browser's SW
    // wake/clone budget even though page rendering already succeeded. The small
    // commit above keeps the actual site usable through the live asset responder.
    console.warn('[igpreview] full asset commit failed; using live asset fallback:', commit.fullAssetError);
  }

  source = next;
  if (!commit.fullAssetsCommitted && manifest) void provisionAssetsToSW(next);
  if (next.generation !== prevGen) void refreshOpenPreviews(prevGen);
  return true;
}

/** Backward-compatible best-effort wrapper for older callers. New build code
 * should await publishPreviewSource before committing its UI generation. */
export function updatePreviewSource(next: PreviewSource): void {
  void publishPreviewSource(next);
}

/** Wire the SW render responder + the BroadcastChannel hot-reload bus (idempotent). */
export function wirePreviewResponder(): void {
  if (responderWired) return;
  responderWired = true;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      // The SW restarted (idle-killed) and lost its provisioned asset set — re-push it.
      if (msg.type === 'igpreview:needAssets') {
        if (source) void provisionAssetsToSW(source);
        return;
      }
      if (msg.type !== 'igpreview:render') return;
      const port = event.ports[0];
      if (!port) return;
      void answerRender(msg.generator, msg.path, !!msg.isPage, port);
    });
  }

  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'hello' && typeof d.generator === 'string' && typeof d.path === 'string') {
        // Cached pages from the pre-client-id protocol remain functional; their
        // path-derived id cannot replace navigation history, but expires by TTL.
        const clientId = typeof d.clientId === 'string' && d.clientId
          ? d.clientId
          : `legacy:${d.generator}:${d.path}`;
        registerPreviewPath(clientId, d.generator, d.path);
        // A tab can miss the original reload broadcast while its document is
        // loading. If it later reports an older generation, compare that tab's
        // cached bytes with the current render. A generation mismatch alone does
        // NOT imply a content change and must not reload an unrelated page.
        if (
          source &&
          d.generator === source.igId &&
          typeof d.generation === 'number' &&
          d.generation < source.generation
        ) {
          const src = source;
          const token = refreshToken;
          void refreshPreviewPage(src, d.path, d.generation, token);
        }
      }
    };
    // Ask any already-open preview tabs to announce themselves.
    channel.postMessage({ type: 'who' });
  } catch {
    channel = null;
  }
}

/** Answer one SW render request using the currently-initialized adapter. */
async function answerRender(
  generator: string,
  path: string,
  isPage: boolean,
  port: MessagePort,
): Promise<void> {
  try {
    const src = source;
    // `generator` is the first URL segment — now the IG id (the scheme's key).
    if (!src || src.igId !== generator) {
      // We don't hold this IG loaded — decline; the SW falls back.
      port.postMessage({ ok: false });
      return;
    }
    if (isPage) {
      const { html } = await src.adapter.renderPage(path);
      // Always base at the PREVIEW ROOT (never the adapter's static baseHref): that
      // way EVERY asset ref — design assets AND IG images — flows back through the SW
      // asset tier as a real, cacheable, navigable URL. The responder resolves design
      // assets from the adapter's static tree below when assetBytes doesn't know them.
      const prepared = preparePreviewHtml(html, generator, path, src.generation);
      port.postMessage({ ok: true, isBase64: false, mime: 'text/html; charset=utf-8', body: prepared });
    } else {
      const name = path.replace(/^\.?\//, '');
      // Tier 1: adapter-known bytes (IG images, stock template statics).
      let asset = await src.adapter.assetBytes(name).catch(() => null);
      // Tier 2: the adapter's static design-asset tree (cycle's css/js/fonts served
      // from the app's own static path). Relay the bytes so they too ride the SW.
      if (!asset && src.adapter.baseHref) {
        asset = await fetchStaticAsset(src.adapter.baseHref, name).catch(() => null);
      }
      if (!asset) {
        port.postMessage({ ok: false });
        return;
      }
      port.postMessage({ ok: true, isBase64: true, mime: asset.mime, body: asset.base64 });
    }
  } catch {
    port.postMessage({ ok: false });
  }
}

/** Smart hot-reload: after a new generation, re-render every OPEN preview page,
 *  byte-compare against what was last served, and reload only the changed ones.
 *  Debounced to the latest generation: a newer pass supersedes an in-flight one. */
let refreshToken = 0;
const pageRefreshes = new Map<string, Promise<void>>();

async function refreshOpenPreviews(previousGeneration: number): Promise<void> {
  const src = source;
  if (!src || !channel) return;
  const myToken = ++refreshToken;
  const paths = registeredPreviewPaths(openPreviews, src.igId);

  for (const path of paths) {
    if (myToken !== refreshToken) return; // a newer generation superseded us
    await refreshPreviewPage(src, path, previousGeneration, myToken);
  }
}

/** Compare and refresh one page, coalescing the publish pass with a stale hello
 * for the same IG/generation/path. The broadcast is emitted only after a real
 * byte change and is scoped by both IG id and page path. */
async function refreshPreviewPage(
  src: PreviewSource,
  path: string,
  previousGeneration: number,
  token: number,
): Promise<void> {
  if (!channel || source !== src || token !== refreshToken) return;
  const key = `${src.igId}\u0000${src.generation}\u0000${previousGeneration}\u0000${path}`;
  const pending = pageRefreshes.get(key);
  if (pending) return pending;

  const work = (async () => {
    try {
      const pathname = pagePathname(src.igId, path);
      // Read the generation reported by the tab before writing the new render.
      // Looking in a newer cache can confuse an embedded iframe's eager render
      // with the bytes still displayed by an older external tab.
      const before = await readCachedPage(pathname, previousGeneration);
      const { html } = await src.adapter.renderPage(path);
      const prepared = preparePreviewHtml(html, src.igId, path, src.generation);
      if (source !== src || token !== refreshToken) return;
      // Always refresh the current cache; only changed content drives navigation.
      await writeCachedPage(pathname, prepared, src.generation);
      if (source !== src || token !== refreshToken) return;
      if (previewContentChanged(before, prepared)) {
        channel?.postMessage({
          type: 'reload',
          generator: src.igId,
          generation: src.generation,
          paths: [path],
        });
      }
    } catch {
      /* a page that no longer renders is skipped, not reloaded */
    }
  })();
  pageRefreshes.set(key, work);
  try {
    await work;
  } finally {
    if (pageRefreshes.get(key) === work) pageRefreshes.delete(key);
  }
}

/** Remove the parts of the injected HTML that change every generation (the snippet's
 *  embedded generation number) so byte-compare reflects real content changes only. */
function stripVolatile(html: string): string {
  return html.replace(/"generation":\d+/g, '"generation":0');
}

export function previewContentChanged(before: string | null, after: string): boolean {
  return before == null || stripVolatile(before) !== stripVolatile(after);
}

/** Fetch a design asset from the adapter's STATIC tree (e.g. cycle's
 *  `<base>data/cycle/site-assets/`) and return it as base64 so it can ride the SW
 *  ladder as a real preview URL. `baseHref` ends in '/'; `name` is page-relative. */
async function fetchStaticAsset(
  baseHref: string,
  name: string,
): Promise<{ name: string; mime: string; base64: string } | null> {
  const url = new URL(name, new URL(baseHref, self.location.origin)).toString();
  const resp = await fetch(url);
  if (!resp.ok) return null;
  const buf = new Uint8Array(await resp.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  const mime = resp.headers.get('Content-Type') || 'application/octet-stream';
  return { name, mime, base64: btoa(bin) };
}
