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

/** Build the real preview URL for a page under a generator. */
export function previewUrl(generatorId: string, pagePath: string): string {
  const gen = encodeURIComponent(generatorId);
  // Encode each path segment but keep the slashes (real nested URLs).
  const path = pagePath.split('/').map(encodeURIComponent).join('/');
  return `${PREVIEW_ROOT}${gen}/${path}`;
}

// ---- SW registration -----------------------------------------------------------

let swRegistration: ServiceWorkerRegistration | null = null;
let swCapable: boolean | null = null;

/** Register the preview SW (idempotent). Returns whether preview windows are
 *  supported in this browser/context (false in private windows without SW, etc.). */
export async function ensurePreviewServiceWorker(): Promise<boolean> {
  if (swCapable !== null) return swCapable;
  if (!('serviceWorker' in navigator)) {
    swCapable = false;
    return false;
  }
  try {
    // The SW script sits at `<base>preview-sw.js`; its directory (the app base) is
    // an ancestor of the requested scope `<base>preview/`, so no Service-Worker-Allowed
    // header is needed — the script may legally claim that narrower scope.
    swRegistration = await navigator.serviceWorker.register(`${BASE}preview-sw.js`, {
      scope: PREVIEW_ROOT,
    });
    // Wait until the SW is ACTIVATED so it can serve preview/ requests (the embedded
    // iframe navigates there immediately). NOT `navigator.serviceWorker.ready` — that
    // resolves only when a SW controls THIS page, but our scope is preview/ (the app
    // shell at `/` is intentionally never controlled), so `.ready` would hang forever.
    const sw = swRegistration.active ?? swRegistration.waiting ?? swRegistration.installing;
    if (sw && sw.state !== 'activated') {
      await new Promise<void>((res) => {
        const check = () => { if (sw.state === 'activated') { sw.removeEventListener('statechange', check); res(); } };
        sw.addEventListener('statechange', check);
        check();
      });
    }
    swCapable = true;
  } catch (e) {
    console.warn('[igpreview] SW registration failed; preview window disabled:', e);
    swCapable = false;
  }
  return swCapable;
}

/** Tell the active SW the current compile generation (drives cache naming + prune). */
export async function announceGenerationToSW(generation: number): Promise<void> {
  try {
    const reg = swRegistration ?? (await navigator.serviceWorker?.ready);
    const sw = reg?.active ?? navigator.serviceWorker?.controller;
    sw?.postMessage({ type: 'igpreview:setGeneration', generation });
  } catch {
    /* best-effort */
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
  var ch=new BroadcastChannel(${JSON.stringify(CHANNEL_NAME)});
  var say=function(){try{ch.postMessage({type:'hello',generator:me.generator,path:me.path,generation:me.generation});}catch(e){}};
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
  let out = rawHtml;
  // <base>: relative asset names (assets/css/x.css, foo.png) resolve to
  // `<base>preview/<gen>/<pageDir>/...` so the SW answers them all (the responder
  // relays design assets it can't render — see answerRender). Point <base> at the
  // page's directory under the preview root.
  const pageDir = pagePath.includes('/') ? pagePath.slice(0, pagePath.lastIndexOf('/') + 1) : '';
  const baseHref = previewUrl(generatorId, pageDir);
  const baseTag = `<base href="${baseHref}">`;
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

/** Live source, updated by the editor as the selected generator / generation changes. */
let source: PreviewSource | null = null;

const CACHE_PREFIX = 'igpreview::';

/** Open preview tabs the editor has heard from: path -> last-seen generation. */
const openPreviews = new Map<string, number>();

/** The full preview URL pathname for a page under the current source's generator. */
function pagePathname(generatorId: string, page: string): string {
  return new URL(previewUrl(generatorId, page), self.location.origin).pathname;
}

/** Read the bytes currently cached for a preview page (what the tab last showed),
 *  searching newest generation first. Null if nothing is cached yet. */
async function readCachedPage(pathname: string): Promise<string | null> {
  if (typeof caches === 'undefined') return null;
  const keys = (await caches.keys())
    .filter((k) => k.startsWith(CACHE_PREFIX))
    .sort((a, b) => (Number(b.slice(CACHE_PREFIX.length)) || 0) - (Number(a.slice(CACHE_PREFIX.length)) || 0));
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
export function updatePreviewSource(next: PreviewSource): void {
  const prevGen = source?.generation ?? -1;
  source = next;
  void announceGenerationToSW(next.generation);
  if (next.generation !== prevGen) void refreshOpenPreviews();
}

/** Wire the SW render responder + the BroadcastChannel hot-reload bus (idempotent). */
export function wirePreviewResponder(): void {
  if (responderWired) return;
  responderWired = true;

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg || msg.type !== 'igpreview:render') return;
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
      if (d.type === 'hello' && typeof d.path === 'string') {
        openPreviews.set(d.path, typeof d.generation === 'number' ? d.generation : 0);
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
      openPreviews.set(path, src.generation);
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
async function refreshOpenPreviews(): Promise<void> {
  const src = source;
  if (!src || !channel) return;
  const myToken = ++refreshToken;
  const gen = src.generation;
  const paths = [...openPreviews.keys()];
  const changed: string[] = [];

  for (const path of paths) {
    if (myToken !== refreshToken) return; // a newer generation superseded us
    try {
      const pathname = pagePathname(src.igId, path);
      // The bytes the tab CURRENTLY shows live in the SW cache (what was last served,
      // whether via live render or a cache hit) — that is the correct baseline. Read
      // it BEFORE overwriting so an unrelated page (identical bytes) isn't reloaded.
      const before = await readCachedPage(pathname);
      const { html } = await src.adapter.renderPage(path);
      const prepared = preparePreviewHtml(html, src.igId, path, gen);
      // Always refresh the current-generation cache so a reload serves the new bytes.
      await writeCachedPage(pathname, prepared, gen);
      openPreviews.set(path, gen);
      // Ignore only the injected generation stamp (always differs) — real content
      // changes drive the reload.
      const diff = before == null || stripVolatile(before) !== stripVolatile(prepared);
      if (diff) changed.push(path);
    } catch {
      /* a page that no longer renders is skipped, not reloaded */
    }
  }
  if (myToken !== refreshToken) return;
  if (changed.length) channel.postMessage({ type: 'reload', generator: src.igId, generation: gen, paths: changed });
}

/** Remove the parts of the injected HTML that change every generation (the snippet's
 *  embedded generation number) so byte-compare reflects real content changes only. */
function stripVolatile(html: string): string {
  return html.replace(/"generation":\d+/g, '"generation":0');
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
