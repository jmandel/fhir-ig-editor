// UI-side handle to the engine worker. Wraps postMessage in promises, owns the
// package-bundle fetch+inflate + OPFS cache, and memoizes per-profile snapshots.
// The rest of the app talks only to this class — the worker protocol is the
// reusable seam (spec §3: "if we later want full vscode.dev, the worker protocol
// is it").
//
// Cold-start (spec §1): init fetches ONLY the compile-critical bundles, inflates
// them (streaming), OPFS-caches the inflated maps, and mounts them — first paint
// happens without the ~6.8 MB r5.core tgz. r5.core is `defer:true` in the
// manifest and is fetched + mounted LAZILY via ensureSnapshotBundles() the first
// time a snapshot / site build needs it. Warm start (reload) reads inflated
// bundles straight from OPFS — no network, no gunzip/untar.

import EngineWorker from './engine.worker?worker';
import type {
  BundleSpec,
  CompileResult,
  ExpandResult,
  InitResult,
  MountResult,
  ProgressEvent,
  RenderPageResult,
  SitePreviewResult,
  SnapshotResult,
  WorkerReply,
  WorkerRequest,
} from './protocol';
import { readCachedBundle, writeCachedBundle } from './bundleCache';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** Omit that distributes over a discriminated union (so each variant keeps its
 *  discriminant). Plain `Omit` collapses the union and loses the payload keys. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** One bundle entry in the baked manifest. `defer:true` = not needed by the
 *  first compile (fetched lazily on first snapshot/site build). */
interface BundleEntry {
  label: string;
  tgz: string;
  bytes?: number;
  defer?: boolean;
}
interface BundleManifest {
  bundles: BundleEntry[];
}

export type ProgressCb = (ev: ProgressEvent) => void;

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private snapshotCache = new Map<string, SnapshotResult>();
  private inited = false;
  /** Deferred bundle entries (from the manifest) not mounted at init time. */
  private deferred: BundleEntry[] = [];
  /** A single in-flight lazy-mount promise so concurrent snapshot/site builds
   *  share one fetch of the deferred bundles. */
  private deferredMount: Promise<void> | null = null;
  private progressCb: ProgressCb | null = null;

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

  /** Fetch/inflate (or read from OPFS) one bundle into a mountable BundleSpec.
   *  Emits progress and back-fills the OPFS cache on a cold fetch. */
  private async loadBundle(entry: BundleEntry, stageLabel: string): Promise<BundleSpec> {
    const cached = await readCachedBundle(entry.label);
    if (cached) {
      this.progressCb?.({
        stage: 'bundle-cache-hit',
        label: entry.label,
        bytes: entry.bytes,
        message: `${stageLabel} ${entry.label} (cached)`,
        fromCache: true,
      });
      return cached;
    }
    this.progressCb?.({
      stage: stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch',
      label: entry.label,
      bytes: entry.bytes,
      message: `${stageLabel} ${entry.label}${entry.bytes ? ` (${fmtBytes(entry.bytes)})` : ''}…`,
    });
    // Bundle filenames contain '#' (e.g. hl7.fhir.r4.core#4.0.1.tgz); a raw '#'
    // in a URL is a fragment delimiter, so encode it (the P0 gotcha).
    const url = `${BASE}data/bundles/${encodeURIComponent(entry.tgz)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`);
    // Stream straight through DecompressionStream (no big ArrayBuffer round-trip).
    const { inflateBundleResponse } = await import('./inflate');
    const files = await inflateBundleResponse(resp);
    const spec: BundleSpec = { label: entry.label, files };
    // Persist the inflated map for a warm next start (best-effort).
    void writeCachedBundle(spec);
    return spec;
  }

  /** Boot: mount the compile-critical (non-deferred) bundles. Deferred bundles
   *  (r5.core) are held back and mounted lazily on first snapshot/site build. */
  async init(onProgress?: ProgressCb): Promise<InitResult> {
    if (this.inited) throw new Error('engine already initialized');
    this.progressCb = onProgress ?? null;

    this.progressCb?.({ stage: 'manifest', message: 'Loading package manifest…' });
    const manifest: BundleManifest = await (
      await fetch(`${BASE}data/bundles/manifest.json`)
    ).json();

    const eager = manifest.bundles.filter((b) => !b.defer);
    this.deferred = manifest.bundles.filter((b) => b.defer);

    const bundles: BundleSpec[] = [];
    for (let i = 0; i < eager.length; i++) {
      const spec = await this.loadBundle(eager[i], 'Loading');
      this.progressCb?.({
        stage: 'bundle-mount',
        label: eager[i].label,
        message: `Mounting ${eager[i].label}…`,
        fraction: (i + 1) / eager.length,
      });
      bundles.push(spec);
    }

    this.progressCb?.({ stage: 'bundle-mount', message: 'Mounting packages in engine…' });
    const res = await this.call<InitResult>({ type: 'init', bundles });
    this.inited = true;
    this.progressCb?.({
      stage: 'ready',
      message: `Engine ready — mounted ${res.mounted} packages${
        this.deferred.length ? ` (${this.deferred.length} deferred)` : ''
      }.`,
    });
    return res;
  }

  /** Ensure the deferred (snapshot-only) bundles are fetched + mounted. Called
   *  before the first snapshot / site build. Idempotent + concurrency-safe: a
   *  single shared promise; subsequent calls resolve instantly. */
  async ensureSnapshotBundles(): Promise<void> {
    if (this.deferred.length === 0) return;
    if (this.deferredMount) return this.deferredMount;
    this.deferredMount = (async () => {
      const specs: BundleSpec[] = [];
      for (const entry of this.deferred) {
        specs.push(await this.loadBundle(entry, 'Loading (snapshot data)'));
      }
      this.progressCb?.({
        stage: 'bundle-mount',
        message: `Mounting ${specs.map((s) => s.label).join(', ')}…`,
      });
      const r = await this.call<MountResult>({ type: 'mountBundles', bundles: specs });
      // Mounted now; clear the deferred list so we don't re-fetch.
      this.deferred = [];
      this.progressCb?.({
        stage: 'ready',
        message: `Snapshot data ready — ${r.mounted} packages mounted.`,
      });
    })();
    // Don't LATCH a failure: if the deferred fetch/mount rejects (flaky network,
    // corrupt bundle), clear the shared promise so a later snapshot/site build can
    // retry instead of re-inheriting the same rejection forever. `this.deferred`
    // is only cleared on success (above), so a retry re-fetches the right set.
    this.deferredMount.catch(() => {
      this.deferredMount = null;
    });
    return this.deferredMount;
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
    // Snapshots need the deferred (R5 core) bundle — mount it lazily first.
    await this.ensureSnapshotBundles();
    const res = await this.call<SnapshotResult>({ type: 'snapshot', url });
    this.snapshotCache.set(url, res);
    return res;
  }

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — needs no mounted packages beyond the resources passed in, so it
   *  runs even before the deferred bundles are mounted. */
  async expandValueSet(valueSetJson: string, resourcesJson: string): Promise<ExpandResult> {
    return this.call<ExpandResult>({ type: 'expandValueSet', valueSetJson, resourcesJson });
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
    // The site build snapshots every SD, so it needs the deferred bundle too.
    await this.ensureSnapshotBundles();
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

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
