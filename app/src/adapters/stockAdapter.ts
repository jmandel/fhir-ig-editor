// The stock FHIR IG template as a SiteGeneratorAdapter — SOURCE-DRIVEN (task #45).
// ONE wasm renderer drives ANY `template#version` (#40): the template package
// chain is DATA, materialized by the engine's loader (LIVE resolve→fetch→mount→
// Session.mountTemplate, or a committed warm-start artifact — both mount the
// byte-identical tree). The IG layer (per-artifact page SHELLS + the `_data`
// site-data model) is no longer a pre-baked `{projectId}-stock.json` bundle: it
// is SYNTHESIZED from the CURRENT compile + the mounted template's
// `config.json`/`layouts` by `Session.produceStockSite` (crates/site_producer).
// Pagecontent, IG-authored `input/includes`/`input/data`, and images are staged
// live from the project source. Fragment kinds regenerate LIVE from the current
// compile (engine-first include order); staged copies only serve kinds the
// engine does not produce yet (documented gaps, e.g. instance -html narrative).

import type { AdapterContext, PageInfo, SiteGeneratorAdapter } from './types';
import type { EngineClient } from '../worker/client';
import type { SiteTreeFile } from '../worker/protocol';

/** The default stock template#version (US Core / IPS / cycle render at parity
 *  with it). Matches the curated default family + the committed warm-start
 *  artifact under data/templates/. The App may set any other coord via
 *  setTemplate (the selector defaults to the family's LATEST PUBLISHED version
 *  once the catalog loads). */
const DEFAULT_TEMPLATE = 'hl7.fhir.template#1.0.0';

/** An AntHookError surfaced from mountTemplate always contains these substrings
 *  (loader Display text): a custom-ant template we refuse to run in-browser. */
function isAntHookError(msg: string): boolean {
  return /never execute ant|server-side/i.test(msg);
}

/** Deterministic HierarchicalTableGenerator uuid (run-context quirk class):
 *  fixed so re-renders are stable and cache keys hash cleanly. */
const RUN_UUID = 'e0e0e0e0-0000-4000-8000-igeditor0000';

/** CRLF front-matter shim that turns a staged pagecontent `<name>.md` into a
 *  narrative PAGE: the template's `template-page-md.html` resolves
 *  `{{page.path | split '.html'}}.md` — the page-dir-prefixed include name. */
const PAGE_MD_SHIM = '---\r\n---\r\n{% include template-page-md.html %}';

/** Pagecontent md whose basename ends with one of these suffixes is an
 *  auto-INCLUDE (fragment-intro/notes/etc. pull it into an artifact page), NOT a
 *  standalone narrative page — so it gets an `_includes` copy but no page shim.
 *  Mirrors the publisher's artifact-fragment naming convention. */
const FRAGMENT_SUFFIXES = ['intro', 'introduction', 'notes', 'search', 'summary', 'examples'];

function isFragmentInclude(name: string): boolean {
  return FRAGMENT_SUFFIXES.some((s) => name.endsWith(`-${s}`));
}

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

/** A small, self-contained inline notice shown when a page's content fragments
 *  can't materialize at render time (packages still loading / blocked), in place
 *  of a silently empty body. */
function gapNoticeHtml(n: number): string {
  const frag = `${n} fragment${n === 1 ? '' : 's'}`;
  return (
    `<div role="status" style="margin:0 0 14px;padding:10px 14px;border:1px solid #d98c00;` +
    `border-left-width:4px;border-radius:4px;background:#fff6e6;color:#7a4d00;` +
    `font:13px/1.5 system-ui,sans-serif;">` +
    `<strong>${frag} unavailable</strong> — packages are still loading or were blocked, ` +
    `so this page's content could not be generated yet. It will fill in once the ` +
    `required packages finish downloading (or are provided for an offline/blocked network).` +
    `</div>`
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

/** The fragment kind whose materialization proves a page's body content is
 *  present — probed for the fragment-gap notice when the rendered HTML carries
 *  no hierarchy table (the source-driven adapter has no page source to scan, so
 *  it probes the page's primary content fragment by kind). */
function probeKindFor(kind: PageInfo['kind']): string | null {
  switch (kind) {
    case 'profile':
      return 'snapshot';
    case 'valueset':
      return 'expansion';
    case 'codesystem':
      return 'content';
    default:
      return null; // narrative/example/artifacts carry no own-resource content fragment
  }
}

class StockTemplateAdapter implements SiteGeneratorAdapter {
  // The registry key / selector value the App + E2E gate reference. ONE adapter
  // instance drives every template#version (the coord is state, not the id).
  id = 'hl7.fhir.template';
  get label(): string {
    return `FHIR IG template ${this.templateCoord} (Rust, stock, source-driven)`;
  }

  private engine: EngineClient | null = null;
  /** The `(project, template)` the site tree was last fully mounted for, so a
   *  project or template switch forces a clean rebuild; a warm re-init (same
   *  project+template) keeps the template layer and only re-produces the
   *  compile-derived shells+_data + re-stages the (possibly edited) source. */
  private mountedFor: string | null = null;
  /** The template#version to materialize. Set by the App from the selector
   *  (default = the stock HL7 FHIR IG template). */
  private templateCoord = DEFAULT_TEMPLATE;
  /** Multi-language (en/) vs flat page layout — DETECTED from the produced
   *  shells (the producer emits the template's staging prefix). */
  private pagePrefix = '';
  private pages: PageInfo[] = [];
  /** Assets served to the preview iframe: the warm template artifact's static
   *  files (css/js/images) + the project's own input/images, keyed by name. */
  private assets: Record<string, SiteTreeFile> = {};

  /** Select the template#version to render with (App → selector). Changing it
   *  forces a clean rebuild on the next init. No-op if unchanged. */
  setTemplate(coord: string): void {
    if (coord === this.templateCoord) return;
    this.templateCoord = coord;
    this.mountedFor = null; // force a full rebuild under the new template
  }

  /** Mount the template#version's tree (config.json + layouts + _includes +
   *  assets) into the engine site tree — WARM (committed artifact) or LIVE
   *  (resolve→fetch→mount→materialize). Both mount the byte-identical tree. */
  private async mountTemplateLayer(engine: EngineClient): Promise<void> {
    try {
      const warm = await engine.fetchTemplateArtifact(this.templateCoord);
      if (warm) {
        await engine.mountSite(warm, { activeTables: true, runUuid: RUN_UUID, merge: true });
        // Keep the template's static assets (css/js/images) for the preview.
        for (const [k, v] of Object.entries(warm)) {
          const m = k.match(/^template\/(?:content\/|assets\/)?(.+)$/) || k.match(/^_includes\/(.+\.(?:css|js|png|svg|jpg|jpeg|gif|ico|woff2?|ttf))$/i);
          if (m) this.assets[m[1]] = v;
        }
      } else {
        // LIVE path: fetch+mount the base chain, then materialize into the tree.
        await engine.mountTemplateChain(this.templateCoord);
        // (Live path template assets live only in the engine tree; the preview
        // renders content correctly but design assets may be unstyled — a
        // documented cosmetic limitation of the live path, not a content gap.)
      }
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

  async init(ctx: AdapterContext): Promise<void> {
    const engine = ctx.engine;
    this.engine = engine;
    const key = `${ctx.project.projectId}::${this.templateCoord}`;
    const fullMount = this.mountedFor !== key;

    if (fullMount) {
      // Clean slate: REPLACE the mounted site tree (drops any prior project's
      // shells/_data/template), then re-establish the template layer. The
      // compile already ran (App compiles before adapter.init), so the engine's
      // render set (compiled + predefined resources incl. the IG) is ready.
      this.assets = {};
      await engine.mountSite({}, { activeTables: true, runUuid: RUN_UUID, merge: false });
      await this.mountTemplateLayer(engine);
    }

    // SOURCE-DRIVEN IG LAYER: synthesize the per-artifact page shells + the
    // `_data` site-data model from the current compile + mounted template. This
    // replaces the pre-baked `{projectId}-stock.json` bundle. Re-run every init
    // so edits (new/changed resources) reflect in the shells + _data.
    await engine.produceStockSite();

    // Detect the page prefix (en/ vs flat) from the produced shells: the
    // producer emits at the template's staging prefix.
    const shellPages = (await engine.listSitePages()).pages;
    this.pagePrefix = shellPages.some((p) => p.startsWith('en/')) ? 'en/' : '';

    // LIVE staging of the project SOURCE: pagecontent (md → include copies +
    // narrative page shims), IG-authored input/includes/* → _includes/*, and
    // input/data/* → _data/*. Overlaying the CURRENT project bytes here makes
    // pagecontent/data edits live: compile → re-init → re-produce → re-stage.
    const overlay: Record<string, SiteTreeFile> = {};
    for (const [path, b64] of Object.entries(ctx.project.siteFiles)) {
      // Collect images for the preview asset server (page-relative names).
      const img = path.match(/^input\/images\/(.+)$/);
      if (img) {
        this.assets[img[1]] = { b64 };
        continue;
      }
      // IG-authored site.data files (us_core_reqs.csv, *.json, *.yml, …).
      const data = path.match(/^input\/data\/(.+)$/);
      if (data) {
        overlay[`_data/${data[1]}`] = { b64 };
        continue;
      }
      // IG-authored liquid includes/fragments (custom chrome).
      const inc = path.match(/^input\/includes\/(.+)$/);
      if (inc) {
        overlay[`_includes/${inc[1]}`] = { b64 };
        continue;
      }
      // Pagecontent markdown: stage as an include (so fragment-intro/notes and
      // the page-md shim resolve it) under BOTH the page-dir-prefixed and flat
      // names, and — for a standalone narrative page — a front-matter shim page.
      const md = path.match(/^input\/pagecontent\/([^/]+)\.md$/);
      if (md) {
        const name = md[1];
        overlay[`_includes/${this.pagePrefix}${name}.md`] = { b64 };
        overlay[`_includes/${name}.md`] = { b64 };
        if (!isFragmentInclude(name)) {
          overlay[`${this.pagePrefix}${name}.html`] = PAGE_MD_SHIM;
        }
      }
    }
    if (Object.keys(overlay).length) {
      await engine.mountSite(overlay, { activeTables: true, runUuid: RUN_UUID, merge: true });
    }
    this.mountedFor = key;

    const { pages } = await engine.listSitePages();
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
    const out = await this.engine.renderSitePage(file);
    // Fragment-gap UX: page BODIES are fragments materialized from the CURRENT
    // compile (snapshot/diff/binding tables from compiled SDs). When the compile
    // is incomplete — packages still loading, or blocked on a denied network —
    // those fragments can't materialize; the publisher's include mechanism emits
    // NOTHING for a miss, so the page renders title-only with a SILENTLY empty
    // body. Surface it: probe this page's own-resource content fragment and, if
    // the engine can't produce it, prepend a small visible inline notice.
    try {
      const gaps = await this.countFragmentGaps(file, out.html);
      if (gaps > 0) return { html: gapNoticeHtml(gaps) + out.html, renderMs: out.renderMs };
    } catch {
      /* gap-probe is best-effort UX; never fail a render over it */
    }
    return out;
  }

  /** Whether this page's primary content fragment fails to materialize now.
   *  Fast path: a materialized snapshot/diff table (HierarchicalTableGenerator)
   *  means the compile fed this page — no gap. Otherwise probe the page's
   *  own-resource content fragment (derived from the page filename + kind, since
   *  the source-driven adapter has no page source to scan); a GAP throws. */
  private async countFragmentGaps(file: string, renderedHtml: string): Promise<number> {
    const engine = this.engine;
    if (!engine) return 0;
    if (/class="?hierarchy"?/.test(renderedHtml)) return 0;
    const name = file.slice(file.lastIndexOf('/') + 1);
    const kind = probeKindFor(classify(name));
    if (!kind) return 0;
    const ref = name.replace(/\.html$/, ''); // "StructureDefinition-us-core-patient"
    try {
      await engine.renderFragment(ref, kind);
      return 0;
    } catch {
      return 1; // FragError::Gap / NoSuchResource — the fragment can't render now
    }
  }

  /** Serve assets the rendered HTML references by name (template css/js/images +
   *  the project's own input/images); the preview rewrites to blob URLs by name. */
  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null> {
    const key = name.replace(/^(?:\.\.\/)+/, '').replace(/^assets\//, '');
    const entry =
      this.assets[name] ?? this.assets[key] ?? this.assets[`assets/${key}`] ?? this.assets[key.slice(key.lastIndexOf('/') + 1)];
    if (entry == null) return null;
    const base64 =
      typeof entry === 'string' ? btoa(unescape(encodeURIComponent(entry))) : entry.b64;
    return { name, mime: mimeFor(name), base64 };
  }
}

export const stockAdapter = new StockTemplateAdapter();
