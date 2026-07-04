// The cycle TS site generator as a SiteGeneratorAdapter (the M2 path,
// refactored onto Adapter API v1). Heavy work stays in the worker: buildSite
// builds site.db rows + mounts cycle's include design for the engine's
// ContentApi liquid; renderPage runs cycle's React chrome there.

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
