// Site preview over one immutable output catalog. The template selector prepares
// a successor handle; the current iframe remains mounted until that successor is
// acknowledged by the preview Service Worker.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutputDescriptor } from '../site/contract';
import { previewUrl, ensurePreviewServiceWorker, PREVIEW_ROOT } from '../preview/previewWindow';

interface Props {
  /** The loaded IG id — the preview URL-scheme key. `preview/<igId>/<path>` is the
   *  SAME URL embedded (iframe src) and external (new tab), so they never diverge. */
  igId: string;
  /** Page descriptors from the last successfully published output catalog. */
  pages: OutputDescriptor[] | null;
  building: boolean;
  error: string | null;
  /** Preview-window (task #37): SW-backed real-tab preview is supported here. */
  previewCapable: boolean | null;
  currentPage?: string;
  onSelectPage?: (path: string) => void;
}

export function PreviewPane({ igId, pages, building, error, previewCapable, currentPage, onSelectPage }: Props) {
  const [localCurrent, setLocalCurrent] = useState<string>('index.html');
  const current = currentPage ?? localCurrent;
  const setCurrent = (path: string) => {
    setLocalCurrent(path);
    onSelectPage?.(path);
  };
  const [loading, setLoading] = useState(false);
  const [swReady, setSwReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The page the iframe is actually showing (parsed from its URL). Prevents a
  // navigation loop: a selector change drives the iframe; a link click inside the
  // iframe drives the selector — both settle here so neither re-fires the other.
  const shownRef = useRef<string>('');
  const previewMounted = pages !== null;

  // Register the preview SW so the EMBEDDED iframe is served the SAME real
  // `preview/<igId>/<path>` URLs as a new tab. Until it controls the scope we can't
  // point the iframe at those URLs (they'd hit the network → 404).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const ok = await ensurePreviewServiceWorker(); // resolves once the SW is ACTIVATED
      if (alive) setSwReady(ok);
    })();
    return () => { alive = false; };
  }, []);

  // Keep the selected page valid when the page list changes.
  useEffect(() => {
    if (!pages) return;
    if (!pages.some((p) => p.path === current)) {
      const fallback =
        pages.find((p) => p.path === 'index.html' || p.path === 'en/index.html') ?? pages[0];
      if (fallback) setCurrent(fallback.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // Selector / IG → navigate the iframe to the SW-served preview URL. Compile
  // generations are handled by the targeted hot-reload channel after the new
  // page is cached; assigning the same iframe src here would cause a second
  // unconditional navigation and discard its scroll position. `previewMounted`
  // covers the distinct case where a template switch temporarily removed and
  // then recreated the iframe: that new DOM node needs its initial navigation.
  useEffect(() => {
    if (!swReady || !igId) return;
    const fr = iframeRef.current;
    if (!fr) return;
    // Navigate only when the iframe isn't already on this page (i.e. `current`
    // was set by the selector, not synced FROM a link click), or the IG changed.
    if (shownRef.current !== current || fr.dataset.igId !== igId) {
      fr.dataset.igId = igId;
      setLoading(true);
      fr.src = previewUrl(igId, current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, igId, swReady, previewMounted]);

  // Sync the selector FROM iframe navigation (link clicks, back/forward): parse the
  // iframe's URL back to a page path. Same-origin (preview/ is under the app origin),
  // so reading its location is allowed.
  const onIframeLoad = useCallback(() => {
    setLoading(false);
    const prefix = `${PREVIEW_ROOT}${encodeURIComponent(igId)}/`;
    try {
      const p = iframeRef.current?.contentWindow?.location?.pathname ?? '';
      if (p.startsWith(prefix)) {
        const page = decodeURIComponent(p.slice(prefix.length));
        shownRef.current = page;
        if (page && page !== current) setCurrent(page);
      }
    } catch {
      /* an external link opened in-frame is cross-origin — leave the selector as-is */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, igId]);

  if (error && !pages) {
    return (
      <div className="preview">
        <div className="preview-error">Site build failed:<pre>{error}</pre></div>
      </div>
    );
  }
  if (!pages) {
    return (
      <div className="preview">
        <div className="panel-empty">{building ? 'Building site preview…' : 'No site preview yet.'}</div>
      </div>
    );
  }

  return (
    <div className="preview">
      {error && (
        <div className="preview-error" role="alert">
          Site rebuild failed; showing the last successful preview.<pre>{error}</pre>
        </div>
      )}
      <div className="preview-bar">
        <label className="preview-page-select">
          Page&nbsp;
          <select value={current} onChange={(e) => setCurrent(e.target.value)}>
            {groupPages(pages).map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.pages.map((p) => (
                  <option key={p.path} value={p.path}>{p.title ?? p.path}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <span className="preview-status">
          {building ? 'rebuilding…' : loading ? 'loading…' : ''}
        </span>
        <span className="preview-note" title="served by the preview Service Worker at this URL">
          {igId ? `preview/${igId}/` : 'preview'}
        </span>
        <button
          className="preview-open-window"
          disabled={previewCapable !== true || !igId}
          title={
            previewCapable === true
              ? 'Open this exact URL as a real site in a new browser tab (same content, live navigation)'
              : previewCapable === false
                ? 'Preview window needs a Service Worker (unavailable in this browser/context)'
                : 'Checking preview support…'
          }
          onClick={() => {
            if (previewCapable !== true || !igId) return;
            // The SAME URL the embedded iframe shows — internal == external.
            window.open(previewUrl(igId, current), '_blank', 'noopener');
          }}
        >
          Open site in new window ↗
        </button>
      </div>
      {swReady ? (
        <iframe
          ref={iframeRef}
          className="preview-frame"
          title="IG page preview"
          sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms"
          onLoad={onIframeLoad}
        />
      ) : (
        <div className="panel-empty">
          {previewCapable === false
            ? 'Site preview needs a Service Worker (unavailable in this browser/context).'
            : 'Starting preview…'}
        </div>
      )}
    </div>
  );
}

type PageGroupKind = 'narrative' | 'artifacts' | 'profile' | 'valueset' | 'codesystem' | 'example' | 'generic';

function pageGroup(page: OutputDescriptor): PageGroupKind {
  switch (page.pageKind) {
    case 'artifacts':
    case 'profile':
    case 'valueset':
    case 'codesystem':
    case 'example':
    case 'generic':
      return page.pageKind;
    case 'profile-companion':
      return 'profile';
    case 'narrative':
    case 'toc':
    case 'validation':
      return 'narrative';
    default:
      return 'generic';
  }
}

function groupPages(pages: OutputDescriptor[]) {
  const order: PageGroupKind[] = ['narrative', 'artifacts', 'profile', 'valueset', 'codesystem', 'example', 'generic'];
  const labels: Record<PageGroupKind, string> = {
    narrative: 'Pages',
    artifacts: 'Index',
    profile: 'Profiles',
    valueset: 'Value sets',
    codesystem: 'Code systems',
    example: 'Examples',
    generic: 'Resources',
  };
  return order
    .map((kind) => ({ label: labels[kind], pages: pages.filter((page) => pageGroup(page) === kind) }))
    .filter((g) => g.pages.length);
}
