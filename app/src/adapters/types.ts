// SiteGeneratorAdapter is the editor's host-integration seam. It coordinates a
// selected generator with preview publication; it is not the semantic handoff.
// Cycle receives a verified ClosedSiteBuild in the worker, while the stock
// adapter drives the native Rust render surface over the already compiled
// project revision.

import type { EngineClient } from '../worker/client';
import type { PagePreviewDescriptor } from '../worker/protocol';

export type PageInfo = PagePreviewDescriptor;

/** Exact project inputs a site build consumes. The matching semantic compile
 * is installed before adapter initialization. */
export interface AdapterProject {
  /** Stable loaded-project id (`cycle`, `uscore`, ...). */
  projectId: string;
  config: string;
  files: Record<string, string>;
  predefined: Record<string, unknown>;
  siteFiles: Record<string, string>;
  buildEpochSecs: number;
}

export interface AdapterContext {
  engine: EngineClient;
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
  /** The COMPLETE static asset set (template css/js/images + IG images) the
   *  preview can reference, so the SW can be provisioned with it ONCE per compile
   *  generation and serve every asset itself — no per-asset round-trip to this
   *  tab's main thread. `pagePrefix` mirrors the key-normalization `assetBytes`
   *  applies. Omit to fall back to per-asset `assetBytes` serving. */
  assetManifest?(): { pagePrefix: string; assets: Record<string, { mime: string; b64: string }> };
  /** Optional typed/incremental cache invalidation hook. */
  invalidate?(dirty: string[]): void;
}

// The curated stock templates + their LIVE registry version catalogs live in
// `./templateCatalog` (#40 default UX). ONE wasm renderer materializes ANY
// template as DATA; the selector offers the curated families' published versions
// AND an advanced write-your-own `id#version` input — any resolvable template
// loads, so the curated set is a convenience, not a whitelist.

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
