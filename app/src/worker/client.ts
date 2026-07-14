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
  BuildError,
  CompileResult,
  EngineOps,
  ExpandResult,
  InitResult,
  MountResult,
  Op,
  PackageMountInput,
  PrepareTransportResult,
  BuildEvent,
  ResolutionStep,
  SnapshotResult,
  TemplateResolution,
  VersionIndex,
  WorkerReply,
} from './protocol';
import type { Build } from '../site/contract';
import type {
  ContentRef,
  GeneratorSpec,
  OutputCatalog,
  ProjectRevision,
  SiteOutput,
} from '../site/contract.generated';
import type { ResolveOutcome } from './packageResolver';
import { assertCompatibleEngineCommit } from './engineVersion';
import {
  BakedBundleTransportError,
  parseBakedBundleManifest,
  readVerifiedBundleBytes,
} from './bundleIntegrity';
import type { BakedBundleEntry, BakedBundleManifest } from './bundleIntegrity';
import { ResolutionCache } from './resolutionCache';
import { getPackageProxy, getRegistries } from '../vfs/packageSettings';
export type { BlockedPackage, ResolveOutcome } from './packageResolver';

class ImmutableBuild implements Build {
  private readonly buildId: string;
  readonly compilation: CompileResult;

  constructor(
    prepared: PrepareTransportResult,
    private readonly outputOperation: () => Promise<OutputCatalog>,
    private readonly renderOperation: (path: string) => Promise<ContentRef>,
    private readonly finalizeOperation: () => Promise<SiteOutput>,
    private readonly report: ProgressCb | null,
  ) {
    this.buildId = prepared.buildId;
    this.compilation = prepared.compiled;
    Object.freeze(this);
  }

  async outputs(): Promise<OutputCatalog> {
    const started = performance.now();
    const catalog = await this.outputOperation();
    this.report?.({
      operation: 'outputs',
      buildId: this.buildId,
      stage: 'site-build',
      message: `Listed ${catalog.outputs.length} outputs.`,
      durationMs: performance.now() - started,
      fileCount: catalog.outputs.length,
    });
    return catalog;
  }

  async render(path: string): Promise<ContentRef> {
    const started = performance.now();
    const content = await this.renderOperation(path);
    this.report?.({
      operation: 'render',
      buildId: this.buildId,
      stage: 'site-build',
      label: path,
      message: `Rendered ${path}.`,
      durationMs: performance.now() - started,
      outputBytes: content.byteLength,
    });
    return content;
  }

  async finalize(): Promise<SiteOutput> {
    const started = performance.now();
    const output = await this.finalizeOperation();
    this.report?.({
      operation: 'finalize',
      buildId: this.buildId,
      stage: 'site-build',
      message: `Finalized ${output.files.length} outputs.`,
      durationMs: performance.now() - started,
      fileCount: output.files.length,
    });
    return output;
  }
}

/** Typed failure from any Build lifecycle or functional operation. */
export class BuildFailure extends Error {
  constructor(readonly detail: BuildError<CompileResult>) {
    super(detail.message);
    this.name = 'BuildFailure';
  }
}

function failedRegistryTgzCarrier(
  error: unknown,
  transaction: PackageMountInput[],
): Extract<PackageMountInput, { kind: 'tgz' }> | null {
  if (!(error instanceof BuildFailure)
    || error.detail.operation !== 'lifecycle'
    || error.detail.phase !== 'package-transport'
    || error.detail.code !== 'integrity'
    || !error.detail.retryable) return null;
  return transaction.find((item): item is Extract<PackageMountInput, { kind: 'tgz' }> => (
    item.kind === 'tgz'
      && error.detail.message.startsWith(
        `TGZ package ${JSON.stringify(item.label)} could not be prepared:`,
      )
  )) ?? null;
}

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export type ProgressCb = (ev: BuildEvent) => void;

const MAX_RETAINED_CYCLE_SUCCESSOR_FILES = 128;
const MAX_RETAINED_CYCLE_SUCCESSOR_CODE_UNITS = 16 * 1024 * 1024;

/** The one no-recycle exception is a bounded input class, not trust in an
 * editable project id. It exists only to exercise the certified lightweight
 * external-builder A -> B -> A path beside one retained Publisher runtime. */
function isBoundedCycleSuccessor(project: ProjectRevision, spec: GeneratorSpec): boolean {
  if (spec.generator !== 'cycle') return false;
  const values = [
    project.config,
    ...Object.values(project.fsh),
    ...Object.values(project.siteFiles),
    JSON.stringify(project.predefined) ?? '',
  ];
  const fileCount = Object.keys(project.fsh).length
    + Object.keys(project.siteFiles).length
    + Object.keys(project.predefined).length;
  return fileCount <= MAX_RETAINED_CYCLE_SUCCESSOR_FILES
    && values.reduce((sum, value) => sum + value.length, 0)
      <= MAX_RETAINED_CYCLE_SUCCESSOR_CODE_UNITS;
}

export class EngineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private snapshotCache = new Map<string, SnapshotResult>();
  private builds = new Map<string, Build>();
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
  /** The mounted engine's commit, checked against the app's expected commit so
   * stale app/engine mixes fail clearly. Captured on init. */
  private engineCommit = 'unknown';
  /** Exact emitted JS+WASM bytes used for semantic cache authority. */
  private readonly engineRecipe = typeof __ENGINE_RECIPE__ === 'undefined'
    ? `unavailable-${performance.timeOrigin}`
    : __ENGINE_RECIPE__;
  /** The Rust executor retains exactly two semantic generations. Mirror that
   * identity at the Worker owner so A -> B -> A stays warm, while a third
   * distinct project recycles before attempting a third allocation graph. */
  private preparedConfigs: string[] = [];
  private lastCompiledResourceCount: number | null = null;
  private recycleCount = 0;
  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    const worker = new EngineWorker();
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new BuildFailure(e.data.error));
    };
    return worker;
  }

  private async recycleWorker(report: ProgressCb | null): Promise<void> {
    if (this.pending.size !== 0) {
      throw new Error('cannot recycle the engine while another operation is pending');
    }
    const retired = this.worker;
    retired.onmessage = null;
    retired.terminate();
    // Worker termination is asynchronous below the DOM API. Yield before
    // creating another WASM instance so Chromium can retire the old thread and
    // linear memory instead of briefly overlapping both multi-GB heaps.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.worker = this.createWorker();
    this.inited = false;
    this.engineCommit = 'unknown';
    this.mountedLabels.clear();
    this.preparedFallbacks.clear();
    this.resolutionCache.clear();
    this.snapshotCache.clear();
    this.builds.clear();
    this.deferredMount = null;
    this.snapshotBundles = [...this.bakedByLabel.values()]
      .filter((bundle) => bundle.loadPhase === 'snapshot');
    this.preparedConfigs = [];
    this.lastCompiledResourceCount = null;
    this.recycleCount += 1;
    report?.({
      stage: 'wasm',
      message: 'Reclaiming compiler memory before opening another large guide…',
    });
    const res: InitResult = await this.call('init');
    this.engineCommit = res.version?.commit || 'unknown';
    assertCompatibleEngineCommit(
      typeof __ENGINE_COMMIT__ === 'undefined' ? undefined : __ENGINE_COMMIT__,
      this.engineCommit,
    );
    this.inited = true;
  }

  /** ONE call path for every engine operation (ledger #2): the op table in
   *  protocol.ts types both the args and the result. */
  private call<K extends Op>(op: K, ...args: EngineOps[K]['args']): Promise<EngineOps[K]['result']> {
    return this.request(op, args);
  }

  private request<K extends Op>(
    op: K,
    args: EngineOps[K]['args'],
    transfer: Transferable[] = [],
  ): Promise<EngineOps[K]['result']> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.worker.postMessage({ id, op, args }, transfer);
      } catch (error) {
        // A synchronous structured-clone/transfer failure never reaches the
        // Worker, so it must not leave an unreachable pending request behind.
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** Select a complete PreparedPackage or fetch/authenticate its exact
   * compressed carrier. Cold bytes remain binary through Worker preparation. */
  private async loadBundle(
    entry: BakedBundleEntry,
    stageLabel: string,
    forceRaw = false,
    report: ProgressCb | null,
  ): Promise<PackageMountInput> {
    const started = performance.now();
    const transportIdentity = `tgz-${entry.sha256}`;
    // PreparedPackage v3 represents the complete package, including template
    // metadata. Templates therefore use the same authenticated warm path and
    // raw cold fallback as every other package.
    if (!forceRaw) {
      const { findPreparedPackage } = await import('./preparedPackageCache');
      const pointer = await findPreparedPackage(entry.label, transportIdentity);
      if (pointer) {
        this.preparedFallbacks.set(
          entry.label,
          () => this.loadBundle(entry, stageLabel, true, report),
        );
        report?.({
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
    report?.({
      stage: stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch',
      label: entry.label,
      bytes: 0,
      totalBytes: entry.bytes,
      message: `${stageLabel} ${entry.label}…`,
    });
    // Bundle filenames contain '#' (e.g. hl7.fhir.r4.core#4.0.1.tgz); a raw '#'
    // in a URL is a fragment delimiter, so encode it (the P0 gotcha).
    const url = `${BASE}data/bundles/${encodeURIComponent(entry.tgz)}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (error) {
      throw new BakedBundleTransportError(
        `fetch baked package ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // Baked bundles are deployment inputs: authenticate the compressed bytes
    // before the inflater or engine can observe any package content.
    const transportStage = stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch';
    const compressed = await readVerifiedBundleBytes(
      resp,
      entry,
      (bytes, totalBytes) => {
        report?.({
          stage: transportStage,
          label: entry.label,
          bytes,
          totalBytes,
          message: `${stageLabel} ${entry.label}…`,
        });
      },
      () => report?.({
        stage: 'bundle-unpack',
        label: entry.label,
        message: `Verifying and unpacking ${entry.label}…`,
        inputBytes: entry.bytes,
      }),
    );
    report?.({
      stage: 'resolve',
      label: entry.label,
      message: `${stageLabel} ${entry.label} verified; ready to prepare.`,
      durationMs: performance.now() - started,
      inputBytes: compressed.byteLength,
    });
    return { kind: 'tgz', label: entry.label, bytes: compressed, transportIdentity };
  }

  /** The only incremental mount path on the main thread. Keep resolution,
   * compile, and snapshot caches synchronized with the worker/Rust session. */
  private async mountPackages(
    packages: PackageMountInput[],
    report: ProgressCb | null,
  ): Promise<MountResult> {
    let transaction = packages;
    const started = performance.now();
    const labelOf = (item: PackageMountInput) => item.kind === 'raw'
      ? item.spec.label
      : item.kind === 'tgz'
        ? item.label
        : item.pointer.label;
    report?.({
      stage: 'bundle-mount',
      message: `Preparing and mounting ${packages.length} package${packages.length === 1 ? '' : 's'}…`,
      inputBytes: packages.reduce((sum, item) => sum + (
        item.kind === 'tgz' ? item.bytes.byteLength : item.kind === 'prepared' ? item.pointer.bytes : 0
      ), 0),
      fileCount: packages.length,
    });
    let result: MountResult;
    for (;;) {
      const coldCarriers = transaction.filter(
        (item): item is Extract<PackageMountInput, { kind: 'tgz' }> => item.kind === 'tgz',
      );
      // An all-cold batch has no same-call fallback that could reuse its input;
      // transfer exact pinned carriers to the Worker instead of copying them.
      // Registry carriers remain attached because a typed Rust decode failure
      // may continue at the next configured registry; the rest of the atomic
      // batch must remain reusable for that retry.
      const transfer = coldCarriers.length === transaction.length
        && coldCarriers.every((item) => item.transportIdentity !== 'unpinned')
        ? coldCarriers.map((item) => item.bytes)
        : [];
      try {
        result = await this.request('mountPackages', [transaction], transfer);
        break;
      } catch (error) {
        // A missing/corrupt prepared artifact is an optimization miss. Reacquire
        // only prepared members and retry the unchanged atomic order.
        if (transaction.some((item) => item.kind === 'prepared')) {
          transaction = await Promise.all(transaction.map(async (item) => {
            if (item.kind !== 'prepared') return item;
            try {
              return await this.rawFallbackForPrepared(item.pointer.label);
            } catch {
              throw error;
            }
          }));
          continue;
        }

        // Only the Worker/Rust typed package-transport integrity failure may
        // advance registry order. Baked/local TGZ carriers have no registry
        // continuation and remain fail-closed.
        const failed = failedRegistryTgzCarrier(error, transaction);
        if (!failed) throw error;
        const { retryRegistryTgzCarrier } = await import('./packageResolver');
        const replacement = await retryRegistryTgzCarrier(
          failed,
          (event) => report?.(event),
        );
        if (!replacement) throw error;
        transaction = transaction.map((item) => item === failed ? replacement : item);
      }
    }
    const rpcMs = performance.now() - started;
    for (const label of result.newlyMounted) this.mountedLabels.add(label);
    // A mount invalidates resolution of the *next* compile, but it does not
    // mutate the exact package allow-list retained by Rust's previous compiled
    // revision. Keep that immutable result until re-resolution proves its
    // closure changed.
    this.resolutionCache.noteMount(result.newlyMounted);
    for (const event of result.events) {
      report?.({
        ...event,
        label: event.label ?? transaction.map(labelOf).join(', '),
        metrics: {
          ...event.metrics,
          workerRoundTripMs: rpcMs,
        },
      });
    }
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
    const report = onProgress ?? null;

    report?.({ stage: 'manifest', message: 'Loading package manifest…' });
    const manifestResponse = await fetch(`${BASE}data/bundles/manifest.json`);
    if (!manifestResponse.ok) {
      throw new Error(`fetch package bundle manifest -> ${manifestResponse.status}`);
    }
    const manifest: BakedBundleManifest = parseBakedBundleManifest(await manifestResponse.json());

    for (const b of manifest.bundles) this.bakedByLabel.set(b.label, b);
    this.snapshotBundles = manifest.bundles.filter((bundle) => bundle.loadPhase === 'snapshot');
    report?.({ stage: 'wasm', message: 'Starting compiler engine…' });
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
    for (const event of res.events) report?.(event);
    report?.({
      stage: 'ready',
      message: `Engine ready — ${manifest.bundles.length} packages available on demand.`,
    });
    return res;
  }

  /** Ensure the snapshot-role bundles are fetched + mounted. Called only
   *  before the first explicit snapshot inspection. Site preparation resolves
   *  its exact package closure independently and must not pull the R5 support
   *  bundle into an ordinary R4 preview. Idempotent + concurrency-safe: a
   *  single shared promise; subsequent calls resolve instantly. */
  async ensureSnapshotBundles(report: ProgressCb | null = null): Promise<void> {
    if (this.snapshotBundles.length === 0) return;
    if (this.deferredMount) return this.deferredMount;
    this.deferredMount = (async () => {
      const needed = this.snapshotBundles.filter((entry) => !this.mountedLabels.has(entry.label));
      const { packageBatchProgress } = await import('./packageResolver');
      const batch = packageBatchProgress(needed.map((entry) => entry.label), (event) => report?.(event));
      const specs = await Promise.all(needed.map(async (entry) => {
        const spec = await this.loadBundle(entry, 'Loading (profile dependency)', false, batch.report);
        batch.complete(entry.label);
        return spec;
      }));
      report?.({
        stage: 'bundle-mount',
        message: `Mounting ${specs.map((item) => item.kind === 'raw' ? item.spec.label : item.kind === 'tgz' ? item.label : item.pointer.label).join(', ')}…`,
      });
      const r = await this.mountPackages(specs, report);
      // Mounted now; clear the deferred list so we don't re-fetch.
      this.snapshotBundles = [];
      report?.({
        stage: 'ready',
        message: `Profile dependencies ready — ${r.mounted} packages mounted.`,
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
  async acquireForProject(
    config: string,
    report: ProgressCb | null = null,
  ): Promise<ResolveOutcome> {
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
        await this.mountPackages(bundles, report);
      },
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry, report: ProgressCb) => this.loadBundle(bundle, 'Loading (dependency)', false, report),
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
        (ev) => report?.({ ...ev }),
      );
      const freshnessMs = performance.now() - freshnessStarted;
      if (validatedIndex) {
        const labels = lockCache.lockedLabels(lock);
        const needed = labels.filter((label) => !this.mountedLabels.has(label));
        const acquireStarted = performance.now();
        const exact = await obtainLockedPackages(
          host,
          needed,
          (ev) => report?.({ ...ev }),
        );
        const acquireMs = performance.now() - acquireStarted;
        if (exact.blocked.length === 0 && exact.packages.length === needed.length) {
          const mountStarted = performance.now();
          const lockMount = exact.packages.length > 0
            ? await this.mountPackages(exact.packages, report)
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
            report?.({
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
      report?.({
        stage: 'resolve',
        message: 'Cached package closure was stale or incomplete; resolving normally.',
        fromCache: false,
        durationMs: performance.now() - lockStarted,
        metrics: { persistentLockHit: 0, lockReadMs },
      });
    } else {
      report?.({
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
      (ev) => report?.({ ...ev }),
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
    report?.({
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

  async snapshot(url: string, report: ProgressCb | null = null): Promise<SnapshotResult> {
    const cached = this.snapshotCache.get(url);
    if (cached) {
      report?.({ stage: 'snapshot', label: url, message: `Reusing snapshot for ${url}.`, fromCache: true, durationMs: 0 });
      return cached;
    }
    const started = performance.now();
    // Snapshots need the deferred (R5 core) bundle — mount it lazily first.
    await this.ensureSnapshotBundles(report);
    const res: SnapshotResult = await this.call('snapshot', url);
    this.snapshotCache.set(url, res);
    report?.({
      stage: 'snapshot',
      label: url,
      message: `Prepared full definition for ${url}.`,
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

  async prepare(
    project: ProjectRevision,
    spec: GeneratorSpec,
    report: ProgressCb | null = null,
  ): Promise<Build> {
    const started = performance.now();
    try {
      const switchingProject = !this.preparedConfigs.includes(project.config);
      // A zero-emission predefined Publisher guide can hold a very large
      // package/render graph. Recycle before every unbounded successor, with
      // one certified exception: the built-in small Cycle fixture can coexist
      // with one retained Publisher runtime for the measured A -> B -> A path.
      // A third distinct project always recycles.
      const smallCycleSuccessor = isBoundedCycleSuccessor(project, spec);
      if (switchingProject
        && (this.preparedConfigs.length >= 2
          || (this.lastCompiledResourceCount === 0 && !smallCycleSuccessor))) {
        await this.recycleWorker(report);
      }
      await this.acquireForProject(project.config, report);
      if (spec.generator === 'publisher') {
        await this.ensureTemplatePackages(spec.templateCoordinate, report);
        await this.acquireForProject(project.config, report);
      }
      this.snapshotCache.clear();
      report?.({
        operation: 'prepare',
        stage: 'compile',
        message: 'Compiling definitions and preparing the site…',
        fileCount: Object.keys(project.fsh).length,
      });
      const result = await this.call('prepare', project, spec);
      for (const event of result.events) report?.(event);
      report?.({
        stage: 'site-build',
        label: result.buildId,
        message: `Prepared ${result.generator} SiteBuild ${result.buildId}.`,
        durationMs: performance.now() - started,
        fileCount: Object.keys(project.fsh).length,
      });
      this.preparedConfigs = this.preparedConfigs
        .filter((config) => config !== project.config);
      this.preparedConfigs.push(project.config);
      if (this.preparedConfigs.length > 2) this.preparedConfigs.shift();
      this.lastCompiledResourceCount = result.compiled.resources.length;
      const build = new ImmutableBuild(
        result,
        () => this.call('outputs', result.buildId),
        (path) => this.call('render', result.buildId, path),
        () => this.call('finalize', result.buildId),
        report,
      );
      this.builds.delete(result.buildId);
      this.builds.set(result.buildId, build);
      while (this.builds.size > 2) {
        const retired = this.builds.keys().next().value;
        if (retired === undefined) break;
        this.builds.delete(retired);
      }
      return build;
    } catch (error) {
      if (error instanceof BuildFailure) throw error;
      throw new BuildFailure({
        operation: 'prepare',
        phase: 'preparation',
        code: 'internal',
        message: String(error),
        retryable: false,
      });
    }
  }

  open(buildId: string): Build | undefined {
    return this.builds.get(buildId);
  }

  /** Acquire exactly the template coordinates requested by Rust's private
   * resolution handshake. No host-side template tree or chain is retained. */
  private async ensureTemplatePackages(
    coordinate: string,
    report: ProgressCb | null,
  ): Promise<void> {
    const { obtainAndMountPackage } = await import('./packageResolver');
    const host = {
      resolveStep: (config: string, index?: VersionIndex) => this.resolveStep(config, index),
      mount: async (packages: PackageMountInput[]) => { await this.mountPackages(packages, report); },
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry, report: ProgressCb) => this.loadBundle(bundle, 'Loading (template)', false, report),
    };
    for (let round = 0; round < 24; round += 1) {
      const step: TemplateResolution = await this.call('resolveTemplate', coordinate);
      if (step.satisfied) return;
      if (!step.missing) throw new Error(`Template ${coordinate} is unresolved without a missing coordinate`);
      const mounted = await obtainAndMountPackage(host, step.missing, (event) => {
        report?.({ ...event });
      });
      if (!mounted) throw new Error(`Template ${coordinate} requires unavailable ${step.missing}`);
    }
    throw new Error(`Template ${coordinate} dependency chain exceeded 24 packages`);
  }

  get initialized() {
    return this.inited;
  }
}
