declare const __ENGINE_COMMIT__: string | undefined;
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
  EngineOps,
  ExpandResult,
  InitResult,
  MountResult,
  Op,
  ProgressEvent,
  RenderPageResult,
  ResolutionStep,
  SitePreviewResult,
  SiteTreeFile,
  SnapshotResult,
  StockSiteOptions,
  VersionIndex,
  WorkerReply,
} from './protocol';
import { readCachedBundle, writeCachedBundle } from './bundleCache';
import type { ResolveOutcome } from './packageResolver';
export type { BlockedPackage, ResolveOutcome } from './packageResolver';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

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
  /** The baked manifest's `label -> entry` map, kept so the runtime resolver can
   *  source a missing package from a same-origin prebuilt bundle (task #32). */
  private bakedByLabel = new Map<string, BundleEntry>();
  /** A single in-flight lazy-mount promise so concurrent snapshot/site builds
   *  share one fetch of the deferred bundles. */
  private deferredMount: Promise<void> | null = null;
  private progressCb: ProgressCb | null = null;
  /** The mounted engine's commit — the invalidation key for the OPFS materialized-
   *  template cache (#40 scope 4): a wasm bump changes this, so stale trees are
   *  never served. Captured on init. */
  private engineCommit = 'unknown';
  /** Verification hook (#40 E2E): force the LIVE template path (resolve→fetch→
   *  mount→mountTemplate) by suppressing the warm-start artifact + cache, so the
   *  live materialization can be gated even for a coord that HAS a committed
   *  artifact. Set via `__igDebug.engine.forceLiveTemplate = true`. */
  forceLiveTemplate = false;

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

  /** ONE call path for every engine operation (ledger #2): the op table in
   *  protocol.ts types both the args and the result. */
  private call<K extends Op>(op: K, ...args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, op, args });
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

    for (const b of manifest.bundles) this.bakedByLabel.set(b.label, b);
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
    const res: InitResult = await this.call('init', bundles);
    this.inited = true;
    this.engineCommit = res.version?.commit || 'unknown';
    // Stale-mix guard: the app bundle was built against a specific engine
    // commit; if the served (HTTP-cached) wasm reports a different one, the
    // user has a stale engine + fresh app (or vice versa) — reload fixes it.
    if (typeof __ENGINE_COMMIT__ !== 'undefined' && __ENGINE_COMMIT__ !== 'dev' && this.engineCommit !== __ENGINE_COMMIT__) {
      const msg = `Engine version mismatch: app expects ${__ENGINE_COMMIT__}, loaded ${this.engineCommit}. Hard-reload the page (a redeploy left a stale cached engine).`;
      console.error(msg);
      this.progressCb?.({ stage: 'ready', label: 'engine', message: msg });
    }
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
      const r: MountResult = await this.call('mountBundles', specs);
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

  // ---- runtime package resolution (task #32) ----

  /** Set/replace the progress callback used by acquisition + lazy mounts (so the
   *  UI can surface resolve/registry-fetch/blocked stages outside init). */
  setProgress(cb: ProgressCb | null): void {
    this.progressCb = cb;
  }

  /** Ingest a user-dropped `.tgz` into the session-local package store (source d:
   *  air-gapped / registry-blocked). The next `acquireForProject` will prefer it
   *  over the network. Returns the `id#version` label it registered. */
  async ingestLocalTgz(tgz: ArrayBuffer): Promise<string> {
    const { ingestTgz } = await import('./localPackages');
    return ingestTgz(tgz);
  }


  /** Ask the engine to resolve the project's package sets against the CURRENTLY
   *  mounted bundles. The resolution logic is entirely in Rust; this is transport.*/
  async resolveStep(config: string, versionIndex?: VersionIndex): Promise<ResolutionStep> {
    return this.call('resolveProject', config, versionIndex);
  }

  /** Run the full resolve → fetch → mount → resolve acquisition loop for a
   *  project, driven ONLY by the engine's ResolutionStep. Fetches missing
   *  packages from (a) same-origin prebuilt bundles, (b) local .tgz drops,
   *  (c) the FHIR registry, (d) an optional proxy — mounting each until the engine
   *  reports `satisfied`. Packages no source can supply come back as a precise
   *  `blocked` list for the UI. Safe to call before every compile of an arbitrary
   *  IG; it is a no-op once the closure is already mounted. */
  async acquireForProject(config: string): Promise<ResolveOutcome> {
    const { acquireForProject, indexFromLabels } = await import('./packageResolver');
    // Seed the resolver's version index with the baked manifest's pinned labels so
    // a `latest`/`x` request for a package that exists ONLY as a baked bundle (the
    // publisher-internal `.r4` alias set — hl7.fhir.uv.tools.r4 / hl7.terminology.r4
    // / hl7.fhir.uv.extensions.r4, none of which are on packages.fhir.org) resolves
    // to its baked pin with ZERO network. Without this the engine reports the coord
    // as an unresolved_version, the registry can never answer, and it hard-blocks
    // with "no versions found" even though the bytes are already mounted.
    const seedIndex = indexFromLabels(this.bakedByLabel.keys());
    return acquireForProject(
      {
        resolveStep: (cfg, idx) => this.resolveStep(cfg, idx),
        mount: async (bundles) => {
          await this.call('mountBundles', bundles);
        },
        bakedBundle: (label) => {
          const e = this.bakedByLabel.get(label);
          return e ? { tgz: e.tgz, bytes: e.bytes } : undefined;
        },
        fetchBaked: (label, tgz) =>
          this.loadBundle({ label, tgz }, 'Loading (dependency)'),
      },
      config,
      (ev) => this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
      seedIndex,
    );
  }

  async compile(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
  ): Promise<CompileResult> {
    // Every compile invalidates memoized snapshots (resources may have changed).
    this.snapshotCache.clear();
    return this.call('compile', config, files, predefined);
  }

  async snapshot(url: string): Promise<SnapshotResult> {
    const cached = this.snapshotCache.get(url);
    if (cached) return cached;
    // Snapshots need the deferred (R5 core) bundle — mount it lazily first.
    await this.ensureSnapshotBundles();
    const res: SnapshotResult = await this.call('snapshot', url);
    this.snapshotCache.set(url, res);
    return res;
  }

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — needs no mounted packages beyond the resources passed in, so it
   *  runs even before the deferred bundles are mounted. */
  async expandValueSet(valueSetJson: string, resourcesJson: string): Promise<ExpandResult> {
    return this.call('expandValueSet', valueSetJson, resourcesJson);
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
    return this.call('buildSite', config, files, predefined, siteFiles, buildEpochSecs);
  }

  /** Render one page to HTML (render-on-demand per visible page). */
  async renderPage(file: string): Promise<RenderPageResult> {
    return this.call('renderPage', file);
  }

  /** Fetch an asset's bytes (base64) for serving into the preview iframe. */
  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string } | null> {
    return this.call('assetBytes', name);
  }

  // ---- F6 stock-template render surface (engine-side pages/fragments) ----

  /** Mount (REPLACE) the engine's site tree for the stock-template renderer. */
  async mountSite(files: Record<string, SiteTreeFile>, options?: StockSiteOptions): Promise<{ mounted: number }> {
    return this.call('mountSite', files, options);
  }

  /** Live template loader (#40): materialize a template `id#ver` chain (already
   *  mounted as bundle packages) into the engine site tree. Throws if the chain
   *  is incomplete or the template needs server-side rendering (custom ant). */
  async mountTemplate(coord: string): Promise<{ files: number }> {
    return this.call('mountTemplate', coord);
  }

  /** Source-driven stock site (task #45): synthesize the artifact page shells +
   *  the `_data` model from the CURRENT compile + the mounted template, merging
   *  both into the engine site tree. Call AFTER compile + mountTemplate. Replaces
   *  the pre-baked `{id}-stock.json` warm-start bundle. */
  async produceStockSite(): Promise<{ pages: number; data: number }> {
    return this.call('produceStockSite');
  }

  /** LIVE template load (#40): the full resolve→fetch→mount→materialize path.
   *  Walks the template's `base` chain (Rust's rule, mirrored in JS because
   *  `mountTemplate` consumes an already-mounted chain), fetching + mounting each
   *  chain package via the SAME transport regular packages use, then calls
   *  `Session.mountTemplate` to materialize the tree into the engine site tree.
   *  Any AntHookError (custom-ant template) propagates as an Error whose message
   *  contains "never execute ant" — the adapter maps that to a friendly refusal. */
  async mountTemplateChain(coord: string): Promise<{ chain: string[]; files: number }> {
    const { mountTemplateChain } = await import('./templateChain');
    const host = {
      // Template chain packages are not sushi-config deps, so resolveStep/bakedBundle
      // are reused only for their transport (baked bundle lookup + registry fetch);
      // the CHAIN decision lives in the walk, not in resolveStep.
      resolveStep: (cfg: string, idx?: VersionIndex) => this.resolveStep(cfg, idx),
      mount: async (bundles: BundleSpec[]) => {
        await this.call('mountBundles', bundles);
      },
      bakedBundle: (label: string) => {
        const e = this.bakedByLabel.get(label);
        return e ? { tgz: e.tgz, bytes: e.bytes } : undefined;
      },
      fetchBaked: (label: string, tgz: string) => this.loadBundle({ label, tgz }, 'Loading (template)'),
    };
    const { chain } = await mountTemplateChain(host, coord, (ev) =>
      this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
    );
    this.progressCb?.({ stage: 'bundle-mount', label: coord, message: `Materializing template ${coord}…` });
    const { files } = await this.mountTemplate(coord);
    this.progressCb?.({ stage: 'ready', message: `Template ${coord} materialized — ${files} files.` });
    return { chain, files };
  }

  /** WARM-START template layer (#40): fetch the committed `fig packages bundle
   *  --template` artifact and map it to the engine site tree EXACTLY as the engine
   *  `mount_template` does (`includes/*`→`_includes/*`, everything else →
   *  `template/*`), so the warm and live paths mount byte-identical trees (the
   *  byte gate). Returns the mapped `mountSite` files, or null on 404 (no committed
   *  artifact for this coord → the caller falls back to the live path). */
  async fetchTemplateArtifact(coord: string): Promise<Record<string, SiteTreeFile> | null> {
    // Verification hook: force the LIVE path (return null → adapter falls through
    // to mountTemplateChain). Used by the E2E live-template gate.
    if (this.forceLiveTemplate) return null;
    // OPFS materialized-tree cache first (#40 scope 4): a mapped tree we already
    // materialized under THIS engine commit — a pure read, no network/re-map.
    const { readCachedTemplateTree, writeCachedTemplateTree } = await import('./templateTreeCache');
    const cached = await readCachedTemplateTree(coord, this.engineCommit);
    if (cached) {
      this.progressCb?.({ stage: 'bundle-cache-hit', label: coord, message: `Template ${coord} (materialized cache)`, fromCache: true });
      return cached;
    }
    // Nested path `data/templates/<id>/<version>.json` — NOT `<id>%23<version>`.
    // A `%23` in the filename 404s on any server that decodes it back to `#`
    // (GitHub Pages does), which silently dropped the whole template (CSS/JS/images
    // → unstyled preview). Splitting id#version into path segments is decode-safe.
    const [tplId, tplVer] = coord.split('#');
    const url = `${BASE}data/templates/${tplId}/${tplVer ?? '1.0.0'}.json`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      // Network-level failure (offline, CORS, stale app shell mid-deploy) must
      // NOT abort the ladder — fall through to the live chain-mount path.
      console.warn(`template warm artifact fetch failed (${url}): ${e}`);
      return null;
    }
    if (!resp.ok) return null;
    const doc = (await resp.json()) as { files: Record<string, SiteTreeFile> };
    const mapped: Record<string, SiteTreeFile> = {};
    for (const [rel, val] of Object.entries(doc.files)) {
      const inc = rel.startsWith('includes/') ? `_includes/${rel.slice('includes/'.length)}` : `template/${rel}`;
      mapped[inc] = val;
    }
    // Write-through so the next load (any session) skips the fetch + re-map.
    void writeCachedTemplateTree(coord, this.engineCommit, mapped);
    return mapped;
  }

  /** Renderable page rel paths from the engine's mounted site tree. */
  async listSitePages(): Promise<{ pages: string[] }> {
    return this.call('listSitePages');
  }

  /** Render one page through the engine's stock-template surface. */
  async renderSitePage(name: string): Promise<{ html: string; renderMs: number }> {
    return this.call('renderSitePage', name);
  }

  /** Render one publisher fragment (`{Type}-{id}`, kind) — the engine-backed
   *  FragmentApi every site-generator adapter shares. */
  async renderFragment(ref: string, kind: string): Promise<{ html: string }> {
    return this.call('renderFragment', ref, kind);
  }

  /** ContentApi: engine-side Liquid over the session provider. */
  async renderLiquid(source: string, data?: Record<string, unknown>): Promise<{ html: string }> {
    return this.call('renderLiquid', source, data);
  }

  /** ContentApi: engine-side kramdown (Jekyll markdownify semantics). */
  async renderMarkdown(md: string, opts?: { rougeWrappers?: boolean }): Promise<{ html: string }> {
    return this.call('renderMarkdown', md, opts);
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
