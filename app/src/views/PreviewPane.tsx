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
import { previewUrl } from '../preview/previewWindow';

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
}

export function PreviewPane({ adapter, generators, onSelectGenerator, pages, generation, building, error, previewCapable }: Props) {
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

  const selector = (
    <label className="preview-generator-select" title="Site generator / template">
      Template&nbsp;
      <select value={adapter.id} onChange={(e) => onSelectGenerator(e.target.value)}>
        {generators.map((g) => (
          <option key={g.id} value={g.id}>{g.label}</option>
        ))}
      </select>
    </label>
  );

  if (error) {
    return (
      <div className="preview">
        <div className="preview-bar">{selector}</div>
        <div className="preview-error">Site build failed:<pre>{error}</pre></div>
      </div>
    );
  }
  if (!pages) {
    return (
      <div className="preview">
        <div className="preview-bar">{selector}</div>
        <div className="panel-empty">{building ? 'Building site preview…' : 'No site preview yet.'}</div>
      </div>
    );
  }

  return (
    <div className="preview">
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
