// Cycle's shared external site builder behind the editor adapter seam. Heavy
// work stays in the worker: buildSite derives and verifies a ClosedSiteBuild,
// then constructs CycleSiteRenderer with Cycle's own shared LiquidJS content
// policy. This path does not use the native Rust ContentApi/template tree.

import type { AdapterContext, PageInfo, SiteGeneratorAdapter } from './types';
import type { EngineClient } from '../worker/client';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

class CycleAdapter implements SiteGeneratorAdapter {
  id = 'cycle';
  label = 'Cycle site generator (TS)';
  /** Design assets copied to the app's static tree at build time. */
  baseHref = `${BASE}data/cycle/site-assets/`;

  private engine: EngineClient | null = null;
  private pages: PageInfo[] = [];

  async init(ctx: AdapterContext): Promise<void> {
    this.engine = ctx.engine;
    const p = ctx.project;
    const res = await ctx.engine.buildSite(p.config, p.files, p.predefined, p.siteFiles, p.buildEpochSecs);
    this.pages = res.pages;
  }

  async listPages(): Promise<PageInfo[]> {
    return this.pages;
  }

  async renderPage(file: string): Promise<{ html: string; renderMs?: number }> {
    if (!this.engine) throw new Error('cycle adapter not initialized');
    return this.engine.renderPage(file);
  }

  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null> {
    if (!this.engine) return null;
    return this.engine.assetBytes(name);
  }
}

export const cycleAdapter = new CycleAdapter();
