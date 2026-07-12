declare const __ENGINE_COMMIT__: string | undefined;
declare const __ENGINE_RECIPE__: string | undefined;
// UI-side handle to the engine worker. Wraps postMessage in promises, owns the
// authenticated cold package fetch/preparation and compact PreparedPackage OPFS
// warm path, and memoizes per-profile snapshots.
// The rest of the app talks only to this class — the worker protocol is the
// reusable seam (spec §3: "if we later want full vscode.dev, the worker protocol
// is it").
//
// Startup loads only the authenticated package CATALOG. The Rust resolver then
// selects the active project's exact compile closure; snapshot-only and template
// packages remain lazy. OPFS is a transport/preparation cache, never authority.

import EngineWorker from './engine.worker?worker';
import type {
  BundleSpec,
  CompileResult,
  EngineOps,
  ExpandResult,
  InitResult,
  MountResult,
  Op,
  PackageMountInput,
  ProgressEvent,
  ResolutionStep,
  SnapshotResult,
  TemplateResolution,
  VersionIndex,
  WorkerReply,
} from './protocol';
import type {
  BuildHandle,
  GeneratorSpec,
  OutputCatalog,
  PrepareResult,
  ProjectInput,
  RenderedOutput,
  SiteOutput,
} from '../site/contract';
import type { ResolveOutcome } from './packageResolver';
import { assertCompatibleEngineCommit } from './engineVersion';
import { parseBakedBundleManifest, readVerifiedBundleBytes } from './bundleIntegrity';
import type { BakedBundleEntry, BakedBundleManifest } from './bundleIntegrity';
import { ResolutionCache } from './resolutionCache';
import { getPackageProxy, getRegistries } from '../vfs/packageSettings';
export type { BlockedPackage, ResolveOutcome } from './packageResolver';

/** A failed atomic prepare. A successful compile is retained as presentation
 * metadata when only the selected site generator failed afterward. */
export class PrepareError extends Error {
  constructor(
    message: string,
    readonly stage: 'compile' | 'site',
    readonly compiled?: CompileResult,
  ) {
    super(message);
    this.name = 'PrepareError';
  }
}

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export type ProgressCb = (ev: ProgressEvent) => void;

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private snapshotCache = new Map<string, SnapshotResult>();
  /** One resolver-loop outcome bound to exact config bytes and the current
   * package-mount generation. Rust invalidates its fixpoint on a fresh mount;
   * the host mirrors that law here. */
  private resolutionCache = new ResolutionCache<ResolveOutcome>();
  private inited = false;
  /** Snapshot-engine specials, separate from resolver-selected compile packages. */
  private snapshotBundles: BakedBundleEntry[] = [];
  /** The baked manifest's `label -> entry` map, kept so the runtime resolver can
   *  source a missing package from a same-origin prebuilt bundle (task #32). */
  private bakedByLabel = new Map<string, BakedBundleEntry>();
  /** A single in-flight lazy-mount promise so concurrent snapshot/site builds
   * share one fetch of the snapshot-role bundles. */
  private deferredMount: Promise<void> | null = null;
  /** Host mirror used to avoid even reading a package cache entry that the
   * current Worker session has already mounted. */
  private mountedLabels = new Set<string>();
  private preparedFallbacks = new Map<string, () => Promise<PackageMountInput>>();
  private progressCb: ProgressCb | null = null;
  /** The mounted engine's commit, checked against the app's expected commit so
   * stale app/engine mixes fail clearly. Captured on init. */
  private engineCommit = 'unknown';
  /** Exact emitted JS+WASM bytes used for semantic cache authority. */
  private readonly engineRecipe = typeof __ENGINE_RECIPE__ === 'undefined'
    ? `unavailable-${performance.timeOrigin}`
    : __ENGINE_RECIPE__;

  constructor() {
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (e.data.ok) p.resolve(e.data.result);
      else if (e.data.detail?.operation === 'prepare') {
        p.reject(new PrepareError(
          e.data.error,
          e.data.detail.stage,
          e.data.detail.stage === 'site' ? e.data.detail.compiled : undefined,
        ));
      } else {
        p.reject(new Error(e.data.error));
      }
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

  /** Select a complete PreparedPackage or fetch/authenticate/inflate its exact
   * baked transport into a mountable BundleSpec. */
  private async loadBundle(
    entry: BakedBundleEntry,
    stageLabel: string,
    forceRaw = false,
  ): Promise<PackageMountInput> {
    const started = performance.now();
    const transportIdentity = `tgz-${entry.sha256}`;
    // PreparedPackage v2 represents the complete package, including template
    // metadata. Templates therefore use the same authenticated warm path and
    // raw cold fallback as every other package.
    if (!forceRaw) {
      const { findPreparedPackage } = await import('./preparedPackageCache');
      const pointer = await findPreparedPackage(entry.label, transportIdentity);
      if (pointer) {
        this.preparedFallbacks.set(entry.label, () => this.loadBundle(entry, stageLabel, true));
        this.progressCb?.({
          stage: 'bundle-cache-hit',
          label: entry.label,
          message: `${stageLabel} ${entry.label} (prepared binary)`,
          fromCache: true,
          durationMs: performance.now() - started,
          inputBytes: pointer.bytes,
        });
        return { kind: 'prepared', pointer };
      }
    }
    this.progressCb?.({
      stage: stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch',
      label: entry.label,
      bytes: 0,
      totalBytes: entry.bytes,
      message: `${stageLabel} ${entry.label}…`,
    });
    // Bundle filenames contain '#' (e.g. hl7.fhir.r4.core#4.0.1.tgz); a raw '#'
    // in a URL is a fragment delimiter, so encode it (the P0 gotcha).
    const url = `${BASE}data/bundles/${encodeURIComponent(entry.tgz)}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`fetch ${url} -> ${resp.status}`);
    // Baked bundles are deployment inputs: authenticate the compressed bytes
    // before the inflater or engine can observe any package content.
    const transportStage = stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch';
    const compressed = await readVerifiedBundleBytes(
      resp,
      entry,
      (bytes, totalBytes) => {
        this.progressCb?.({
          stage: transportStage,
          label: entry.label,
          bytes,
          totalBytes,
          message: `${stageLabel} ${entry.label}…`,
        });
      },
      () => this.progressCb?.({
        stage: 'bundle-unpack',
        label: entry.label,
        message: `Verifying and unpacking ${entry.label}…`,
        inputBytes: entry.bytes,
      }),
    );
    const { inflateBundle } = await import('./inflate');
    const files = await inflateBundle(compressed);
    const spec: BundleSpec = { label: entry.label, files };
    this.progressCb?.({
      stage: 'bundle-unpack',
      label: entry.label,
      message: `${stageLabel} ${entry.label} loaded and inflated.`,
      durationMs: performance.now() - started,
      inputBytes: compressed.byteLength,
      fileCount: Object.keys(files).length,
    });
    // The Worker prepares and persists the binary execution artifact while
    // mounting. There is no inflated/base64 persistence layer.
    return { kind: 'raw', spec, transportIdentity };
  }

  /** The only incremental mount path on the main thread. Keep resolution,
   * compile, and snapshot caches synchronized with the worker/Rust session. */
  private async mountPackages(packages: PackageMountInput[]): Promise<MountResult> {
    let transaction = packages;
    const hasRaw = transaction.some((item) => item.kind === 'raw');
    const hasPrepared = transaction.some((item) => item.kind === 'prepared');
    // Preserve one Rust transaction. A partially warm batch falls back to raw
    // for its prepared members instead of committing two independent groups.
    if (hasRaw && hasPrepared) {
      transaction = await Promise.all(transaction.map(async (item) => {
        if (item.kind === 'raw') return item;
        return this.rawFallbackForPrepared(item.pointer.label);
      }));
    }
    const started = performance.now();
    let result: MountResult;
    try {
      result = await this.call('mountPackages', transaction);
    } catch (error) {
      // A missing/corrupt prepared artifact is an optimization miss. Reacquire
      // the authenticated original transport and prepare it again immediately.
      if (!transaction.every((item) => item.kind === 'prepared')) throw error;
      const fallbacks = await Promise.all(transaction.map(async (item) => {
        try {
          return await this.rawFallbackForPrepared(item.pointer.label);
        } catch {
          throw error;
        }
      }));
      transaction = fallbacks;
      result = await this.call('mountPackages', fallbacks);
    }
    const rpcMs = performance.now() - started;
    for (const label of result.newlyMounted) this.mountedLabels.add(label);
    // A mount invalidates resolution of the *next* compile, but it does not
    // mutate the exact package allow-list retained by Rust's previous compiled
    // revision. Keep that immutable result until re-resolution proves its
    // closure changed.
    this.resolutionCache.noteMount(result.newlyMounted);
    const prepared = result.preparedMetrics;
    this.progressCb?.({
      stage: 'bundle-mount',
      message: result.newlyMounted.length
        ? `Mounted ${result.newlyMounted.join(', ')}.`
        : 'Packages already mounted.',
      durationMs: rpcMs,
      inputBytes: result.inputBytes,
      metrics: {
        workerSerializeMs: result.serializeMs,
        wasmMs: result.wasmMs,
        workerAndCloneMs: Math.max(0, rpcMs - result.mountMs),
        ...(prepared ? {
          preparedWarmBinary: prepared.mode === 'warm-binary' ? 1 : 0,
          preparedColdPrepare: prepared.mode === 'cold-prepare' ? 1 : 0,
          preparedAdded: prepared.added,
          preparedArtifactBytes: prepared.artifactBytes,
          preparedEngineMountMs: prepared.engineMountMs,
          ...(prepared.decodeValidatePrepareMs === undefined ? {} : {
            preparedDecodeValidatePrepareMs: prepared.decodeValidatePrepareMs,
          }),
          ...(prepared.preparedMembers === undefined ? {} : { preparedMembers: prepared.preparedMembers }),
          ...(prepared.mountMemberBodyCopies === undefined ? {} : {
            preparedMountMemberBodyCopies: prepared.mountMemberBodyCopies,
          }),
          ...(prepared.inputJsonBytes === undefined ? {} : { preparedInputJsonBytes: prepared.inputJsonBytes }),
          ...(prepared.base64Bytes === undefined ? {} : { preparedBase64Bytes: prepared.base64Bytes }),
          ...(prepared.decodedSourceBytes === undefined ? {} : {
            preparedDecodedSourceBytes: prepared.decodedSourceBytes,
          }),
          ...(prepared.normalizedBytes === undefined ? {} : { preparedNormalizedBytes: prepared.normalizedBytes }),
          ...(prepared.jsonParseMs === undefined ? {} : { preparedJsonParseMs: prepared.jsonParseMs }),
          ...(prepared.base64DecodeMs === undefined ? {} : { preparedBase64DecodeMs: prepared.base64DecodeMs }),
          ...(prepared.normalizationMs === undefined ? {} : { preparedNormalizationMs: prepared.normalizationMs }),
          ...(prepared.indexingMs === undefined ? {} : { preparedIndexingMs: prepared.indexingMs }),
          ...(prepared.artifactEncodeMs === undefined ? {} : { preparedArtifactEncodeMs: prepared.artifactEncodeMs }),
          ...(prepared.decodeValidateMs === undefined ? {} : {
            preparedDecodeValidateMs: prepared.decodeValidateMs,
          }),
          ...(prepared.packages === undefined ? {} : { preparedPackages: prepared.packages }),
          ...(prepared.retainedBlobBytes === undefined ? {} : {
            preparedRetainedBlobBytes: prepared.retainedBlobBytes,
          }),
          ...(prepared.maxStagedArtifactBytes === undefined ? {} : {
            preparedMaxStagedArtifactBytes: prepared.maxStagedArtifactBytes,
          }),
          ...(prepared.jsBatchBytes === undefined ? {} : {
            preparedJsBatchBytes: prepared.jsBatchBytes,
          }),
          ...(prepared.compressedRetainedBytes === undefined ? {} : {
            preparedCompressedRetainedBytes: prepared.compressedRetainedBytes,
          }),
          ...(prepared.declaredRawBytes === undefined ? {} : {
            preparedDeclaredRawBytes: prepared.declaredRawBytes,
          }),
          ...(prepared.chunksInflated === undefined ? {} : {
            preparedChunksInflated: prepared.chunksInflated,
          }),
          ...(prepared.rawInflatedBytes === undefined ? {} : {
            preparedRawInflatedBytes: prepared.rawInflatedBytes,
          }),
          ...(prepared.chunkCacheHits === undefined ? {} : {
            preparedChunkCacheHits: prepared.chunkCacheHits,
          }),
          ...(prepared.cachedRawBytes === undefined ? {} : {
            preparedCachedRawBytes: prepared.cachedRawBytes,
          }),
          ...(prepared.indexedMembers === undefined ? {} : { preparedIndexedMembers: prepared.indexedMembers }),
          ...(prepared.memberBodyCopies === undefined ? {} : {
            preparedMemberBodyCopies: prepared.memberBodyCopies,
          }),
          ...(prepared.manifestJsonBytes === undefined ? {} : {
            preparedManifestJsonBytes: prepared.manifestJsonBytes,
          }),
          ...(prepared.manifestParseMs === undefined ? {} : { preparedManifestParseMs: prepared.manifestParseMs }),
        } : {}),
      },
    });
    return result;
  }

  private async rawFallbackForPrepared(label: string): Promise<PackageMountInput> {
    const registered = this.preparedFallbacks.get(label);
    if (registered) return registered();
    const { obtainRawPackageByLabel } = await import('./packageResolver');
    const recovered = await obtainRawPackageByLabel(label);
    if (!recovered) throw new Error(`cannot reacquire original package transport for ${label}`);
    return recovered;
  }

  /** Boot the WASM session with an empty package source. Package material is
   * selected only after the active project's config reaches the Rust resolver. */
  async init(onProgress?: ProgressCb): Promise<InitResult> {
    if (this.inited) throw new Error('engine already initialized');
    this.progressCb = onProgress ?? null;

    this.progressCb?.({ stage: 'manifest', message: 'Loading package manifest…' });
    const manifestResponse = await fetch(`${BASE}data/bundles/manifest.json`);
    if (!manifestResponse.ok) {
      throw new Error(`fetch package bundle manifest -> ${manifestResponse.status}`);
    }
    const manifest: BakedBundleManifest = parseBakedBundleManifest(await manifestResponse.json());

    for (const b of manifest.bundles) this.bakedByLabel.set(b.label, b);
    this.snapshotBundles = manifest.bundles.filter((bundle) => bundle.loadPhase === 'snapshot');
    this.progressCb?.({ stage: 'wasm', message: 'Starting compiler engine…' });
    const res: InitResult = await this.call('init');
    this.engineCommit = res.version?.commit || 'unknown';
    // Stale-mix guard: the app bundle was built against a specific engine
    // commit; if the served (HTTP-cached) wasm reports a different one, the
    // user has a stale engine + fresh app (or vice versa) — reload fixes it.
    assertCompatibleEngineCommit(
      typeof __ENGINE_COMMIT__ === 'undefined' ? undefined : __ENGINE_COMMIT__,
      this.engineCommit,
    );
    this.inited = true;
    this.progressCb?.({
      stage: 'ready',
      message: `Engine ready — ${manifest.bundles.length} packages available on demand.`,
      durationMs: res.initMs,
      inputBytes: res.inputBytes,
      metrics: { workerSerializeMs: res.serializeMs, wasmMs: res.wasmMs },
    });
    return res;
  }

  /** Ensure the snapshot-role bundles are fetched + mounted. Called only
   *  before the first explicit snapshot inspection. Site preparation resolves
   *  its exact package closure independently and must not pull the R5 support
   *  bundle into an ordinary R4 preview. Idempotent + concurrency-safe: a
   *  single shared promise; subsequent calls resolve instantly. */
  async ensureSnapshotBundles(): Promise<void> {
    if (this.snapshotBundles.length === 0) return;
    if (this.deferredMount) return this.deferredMount;
    this.deferredMount = (async () => {
      const needed = this.snapshotBundles.filter((entry) => !this.mountedLabels.has(entry.label));
      const specs = await Promise.all(
        needed.map((entry) => this.loadBundle(entry, 'Loading (snapshot data)')),
      );
      this.progressCb?.({
        stage: 'bundle-mount',
        message: `Mounting ${specs.map((item) => item.kind === 'raw' ? item.spec.label : item.pointer.label).join(', ')}…`,
      });
      const r = await this.mountPackages(specs);
      // Mounted now; clear the deferred list so we don't re-fetch.
      this.snapshotBundles = [];
      this.progressCb?.({
        stage: 'ready',
        message: `Snapshot data ready — ${r.mounted} packages mounted.`,
      });
    })();
    // Don't LATCH a failure: if the snapshot fetch/mount rejects (flaky network,
    // corrupt bundle), clear the shared promise so a later snapshot/site build can
    // retry instead of re-inheriting the same rejection forever. `snapshotBundles`
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
    const label = await ingestTgz(tgz);
    // A prior blocked attempt may now be satisfiable before a new mount occurs.
    this.resolutionCache.clear();
    return label;
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
    const cached = this.resolutionCache.get(config);
    if (cached) return cached;
    const {
      acquireForProject,
      indexFromLabels,
      obtainLockedPackages,
      refreshMutableVersionIndex,
    } = await import('./packageResolver');
    // Seed the resolver's version index with the baked manifest's pinned labels so
    // a `latest`/`x` request for a package that exists ONLY as a baked bundle (the
    // publisher-internal `.r4` alias set — hl7.fhir.uv.tools.r4 / hl7.terminology.r4
    // / hl7.fhir.uv.extensions.r4, none of which are on packages.fhir.org) resolves
    // to its baked pin with ZERO network. Without this the engine reports the coord
    // as an unresolved_version, the registry can never answer, and it hard-blocks
    // with "no versions found" even though the bytes are already mounted.
    const seedIndex = indexFromLabels(this.bakedByLabel.keys());
    const host = {
      resolveStep: (cfg: string, idx?: VersionIndex) => this.resolveStep(cfg, idx),
      mount: async (bundles: PackageMountInput[]) => {
        await this.mountPackages(bundles);
      },
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry) => this.loadBundle(bundle, 'Loading (dependency)'),
    };

    // Persistent locks are prefetch plans, never authority. Refresh mutable
    // requests, obtain the exact package bytes concurrently, mount once, then
    // require Rust to reproduce the exact ordered closure before accepting it.
    const lockStarted = performance.now();
    const lockCache = await import('./resolutionLockCache');
    const authority = {
      engineRecipe: this.engineRecipe,
      bakedPackages: [...this.bakedByLabel.values()].map(({ label, sha256 }) => ({ label, sha256 })),
      registries: getRegistries(),
      proxy: getPackageProxy(),
    };
    const lock = await lockCache.readResolutionLock(config, authority);
    const lockReadMs = performance.now() - lockStarted;
    let validatedIndex: VersionIndex | null = null;
    if (lock) {
      const freshnessStarted = performance.now();
      validatedIndex = await refreshMutableVersionIndex(
        lock.mutableRequests,
        seedIndex,
        (ev) => this.progressCb?.({ ...ev }),
      );
      const freshnessMs = performance.now() - freshnessStarted;
      if (validatedIndex) {
        const labels = lockCache.lockedLabels(lock);
        const needed = labels.filter((label) => !this.mountedLabels.has(label));
        const acquireStarted = performance.now();
        const exact = await obtainLockedPackages(
          host,
          needed,
          (ev) => this.progressCb?.({ ...ev }),
        );
        const acquireMs = performance.now() - acquireStarted;
        if (exact.blocked.length === 0 && exact.packages.length === needed.length) {
          const mountStarted = performance.now();
          const lockMount = exact.packages.length > 0
            ? await this.mountPackages(exact.packages)
            : null;
          const lockMountMs = performance.now() - mountStarted;
          const verifyStarted = performance.now();
          const verified = await this.resolveStep(config, validatedIndex);
          const verifyMs = performance.now() - verifyStarted;
          if (lockCache.resolutionMatchesLock(verified, lock)) {
            const outcome: ResolveOutcome = {
              step: verified,
              blocked: [],
              mounted: lockMount?.newlyMounted ?? [],
              versionIndex: validatedIndex,
            };
            this.resolutionCache.record(config, outcome);
            this.progressCb?.({
              stage: 'resolve',
              message: `Verified cached package closure (${labels.length} packages).`,
              fromCache: true,
              durationMs: performance.now() - lockStarted,
              fileCount: labels.length,
              metrics: {
                persistentLockHit: 1,
                lockReadMs,
                freshnessMs,
                exactAcquireMs: acquireMs,
                lockMountMs,
                rustVerifyMs: verifyMs,
              },
            });
            return outcome;
          }
        }
      }
      this.progressCb?.({
        stage: 'resolve',
        message: 'Cached package closure was stale or incomplete; resolving normally.',
        fromCache: false,
        durationMs: performance.now() - lockStarted,
        metrics: { persistentLockHit: 0, lockReadMs },
      });
    } else {
      this.progressCb?.({
        stage: 'resolve',
        message: 'No cached package closure; resolving normally.',
        fromCache: false,
        durationMs: lockReadMs,
        metrics: { persistentLockHit: 0, lockReadMs },
      });
    }
    const outcome = await acquireForProject(
      host,
      config,
      (ev) => this.progressCb?.({ ...ev }),
      validatedIndex ?? seedIndex,
    );
    // The loop's final resolve happened after its final mount, so a satisfied
    // outcome belongs to the current package generation. Do not memoize a
    // blocked/network outcome forever: an unchanged project must be able to
    // retry when a registry or proxy recovers.
    if (outcome.step.satisfied) {
      this.resolutionCache.record(config, outcome);
      await lockCache.writeResolutionLock(
        config,
        authority,
        outcome.step,
        outcome.versionIndex,
      ).catch(() => {});
    } else {
      this.resolutionCache.clear();
    }
    this.progressCb?.({
      stage: 'resolve',
      message: outcome.step.satisfied
        ? `Resolved package closure (${outcome.step.context_closure.length} packages).`
        : `Package resolution stopped with ${outcome.step.missing.length} missing packages.`,
      durationMs: performance.now() - lockStarted,
      fileCount: outcome.step.context_closure.length,
      metrics: {
        persistentLockHit: 0,
        mountedPackages: outcome.mounted.length,
        missingPackages: outcome.step.missing.length,
      },
    });
    return outcome;
  }

  async snapshot(url: string): Promise<SnapshotResult> {
    const cached = this.snapshotCache.get(url);
    if (cached) {
      this.progressCb?.({ stage: 'snapshot', label: url, message: `Reusing snapshot for ${url}.`, fromCache: true, durationMs: 0 });
      return cached;
    }
    const started = performance.now();
    // Snapshots need the deferred (R5 core) bundle — mount it lazily first.
    await this.ensureSnapshotBundles();
    const res: SnapshotResult = await this.call('snapshot', url);
    this.snapshotCache.set(url, res);
    this.progressCb?.({
      stage: 'snapshot',
      label: url,
      message: `Prepared snapshot for ${url}.`,
      durationMs: performance.now() - started,
      metrics: { wasmSnapshotMs: res.snapshotMs },
    });
    return res;
  }

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — needs no mounted packages beyond the resources passed in, so it
   * runs even before the snapshot bundles are mounted. */
  async expandValueSet(valueSetJson: string, resourcesJson: string): Promise<ExpandResult> {
    return this.call('expandValueSet', valueSetJson, resourcesJson);
  }

  // ---- the complete public site-generation API ---------------------------

  async prepare(project: ProjectInput, spec: GeneratorSpec): Promise<PrepareResult> {
    const started = performance.now();
    try {
      await this.acquireForProject(project.config);
      if (spec.generator === 'publisher') {
        await this.ensureTemplatePackages(spec.templateCoordinate);
        await this.acquireForProject(project.config);
      }
      this.snapshotCache.clear();
      const result = await this.call('prepare', project, spec);
      this.progressCb?.({
        stage: 'site-build',
        message: `Prepared ${result.generator} SiteBuild ${result.buildId}.`,
        durationMs: performance.now() - started,
        fileCount: result.compiled.fileCount,
        metrics: {
          compileProjectMs: result.metrics.compileProjectMs,
          rustPrepareMs: result.metrics.rustPrepareMs,
          hostPrepareMs: result.metrics.hostPrepareMs,
          rustPrepareTotalMs: result.metrics.rust.totalMs,
          projectRevisionMs: result.metrics.rust.projectRevisionMs,
          packageLockMs: result.metrics.rust.packageLockMs,
          preparedGuideKeyMs: result.metrics.rust.preparedGuideKeyMs,
          preparedGuideMs: result.metrics.rust.preparedGuideMs,
          preparedGuideCacheHit: Number(result.metrics.rust.preparedGuideCacheHit),
          siteBuildCacheHit: Number(result.metrics.rust.siteBuildCacheHit),
          templateMaterializeMs: result.metrics.rust.templateMaterializeMs,
          publisherRuntimeMs: result.metrics.rust.publisherRuntimeMs,
          publisherModelMs: result.metrics.rust.publisherModelMs,
          renderModelMs: result.metrics.rust.renderModelMs,
          catalogMs: result.metrics.rust.catalogMs,
        },
      });
      return result;
    } catch (error) {
      if (error instanceof PrepareError) throw error;
      throw new PrepareError(String(error), 'site');
    }
  }

  async outputs(handle: BuildHandle): Promise<OutputCatalog> {
    return this.call('outputs', handle);
  }

  async render(handle: BuildHandle, path: string): Promise<RenderedOutput> {
    return this.call('render', handle, path);
  }

  async finalize(handle: BuildHandle): Promise<SiteOutput> {
    return this.call('finalize', handle);
  }

  /** Acquire exactly the template coordinates requested by Rust's private
   * resolution handshake. No host-side template tree or chain is retained. */
  private async ensureTemplatePackages(coordinate: string): Promise<void> {
    const { obtainAndMountPackage } = await import('./packageResolver');
    const host = {
      resolveStep: (config: string, index?: VersionIndex) => this.resolveStep(config, index),
      mount: async (packages: PackageMountInput[]) => { await this.mountPackages(packages); },
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry) => this.loadBundle(bundle, 'Loading (template)'),
    };
    for (let round = 0; round < 24; round += 1) {
      const step: TemplateResolution = await this.call('resolveTemplate', coordinate);
      if (step.satisfied) return;
      if (!step.missing) throw new Error(`Template ${coordinate} is unresolved without a missing coordinate`);
      const mounted = await obtainAndMountPackage(host, step.missing, (event) => {
        this.progressCb?.({ ...event });
      });
      if (!mounted) throw new Error(`Template ${coordinate} requires unavailable ${step.missing}`);
    }
    throw new Error(`Template ${coordinate} dependency chain exceeded 24 packages`);
  }

  get initialized() {
    return this.inited;
  }
}
