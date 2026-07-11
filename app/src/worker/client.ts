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
  RenderPageResult,
  ResolutionStep,
  SitePreviewResult,
  SiteTreeFile,
  SnapshotResult,
  StockBuildOpenResult,
  StockPageRenderResult,
  StockSiteOptions,
  VersionIndex,
  WorkerReply,
} from './protocol';
import { deleteCachedBundle, readCachedBundleMeasured } from './bundleCache';
import type { ResolveOutcome } from './packageResolver';
import { projectCompileRevision } from '../build/projectRevision';
import { assertCompatibleEngineCommit } from './engineVersion';
import { parseBakedBundleManifest, readVerifiedBundleBytes } from './bundleIntegrity';
import type { BakedBundleEntry, BakedBundleManifest } from './bundleIntegrity';
import { ResolutionCache } from './resolutionCache';
import { getPackageProxy, getRegistries } from '../vfs/packageSettings';
import { exactPackageClosureIdentity } from './packageClosureIdentity';
export type { BlockedPackage, ResolveOutcome } from './packageResolver';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export type ProgressCb = (ev: ProgressEvent) => void;

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private snapshotCache = new Map<string, SnapshotResult>();
  /** Exact compileProject input currently installed in the mutable wasm
   * session, plus its result. This makes repeated renderer/template selection a
   * projection of the same compile rather than a second semantic compile. */
  private compiledProjectRevision: string | null = null;
  private compiledProjectResult: CompileResult | null = null;
  /** One resolver-loop outcome bound to exact config bytes and the current
   * package-mount generation. Rust invalidates its fixpoint on a fresh mount;
   * the host mirrors that law here. */
  private resolutionCache = new ResolutionCache<ResolveOutcome>();
  private inited = false;
  /** Snapshot-engine specials, separate from resolver-selected compile packages. */
  private snapshotBundles: BakedBundleEntry[] = [];
  private snapshotSourcesIdentity = '[]';
  /** The baked manifest's `label -> entry` map, kept so the runtime resolver can
   *  source a missing package from a same-origin prebuilt bundle (task #32). */
  private bakedByLabel = new Map<string, BakedBundleEntry>();
  /** A single in-flight lazy-mount promise so concurrent snapshot/site builds
   * share one fetch of the snapshot-role bundles. */
  private deferredMount: Promise<void> | null = null;
  /** Host mirror used to avoid even reading a package cache entry that the
   * current Worker session has already mounted. */
  private mountedLabels = new Set<string>();
  /** Exact prepared artifact installed for every mounted label. Labels alone
   * are not persistent identities because registries may republish a version. */
  private mountedPackageIdentities = new Map<string, string>();
  private preparedFallbacks = new Map<string, () => Promise<PackageMountInput>>();
  private progressCb: ProgressCb | null = null;
  /** The mounted engine's commit — the invalidation key for the OPFS materialized-
   *  template cache (#40 scope 4): a wasm bump changes this, so stale trees are
   *  never served. Captured on init. */
  private engineCommit = 'unknown';
  /** Exact emitted JS+WASM bytes used for semantic cache authority. */
  private readonly engineRecipe = typeof __ENGINE_RECIPE__ === 'undefined'
    ? `unavailable-${performance.timeOrigin}`
    : __ENGINE_RECIPE__;
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
  private async loadBundle(
    entry: BakedBundleEntry,
    stageLabel: string,
    forceRaw = false,
  ): Promise<PackageMountInput> {
    const started = performance.now();
    const transportIdentity = `tgz-${entry.sha256}`;
    // Template-chain walking currently reads package.json on the host. Keep that
    // deliberately on the raw path until template metadata joins the catalog.
    const preparedEligible = !entry.label.includes('.template#');
    if (!forceRaw && preparedEligible) {
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
    const cached = await readCachedBundleMeasured(entry.label, entry.sha256);
    if (cached) {
      this.progressCb?.({
        stage: 'bundle-cache-hit',
        label: entry.label,
        bytes: entry.bytes,
        message: `${stageLabel} ${entry.label} (cached)`,
        fromCache: true,
        durationMs: cached.metrics.totalMs,
        inputBytes: cached.metrics.storedBytes,
        metrics: {
          opfsReadMs: cached.metrics.opfsReadMs,
          jsonParseMs: cached.metrics.jsonParseMs,
          validationMs: cached.metrics.validationMs,
        },
      });
      return { kind: 'raw', spec: cached.spec, transportIdentity };
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
    // Baked bundles are deployment inputs: authenticate the compressed bytes
    // before the inflater or engine can observe any package content.
    const compressed = await readVerifiedBundleBytes(resp, entry);
    const { inflateBundle } = await import('./inflate');
    const files = await inflateBundle(compressed);
    const spec: BundleSpec = { label: entry.label, files };
    this.progressCb?.({
      stage: stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch',
      label: entry.label,
      bytes: compressed.byteLength,
      message: `${stageLabel} ${entry.label} loaded and inflated.`,
      durationMs: performance.now() - started,
      inputBytes: compressed.byteLength,
      fileCount: Object.keys(files).length,
    });
    // The Worker prepares and persists the binary execution artifact while
    // mounting. Do not create another inflated/base64 cache copy here.
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
    for (const { label, cacheKey } of result.packageIdentities ?? []) {
      this.mountedPackageIdentities.set(label, cacheKey);
    }
    for (const label of result.newlyMounted) this.mountedLabels.add(label);
    for (const label of result.preparedStored ?? []) {
      const raw = transaction.find((item) => item.kind === 'raw' && item.spec.label === label);
      if (!raw || raw.kind !== 'raw') continue;
      const compressedSha256 = raw.transportIdentity.startsWith('tgz-')
        ? raw.transportIdentity.slice(4)
        : undefined;
      void deleteCachedBundle(label, compressedSha256);
    }
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
    this.snapshotSourcesIdentity = JSON.stringify(this.snapshotBundles
      .map(({ label, sha256 }) => ({ label, sha256 }))
      .sort((left, right) => left.label.localeCompare(right.label)));

    this.progressCb?.({ stage: 'wasm', message: 'Starting compiler engine…' });
    const res: InitResult = await this.call('init', []);
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

  /** Ensure the snapshot-role bundles are fetched + mounted. Called
   *  before the first snapshot / site build. Idempotent + concurrency-safe: a
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
        (ev) => this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
      );
      const freshnessMs = performance.now() - freshnessStarted;
      if (validatedIndex) {
        const labels = lockCache.lockedLabels(lock);
        const needed = labels.filter((label) => !this.mountedLabels.has(label));
        const acquireStarted = performance.now();
        const exact = await obtainLockedPackages(
          host,
          needed,
          (ev) => this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
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
      (ev) => this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
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

  async compile(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
    siteFiles: Record<string, string>,
  ): Promise<CompileResult> {
    // Correctness is bound to both authored bytes and the package generation.
    // UI-level config memoization may suppress progress chrome, but it may not
    // bypass re-resolution after a deferred/template/dependency mount.
    const resolution = await this.acquireForProject(config);
    const started = performance.now();
    const packageClosure = exactPackageClosureIdentity(
      resolution.step,
      this.mountedPackageIdentities,
    );
    const revision = await projectCompileRevision({ config, files, predefined, siteFiles, packageClosure });
    if (revision === this.compiledProjectRevision && this.compiledProjectResult) {
      this.progressCb?.({
        stage: 'compile',
        message: 'Reusing unchanged compiled project.',
        fromCache: true,
        durationMs: performance.now() - started,
        fileCount: Object.keys(files).length + Object.keys(predefined).length,
      });
      return this.compiledProjectResult;
    }
    // Every compile invalidates memoized snapshots (resources may have changed).
    this.snapshotCache.clear();
    const result = await this.call('compile', config, files, predefined, siteFiles);
    this.compiledProjectRevision = revision;
    this.compiledProjectResult = result;
    this.progressCb?.({
      stage: 'compile',
      message: `Compiled ${result.fileCount} FSH files and ${Object.keys(predefined).length} predefined resources.`,
      durationMs: performance.now() - started,
      fileCount: result.fileCount + Object.keys(predefined).length,
      metrics: {
        wasmBuildMs: result.buildMs,
        ...(result.packageStorage ? {
          packageCompressedRetainedBytes: result.packageStorage.compressedRetainedBytes,
          packageDeclaredRawBytes: result.packageStorage.declaredRawBytes,
          packageChunksInflated: result.packageStorage.chunksInflated,
          packageRawInflatedBytes: result.packageStorage.rawInflatedBytes,
          packageChunkCacheHits: result.packageStorage.cacheHits,
          packageCachedRawBytes: result.packageStorage.cachedRawBytes,
        } : {}),
      },
    });
    return result;
  }

  /** Ensure the mutable engine session contains exactly these authored inputs.
   * Same-revision calls are free; a site-only request for newer inputs performs
   * the missing compile before any adapter can observe session state. */
  async ensureCompiledProject(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
    siteFiles: Record<string, string>,
  ): Promise<CompileResult> {
    return this.compile(config, files, predefined, siteFiles);
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

  // ---- site-build projections and preview ----

  /** Close the typed Cycle SiteBuild + enumerate renderable pages. */
  async buildSite(
    config: string,
    files: Record<string, string>,
    predefined: Record<string, unknown>,
    siteFiles: Record<string, string>,
    buildEpochSecs: number,
  ): Promise<SitePreviewResult> {
    const started = performance.now();
    // Establish the exact ProjectRevision + PackageLock digest without mounting
    // snapshot-only material. A persistent closed-build hit can then skip both
    // snapshot package work and Rust site production.
    await this.ensureCompiledProject(config, files, predefined, siteFiles);
    let projectRevision = this.compiledProjectRevision;
    if (!projectRevision) throw new Error('compiled project has no exact revision identity');
    const restored = await this.call(
      'restoreCycleSite',
      projectRevision,
      buildEpochSecs,
      this.snapshotSourcesIdentity,
    );
    if (restored) {
      this.progressCb?.({
        stage: 'site-build',
        message: `Restored closed Cycle SiteBuild ${restored.buildId}.`,
        fromCache: true,
        durationMs: performance.now() - started,
        fileCount: restored.pages.length + restored.assets.length,
        metrics: { workerBuildMs: restored.buildMs, persistentClosedBuildHit: 1 },
      });
      return restored;
    }
    // A cache miss needs the snapshot-role package. Its mount invalidates the
    // resolver fixpoint; re-establish the exact compile closure afterward.
    await this.ensureSnapshotBundles();
    await this.ensureCompiledProject(config, files, predefined, siteFiles);
    projectRevision = this.compiledProjectRevision;
    if (!projectRevision) throw new Error('compiled project lost its exact revision identity');
    const result = await this.call(
      'buildSite',
      config,
      files,
      predefined,
      siteFiles,
      buildEpochSecs,
      projectRevision,
      this.snapshotSourcesIdentity,
    );
    this.progressCb?.({
      stage: 'site-build',
      message: `Closed Cycle SiteBuild ${result.buildId}.`,
      durationMs: performance.now() - started,
      fileCount: result.pages.length + result.assets.length,
      metrics: { workerBuildMs: result.buildMs, persistentClosedBuildHit: 0 },
    });
    return result;
  }

  /** Render one page to HTML (render-on-demand per visible page). */
  async renderPage(file: string): Promise<RenderPageResult> {
    return this.call('renderPage', file);
  }

  /** Fetch an asset's bytes (base64) for serving into the preview iframe. */
  async assetBytes(name: string): Promise<{ name: string; mime: string; base64: string; fromCache?: boolean } | null> {
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

  /** Freeze the current compiled/template/authored stock generation behind a
   * content-derived predecessor handle. All page rendering must use this handle
   * (or one of its returned successors), never the ambient Session site tree. */
  async openStockBuild(templateCoord: string): Promise<StockBuildOpenResult> {
    return this.call('openStockBuild', templateCoord);
  }

  /** Render from an explicit frozen stock build and return the immutable
   * successor plus its typed Need<ArtifactKey> resolution batch. */
  async renderStockPage(handle: string, name: string): Promise<StockPageRenderResult> {
    return this.call('renderStockPage', handle, name);
  }

  /** LIVE template load (#40): the full resolve→fetch→mount→materialize path.
   *  Walks the template's `base` chain (Rust's rule, mirrored in JS because
   *  `mountTemplate` consumes an already-mounted chain), fetching + mounting each
   *  chain package via the SAME transport regular packages use, then calls
   *  `Session.mountTemplate` to materialize the tree into the engine site tree.
   *  Any AntHookError (custom-ant template) propagates as an Error whose message
   *  contains "never execute ant" — the adapter maps that to a friendly refusal. */
  async mountTemplateChain(coord: string): Promise<{
    chain: string[];
    files: number;
    assets: Record<string, SiteTreeFile>;
  }> {
    const { mountTemplateChain } = await import('./templateChain');
    const host = {
      // Template chain packages are not sushi-config deps, so resolveStep/bakedBundle
      // are reused only for their transport (baked bundle lookup + registry fetch);
      // the CHAIN decision lives in the walk, not in resolveStep.
      resolveStep: (cfg: string, idx?: VersionIndex) => this.resolveStep(cfg, idx),
      mount: async (packages: PackageMountInput[]) => {
        await this.mountPackages(packages);
      },
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry) => this.loadBundle(bundle, 'Loading (template)'),
    };
    const { chain, assets } = await mountTemplateChain(host, coord, (ev) =>
      this.progressCb?.({ stage: ev.stage, label: ev.label, message: ev.message }),
    );
    this.progressCb?.({ stage: 'bundle-mount', label: coord, message: `Materializing template ${coord}…` });
    const { files } = await this.mountTemplate(coord);
    this.progressCb?.({ stage: 'ready', message: `Template ${coord} materialized — ${files} files.` });
    return { chain, files, assets };
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
    const cached = await readCachedTemplateTree(coord, this.engineRecipe);
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
    void writeCachedTemplateTree(coord, this.engineRecipe, mapped);
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

  /** Render one Publisher fragment (`{Type}-{id}`, kind) through the native
   * typed artifact cache. Used by the stock-template warm-up path. */
  async renderFragment(ref: string, kind: string): Promise<{ html: string }> {
    return this.call('renderFragment', ref, kind);
  }

  /** Generic native Rust Liquid operation over the mounted session provider. */
  async renderLiquid(source: string, data?: Record<string, unknown>): Promise<{ html: string }> {
    return this.call('renderLiquid', source, data);
  }

  /** Generic native Markdown operation with Jekyll markdownify semantics. */
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
