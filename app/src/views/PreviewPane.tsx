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
import { previewUrl } from '../preview/previewWindow';

/** The stock adapter's id — the template picker below only shows for it (#40). */
const STOCK_ID = 'hl7.fhir.template';
/** Sentinel family value that reveals the advanced write-your-own input. */
const ADVANCED = '__advanced__';

interface Props {
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

export function PreviewPane({ adapter, generators, onSelectGenerator, pages, generation, building, error, previewCapable, currentTemplate, onSelectTemplate, templateError, templateCatalogs }: Props) {
  const [current, setCurrent] = useState<string>('index.html');
  const [html, setHtml] = useState<string>('');
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const blobUrls = useRef<string[]>([]);

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

  // Rewrite referenced asset names to blob URLs (adapter-served bytes), then
  // inject the adapter's <base> for statically-served design assets.
  const prepareHtml = useCallback(
    async (raw: string): Promise<string> => {
      for (const u of blobUrls.current) URL.revokeObjectURL(u);
      blobUrls.current = [];

      // Collect candidate relative refs (skip absolute URLs, anchors, data:).
      const names = new Set<string>();
      const collect = (val: string) => {
        const base = val.split(/[?#]/)[0];
        if (!base || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(base)) return;
        names.add(base);
      };
      for (const m of raw.matchAll(/\b(?:src|href)=(["'])([^"']+)\1/g)) collect(m[2]);
      for (const m of raw.matchAll(/\bsrcset=(["'])([^"']+)\1/g)) {
        for (const part of m[2].split(',')) collect(part.trim().split(/\s+/)[0] ?? '');
      }

      const urlByName = new Map<string, string>();
      for (const name of names) {
        const a = await adapter.assetBytes(name).catch(() => null);
        if (!a) continue;
        const bin = atob(a.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
        urlByName.set(name, url);
        blobUrls.current.push(url);
      }

      let out = raw.replace(/\b(src|href)=(["'])([^"']+)\2/g, (m: string, attr: string, q: string, val: string) => {
        const base = val.split(/[?#]/)[0];
        if (urlByName.has(base)) return `${attr}=${q}${urlByName.get(base)}${q}`;
        return m;
      });
      out = out.replace(/\bsrcset=(["'])([^"']+)\1/g, (_m: string, q: string, val: string) => {
        const rewritten = val
          .split(',')
          .map((part: string) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            const base = u.split(/[?#]/)[0];
            return urlByName.has(base) ? [urlByName.get(base), ...rest].join(' ') : part.trim();
          })
          .join(', ');
        return `srcset=${q}${rewritten}${q}`;
      });

      if (adapter.baseHref) {
        const baseTag = `<base href="${adapter.baseHref}">`;
        if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
        else out = baseTag + out;
      }
      return out;
    },
    [adapter],
  );

  // Render the current page whenever it changes or the site rebuilds.
  useEffect(() => {
    let cancelled = false;
    if (!pages || !pages.some((p) => p.file === current)) {
      setHtml('');
      return;
    }
    setRendering(true);
    setRenderErr(null);
    (async () => {
      try {
        const res = await adapter.renderPage(current);
        if (cancelled) return;
        const prepared = await prepareHtml(res.html);
        if (cancelled) return;
        setHtml(prepared);
        setRenderMs(res.renderMs ?? null);
      } catch (e) {
        if (!cancelled) setRenderErr(String(e));
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, pages, generation]);

  useEffect(() => () => {
    for (const u of blobUrls.current) URL.revokeObjectURL(u);
  }, []);

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
          {building ? 'rebuilding…' : rendering ? 'rendering…' : renderErr ? 'render error' : renderMs != null ? `rendered in ${renderMs.toFixed(0)} ms` : ''}
        </span>
        <span className="preview-note" title="render-on-demand per visible page">on-demand render</span>
        <button
          className="preview-open-window"
          disabled={!previewCapable}
          title={
            previewCapable
              ? 'Open this page as a real site in a new browser tab (live navigation + hot reload)'
              : 'Preview window needs a Service Worker (unavailable in this browser/context)'
          }
          onClick={() => {
            if (!previewCapable) return;
            window.open(previewUrl(adapter.id, current), '_blank', 'noopener');
          }}
        >
          Open site in new window ↗
        </button>
      </div>
      {renderErr ? (
        <div className="preview-error"><pre>{renderErr}</pre></div>
      ) : (
        <iframe
          className="preview-frame"
          title="IG page preview"
          sandbox="allow-same-origin"
          srcDoc={html}
        />
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
