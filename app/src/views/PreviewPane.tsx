// Site preview over a SiteGeneratorAdapter (Adapter API v1): the template
// selector chooses the generator; pages render on demand (selecting a page or
// recompiling re-renders only the CURRENT page).
//
// Asset handling: rendered HTML references design assets + IG images by
// (relative) name. We rewrite src/href/srcset to blob URLs served by the
// adapter's assetBytes, and inject the adapter's baseHref (when it has one)
// for assets it serves from the app's static tree.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PageInfo, SiteGeneratorAdapter } from '../adapters/types';
import { CURATED_TEMPLATES, isVerified } from '../adapters/templateCatalog';
import type { TemplateCatalog } from '../adapters/templateCatalog';
import { previewUrl, ensurePreviewServiceWorker, PREVIEW_ROOT } from '../preview/previewWindow';

/** The stock adapter's id — the template picker below only shows for it (#40). */
const STOCK_ID = 'hl7.fhir.template';
/** Sentinel family value that reveals the advanced write-your-own input. */
const ADVANCED = '__advanced__';

interface Props {
  /** The loaded IG id — the preview URL-scheme key. `preview/<igId>/<path>` is the
   *  SAME URL embedded (iframe src) and external (new tab), so they never diverge. */
  igId: string;
  adapter: SiteGeneratorAdapter;
  generators: { id: string; label: string }[];
  onSelectGenerator: (id: string) => void;
  /** The adapter's page list for the current compile generation. */
  pages: PageInfo[] | null;
  /** Bumped on every adapter (re)init — re-renders the visible page. */
  generation: number;
  building: boolean;
  error: string | null;
  /** Preview-window (task #37): SW-backed real-tab preview is supported here. */
  previewCapable: boolean;
  /** Live template loader (#40): the currently-selected template `id#version`
   *  and the callback to load another (curated version or advanced coord). */
  currentTemplate: string;
  onSelectTemplate: (coord: string) => void;
  /** A template that failed to load (e.g. custom-ant → needs server-side
   *  rendering); shown as a non-wedging banner, selection falls back. */
  templateError: string | null;
  /** Curated templates' live version catalogs (id → catalog), fetched from the
   *  registry with OPFS/TTL/last-known-good/pinned fallback. The DEFAULT UX: pick
   *  a family + a published version, no typing. Null until first load. */
  templateCatalogs: Record<string, TemplateCatalog> | null;
}

export function PreviewPane({ igId, adapter, generators, onSelectGenerator, pages, generation, building, error, previewCapable, currentTemplate, onSelectTemplate, templateError, templateCatalogs }: Props) {
  const [current, setCurrent] = useState<string>('index.html');
  const [loading, setLoading] = useState(false);
  const [swReady, setSwReady] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // The page the iframe is actually showing (parsed from its URL). Prevents a
  // navigation loop: a selector change drives the iframe; a link click inside the
  // iframe drives the selector — both settle here so neither re-fires the other.
  const shownRef = useRef<string>('');

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
    if (!pages.some((p) => p.file === current)) {
      const fallback =
        pages.find((p) => p.file === 'index.html' || p.file === 'en/index.html') ?? pages[0];
      if (fallback) setCurrent(fallback.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages]);

  // Selector / IG / generation → navigate the iframe to the SW-served preview URL.
  // A new compile generation refreshes the SAME page (the SW re-renders on demand).
  useEffect(() => {
    if (!swReady || !igId) return;
    const fr = iframeRef.current;
    if (!fr) return;
    // Navigate only when the iframe isn't already on this page (i.e. `current` was
    // set by the selector, not synced FROM a link click) — or on a recompile.
    if (shownRef.current !== current || fr.dataset.gen !== String(generation)) {
      fr.dataset.gen = String(generation);
      setLoading(true);
      fr.src = previewUrl(igId, current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, igId, swReady, generation]);

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

  // Template picker (#40 DEFAULT UX): a curated FAMILY select + a VERSION select
  // whose options come LIVE from the registry catalog (newest first, default =
  // latest published) — no typing needed. The free-text `id#version` input is
  // DEMOTED to an "advanced / custom template…" family option (still present —
  // driven means driven, any resolvable template loads via the same loader).
  const isStock = adapter.id === STOCK_ID;
  const [curId, curVer] = splitCoord(currentTemplate);
  const isCurated = CURATED_TEMPLATES.some((t) => t.id === curId);
  // The family <select> value: a curated id, or ADVANCED for custom coords / the
  // advanced affordance. `advancedOpen` forces the advanced input open.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [ownCoord, setOwnCoord] = useState('');
  const familyValue = advancedOpen || !isCurated ? ADVANCED : curId;
  const activeCatalog = templateCatalogs?.[curId] ?? null;
  // Version list for the selected family, newest-first. Ensure the current
  // version is present even if the catalog hasn't loaded / doesn't list it.
  const versions = (() => {
    const vs = activeCatalog?.versions ? [...activeCatalog.versions] : [];
    if (curVer && !vs.includes(curVer)) vs.unshift(curVer);
    return vs;
  })();

  const selector = (
    <span className="preview-generator-controls">
      <label className="preview-generator-select" title="Site generator / template">
        Generator&nbsp;
        <select value={adapter.id} onChange={(e) => onSelectGenerator(e.target.value)}>
          {generators.map((g) => (
            <option key={g.id} value={g.id}>{g.label}</option>
          ))}
        </select>
      </label>
      {isStock && (
        <label className="preview-template-select" title="Stock template family (curated, registry-backed)">
          Template&nbsp;
          <select
            value={familyValue}
            onChange={(e) => {
              const id = e.target.value;
              if (id === ADVANCED) {
                setAdvancedOpen(true);
                setOwnCoord(isCurated ? '' : currentTemplate);
                return;
              }
              setAdvancedOpen(false);
              // Switch families: pick that family's latest published version
              // (its catalog default), falling back to a pinned verified one.
              const cat = templateCatalogs?.[id];
              const ver =
                cat?.latest ??
                cat?.versions[0] ??
                CURATED_TEMPLATES.find((t) => t.id === id)?.verified[0] ??
                '';
              if (ver) onSelectTemplate(`${id}#${ver}`);
            }}
          >
            {CURATED_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
            {!isCurated && <option value={ADVANCED}>{curId || 'custom'} (custom)</option>}
            <option value={ADVANCED}>Advanced / custom template…</option>
          </select>
        </label>
      )}
      {isStock && !advancedOpen && isCurated && (
        <label className="preview-template-version" title="Published version (newest first; ✓ = oracle-verified)">
          Version&nbsp;
          <select
            value={curVer}
            onChange={(e) => onSelectTemplate(`${curId}#${e.target.value}`)}
          >
            {versions.map((v) => (
              <option key={v} value={v}>
                {v}
                {isVerified(curId, v) ? ' ✓ verified' : ''}
                {activeCatalog?.latest === v ? ' (latest)' : ''}
              </option>
            ))}
          </select>
          {activeCatalog?.fromFallback && (
            <span className="preview-template-offline" title="Registry unreachable — showing pinned known-good versions">
              offline
            </span>
          )}
        </label>
      )}
      {isStock && advancedOpen && (
        <span className="preview-template-own" title="Any resolvable template id#version — loads live through the same driven loader">
          <input
            type="text"
            placeholder="id#version (e.g. hl7.fhir.template#0.9.0)"
            value={ownCoord}
            onChange={(e) => setOwnCoord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ownCoord.includes('#')) { onSelectTemplate(ownCoord.trim()); setAdvancedOpen(false); }
            }}
          />
          <button
            className="btn"
            disabled={!ownCoord.includes('#')}
            onClick={() => { onSelectTemplate(ownCoord.trim()); setAdvancedOpen(false); }}
          >
            Load
          </button>
          <button className="btn" onClick={() => setAdvancedOpen(false)} title="Back to curated templates">
            Cancel
          </button>
        </span>
      )}
    </span>
  );

  const templateBanner = templateError ? (
    <div className="preview-template-error" role="alert" title={templateError}>
      ⚠ {templateError}
    </div>
  ) : null;

  if (error) {
    return (
      <div className="preview">
        <div className="preview-bar">{selector}</div>
        {templateBanner}
        <div className="preview-error">Site build failed:<pre>{error}</pre></div>
      </div>
    );
  }
  if (!pages) {
    return (
      <div className="preview">
        <div className="preview-bar">{selector}</div>
        {templateBanner}
        <div className="panel-empty">{building ? 'Building site preview…' : 'No site preview yet.'}</div>
      </div>
    );
  }

  return (
    <div className="preview">
      {templateBanner}
      <div className="preview-bar">
        {selector}
        <label className="preview-page-select">
          Page&nbsp;
          <select value={current} onChange={(e) => setCurrent(e.target.value)}>
            {groupPages(pages).map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.pages.map((p) => (
                  <option key={p.file} value={p.file}>{p.title}</option>
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
          disabled={!previewCapable || !igId}
          title={
            previewCapable
              ? 'Open this exact URL as a real site in a new browser tab (same content, live navigation)'
              : 'Preview window needs a Service Worker (unavailable in this browser/context)'
          }
          onClick={() => {
            if (!previewCapable || !igId) return;
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

/** Split an `id#version` coord into `[id, version]` (version '' if absent). */
function splitCoord(coord: string): [string, string] {
  const h = coord.lastIndexOf('#');
  return h < 0 ? [coord, ''] : [coord.slice(0, h), coord.slice(h + 1)];
}

function groupPages(pages: PageInfo[]) {
  const order: PageInfo['kind'][] = ['narrative', 'artifacts', 'profile', 'valueset', 'codesystem', 'example', 'generic'];
  const labels: Record<PageInfo['kind'], string> = {
    narrative: 'Pages',
    artifacts: 'Index',
    profile: 'Profiles',
    valueset: 'Value sets',
    codesystem: 'Code systems',
    example: 'Examples',
    generic: 'Resources',
  };
  return order
    .map((kind) => ({ label: labels[kind], pages: pages.filter((p) => p.kind === kind) }))
    .filter((g) => g.pages.length);
}
