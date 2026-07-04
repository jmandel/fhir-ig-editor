// SiteGeneratorAdapter — Adapter API v1 (stock-template plan §2.4, decided
// 2026-07-03). The template selector chooses among registered adapters, all
// consuming the same engine session state (compiled project + site.db rows +
// the engine-backed fragment/content surfaces).
//
// Uniformly TypeScript: Rust renderers join via a thin shim over the wasm
// Session (stockAdapter). The plan's `rows` ctx member is realized WORKER-SIDE
// (site.db rows never cross to the UI — the M2 data flow); adapters reach them
// through the engine ops.

import type { EngineClient } from '../worker/client';
import type { PagePreviewDescriptor } from '../worker/protocol';

export type PageInfo = PagePreviewDescriptor;

/** Engine-backed publisher fragments (first-include-miss store) — available to
 *  EVERY adapter, so custom TS chrome can embed publisher-grade fragments. */
export interface FragmentApi {
  fragment(ref: string, kind: string): Promise<string>;
}

/** Engine-backed content processing (TS-liquid sunset): Liquid + kramdown run
 *  in the wasm session; hosts pass data, not engines. */
export interface ContentApi {
  renderLiquid(source: string, data?: Record<string, unknown>): Promise<string>;
  renderMarkdown(md: string, opts?: { rougeWrappers?: boolean }): Promise<string>;
}

/** The project inputs a site build consumes (the compile is already done by
 *  the time an adapter initializes; these feed site.db row building). */
export interface AdapterProject {
  /** The loaded project's id ('cycle', 'uscore') — selects e.g. the packed
   *  stock site bundle. */
  projectId: string;
  config: string;
  files: Record<string, string>;
  predefined: Record<string, unknown>;
  siteFiles: Record<string, string>;
  buildEpochSecs: number;
}

export interface AdapterContext {
  engine: EngineClient;
  fragments: FragmentApi;
  content: ContentApi;
  project: AdapterProject;
}

export interface SiteGeneratorAdapter {
  id: string;
  label: string;
  /** (Re)initialize for the current compile generation. Called after every
   *  successful compile and on template switch. */
  init(ctx: AdapterContext): Promise<void>;
  listPages(): Promise<PageInfo[]>;
  renderPage(file: string): Promise<{ html: string; renderMs?: number }>;
  /** Bytes for an asset the rendered HTML references by name (images, css).
   *  Null when the adapter doesn't know the name. */
  assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null>;
  /** Optional <base href> injected into the preview iframe for design assets
   *  served from the app's static tree (the cycle adapter uses this). */
  baseHref?: string;
  /** Ledger hook (F6 scope 4): invalidate render caches for dirty nodes. */
  invalidate?(dirty: string[]): void;
}

const registry = new Map<string, SiteGeneratorAdapter>();

/** Build-time registry (Adapter API v1): modules register at import time. */
export function registerSiteGenerator(adapter: SiteGeneratorAdapter): void {
  registry.set(adapter.id, adapter);
}

export function listSiteGenerators(): SiteGeneratorAdapter[] {
  return [...registry.values()];
}

export function getSiteGenerator(id: string): SiteGeneratorAdapter | undefined {
  return registry.get(id);
}
