// M2 Preview: the cycle site generator's rendered IG pages, produced IN THE
// BROWSER from a Rust-built site.db (wasm build_site_db -> JS row store -> React
// SSR + liquid in the worker). Edit FSH -> the rendered page updates.
//
// Render-on-demand per visible page (M2 scope, honest per spec §7): selecting a
// page or recompiling re-renders only the CURRENT page, not the whole site.
//
// The rendered HTML references design assets as `assets/cycle/*.css`,
// `assets/fonts/*`, `assets/project.css`, `assets/cycle-mark.svg` (copied to
// public/data/cycle/site-assets/ at build time) and IG images as `X.png`. We inject
// a <base> for the design assets and rewrite image src/href to worker-served blob
// URLs, then show it all in a sandboxed iframe.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EngineClient } from '../worker/client';
import type { PagePreviewDescriptor, SitePreviewResult } from '../worker/protocol';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
const SITE_ASSETS = `${BASE}data/cycle/site-assets/`;

interface Props {
  engine: EngineClient;
  /** The site build result (page list + asset names) for the current compile. */
  site: SitePreviewResult | null;
  building: boolean;
  error: string | null;
}

export function PreviewPane({ engine, site, building, error }: Props) {
  const [current, setCurrent] = useState<string>('index.html');
  const [html, setHtml] = useState<string>('');
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [renderErr, setRenderErr] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const blobUrls = useRef<string[]>([]);

  // Keep the selected page valid when the page list changes.
  useEffect(() => {
    if (!site) return;
    if (!site.pages.some((p) => p.file === current)) {
      const fallback = site.pages.find((p) => p.file === 'index.html') ?? site.pages[0];
      if (fallback) setCurrent(fallback.file);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [site]);

  const assetNames = useMemo(() => new Set((site?.assets ?? []).map((a) => a.name)), [site]);

  // Build blob URLs for the site.db assets this page might reference (images),
  // then rewrite src/href in the HTML to those + the <base> for design assets.
  const prepareHtml = useCallback(
    async (raw: string): Promise<string> => {
      // Revoke prior blob URLs.
      for (const u of blobUrls.current) URL.revokeObjectURL(u);
      blobUrls.current = [];

      const urlByName = new Map<string, string>();
      for (const name of assetNames) {
        const a = await engine.assetBytes(name);
        if (!a) continue;
        const bin = atob(a.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: a.mime }));
        urlByName.set(name, url);
        blobUrls.current.push(url);
      }

      // Rewrite src="X" / srcset="X ..." for IG image assets to blob URLs.
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

      // Inject a <base> so design assets (assets/cycle/*.css, fonts, marks) resolve
      // against the copied site-assets dir. Insert right after <head> (or the doctype).
      const baseTag = `<base href="${SITE_ASSETS}">`;
      if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${baseTag}`);
      else out = baseTag + out;
      return out;
    },
    [assetNames, engine],
  );

  // Render the current page whenever it changes or the site rebuilds.
  useEffect(() => {
    let cancelled = false;
    if (!site || !site.pages.some((p) => p.file === current)) {
      setHtml('');
      return;
    }
    setRendering(true);
    setRenderErr(null);
    (async () => {
      try {
        const res = await engine.renderPage(current);
        if (cancelled) return;
        const prepared = await prepareHtml(res.html);
        if (cancelled) return;
        setHtml(prepared);
        setRenderMs(res.renderMs);
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
  }, [current, site]);

  useEffect(() => () => {
    for (const u of blobUrls.current) URL.revokeObjectURL(u);
  }, []);

  if (error) {
    return <div className="preview-error">Site build failed:<pre>{error}</pre></div>;
  }
  if (!site) {
    return <div className="panel-empty">{building ? 'Building site preview…' : 'No site preview yet.'}</div>;
  }

  return (
    <div className="preview">
      <div className="preview-bar">
        <label className="preview-page-select">
          Page&nbsp;
          <select value={current} onChange={(e) => setCurrent(e.target.value)}>
            {groupPages(site.pages).map((g) => (
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
        <span className="preview-note" title="M2: render-on-demand per visible page">on-demand render</span>
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

function groupPages(pages: PagePreviewDescriptor[]) {
  const order: PagePreviewDescriptor['kind'][] = ['narrative', 'artifacts', 'profile', 'valueset', 'codesystem', 'example', 'generic'];
  const labels: Record<PagePreviewDescriptor['kind'], string> = {
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
