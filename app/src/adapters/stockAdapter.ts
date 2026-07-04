// The stock FHIR IG template as a SiteGeneratorAdapter — the Rust renderer
// (F5 page pass) behind the Adapter API v1 shim. ONE wasm renderer drives ANY
// `template#version` (#40): the template package chain is DATA, materialized by
// the engine's loader — either LIVE (resolve→fetch→mount→Session.mountTemplate)
// or from a committed `fig packages bundle --template` warm-start artifact (both
// mount the byte-identical tree). The IG layer (pages/_data/txcache/IG fragments)
// is the packed `{projectId}-stock.json`; the template layer overlays it, so the
// loader-produced template is authoritative. Fragment kinds regenerate LIVE from
// the current compile (engine-first include order); staged copies only serve
// kinds the engine does not produce yet (documented gaps, e.g. instance -html
// narrative, F4b).

import type { AdapterContext, PageInfo, SiteGeneratorAdapter } from './types';
import type { EngineClient } from '../worker/client';
import type { SiteTreeFile } from '../worker/protocol';

/** The default stock template#version (US Core / cycle render at parity with it).
 *  Matches the curated default family + the committed warm-start artifact under
 *  data/templates/. The App may set any other coord via setTemplate (the selector
 *  defaults to the family's LATEST PUBLISHED version once the catalog loads). */
const DEFAULT_TEMPLATE = 'hl7.fhir.template#1.0.0';

/** An AntHookError surfaced from mountTemplate always contains these substrings
 *  (loader Display text): a custom-ant template we refuse to run in-browser. */
function isAntHookError(msg: string): boolean {
  return /never execute ant|server-side/i.test(msg);
}

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
  // The registry key / selector value the App + E2E gate reference. ONE adapter
  // instance drives every template#version (the coord is state, not the id).
  id = 'hl7.fhir.template';
  get label(): string {
    return `FHIR IG template ${this.templateCoord} (Rust, stock)`;
  }

  private engine: EngineClient | null = null;
  /** The packed IG-layer tree (fetched once per project; mounted ONCE — later
   *  inits merge only the live overlay, keeping the warm-edit path fast). */
  private tree: Record<string, SiteTreeFile> | null = null;
  private treeProject: string | null = null;
  private mountedProject: string | null = null;
  /** The template#version to materialize. Set by the App from the selector
   *  (default = the stock HL7 FHIR IG template). */
  private templateCoord = DEFAULT_TEMPLATE;
  /** The `(project, template)` the template LAYER was last materialized for, so a
   *  template switch (or project change) forces a fresh materialize + re-mount. */
  private mountedTemplateFor: string | null = null;
  /** Multi-language (en/) vs flat page layout — detected from the bundle. */
  private pagePrefix = '';
  private pages: PageInfo[] = [];

  /** Select the template#version to render with (App → selector). Changing it
   *  invalidates the mounted template layer AND forces a full IG re-mount so the
   *  next init re-materializes cleanly. No-op if unchanged. */
  setTemplate(coord: string): void {
    if (coord === this.templateCoord) return;
    this.templateCoord = coord;
    this.mountedTemplateFor = null;
    this.mountedProject = null; // force a full IG-layer re-mount under the new template
  }

  private async ensureTree(projectId: string): Promise<Record<string, SiteTreeFile>> {
    if (this.tree && this.treeProject === projectId) return this.tree;
    const resp = await fetch(`${BASE}data/sites/${projectId}-stock.json`);
    if (!resp.ok) throw new Error(`stock site tree fetch (${projectId}) -> ${resp.status}`);
    this.tree = (await resp.json()) as Record<string, SiteTreeFile>;
    this.treeProject = projectId;
    this.pagePrefix = Object.keys(this.tree).some((k) => k.startsWith('en/')) ? 'en/' : '';
    return this.tree;
  }

  async init(ctx: AdapterContext): Promise<void> {
    this.engine = ctx.engine;
    // Fragment rendering snapshots the compiled SDs; the deferred (r5) bundle
    // is not needed for an R4 IG, but the context closure must be mounted —
    // App's acquireForProject already guarantees that before compile.
    const packed = await this.ensureTree(ctx.project.projectId);
    const fullMount = this.mountedProject !== ctx.project.projectId;
    // LIVE md staging (the publisher's exact transform, verified byte-level on
    // us-core AND cycle F0 builds): each input/pagecontent/<name>.md is staged
    // as (a) a byte-copy at _includes/<name>.md and (b) a CRLF front-matter
    // shim page `{% include template-page-md.html %}`. Overlaying the CURRENT
    // project bytes here makes pagecontent edits live: compile -> re-init ->
    // re-mount -> the page renders from the edited markdown.
    const tree: Record<string, SiteTreeFile> = fullMount ? { ...packed } : {};
    const SHIM = '---\r\n---\r\n{% include template-page-md.html %}';
    for (const [path, b64] of Object.entries(ctx.project.siteFiles)) {
      const m = path.match(/^input\/pagecontent\/([^/]+)\.md$/);
      if (!m) continue;
      const name = m[1];
      // The template's shim resolves `{{page.path | split '.html'}}.md` — the
      // PAGE-DIR-prefixed include name (`en/<name>.md` in multi-language
      // layouts). Mount BOTH forms so flat layouts work too. (The packed
      // bundle can't carry these: they are dynamic include names invisible to
      // the static closure — the live overlay is their ONLY source.)
      tree[`_includes/en/${name}.md`] = { b64 };
      tree[`_includes/${name}.md`] = { b64 };
      const shimKey = `${this.pagePrefix}${name}.html`;
      if (!(shimKey in packed)) tree[shimKey] = SHIM;
    }
    await ctx.engine.mountSite(tree, {
      activeTables: true,
      runUuid: RUN_UUID,
      // engine-first is the default; merge=false only on the FIRST mount of a
      // project (the big packed tree); warm re-inits send just the overlay.
      merge: !fullMount,
    });
    this.mountedProject = ctx.project.projectId;

    // TEMPLATE LAYER (#40). Materialize the selected template#version and overlay
    // it LAST, so the loader-produced template (`_includes/fragment-*.html`,
    // `_includes/template-page*.html`, template assets) is authoritative over any
    // stale copy baked into the packed IG bundle. Materialized once per
    // (project, template); a template switch or project change re-does it.
    //   - WARM path: the committed `fig packages bundle --template` artifact
    //     (already the loader's bytes) mounted via mountSite(merge).
    //   - LIVE path (no committed artifact): resolve→fetch→mount the base chain,
    //     then Session.mountTemplate materializes it into the site tree.
    // Both mount the byte-identical `_includes/*`+`template/*` tree (byte gate).
    const templateKey = `${ctx.project.projectId}::${this.templateCoord}`;
    if (this.mountedTemplateFor !== templateKey || fullMount) {
      try {
        const warm = await ctx.engine.fetchTemplateArtifact(this.templateCoord);
        if (warm) {
          await ctx.engine.mountSite(warm, { activeTables: true, runUuid: RUN_UUID, merge: true });
        } else {
          await ctx.engine.mountTemplateChain(this.templateCoord);
        }
        this.mountedTemplateFor = templateKey;
      } catch (e) {
        const msg = String(e);
        if (isAntHookError(msg)) {
          throw new Error(
            `Template ${this.templateCoord} needs server-side rendering (it wires custom ant hooks, ` +
              `which we never execute in the browser). Pick another template.`,
          );
        }
        throw new Error(`Loading template ${this.templateCoord} failed: ${msg}`);
      }
    }

    const { pages } = await ctx.engine.listSitePages();
    const prefix = this.pagePrefix;
    this.pages = pages
      .filter((p) => (prefix ? p.startsWith(prefix) : !p.includes('/')))
      .map((p) => {
        const name = prefix ? p.slice(prefix.length) : p;
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
