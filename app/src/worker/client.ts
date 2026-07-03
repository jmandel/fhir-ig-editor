// UI-side handle to the engine worker. Wraps postMessage in promises, owns the
// package-bundle fetch+inflate, and memoizes per-profile snapshots. The rest of
// the app talks only to this class — the worker protocol is the reusable seam
// (spec §3: "if we later want full vscode.dev, the worker protocol is it").

import EngineWorker from './engine.worker?worker';
import type {
  BundleSpec,
  CompileResult,
  InitResult,
  RenderPageResult,
  SitePreviewResult,
  SnapshotResult,
  WorkerReply,
  WorkerRequest,
} from './protocol';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** Omit that distributes over a discriminated union (so each variant keeps its
 *  discriminant). Plain `Omit` collapses the union and loses the payload keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Bundle manifest baked into public/data/ by scripts/bundle-packages. */
interface BundleManifest {
  bundles: { label: string; tgz: string }[];
}

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private snapshotCache = new Map<string, SnapshotResult>();
  private inited = false;

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error));
    };
  }

  private call<T>(msg: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  /** Fetch + inflate the baked package bundles, then mount them once. */
  async init(onProgress?: (msg: string) => void): Promise<InitResult> {
    if (this.inited) throw new Error('engine already initialized');
    onProgress?.('Loading package manifest…');
    const manifest: BundleManifest = await (await fetch(`${BASE}data/bundles/manifest.json`)).json();

    const bundles: BundleSpec[] = [];
    // Inflate bundles on the UI side (DecompressionStream is available in both
    // window + worker; doing it here keeps the worker's init call pure JSON and
    // lets us show per-package progress).
    const { inflateBundleResponse } = await import('./inflate');
    for (const b of manifest.bundles) {
      onProgress?.(`Inflating ${b.label}…`);
      // Bundle filenames contain '#' (e.g. hl7.fhir.r4.core#4.0.1.tgz); a raw '#'
      // in a URL is a fragment delimiter, so encode it (the P0 gotcha).
      const url = `${BASE}data/bundles/${encodeURIComponent(b.tgz)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`);
      // Stream straight through DecompressionStream (no 65 MB ArrayBuffer
      // round-trip — that intermittently fails on large blobs in headless Chromium).
      bundles.push({ label: b.label, files: await inflateBundleResponse(resp) });
    }
    onProgress?.('Mounting packages in engine…');
    const res = await this.call<InitResult>({ type: 'init', bundles });
    this.inited = true;
    return res;
  }

  async compile(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
  ): Promise<CompileResult> {
    // Every compile invalidates memoized snapshots (resources may have changed).
    this.snapshotCache.clear();
    return this.call<CompileResult>({ type: 'compile', config, files, predefined });
  }

  async snapshot(url: string): Promise<SnapshotResult> {
    const cached = this.snapshotCache.get(url);
    if (cached) return cached;
    const res = await this.call<SnapshotResult>({ type: 'snapshot', url });
    this.snapshotCache.set(url, res);
    return res;
  }

  // ---- M2 site preview ----

  /** Build the in-browser site.db rows + enumerate renderable pages. */
  async buildSite(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
    siteFiles: Record<string, string>,
    buildEpochSecs: number,
  ): Promise<SitePreviewResult> {
    return this.call<SitePreviewResult>({
      type: 'buildSite',
      config,
      files,
      predefined,
      siteFiles,
      buildEpochSecs,
    });
  }

  /** Render one page to HTML (render-on-demand per visible page). */
  async renderPage(file: string): Promise<RenderPageResult> {
    return this.call<RenderPageResult>({ type: 'renderPage', file });
  }

  /** Fetch an asset's bytes (base64) for serving into the preview iframe. */
  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null> {
    return this.call<{ name: string; mime: string; base64: string } | null>({ type: 'assetBytes', name });
  }

  get initialized() {
    return this.inited;
  }
}
