/** Response-only preview controls. Canonical renderer bytes never pass back
 * through ContentStore after this transform. */

const CHANNEL_NAME = 'igpreview';

function previewUrl(previewRoot, igId, pagePath) {
  return `${previewRoot}${encodeURIComponent(igId)}/${pagePath.split('/').map(encodeURIComponent).join('/')}`;
}

function escapeAttribute(value) {
  return String(value).replace(/[&"<>]/g, (char) => ({
    '&': '&amp;',
    '"': '&quot;',
    '<': '&lt;',
    '>': '&gt;',
  }[char]));
}

/** Installed inline at the start of <head>. It intentionally has no closure:
 * hotReloadControls serializes this function into a renderer response. */
export function installPreviewControls(me, channelName, runtime = globalThis) {
  try {
    let here;
    try {
      here = decodeURIComponent(runtime.location.pathname);
    } catch {
      here = runtime.location.pathname;
    }
    if (!here.endsWith(`/${me.path}`)) return;
    const key = `${me.generator}\n${me.path}`;
    if (runtime.__igpreviewHotReloadKey === key) return;
    runtime.__igpreviewHotReloadKey = key;

    const scrollKey = `igpreview:scroll:${key}`;
    const restoreScroll = (position) => {
      const document = runtime.document;
      const history = runtime.history;
      const startedAt = Date.now();
      const deadline = startedAt + 8_000;
      const quietForMs = 750;
      let lastLayoutSignal = startedAt;
      let reachedAt = null;
      let stopped = false;
      let timer = null;
      let frame = null;
      let observer = null;
      const priorRestoration = history.scrollRestoration;
      history.scrollRestoration = 'manual';

      const removePosition = () => {
        try {
          runtime.sessionStorage.removeItem(scrollKey);
        } catch {
          // Storage is an optimization; scroll restoration remains best effort.
        }
      };
      const finish = () => {
        if (stopped) return;
        stopped = true;
        removePosition();
        if (timer != null) runtime.clearTimeout(timer);
        if (frame != null) runtime.cancelAnimationFrame(frame);
        observer?.disconnect();
        for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
          runtime.removeEventListener(event, cancelForUser, true);
        }
        runtime.removeEventListener('scroll', correctLateScroll, true);
        runtime.removeEventListener('resize', layoutSignal, true);
        runtime.removeEventListener('load', layoutSignal, true);
        runtime.removeEventListener('pageshow', layoutSignal, true);
        document.removeEventListener('DOMContentLoaded', layoutSignal, true);
        document.removeEventListener('readystatechange', layoutSignal, true);
        history.scrollRestoration = priorRestoration;
      };
      const cancelForUser = (event) => {
        // Synthetic page events must not cancel restoration. A real gesture
        // means the user has taken ownership and must win immediately.
        if (event.isTrusted) finish();
      };
      const atTarget = () => Math.abs(runtime.scrollX - position.x) <= 2
        && Math.abs(runtime.scrollY - position.y) <= 2;
      const attempt = () => {
        if (stopped) return;
        runtime.scrollTo(position.x, position.y);
        const now = Date.now();
        if (atTarget()) {
          if (reachedAt == null) reachedAt = now;
        } else {
          reachedAt = null;
        }
        if (document.readyState === 'complete'
          && reachedAt != null
          && now - reachedAt >= quietForMs
          && now - lastLayoutSignal >= quietForMs) {
          finish();
          return;
        }
        // Always make one final attempt after the bound: lifecycle handlers can
        // arrive even when background-tab timers and animation frames are
        // throttled. The saved target is retained until success or this bound.
        if (now >= deadline) {
          runtime.scrollTo(position.x, position.y);
          finish();
          return;
        }
        frame = runtime.requestAnimationFrame(attempt);
      };
      const scheduleSettledCheck = () => {
        if (timer != null) runtime.clearTimeout(timer);
        timer = runtime.setTimeout(attempt, quietForMs + 25);
      };
      function layoutSignal() {
        if (stopped) return;
        lastLayoutSignal = Date.now();
        reachedAt = null;
        attempt();
        scheduleSettledCheck();
      }
      function correctLateScroll() {
        // A template script can scroll after load without changing layout. Real
        // user input is caught first by cancelForUser; other late scrolls are
        // part of page initialization and must not beat hot-reload restoration.
        if (!stopped && !atTarget()) {
          reachedAt = null;
          attempt();
        }
      }

      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        runtime.addEventListener(event, cancelForUser, { capture: true, passive: true });
      }
      runtime.addEventListener('scroll', correctLateScroll, true);
      runtime.addEventListener('resize', layoutSignal, true);
      runtime.addEventListener('load', layoutSignal, true);
      runtime.addEventListener('pageshow', layoutSignal, true);
      document.addEventListener('DOMContentLoaded', layoutSignal, true);
      document.addEventListener('readystatechange', layoutSignal, true);
      if (typeof runtime.ResizeObserver === 'function') {
        observer = new runtime.ResizeObserver(layoutSignal);
        observer.observe(document.documentElement);
      }
      attempt();
      scheduleSettledCheck();
    };

    try {
      const saved = runtime.sessionStorage.getItem(scrollKey);
      if (saved) {
        const position = JSON.parse(saved);
        const age = Date.now() - position.savedAt;
        const valid = Number.isFinite(position.x)
          && position.x >= 0
          && Number.isFinite(position.y)
          && position.y >= 0
          && Number.isSafeInteger(position.targetGeneration)
          && me.generation >= position.targetGeneration
          && typeof position.fromContentSha256 === 'string'
          && position.fromContentSha256 !== me.contentSha256
          && Number.isFinite(age)
          && age >= -5_000
          && age <= 60_000;
        if (valid) restoreScroll(position);
        else runtime.sessionStorage.removeItem(scrollKey);
      }
    } catch {
      try {
        runtime.sessionStorage.removeItem(scrollKey);
      } catch {
        // Storage can be unavailable in hardened browsing modes.
      }
    }

    const channel = new runtime.BroadcastChannel(channelName);
    let id;
    try {
      id = runtime.sessionStorage.getItem('igpreview:client-id');
      if (!id) {
        id = runtime.crypto?.randomUUID
          ? runtime.crypto.randomUUID()
          : Date.now().toString(36) + Math.random().toString(36).slice(2);
        runtime.sessionStorage.setItem('igpreview:client-id', id);
      }
    } catch {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    }
    const say = () => {
      try {
        channel.postMessage({
          type: 'hello',
          clientId: id,
          generator: me.generator,
          path: me.path,
          generation: me.generation,
          contentSha256: me.contentSha256,
        });
      } catch {
        // A closed channel is equivalent to an editor that is not listening.
      }
    };
    channel.onmessage = (event) => {
      const message = event.data;
      if (!message) return;
      if (message.type === 'reload'
        && message.generator === me.generator
        && message.generation >= me.generation
        && Array.isArray(message.paths)
        && message.paths.includes(me.path)) {
        try {
          runtime.sessionStorage.setItem(scrollKey, JSON.stringify({
            x: runtime.scrollX,
            y: runtime.scrollY,
            savedAt: Date.now(),
            targetGeneration: message.generation,
            fromContentSha256: me.contentSha256,
          }));
        } catch {
          // Reload still proceeds if session storage is unavailable.
        }
        runtime.location.reload();
      }
      if (message.type === 'who') say();
    };
    say();
    runtime.addEventListener('pageshow', say);
  } catch {
    // Preview controls must never make otherwise valid renderer HTML fail.
  }
}

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function hotReloadControls(igId, pagePath, generation, contentSha256) {
  const me = scriptJson({ generator: igId, path: pagePath, generation, contentSha256 });
  // Keep `var me=...` as a deliberately simple response diagnostic: the
  // browser gate and field debugging can inspect the exact page binding without
  // evaluating renderer code.
  return `<script data-igpreview="hot-reload">var me=${me};(${installPreviewControls.toString()})(me,${scriptJson(CHANNEL_NAME)});</script>`;
}

export function preparePreviewHtml(rawHtml, previewRoot, igId, pagePath, generation, contentSha256) {
  let html = rawHtml
    .replace(/<script\b[^>]*data-igpreview=["']hot-reload["'][^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<base\b[^>]*data-igpreview=["']base["'][^>]*>/gi, '');
  const base = `<base data-igpreview="base" href="${escapeAttribute(previewUrl(previewRoot, igId, pagePath))}">`;
  const controls = hotReloadControls(igId, pagePath, generation, contentSha256);
  // Base and controls must precede renderer scripts. In particular,
  // history.scrollRestoration must become manual before a slow/background page
  // finishes loading, not at the end of body after its scripts have run.
  const headControls = base + controls;
  html = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (match) => match + headControls)
    : headControls + html;
  return html;
}
