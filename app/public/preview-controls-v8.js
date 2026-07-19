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
      let stopped = false;
      let observer = null;
      let layoutRevision = 0;
      let stabilityCheckPending = false;
      const priorRestoration = history.scrollRestoration;
      history.scrollRestoration = 'manual';

      const removePosition = () => {
        try {
          runtime.sessionStorage.removeItem(scrollKey);
        } catch {
          // Storage is an optimization; scroll restoration remains best effort.
        }
      };
      const finish = (consumePosition) => {
        if (stopped) return;
        stopped = true;
        if (consumePosition) removePosition();
        observer?.disconnect();
        for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
          runtime.removeEventListener(event, cancelForUser, true);
        }
        runtime.removeEventListener('scroll', correctLateScroll, true);
        runtime.removeEventListener('resize', layoutSignal, true);
        runtime.removeEventListener('load', layoutSignal, true);
        runtime.removeEventListener('pageshow', layoutSignal, true);
        runtime.removeEventListener('pagehide', abandon, true);
        runtime.removeEventListener('unload', abandon, true);
        document.removeEventListener('DOMContentLoaded', layoutSignal, true);
        document.removeEventListener('readystatechange', layoutSignal, true);
        history.scrollRestoration = priorRestoration;
      };
      const abandon = () => finish(false);
      const cancelForUser = (event) => {
        // Synthetic page events must not cancel restoration. A real gesture
        // means the user has taken ownership and must win immediately.
        if (event.isTrusted) finish(true);
      };
      const effectiveTarget = () => {
        // Once loading is complete, an old position can be beyond a now-shorter
        // document. Treat the browser's real scroll extent as the reachable
        // target instead of retaining an impossible restoration forever.
        if (document.readyState !== 'complete') return position;
        const root = document.scrollingElement || document.documentElement;
        const maxX = Number.isFinite(root?.scrollWidth) && Number.isFinite(root?.clientWidth)
          ? Math.max(0, root.scrollWidth - root.clientWidth)
          : position.x;
        const maxY = Number.isFinite(root?.scrollHeight) && Number.isFinite(root?.clientHeight)
          ? Math.max(0, root.scrollHeight - root.clientHeight)
          : position.y;
        return { x: Math.min(position.x, maxX), y: Math.min(position.y, maxY) };
      };
      const atTarget = () => {
        const target = effectiveTarget();
        return Math.abs(runtime.scrollX - target.x) <= 2
          && Math.abs(runtime.scrollY - target.y) <= 2;
      };
      const confirmStableTarget = () => {
        if (stopped || stabilityCheckPending || document.readyState !== 'complete' || !atTarget()) return;
        const requestFrame = runtime.requestAnimationFrame;
        if (typeof requestFrame !== 'function') {
          // `complete` is the strongest observable readiness boundary in a
          // non-visual runtime. Browsers take the two-frame path below.
          finish(true);
          return;
        }
        stabilityCheckPending = true;
        const candidateRevision = layoutRevision;
        requestFrame.call(runtime, () => {
          if (stopped) return;
          if (candidateRevision !== layoutRevision || !atTarget()) {
            stabilityCheckPending = false;
            confirmStableTarget();
            return;
          }
          // The first frame applies pending layout and scroll work; a second
          // frame confirms that the target survived the resulting paint.
          requestFrame.call(runtime, () => {
            stabilityCheckPending = false;
            if (!stopped
              && candidateRevision === layoutRevision
              && document.readyState === 'complete'
              && atTarget()) {
              finish(true);
            } else {
              confirmStableTarget();
            }
          });
        });
      };
      const attempt = () => {
        if (stopped) return;
        const target = effectiveTarget();
        runtime.scrollTo(target.x, target.y);
        confirmStableTarget();
      };
      function layoutSignal() {
        if (stopped) return;
        layoutRevision += 1;
        attempt();
      }
      function correctLateScroll() {
        // A template script can scroll after load without changing layout. Real
        // user input is caught first by cancelForUser; other late scrolls are
        // part of page initialization and must not beat hot-reload restoration.
        if (!stopped && !atTarget()) {
          layoutRevision += 1;
          attempt();
        } else {
          confirmStableTarget();
        }
      }

      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
        runtime.addEventListener(event, cancelForUser, { capture: true, passive: true });
      }
      runtime.addEventListener('scroll', correctLateScroll, true);
      runtime.addEventListener('resize', layoutSignal, true);
      runtime.addEventListener('load', layoutSignal, true);
      runtime.addEventListener('pageshow', layoutSignal, true);
      runtime.addEventListener('pagehide', abandon, true);
      runtime.addEventListener('unload', abandon, true);
      document.addEventListener('DOMContentLoaded', layoutSignal, true);
      document.addEventListener('readystatechange', layoutSignal, true);
      if (typeof runtime.ResizeObserver === 'function') {
        observer = new runtime.ResizeObserver(layoutSignal);
        observer.observe(document.documentElement);
      }
      attempt();
    };

    try {
      const saved = runtime.sessionStorage.getItem(scrollKey);
      if (saved) {
        const position = JSON.parse(saved);
        const valid = Number.isFinite(position.x)
          && position.x >= 0
          && Number.isFinite(position.y)
          && position.y >= 0
          && Number.isSafeInteger(position.targetGeneration)
          && me.generation === position.targetGeneration
          && typeof position.fromContentSha256 === 'string'
          && position.fromContentSha256 !== me.contentSha256;
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
            targetGeneration: message.generation,
            fromContentSha256: me.contentSha256,
          }));
        } catch {
          // Reload still proceeds if session storage is unavailable.
        }
        runtime.location.reload();
      }
    };
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
