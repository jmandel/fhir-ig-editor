// The stock FHIR IG template as a SiteGeneratorAdapter — the Rust renderer
// (F5 page pass) behind the Adapter API v1 shim. ONE wasm renderer, template
// bundles as DATA: this entry mounts the packed publisher-staged site tree
// (template scripts, statics, _data, txcache) and renders pages through
// Session.renderPage. Fragment kinds regenerate LIVE from the current compile
// (engine-first include order); staged copies only serve kinds the engine
// does not produce yet (documented gaps, e.g. instance -html narrative, F4b).

import type { AdapterContext, PageInfo, SiteGeneratorAdapter } from './types';
import type { EngineClient } from '../worker/client';
import type { SiteTreeFile } from '../worker/protocol';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** Deterministic HierarchicalTableGenerator uuid (run-context quirk class):
 *  fixed so re-renders are stable and cache keys hash cleanly. */
const RUN_UUID = 'e0e0e0e0-0000-4000-8000-igeditor0000';

function mimeFor(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      css: 'text/css',
      js: 'text/javascript',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      eot: 'application/vnd.ms-fontobject',
      html: 'text/html',
      json: 'application/json',
    }[ext] ?? 'application/octet-stream'
  );
}

function classify(name: string): PageInfo['kind'] {
  if (name.startsWith('StructureDefinition-')) return 'profile';
  if (name.startsWith('ValueSet-')) return 'valueset';
  if (name.startsWith('CodeSystem-')) return 'codesystem';
  if (name === 'artifacts.html') return 'artifacts';
  if (/^[A-Z][A-Za-z]+-/.test(name)) return 'example';
  return 'narrative';
}

class StockTemplateAdapter implements SiteGeneratorAdapter {
  id = 'hl7.fhir.template';
  label = 'FHIR IG template (Rust, stock)';

  private engine: EngineClient | null = null;
  /** The packed site tree (fetched once; re-mounted per compile generation). */
  private tree: Record<string, SiteTreeFile> | null = null;
  private pages: PageInfo[] = [];

  private async ensureTree(): Promise<Record<string, SiteTreeFile>> {
    if (this.tree) return this.tree;
    const resp = await fetch(`${BASE}data/sites/cycle-stock.json`);
    if (!resp.ok) throw new Error(`stock site tree fetch -> ${resp.status}`);
    this.tree = (await resp.json()) as Record<string, SiteTreeFile>;
    return this.tree;
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.engine = ctx.engine;
    // Fragment rendering snapshots the compiled SDs; the deferred (r5) bundle
    // is not needed for an R4 IG, but the context closure must be mounted —
    // App's acquireForProject already guarantees that before compile.
    const tree = await this.ensureTree();
    await ctx.engine.mountSite(tree, {
      activeTables: true,
      runUuid: RUN_UUID,
      // engine-first is the default; stated for the contrast with cycle.
    });
    const { pages } = await ctx.engine.listSitePages();
    this.pages = pages
      .filter((p) => p.startsWith('en/'))
      .map((p) => {
        const name = p.slice(3);
        return { file: p, title: name.replace(/\.html$/, ''), kind: classify(name) };
      });
  }

  async listPages(): Promise<PageInfo[]> {
    return this.pages;
  }

  async renderPage(file: string): Promise<{ html: string; renderMs?: number }> {
    if (!this.engine) throw new Error('stock adapter not initialized');
    return this.engine.renderSitePage(file);
  }

  /** Serve assets straight from the packed tree (the pages reference them
   *  relative to the page dir; the preview rewrites to blob URLs by name). */
  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null> {
    const tree = this.tree;
    if (!tree) return null;
    // Page-relative names resolve against en/ first, then the tree root.
    const entry = tree[`en/${name}`] ?? tree[name] ?? tree[`assets/${name.replace(/^assets\//, '')}`];
    if (entry == null) return null;
    const base64 =
      typeof entry === 'string' ? btoa(unescape(encodeURIComponent(entry))) : entry.b64;
    return { name, mime: mimeFor(name), base64 };
  }
}

export const stockAdapter = new StockTemplateAdapter();
