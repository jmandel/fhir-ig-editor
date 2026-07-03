// The M2 render adapter: cycle's site generator's per-page render path, run in the
// browser Worker. `build.tsx` in the submodule is a top-level Bun SCRIPT (it does
// fs writes + Bun.build + a link check + renders ALL pages), so it can't be called
// directly. This module IMPORTS the submodule's PURE render pieces (Layout, the
// fhir/* page components, core/liquid, core/markdown) and re-implements build.tsx's
// per-page selection + Layout-wrapping as callable functions — no fs, no Bun.
//
// The submodule is read-only; its `core/db` (bun:sqlite) is redirected to our
// `dbShim` via a Vite alias (see vite.config.ts). So importing Layout — which pulls
// in chrome/Menu -> core/db — resolves to our RowStore-backed shim, not a file DB.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Submodule render pieces (pure given props; db access goes through the alias).
import { Layout } from '@cycle/chrome/Layout';
import type { Crumb, TocItem } from '@cycle/chrome/Layout';
import { ProfilePage } from '@cycle/fhir/ProfilePage';
import type { ProfileExampleUse, ProfileRequirement } from '@cycle/fhir/ProfilePage';
import { ArtifactsPage } from '@cycle/fhir/ArtifactsPage';
import { ValueSetPage } from '@cycle/fhir/ValueSetPage';
import { CodeSystemPage } from '@cycle/fhir/CodeSystemPage';
import { ExamplePage } from '@cycle/fhir/ExamplePage';
import { ResourcePage } from '@cycle/fhir/ResourcePage';
import { renderResourceFragment } from '@cycle/fhir/fragments';
import type { ResolveType } from '@cycle/fhir/ElementTable';
import { renderLiquid } from '@cycle/core/liquid';
import { includes } from '@cycle/project/includes';
import { renderMarkdown, sanitizeMarkdownSource } from '@cycle/core/markdown';
import { project } from '@cycle/project';

import * as db from './dbShim';
import { RowStore, type SiteDbRows, type ResourceRow, type MenuRow } from './rowStore';
import { setActiveStore } from './dbShim';

// build.tsx constants ported verbatim.
const RESOURCE_SORT = 'http://hl7.org/fhir/tools/StructureDefinition/resource-sort';
const EXAMPLE_PROFILE_EXTENSION = 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ImplementationGuide.definition.resource.profile';
const PRIMARY_RESOURCE_TYPES = new Set(['StructureDefinition', 'ValueSet', 'CodeSystem', 'ImplementationGuide']);
const PRIMS = new Set(['boolean', 'integer', 'string', 'decimal', 'uri', 'url', 'canonical', 'base64Binary', 'instant', 'date', 'dateTime', 'time', 'code', 'oid', 'id', 'markdown', 'unsignedInt', 'positiveInt', 'uuid', 'xhtml']);
const DTYPES = new Set(['CodeableConcept', 'Coding', 'Quantity', 'Reference', 'Period', 'Identifier', 'Range', 'Ratio', 'Annotation', 'Attachment', 'HumanName', 'Address', 'ContactPoint', 'Timing', 'Money', 'Age', 'Duration', 'SampledData', 'Signature', 'Meta', 'Narrative', 'Extension', 'BackboneElement', 'Element', 'Dosage']);

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One rendered page + the list of pages the site knows about (for the tab list). */
export interface RenderedPage {
  file: string; // e.g. index.html, StructureDefinition-menstrual-flow.html
  html: string;
}

/** A page the preview can show. Kind drives which build.tsx branch renders it. */
export interface PageDescriptor {
  file: string; // <slug>.html or <Type>-<Id>.html
  title: string;
  kind: 'narrative' | 'artifacts' | 'profile' | 'valueset' | 'codesystem' | 'example' | 'generic';
}

// A per-render context bundling everything build.tsx computes once at module top.
class SiteContext {
  meta: Record<string, string>;
  all: ResourceRow[];
  igResource: any;
  byUrl = new Map<string, string>();
  artifactHrefByLocalTarget = new Map<string, string>();
  resourcesByReference = new Map<string, ResourceRow>();
  sortRanks = new Map<string, number>();
  exampleRefs = new Set<string>();
  exampleProfilesByReference = new Map<string, string[]>();
  navMap: Record<string, string> = { index: 'Home', artifacts: 'Artifacts' };
  menuRows: MenuRow[];
  menuById: Map<number, MenuRow>;
  liquidSiteData: Record<string, any>;
  structureDefinitions: ResourceRow[];
  structureDefinitionRowsByUrl = new Map<string, ResourceRow>();
  structureDefinitionDataByUrl = new Map<string, any>();
  derivedProfiles = new Map<string, string[]>();
  artifactsNav: string;

  constructor(public store: RowStore) {
    this.meta = store.metadata();
    this.all = store.resources();
    this.igResource = store.ig();
    for (const r of this.all) if (r.Url) this.byUrl.set(r.Url, this.page(r));
    for (const r of this.all) {
      const href = this.page(r);
      this.artifactHrefByLocalTarget.set(`${r.Type}-${r.Id}`, href);
      this.artifactHrefByLocalTarget.set(`${r.Type}/${r.Id}`, href);
    }
    this.resourcesByReference = new Map(this.all.map((r) => [`${r.Type}/${r.Id}`, r]));
    for (const r of this.igResource.definition?.resource || []) {
      const ref = r.reference?.reference;
      const sort = (r.extension || []).find((e: any) => e.url === RESOURCE_SORT)?.valueInteger;
      if (ref && typeof sort === 'number') this.sortRanks.set(ref, sort);
      if (!ref) continue;
      const profiles = new Set<string>();
      if (r.exampleCanonical) profiles.add(r.exampleCanonical);
      if (Array.isArray(r.profile)) for (const p of r.profile) profiles.add(p);
      for (const ext of r.extension || []) {
        if (ext.url !== EXAMPLE_PROFILE_EXTENSION) continue;
        if (Array.isArray(ext.valueCanonical)) for (const p of ext.valueCanonical) profiles.add(p);
        else if (ext.valueCanonical) profiles.add(ext.valueCanonical);
      }
      if (r.exampleBoolean || r.exampleCanonical || profiles.size) this.exampleRefs.add(ref);
      if (profiles.size) this.exampleProfilesByReference.set(ref, [...profiles]);
    }
    this.liquidSiteData = this.publisherStyleSiteData(this.igResource, this.meta);
    this.menuRows = store.menu();
    this.menuById = new Map(this.menuRows.map((m) => [m.Id, m]));
    for (const m of this.menuRows) {
      if (!m.Href) continue;
      const slug = m.Href.split('#')[0].replace(/\.html$/, '');
      if (slug) this.navMap[slug] = this.topMenuLabel(m);
    }
    this.artifactsNav = this.navMap['artifacts'] || 'Artifacts';
    this.structureDefinitions = this.artifactResources('StructureDefinition');
    this.structureDefinitionRowsByUrl = new Map(this.structureDefinitions.filter((r) => r.Url).map((r) => [r.Url!, r]));
    for (const r of this.structureDefinitions) {
      if (!r.Url) continue;
      const data = this.structureDefinitionData(r);
      const base = data.baseDefinition;
      if (!base || !this.byUrl.has(base)) continue;
      this.derivedProfiles.set(base, [...(this.derivedProfiles.get(base) || []), r.Url]);
    }
  }

  page(r: ResourceRow): string { return `${r.Type}-${r.Id}.html`; }
  resourceReference(r: ResourceRow): string { return `${r.Type}/${r.Id}`; }

  topMenuLabel(row: MenuRow): string {
    let current = row;
    while (current.ParentId != null && this.menuById.has(current.ParentId)) current = this.menuById.get(current.ParentId)!;
    return current.Label;
  }

  isExampleRow(r: ResourceRow): boolean {
    return !PRIMARY_RESOURCE_TYPES.has(r.Type) && this.exampleRefs.has(this.resourceReference(r));
  }
  isGenericResourcePageRow(r: ResourceRow): boolean {
    return !PRIMARY_RESOURCE_TYPES.has(r.Type) && !this.isExampleRow(r);
  }
  artifactRank(r: ResourceRow): number { return this.sortRanks.get(`${r.Type}/${r.Id}`) ?? 100000; }
  byArtifactOrder = (a: ResourceRow, b: ResourceRow): number =>
    this.artifactRank(a) - this.artifactRank(b) || (a.Title || a.Name || a.Id).localeCompare(b.Title || b.Name || b.Id);
  artifactResources(type?: string): ResourceRow[] {
    return this.all.filter((r) => !type || r.Type === type).sort(this.byArtifactOrder);
  }
  exampleResources(): ResourceRow[] { return this.artifactResources().filter((r) => this.isExampleRow(r)); }

  structureDefinitionData(r: ResourceRow): any {
    if (r.Url && this.structureDefinitionDataByUrl.has(r.Url)) return this.structureDefinitionDataByUrl.get(r.Url);
    const data = this.store.parse(r);
    if (r.Url) this.structureDefinitionDataByUrl.set(r.Url, data);
    return data;
  }
  localAuthoredElementChain(data: any): any[] {
    const chain: any[] = [];
    const seen = new Set<string>();
    const visit = (sd: any) => {
      const url = sd?.url;
      if (url) { if (seen.has(url)) return; seen.add(url); }
      const baseRow = sd?.baseDefinition ? this.structureDefinitionRowsByUrl.get(sd.baseDefinition) : undefined;
      if (baseRow) visit(this.structureDefinitionData(baseRow));
      chain.push(...(sd?.differential?.element || []));
    };
    visit(data);
    return chain;
  }
  profileAndDerivedUrls(url: string): Set<string> {
    const out = new Set<string>();
    const walk = (u: string) => {
      if (!u || out.has(u)) return;
      out.add(u);
      for (const child of this.derivedProfiles.get(u) || []) walk(child);
    };
    walk(url);
    return out;
  }
  profileRootRequirements(data: any, rootType: string): ProfileRequirement[] {
    const root = (data.differential?.element || []).find((e: any) => e.path === rootType);
    return (root?.constraint || []).filter((c: any) => c.key && c.human);
  }
  profileExamples(profileUrl: string): ProfileExampleUse[] {
    if (!profileUrl) return [];
    const accepted = this.profileAndDerivedUrls(profileUrl);
    const examples: ProfileExampleUse[] = [];
    for (const r of this.exampleResources()) {
      const profiles = this.exampleProfilesByReference.get(this.resourceReference(r)) || [];
      if (!profiles.some((p) => accepted.has(p))) continue;
      const data = this.store.parse(r);
      const code = JSON.stringify(data, null, 2);
      const direct = profiles.includes(profileUrl);
      const inlineable = direct && r.Type !== 'Bundle' && code.length <= 16000;
      examples.push({
        title: r.Title || r.Name || r.Id,
        href: this.page(r),
        jsonHref: `${r.Type}-${r.Id}.json`,
        count: 1,
        direct,
        resourceTypes: [r.Type],
        ...(inlineable ? { preview: { filename: `${r.Type}-${r.Id}.json`, code } } : {}),
      });
    }
    return examples;
  }

  resolve: ResolveType = (code: string, profileUrl?: string): string => {
    if (profileUrl && this.byUrl.has(profileUrl)) return this.byUrl.get(profileUrl)!;
    if (profileUrl) return profileUrl;
    if (PRIMS.has(code) || DTYPES.has(code)) return `https://hl7.org/fhir/R4/datatypes.html#${code}`;
    return `https://hl7.org/fhir/R4/${code.toLowerCase()}.html`;
  };

  // --- publisherStyleSiteData (build.tsx:182), trimmed of link-only aliases. ---
  private dependencyBaseUrl(dep: any): string | null {
    const raw = String(dep?.uri || '').trim();
    if (!raw) return null;
    const base = raw.replace(/\/ImplementationGuide\/[^/]+$/, '').replace(/\/+$/, '');
    return base || null;
  }
  private dependencyAliases(dep: any): string[] {
    const aliases = new Set<string>();
    const add = (v: unknown) => { const s = String(v || '').trim(); if (s) aliases.add(s); };
    add(dep?.id); add(dep?.packageId);
    const pkg = String(dep?.packageId || '').trim();
    if (pkg) {
      const lastDot = pkg.split('.').at(-1);
      add(lastDot); add(lastDot?.replace(/^davinci-/, '')); add(lastDot?.replace(/-r\d+$/, ''));
      add(pkg.split('-').at(-1));
    }
    return [...aliases].filter((s) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s));
  }
  private publisherStyleSiteData(ig: any, metadata: Record<string, string>): Record<string, any> {
    const ver: Record<string, string> = {};
    for (const dep of ig.dependsOn || []) {
      const base = this.dependencyBaseUrl(dep);
      if (!base) continue;
      for (const alias of this.dependencyAliases(dep)) ver[alias] = base;
    }
    ver.feature ||= 'http://hl7.org/fhir/uv/application-feature';
    return {
      fhir: {
        ...metadata, ig, ver,
        path: metadata.path || 'http://hl7.org/fhir/R4/',
        canonical: metadata.canonical || ig.url?.replace(/\/ImplementationGuide\/[^/]+$/, ''),
        packageId: metadata.packageId || ig.packageId || ig.id,
        igVer: metadata.igVer || ig.version,
        version: metadata.version || ig.fhirVersion?.[0] || '4.0.1',
        genDate: metadata.genDate,
      },
    };
  }

  // build.tsx:147 configuredProfileGroups + profileGroupLabel (sidebar grouping).
  get configuredProfileGroups(): { label: string; ids: string[] }[] {
    return project.profileGroups || [];
  }
  profileGroupLabel(id: string): string | null {
    return this.configuredProfileGroups.find((g) => g.ids.includes(id))?.label || null;
  }

  // --- generated fragments + link rewriting (build.tsx) ---
  simpleNameList(_type: string): string { return '<li class="muted">None.</li>'; }
  generatedFragment(name: string): string | null {
    if (name === 'table-profiles.xhtml') return this.artifactTable('Profile', this.artifactResources('StructureDefinition'));
    return null;
  }
  artifactTable(type: string, rows: ResourceRow[]): string {
    if (!rows.length) return '<p class="muted">None.</p>';
    const body = rows.map((r) => {
      const title = esc(r.Title || r.Name || r.Id);
      const href = this.page(r);
      return `<tr><td><a href="${esc(href)}">${title}</a></td><td>${esc(r.Description || '')}</td></tr>`;
    }).join('');
    return `<div class="table-scroll"><table class="cycle-table"><thead><tr><th>${esc(type)}</th><th>Description</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  liquidAssetInclude = (name: string): string => {
    const generated = this.generatedFragment(name) ?? this.store.textAsset(name);
    if (generated != null) return generated;
    // In the real site build, some `{% include %}` fragments (e.g.
    // `sample-viewer-links.md`) are generated by the SURROUNDING build script and
    // committed into the include dir before rendering — they don't exist in the IG
    // source the editor holds. Rather than fail the whole page (the renderer's
    // fail-loud default), render an honest placeholder so the page still previews.
    return `<div class="ig-editor-missing-include" style="border:1px dashed #b58900;background:#fff8e1;color:#7a5c00;padding:6px 10px;border-radius:4px;font-size:12px;margin:8px 0">Include <code>${name}</code> is generated by the site's build wrapper and isn't part of the IG source — not shown in the in-editor preview.</div>`;
  };

  private FHIR_CORE_DOC = /(\]\(|href=["'])(\.\/)?([a-z][a-z0-9-]+\.html)(#[^)'" ]+)?/gi;
  rewriteCoreFhirDocLinks(markdown: string): string {
    return markdown.replace(this.FHIR_CORE_DOC, (m, prefix, _dot, pageName, anchor = '') => {
      // Keep it conservative: only rewrite well-known core page names.
      return m; // The full core-doc set is large; leaving intra-IG links intact
      // is fine for preview (external links resolve against hl7.org anyway).
      void prefix; void pageName; void anchor;
    });
  }
  rewriteKnownArtifactLinks(markdown: string): string {
    const rewrite = (href: string): string => {
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
      const marker = href.search(/[?#]/);
      const base = marker >= 0 ? href.slice(0, marker) : href;
      const suffix = marker >= 0 ? href.slice(marker) : '';
      const target = this.artifactHrefByLocalTarget.get(base);
      return target ? `${target}${suffix}` : href;
    };
    return markdown
      .replace(/\bhref=(["'])([^"']+)\1/g, (_m, q, href) => `href=${q}${rewrite(href)}${q}`)
      .replace(/(\]\()([^)\s]+)(\))/g, (_m, open, href, close) => `${open}${rewrite(href)}${close}`);
  }
}

// ---- sidebars (ported from build.tsx:348 ArtifactSidebar, verbatim) ----
function ArtifactSidebar({ ctx, current }: { ctx: SiteContext; current: string }): React.ReactNode {
  const sds = ctx.artifactResources('StructureDefinition');
  const terms = [...ctx.artifactResources('ValueSet'), ...ctx.artifactResources('CodeSystem')];
  const configuredProfileGroups = ctx.configuredProfileGroups;
  const groups = configuredProfileGroups.length
    ? configuredProfileGroups
    : [{ label: 'Profiles', ids: sds.map((r) => r.Id) }];
  return (
    <>
      <div className="side-group">
        <div className="side-title">Profiles</div>
        {groups.map((group) => {
          const rows = configuredProfileGroups.length
            ? sds.filter((r) => ctx.profileGroupLabel(r.Id) === group.label)
            : sds;
          if (!rows.length) return null;
          return (
            <React.Fragment key={group.label}>
              {configuredProfileGroups.length ? <div className="side-subtitle">{group.label}</div> : null}
              {rows.map((r) => (
                <a key={r.Id} href={ctx.page(r)} {...(ctx.page(r) === current ? { 'aria-current': 'page' } : {})}>
                  <span style={{ flex: 1 }}>{r.Title || r.Name || r.Id}</span>
                </a>
              ))}
            </React.Fragment>
          );
        })}
      </div>
      <div className="side-group">
        <div className="side-title">Terminology</div>
        {terms.map((r) => (
          <a key={r.Id} href={ctx.page(r)} {...(ctx.page(r) === current ? { 'aria-current': 'page' } : {})}>
            <span style={{ flex: 1 }}>{r.Title || r.Name || r.Id}</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-2xs)', color: 'var(--ink-300)' }}>{r.Type === 'ValueSet' ? 'VS' : 'CS'}</span>
          </a>
        ))}
      </div>
    </>
  );
}

// Wrap a node in Layout + serialize (build.tsx:emit, minus the file write).
function emitHtml(
  ctx: SiteContext,
  node: React.ReactNode,
  opts: { title: string; crumbs?: Crumb[]; toc?: TocItem[]; navActive?: string; sidebar?: React.ReactNode; machineBase?: string; aiSource?: string },
): string {
  return (
    '<!doctype html>\n' +
    renderToStaticMarkup(
      <Layout
        meta={ctx.meta}
        title={opts.title}
        crumbs={opts.crumbs}
        toc={opts.toc}
        navActive={opts.navActive}
        sidebar={opts.sidebar}
        machineBase={opts.machineBase}
        aiSource={opts.aiSource}
        ig={ctx.igResource}
      >
        {node}
      </Layout>,
    )
  );
}

// --- narrative page (build.tsx:486) ---
function renderNarrative(ctx: SiteContext, slug: string, body: string, title: string): string {
  let liquidOut = renderLiquid(body, {
    includes,
    ig: ctx.igResource,
    siteData: ctx.liquidSiteData,
    assetInclude: ctx.liquidAssetInclude,
    sql: (query: string) => ctx.store.query(query),
    fragment: (args: string) =>
      renderResourceFragment(args, (type: string, id: string) => {
        const row = ctx.resourcesByReference.get(`${type}/${id}`);
        return row ? ctx.store.parse(row) : null;
      }, { fhirVersion: ctx.meta.version || ctx.igResource.fhirVersion?.[0] }),
  });
  liquidOut = sanitizeMarkdownSource(ctx.rewriteKnownArtifactLinks(ctx.rewriteCoreFhirDocLinks(liquidOut)));
  const { html, toc } = renderMarkdown(liquidOut);
  return emitHtml(ctx, <div className="cycle-prose" dangerouslySetInnerHTML={{ __html: html }} />, {
    title,
    navActive: ctx.navMap[slug],
    toc: toc.filter((t: any) => t.level === 2).map((t: any) => ({ id: t.id, label: t.label })),
    crumbs: slug === 'index' ? undefined : [{ label: 'Home', href: 'index.html' }, { label: title }],
    aiSource: `${slug}.md`,
  });
}

/** Enumerate every page the preview can show, in a sensible order. */
export function listPages(rows: SiteDbRows): PageDescriptor[] {
  const store = new RowStore(rows);
  setActiveStore(store);
  const ctx = new SiteContext(store);
  const out: PageDescriptor[] = [];
  for (const p of ctx.store.pages()) {
    if (!p.Body) continue;
    out.push({ file: `${p.Slug}.html`, title: p.Title, kind: 'narrative' });
  }
  out.push({ file: 'artifacts.html', title: 'Artifacts', kind: 'artifacts' });
  for (const r of ctx.artifactResources('StructureDefinition')) out.push({ file: ctx.page(r), title: r.Title || r.Name || r.Id, kind: 'profile' });
  for (const r of ctx.artifactResources('ValueSet')) out.push({ file: ctx.page(r), title: r.Title || r.Name || r.Id, kind: 'valueset' });
  for (const r of ctx.artifactResources('CodeSystem')) out.push({ file: ctx.page(r), title: r.Title || r.Name || r.Id, kind: 'codesystem' });
  for (const r of ctx.artifactResources().filter((x) => ctx.isGenericResourcePageRow(x))) {
    if (r.Type === 'ImplementationGuide') continue;
    out.push({ file: ctx.page(r), title: r.Title || r.Name || r.Id, kind: 'generic' });
  }
  for (const r of ctx.exampleResources()) out.push({ file: ctx.page(r), title: r.Title || r.Name || r.Id, kind: 'example' });
  return out;
}

/** Render ONE page by its file name (e.g. index.html, StructureDefinition-x.html). */
export function renderPage(rows: SiteDbRows, file: string): RenderedPage {
  const store = new RowStore(rows);
  setActiveStore(store);
  const ctx = new SiteContext(store);

  // Narrative?
  const slug = file.replace(/\.html$/, '');
  const pageRow = ctx.store.pages().find((p) => p.Slug === slug && p.Body);
  if (pageRow) return { file, html: renderNarrative(ctx, pageRow.Slug, pageRow.Body!, pageRow.Title) };

  if (file === 'artifacts.html') {
    const html = emitHtml(
      ctx,
      <ArtifactsPage
        resources={ctx.artifactResources()}
        page={(r: any) => ctx.page(r)}
        isExample={(r: any) => ctx.isExampleRow(r)}
        profileGroupLabel={(id: string) => ctx.profileGroupLabel(id)}
        profileGroups={ctx.configuredProfileGroups}
      />,
      {
        title: 'Artifacts', navActive: ctx.artifactsNav,
        toc: [{ id: 'profiles', label: 'Profiles' }, { id: 'value-sets', label: 'Value sets' }, { id: 'code-systems', label: 'Code systems' }, { id: 'examples', label: 'Examples' }],
        crumbs: [{ label: 'Home', href: 'index.html' }, { label: 'Artifacts' }],
        sidebar: <ArtifactSidebar ctx={ctx} current="artifacts.html" />,
      },
    );
    return { file, html };
  }

  // Resource-backed page: find its row.
  const row = ctx.all.find((r) => ctx.page(r) === file);
  if (!row) throw new Error(`preview: no page '${file}'`);

  if (row.Type === 'StructureDefinition') {
    const data = ctx.structureDefinitionData(row);
    const rootType = row.sdType || data.type;
    const examples = ctx.profileExamples(row.Url || '');
    const html = emitHtml(
      ctx,
      <ProfilePage r={row as any} data={data} resolve={ctx.resolve} requirements={ctx.profileRootRequirements(data, rootType)} examples={examples} authoredElementChain={ctx.localAuthoredElementChain(data)} />,
      {
        title: row.Title || row.Name || row.Id, navActive: ctx.artifactsNav,
        crumbs: [{ label: 'Artifacts', href: 'artifacts.html' }, { label: 'Profiles', href: 'artifacts.html#profiles' }, { label: row.Title || row.Id }],
        toc: [{ id: 'overview', label: 'Overview' }, ...(examples.length ? [{ id: 'examples', label: 'Examples' }] : []), { id: 'elements', label: 'Formal definition' }],
        sidebar: <ArtifactSidebar ctx={ctx} current={file} />,
        machineBase: `${row.Type}-${row.Id}`,
      },
    );
    return { file, html };
  }
  if (row.Type === 'ValueSet') {
    const data = ctx.store.parse(row);
    const html = emitHtml(ctx, <ValueSetPage r={row as any} data={data} resolve={ctx.resolve} expansion={ctx.store.valueSetCodes(row.Url || '')} />, {
      title: row.Title || row.Name || row.Id, navActive: ctx.artifactsNav,
      crumbs: [{ label: 'Artifacts', href: 'artifacts.html' }, { label: 'Value sets', href: 'artifacts.html#value-sets' }, { label: row.Title || row.Id }],
      toc: [{ id: 'overview', label: 'Overview' }, { id: 'definition', label: 'Composition' }],
      sidebar: <ArtifactSidebar ctx={ctx} current={file} />,
      machineBase: `${row.Type}-${row.Id}`,
    });
    return { file, html };
  }
  if (row.Type === 'CodeSystem') {
    const data = ctx.store.parse(row);
    const html = emitHtml(ctx, <CodeSystemPage r={row as any} data={data} concepts={ctx.store.concepts(row.Key) as any} />, {
      title: row.Title || row.Name || row.Id, navActive: ctx.artifactsNav,
      crumbs: [{ label: 'Artifacts', href: 'artifacts.html' }, { label: 'Code systems', href: 'artifacts.html#code-systems' }, { label: row.Title || row.Id }],
      toc: [{ id: 'overview', label: 'Overview' }, { id: 'concepts', label: 'Concepts' }],
      sidebar: <ArtifactSidebar ctx={ctx} current={file} />,
      machineBase: `${row.Type}-${row.Id}`,
    });
    return { file, html };
  }
  // Example or generic resource.
  const data = ctx.store.parse(row);
  if (ctx.isExampleRow(row)) {
    const html = emitHtml(ctx, <ExamplePage r={row as any} data={data} />, {
      title: row.Title || row.Name || row.Id, navActive: ctx.artifactsNav,
      crumbs: [{ label: 'Artifacts', href: 'artifacts.html' }, { label: 'Examples', href: 'artifacts.html#examples' }, { label: row.Title || row.Id }],
      toc: [{ id: 'overview', label: 'Overview' }, { id: 'source', label: 'Source' }],
      sidebar: <ArtifactSidebar ctx={ctx} current={file} />,
      machineBase: `${row.Type}-${row.Id}`,
    });
    return { file, html };
  }
  const html = emitHtml(ctx, <ResourcePage r={row as any} data={data} />, {
    title: row.Title || row.Name || row.Id, navActive: ctx.artifactsNav,
    crumbs: [{ label: 'Artifacts', href: 'artifacts.html' }, { label: row.Type }, { label: row.Title || row.Id }],
    toc: [{ id: 'overview', label: 'Overview' }, { id: 'source', label: 'Source' }],
    sidebar: <ArtifactSidebar ctx={ctx} current={file} />,
    machineBase: `${row.Type}-${row.Id}`,
  });
  return { file, html };
}

// Referenced so `project`/`db` imports are retained (Layout uses project; the
// alias keeps db bound). No-ops otherwise.
export const __keep = { project, db };
