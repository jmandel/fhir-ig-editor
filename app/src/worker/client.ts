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
  PackageMountStageResult,
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
import type { ResolveOutcome, ResolverMountTransaction } from './packageResolver';
import { assertCompatibleEngineCommit } from './engineVersion';
import {
  BakedBundleTransportError,
  parseBakedBundleManifest,
  readVerifiedBundleBytes,
} from './bundleIntegrity';
import type { BakedBundleEntry, BakedBundleManifest } from './bundleIntegrity';
import { openPackageTransport } from './transportInactivity';
import { reactivateCachedResolution, ResolutionCache } from './resolutionCache';
import { packageSourceSnapshot } from '../vfs/packageSettings';
import type { PackageSourceSnapshot } from '../vfs/packageSettings';
import { epochMs, pointEvent, spanEvent } from '../performance/timeline';
import { ingestTgz, localPackageEpoch, LocalPackageAuthority } from './localPackages';
import {
  VersionObservationCache,
} from './versionObservationCache';
import type {
  VersionObservation,
  VersionObservationAttempt,
} from './versionObservationCache';
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
    const startedMs = epochMs();
    const catalog = await this.outputOperation();
    emitProgress(this.report, spanEvent('site.outputs', 'window', startedMs, {
      operation: 'outputs',
      buildId: this.buildId,
      stage: 'site-build',
      message: `Listed ${catalog.outputs.length} outputs.`,
      fileCount: catalog.outputs.length,
    }));
    return catalog;
  }

  async render(path: string): Promise<ContentRef> {
    const startedMs = epochMs();
    const content = await this.renderOperation(path);
    emitProgress(this.report, spanEvent('site.render', 'window', startedMs, {
      operation: 'render',
      buildId: this.buildId,
      stage: 'site-build',
      label: path,
      message: `Rendered ${path}.`,
      outputBytes: content.byteLength,
    }));
    return content;
  }

  async finalize(): Promise<SiteOutput> {
    const startedMs = epochMs();
    const output = await this.finalizeOperation();
    emitProgress(this.report, spanEvent('site.finalize', 'window', startedMs, {
      operation: 'finalize',
      buildId: this.buildId,
      stage: 'site-build',
      message: `Finalized ${output.files.length} outputs.`,
      fileCount: output.files.length,
    }));
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

export type EngineInitializationStage = 'manifest' | 'wasm';

/** Preserve which independent startup branch failed without changing the
 * underlying error text presented to the user. */
export class EngineInitializationFailure extends Error {
  constructor(
    readonly stage: EngineInitializationStage,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'EngineInitializationFailure';
  }
}

function isFailedRegistryTgzCarrier(
  error: unknown,
  item: Extract<PackageMountInput, { kind: 'tgz' }>,
): boolean {
  if (!(error instanceof BuildFailure)
    || error.detail.operation !== 'lifecycle'
    || error.detail.phase !== 'package-transport'
    || error.detail.code !== 'integrity'
    || !error.detail.retryable) return false;
  return error.detail.message.startsWith(
    `TGZ package ${JSON.stringify(item.label)} could not be prepared:`,
  );
}

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

export type ProgressCb = (ev: BuildEvent) => void;
export type EngineFatalCb = (error: Error) => void;

function emitProgress(report: ProgressCb | null, event: BuildEvent): void {
  try {
    report?.(event);
  } catch (error) {
    console.error('progress observer failed', error);
  }
}

function emitFatal(listener: EngineFatalCb, error: Error): void {
  try {
    listener(error);
  } catch (observerError) {
    console.error('engine fatal observer failed', observerError);
  }
}

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
  private initPromise: Promise<InitResult> | null = null;
  private disposed = false;
  private workerFailure: Error | null = null;
  private fatalFailure: Error | null = null;
  private readonly fatalListeners = new Set<EngineFatalCb>();
  private snapshotCache = new Map<string, SnapshotResult>();
  /** Invalidates late snapshot completions before any new prepare starts. */
  private projectGeneration = 0;
  /** Snapshot inspection joins the currently installing semantic revision. */
  private prepareBarrier: Promise<void> = Promise.resolve();
  private builds = new Map<string, Build>();
  /** One resolver-loop outcome bound to exact config bytes and the current
   * package-mount generation. Rust invalidates its fixpoint on a fresh mount;
   * the host mirrors that law here. */
  private resolutionCache = new ResolutionCache<ResolveOutcome>();
  /** Successful mutable registry observations are session-bound and promoted
   * only by a satisfied acquisition attempt. */
  private versionObservations = new VersionObservationCache<VersionObservation>(
    (value) => value.cacheable && !value.unreachable,
  );
  private packageSourceEpoch: string | null = null;
  private inited = false;
  /** The baked manifest's `label -> entry` map, kept so the runtime resolver can
   *  source a missing package from a same-origin prebuilt bundle (task #32). */
  private bakedByLabel = new Map<string, BakedBundleEntry>();
  /** Host mirror used to avoid even reading a package cache entry that the
   * current Worker session has already mounted. */
  private mountedLabels = new Set<string>();
  private preparedFallbacks = new Map<string, () => Promise<PackageMountInput>>();
  /** Local package bytes are process-scoped authority while mounted package
   * state is Worker-scoped. This transaction keeps those lifetimes coherent. */
  private readonly localPackageAuthority = new LocalPackageAuthority();
  /** One package transaction may remain open while network requests finish.
   * Serialize complete ticket lifetimes, not merely individual Worker RPCs. */
  private packageMountTail: Promise<void> = Promise.resolve();
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
  private workerCreatedAtMs = 0;
  constructor() {
    this.worker = this.createWorker();
  }

  private createWorker(): Worker {
    if (this.disposed) throw new Error('engine client is disposed');
    this.versionObservations.clear();
    this.resolutionCache.clear();
    this.packageSourceEpoch = null;
    this.workerCreatedAtMs = epochMs();
    const worker = new EngineWorker();
    this.workerFailure = null;
    this.fatalFailure = null;
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const { id } = e.data;
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new BuildFailure(e.data.error));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const location = event.filename
        ? ` (${event.filename}${event.lineno ? `:${event.lineno}${event.colno ? `:${event.colno}` : ''}` : ''})`
        : '';
      this.failWorker(
        worker,
        new Error(`compiler Worker failed${location}: ${event.message || 'unknown Worker error'}`, {
          cause: event.error,
        }),
      );
    };
    worker.onmessageerror = () => {
      this.failWorker(worker, new Error('compiler Worker returned an unreadable message'));
    };
    return worker;
  }

  private invalidatePackageAuthority(): void {
    this.packageSourceEpoch = null;
    this.versionObservations.clear();
    this.resolutionCache.clear();
  }

  private synchronizePackageAuthority(
    source: PackageSourceSnapshot,
    localEpoch: number,
  ): string {
    const sourceEpoch = JSON.stringify([source.sourceKey, localEpoch]);
    if (this.packageSourceEpoch !== sourceEpoch) {
      this.resolutionCache.clear();
      this.packageSourceEpoch = sourceEpoch;
    }
    this.versionObservations.syncScope(sourceEpoch);
    return sourceEpoch;
  }

  private detachWorker(worker: Worker): void {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
  }

  private rejectPending(reason: Error): void {
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  /** A Worker crash is terminal for its mutable Session. Reject every request
   * against that exact Worker, then make later calls fail immediately instead
   * of leaving an init/build promise pending forever. A deliberate recycle
   * installs a fresh Worker and clears this generation-scoped failure. */
  private failWorker(worker: Worker, reason: Error): void {
    if (this.disposed || this.worker !== worker) return;
    if (this.fatalFailure) return;
    this.workerFailure = reason;
    this.fatalFailure = reason;
    this.inited = false;
    this.detachWorker(worker);
    worker.terminate();
    this.rejectPending(reason);
    for (const listener of [...this.fatalListeners]) emitFatal(listener, reason);
  }

  /** Observe terminal failure of the currently-owned Worker. The failure is
   * replayed so a React remount cannot accidentally rejoin a stale resolved
   * startup promise and present the dead engine as ready. */
  onFatal(listener: EngineFatalCb): () => void {
    if (this.disposed) return () => {};
    this.fatalListeners.add(listener);
    if (this.fatalFailure) emitFatal(listener, this.fatalFailure);
    return () => {
      this.fatalListeners.delete(listener);
    };
  }

  private async acquirePackageMountLock(): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.packageMountTail;
    this.packageMountTail = previous.then(() => gate, () => gate);
    await previous.catch(() => {});
    return release;
  }

  private async recycleWorker(report: ProgressCb | null): Promise<void> {
    const release = await this.acquirePackageMountLock();
    try {
      await this.recycleWorkerUnlocked(report);
    } finally {
      release();
    }
  }

  private async recycleWorkerUnlocked(report: ProgressCb | null): Promise<void> {
    if (this.disposed) throw new Error('engine client is disposed');
    if (this.pending.size !== 0) {
      throw new Error('cannot recycle the engine while another operation is pending');
    }
    const recycleStartedMs = epochMs();
    const nextRecycle = this.recycleCount + 1;
    const recycleLabel = `recycle-${nextRecycle}`;
    emitProgress(report, pointEvent('engine.recycle.start', 'window', {
      stage: 'wasm',
      label: recycleLabel,
      message: 'Reclaiming compiler memory before opening another large guide…',
      metrics: { recycleCount: nextRecycle },
    }, recycleStartedMs));
    const retired = this.worker;
    // Close the request gate before terminating. Even a direct protocol caller
    // racing the bounded memory-release wait must reject, never post to a dead
    // Worker and remain pending forever. createWorker reopens the gate.
    this.workerFailure = new Error('compiler Worker is recycling');
    this.detachWorker(retired);
    retired.terminate();
    // Worker termination is asynchronous below the DOM API. Yield before
    // creating another WASM instance so Chromium can retire the old thread and
    // linear memory instead of briefly overlapping both multi-GB heaps.
    const waitStartedMs = epochMs();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const waitFinishedMs = epochMs();
    emitProgress(report, spanEvent('engine.recycle.wait', 'window', waitStartedMs, {
      stage: 'wasm',
      label: recycleLabel,
      message: 'Allowed the retired compiler Worker to release its linear memory.',
      metrics: { configuredWaitMs: 250, recycleCount: nextRecycle },
    }, waitFinishedMs));
    if (this.disposed) throw new Error('engine client is disposed');
    this.worker = this.createWorker();
    this.inited = false;
    this.engineCommit = 'unknown';
    this.mountedLabels.clear();
    this.preparedFallbacks.clear();
    this.resolutionCache.clear();
    this.snapshotCache.clear();
    this.builds.clear();
    this.preparedConfigs = [];
    this.lastCompiledResourceCount = null;
    this.recycleCount = nextRecycle;
    const rpcStartedMs = epochMs();
    emitProgress(report, pointEvent('engine.recycle.init-request', 'window', {
      stage: 'wasm',
      label: recycleLabel,
      message: 'Starting replacement compiler engine…',
      metrics: { recycleCount: nextRecycle },
    }, rpcStartedMs));
    const replacement = this.worker;
    let res: InitResult;
    let rpcFinishedMs: number;
    let workerEvents: BuildEvent[];
    try {
      const replacementInit = this.call('init');
      this.initPromise = replacementInit;
      res = await replacementInit;
      rpcFinishedMs = epochMs();
      const workerReady = res.events.find((event) => event.phase === 'engine.worker.ready');
      workerEvents = res.events
        .filter((event) => event !== workerReady)
        .map((event) => ({
          ...event,
          label: event.label ?? recycleLabel,
          metrics: { ...event.metrics, recycleCount: nextRecycle },
        }));
      const moduleEvent = spanEvent('engine.worker.module', 'window', this.workerCreatedAtMs, {
        stage: 'wasm',
        label: recycleLabel,
        message: 'Loaded and evaluated replacement compiler Worker module.',
        metrics: { recycleCount: nextRecycle },
      }, workerReady?.startMs ?? rpcStartedMs);
      const rpcEvent = spanEvent('engine.init.rpc', 'window', rpcStartedMs, {
        stage: 'wasm',
        label: recycleLabel,
        message: 'Completed replacement compiler initialization request.',
        metrics: { recycleCount: nextRecycle },
      }, rpcFinishedMs);
      for (const event of [moduleEvent, ...workerEvents, rpcEvent]) emitProgress(report, event);
      this.engineCommit = res.version?.commit || 'unknown';
      assertCompatibleEngineCommit(
        typeof __ENGINE_COMMIT__ === 'undefined' ? undefined : __ENGINE_COMMIT__,
        this.engineCommit,
      );
      this.inited = true;
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.failWorker(replacement, reason);
      throw reason;
    }
    emitProgress(report, spanEvent('engine.recycle', 'window', recycleStartedMs, {
      stage: 'ready',
      label: recycleLabel,
      message: 'Replacement compiler engine ready.',
      metrics: {
        recycleCount: nextRecycle,
        configuredWaitMs: 250,
        wasmMemoryBytes: workerEvents.find((event) => event.phase === 'engine.session.init')
          ?.metrics?.wasmMemoryBytes ?? 0,
      },
    }, rpcFinishedMs));
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
    if (this.disposed) return Promise.reject(new Error('engine client is disposed'));
    if (this.workerFailure) return Promise.reject(this.workerFailure);
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
    const transportIdentity = `tgz-${entry.sha256}`;
    // PreparedPackage v3 represents the complete package, including template
    // metadata. Templates therefore use the same authenticated warm path and
    // raw cold fallback as every other package.
    if (!forceRaw) {
      const cacheReadStartedMs = epochMs();
      const { findPreparedPackage } = await import('./preparedPackageCache');
      const pointer = await findPreparedPackage(entry.label, transportIdentity);
      if (pointer) {
        this.preparedFallbacks.set(
          entry.label,
          () => this.loadBundle(entry, stageLabel, true, report),
        );
        emitProgress(report, {
          phase: 'package.cache-read',
          source: 'window',
          startMs: cacheReadStartedMs,
          stage: 'bundle-cache-hit',
          label: entry.label,
          message: `${stageLabel} ${entry.label} (prepared binary)`,
          fromCache: true,
          durationMs: Math.max(0, epochMs() - cacheReadStartedMs),
          inputBytes: pointer.bytes,
        });
        return { kind: 'prepared', pointer };
      }
      emitProgress(report, spanEvent('package.cache-read', 'window', cacheReadStartedMs, {
        stage: 'bundle-fetch',
        label: entry.label,
        message: `${entry.label} is not in the prepared-package cache.`,
        fromCache: false,
      }));
    }
    const fetchStartedMs = epochMs();
    emitProgress(report, {
      phase: 'package.fetch.progress',
      source: 'window',
      startMs: epochMs(),
      stage: stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch',
      label: entry.label,
      bytes: 0,
      totalBytes: entry.bytes,
      message: `${stageLabel} ${entry.label}…`,
    });
    // Bundle filenames contain '#' (e.g. hl7.fhir.r4.core#4.0.1.tgz); a raw '#'
    // in a URL is a fragment delimiter, so encode it (the P0 gotcha).
    const url = `${BASE}data/bundles/${encodeURIComponent(entry.tgz)}`;
    let transport: Awaited<ReturnType<typeof openPackageTransport>>;
    try {
      transport = await openPackageTransport(entry.label, url);
    } catch (error) {
      throw new BakedBundleTransportError(
        `fetch baked package ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    // Baked bundles are deployment inputs: authenticate the compressed bytes
    // before the inflater or engine can observe any package content.
    const transportStage = stageLabel === 'Loading' ? 'bundle-fetch' : 'lazy-fetch';
    let verifyStartedMs: number | null = null;
    let compressed: ArrayBuffer;
    try {
      compressed = await readVerifiedBundleBytes(
        transport.response,
        entry,
        (bytes, totalBytes) => {
          emitProgress(report, {
            phase: 'package.fetch.progress',
            source: 'window',
            startMs: epochMs(),
            stage: transportStage,
            label: entry.label,
            bytes,
            totalBytes,
            message: `${stageLabel} ${entry.label}…`,
          });
        },
        () => {
          verifyStartedMs = epochMs();
          emitProgress(report, pointEvent('package.verify-start', 'window', {
            stage: 'bundle-unpack',
            label: entry.label,
            message: `Verifying ${entry.label}…`,
            inputBytes: entry.bytes,
          }, verifyStartedMs));
        },
        transport.guard,
      );
    } finally {
      transport.guard.close();
    }
    const verifiedAtMs = epochMs();
    emitProgress(report, spanEvent('package.fetch', 'window', fetchStartedMs, {
      stage: 'resolve',
      label: entry.label,
      message: `${stageLabel} ${entry.label}; ready to verify.`,
      inputBytes: compressed.byteLength,
    }, verifyStartedMs ?? verifiedAtMs));
    if (verifyStartedMs != null) {
      emitProgress(report, spanEvent('package.verify', 'window', verifyStartedMs, {
        stage: 'resolve',
        label: entry.label,
        message: `Verified ${entry.label}; ready to prepare.`,
        inputBytes: compressed.byteLength,
      }, verifiedAtMs));
    }
    return { kind: 'tgz', label: entry.label, bytes: compressed, transportIdentity };
  }

  /** Hold the package-mount mutex across transport acquisition, per-slot
   * preparation, and the one atomic commit. */
  private async openPackageMount(
    labels: readonly string[],
    report: ProgressCb | null,
    source: PackageSourceSnapshot,
  ): Promise<ResolverMountTransaction | null> {
    const release = await this.acquirePackageMountLock();
    const startedMs = epochMs();
    let inputBytes = 0;
    let finished = false;
    let ticket: number;
    try {
      if (labels.length === 0) throw new Error('package mount requires at least one label');
      const seen = new Set<string>();
      for (const label of labels) {
        if (seen.has(label)) throw new Error(`duplicate package in mount request: ${label}`);
        if (this.mountedLabels.has(label)) {
          release();
          return null;
        }
        seen.add(label);
      }
      ({ ticket } = await this.call('openPackageMount', [...labels]));
    } catch (error) {
      release();
      throw error;
    }
    emitProgress(report, {
      phase: 'package.mount.request',
      source: 'window',
      startMs: startedMs,
      stage: 'bundle-mount',
      message: `Preparing and mounting ${labels.length} package${labels.length === 1 ? '' : 's'}…`,
      fileCount: labels.length,
    });

    const stage = async (index: number, initial: PackageMountInput): Promise<void> => {
      let input = initial;
      for (;;) {
        const rpcStarted = performance.now();
        const bytes = input.kind === 'tgz'
          ? input.bytes.byteLength
          : input.kind === 'prepared'
            ? input.pointer.bytes
            : 0;
        inputBytes += bytes;
        try {
          const result: PackageMountStageResult = await this.request(
            'stagePackageMount',
            [ticket, index, input],
            input.kind === 'tgz' ? [input.bytes] : [],
          );
          const rpcMs = performance.now() - rpcStarted;
          for (const event of result.events) {
            emitProgress(report, {
              ...event,
              metrics: { ...event.metrics, workerRoundTripMs: rpcMs },
            });
          }
          return;
        } catch (error) {
          if (input.kind === 'prepared') {
            try {
              input = await this.rawFallbackForPrepared(input.pointer.label, source);
            } catch {
              throw error;
            }
            continue;
          }
          if (input.kind !== 'tgz' || !isFailedRegistryTgzCarrier(error, input)) throw error;
          const { retryRegistryTgzCarrier } = await import('./packageResolver');
          const replacement = await retryRegistryTgzCarrier(
            input,
            (event) => emitProgress(report, event),
          );
          if (!replacement) throw error;
          input = replacement;
        }
      }
    };

    const commit = async (): Promise<MountResult> => {
      if (finished) throw new Error(`package mount ticket ${ticket} is already closed`);
      const rpcStarted = performance.now();
      try {
        const result = await this.call('commitPackageMount', ticket);
        const rpcMs = performance.now() - rpcStarted;
        for (const label of result.newlyMounted) this.mountedLabels.add(label);
        // Keep Rust resolution and its host mirror on the same package generation.
        this.resolutionCache.noteMount(result.newlyMounted);
        for (const event of result.events) {
          emitProgress(report, {
            ...event,
            label: event.label ?? labels.join(', '),
            metrics: { ...event.metrics, workerRoundTripMs: rpcMs },
          });
        }
        emitProgress(report, spanEvent('package.mount.rpc', 'window', startedMs, {
          stage: 'bundle-mount',
          message: `Completed atomic mount of ${result.newlyMounted.length} package${result.newlyMounted.length === 1 ? '' : 's'}.`,
          fileCount: result.newlyMounted.length,
          inputBytes,
        }));
        finished = true;
        release();
        return result;
      } catch (error) {
        try {
          await this.call('abortPackageMount', ticket);
        } catch {
          // Preserve the commit failure; Worker commit either consumed or
          // explicitly aborted the matching Rust transaction.
        } finally {
          finished = true;
          release();
        }
        throw error;
      }
    };

    const abort = async (): Promise<void> => {
      if (finished) return;
      try {
        await this.call('abortPackageMount', ticket);
      } finally {
        finished = true;
        release();
      }
    };
    return { stage, commit, abort };
  }

  private async rawFallbackForPrepared(
    label: string,
    source: PackageSourceSnapshot,
  ): Promise<PackageMountInput> {
    const registered = this.preparedFallbacks.get(label);
    if (registered) return registered();
    const { obtainRawPackageByLabel } = await import('./packageResolver');
    const recovered = await obtainRawPackageByLabel(label, source);
    if (!recovered) throw new Error(`cannot reacquire original package transport for ${label}`);
    return recovered;
  }

  /** Boot the WASM session with an empty package source. Package material is
   * selected only after the active project's config reaches the Rust resolver.
   * The promise is process-single-flight: React remounts and other concurrent
   * consumers observe the same initialization instead of creating a second
   * session or issuing a duplicate init RPC. */
  init(onProgress?: ProgressCb): Promise<InitResult> {
    if (this.disposed) return Promise.reject(new Error('engine client is disposed'));
    if (this.workerFailure) return Promise.reject(this.workerFailure);
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.initialize(onProgress ?? null);
    return this.initPromise;
  }

  private async initialize(report: ProgressCb | null): Promise<InitResult> {
    const startupStartedMs = this.workerCreatedAtMs;
    const manifestFetchStartedMs = epochMs();
    emitProgress(report, pointEvent('engine.manifest.fetch-start', 'window', {
      stage: 'manifest',
      message: 'Loading package manifest…',
    }, manifestFetchStartedMs));
    const rpcStartedMs = epochMs();
    emitProgress(report, pointEvent('engine.init.request', 'window', {
      stage: 'wasm',
      message: 'Starting compiler engine…',
    }, rpcStartedMs));
    // Fetch/parse the small host manifest while the Worker loads, compiles, and
    // instantiates WASM. Neither result depends on the other.
    const manifestPromise = (async () => {
      const manifestResponse = await fetch(`${BASE}data/bundles/manifest.json`);
      if (!manifestResponse.ok) {
        throw new Error(`fetch package bundle manifest -> ${manifestResponse.status}`);
      }
      const manifestText = await manifestResponse.text();
      const manifestFetchedMs = epochMs();
      const manifestBytes = new TextEncoder().encode(manifestText).byteLength;
      const manifestFetchEvent = spanEvent('engine.manifest.fetch', 'window', manifestFetchStartedMs, {
        stage: 'manifest',
        message: 'Loaded package manifest.',
        inputBytes: manifestBytes,
      }, manifestFetchedMs);
      emitProgress(report, manifestFetchEvent);
      const manifestParseStartedMs = epochMs();
      const manifest: BakedBundleManifest = parseBakedBundleManifest(JSON.parse(manifestText));
      const manifestParseEvent = spanEvent('engine.manifest.parse', 'window', manifestParseStartedMs, {
        stage: 'manifest',
        message: 'Parsed package manifest.',
        inputBytes: manifestBytes,
        fileCount: manifest.bundles.length,
      });
      emitProgress(report, manifestParseEvent);
      return { manifest, manifestFetchEvent, manifestParseEvent };
    })().catch((error: unknown) => {
      throw error instanceof EngineInitializationFailure
        ? error
        : new EngineInitializationFailure('manifest', error);
    });
    const workerInitPromise = this.call('init').catch((error: unknown) => {
      throw error instanceof EngineInitializationFailure
        ? error
        : new EngineInitializationFailure('wasm', error);
    });
    const [{ manifest, manifestFetchEvent, manifestParseEvent }, res] = await Promise.all([
      manifestPromise,
      workerInitPromise,
    ]);
    const rpcFinishedMs = epochMs();
    if (this.disposed) throw new Error('engine client is disposed');
    for (const b of manifest.bundles) this.bakedByLabel.set(b.label, b);
    const workerReady = res.events.find((event) => event.phase === 'engine.worker.ready');
    const workerEvents = res.events.filter((event) => event !== workerReady);
    const moduleEvent = spanEvent('engine.worker.module', 'window', this.workerCreatedAtMs, {
      stage: 'wasm',
      message: 'Loaded and evaluated compiler Worker module.',
    }, workerReady?.startMs ?? rpcStartedMs);
    const rpcEvent = spanEvent('engine.init.rpc', 'window', rpcStartedMs, {
      stage: 'wasm',
      message: 'Completed compiler initialization request.',
    }, rpcFinishedMs);
    const startupEvent = spanEvent('engine.startup', 'window', startupStartedMs, {
      stage: 'wasm',
      message: 'Compiler engine ready.',
      metrics: {
        wasmMemoryBytes: workerEvents.find((event) => event.phase === 'engine.session.init')
          ?.metrics?.wasmMemoryBytes ?? 0,
      },
    }, rpcFinishedMs);
    const readyEvent = pointEvent('engine.ready', 'window', {
      stage: 'ready',
      message: `Engine ready — ${manifest.bundles.length} packages available on demand.`,
    }, rpcFinishedMs);
    res.events = [
      manifestFetchEvent,
      manifestParseEvent,
      moduleEvent,
      ...workerEvents,
      rpcEvent,
      startupEvent,
      readyEvent,
    ];
    this.engineCommit = res.version?.commit || 'unknown';
    // Stale-mix guard: the app bundle was built against a specific engine
    // commit; if the served (HTTP-cached) wasm reports a different one, the
    // user has a stale engine + fresh app (or vice versa) — reload fixes it.
    assertCompatibleEngineCommit(
      typeof __ENGINE_COMMIT__ === 'undefined' ? undefined : __ENGINE_COMMIT__,
      this.engineCommit,
    );
    this.inited = true;
    for (const event of [moduleEvent, ...workerEvents, rpcEvent, startupEvent, readyEvent]) {
      emitProgress(report, event);
    }
    return res;
  }

  /** End this page process's ownership cleanly. HMR uses this before replacing
   * the owner so no orphan Worker or forever-pending RPC survives the update. */
  dispose(reason: Error = new Error('engine client disposed')): void {
    if (this.disposed) return;
    // A candidate is authority only after a successful complete prepare. HMR
    // or owner disposal must not strand an unverified local override in the
    // process-scoped store for a replacement EngineClient.
    this.localPackageAuthority.rollback();
    this.disposed = true;
    this.inited = false;
    this.workerFailure = reason;
    this.detachWorker(this.worker);
    this.worker.terminate();
    this.rejectPending(reason);
    this.fatalListeners.clear();
  }

  // ---- runtime package resolution (task #32) ----

  /** Ingest a user-dropped `.tgz` into the session-local package store (source d:
   *  air-gapped / registry-blocked). The next `acquireForProject` will prefer it
   *  over the network. Returns the `id#version` label it registered. */
  async ingestLocalTgz(tgz: ArrayBuffer): Promise<string> {
    // Never let a late drop join an older immutable ProjectRevision midway
    // through preparation. PackageSettings preserves multi-file selection
    // order, and each completed prepare owns exactly the candidates it began
    // with.
    await this.prepareBarrier;
    const installation = await ingestTgz(tgz);
    this.localPackageAuthority.accept(
      installation,
      this.mountedLabels.has(installation.label),
    );
    // A prior blocked attempt may now be satisfiable before a new mount occurs.
    if (installation.changed) this.invalidatePackageAuthority();
    return installation.label;
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
    source: PackageSourceSnapshot = packageSourceSnapshot(),
    localEpoch: number = localPackageEpoch(),
  ): Promise<ResolveOutcome> {
    // The caller may bind this acquisition into a larger prepare operation.
    // Every metadata and TGZ request uses the same immutable registry/proxy and
    // local-authority view even if the Settings UI changes while an RPC runs.
    const sourceEpoch = this.synchronizePackageAuthority(source, localEpoch);
    const cached = this.resolutionCache.get(config, sourceEpoch);
    if (cached) {
      const cacheStartedMs = epochMs();
      const reactivated = await reactivateCachedResolution(
        cached,
        (versionIndex) => this.resolveStep(config, versionIndex),
      );
      if (reactivated) {
        emitProgress(report, spanEvent('package.resolution-cache', 'window', cacheStartedMs, {
          stage: 'resolve',
          message: `Reverified resolved package closure (${reactivated.step.context_closure.length} packages).`,
          fromCache: true,
          fileCount: reactivated.step.context_closure.length,
          metrics: { memoryResolutionHit: 1 },
        }));
        return { ...reactivated, blocked: [], mounted: [] };
      }
    }
    const {
      acquireForProject,
      fetchRegistryVersions,
      indexFromLabels,
      obtainLockedPackages,
      refreshMutableVersionIndex,
    } = await import('./packageResolver');
    const observationAttempt: VersionObservationAttempt<VersionObservation> =
      this.versionObservations.begin(sourceEpoch);
    let observationsSettled = false;
    const settleObservations = (satisfied: boolean) => {
      if (observationsSettled) return;
      observationsSettled = true;
      if (satisfied) observationAttempt.commit();
      else observationAttempt.discard();
    };
    const observeVersions = async (id: string, onProgress: ProgressCb) => {
      const startedMs = epochMs();
      const observed = await observationAttempt.observe(
        id,
        () => fetchRegistryVersions(id, onProgress, source),
      );
      if (observed.fromCache) {
        onProgress(spanEvent('package.version-fetch', 'window', startedMs, {
          stage: 'registry-fetch',
          label: id,
          message: `Reused ${observed.value.versions.length} observed versions for ${id}.`,
          fromCache: true,
          fileCount: observed.value.versions.length,
        }));
      }
      return observed.value;
    };
    try {
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
      openMount: (labels: readonly string[]) => this.openPackageMount(labels, report, source),
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
      registries: [...source.registries],
      proxy: source.proxy,
    };
    const lock = await lockCache.readResolutionLock(config, authority);
    const lockReadMs = performance.now() - lockStarted;
    let validatedIndex: VersionIndex | null = null;
    if (lock) {
      const freshnessStarted = performance.now();
      validatedIndex = await refreshMutableVersionIndex(
        lock.mutableRequests,
        seedIndex,
        (ev) => emitProgress(report, { ...ev }),
        source,
        observeVersions,
      );
      const freshnessMs = performance.now() - freshnessStarted;
      if (validatedIndex) {
        const labels = lockCache.lockedLabels(lock);
        const needed = labels.filter((label) => !this.mountedLabels.has(label));
        const acquireStarted = performance.now();
        const exact = await obtainLockedPackages(
          host,
          needed,
          (ev) => emitProgress(report, { ...ev }),
          source,
        );
        const acquireMs = performance.now() - acquireStarted;
        if (!exact.stale
          && exact.blocked.length === 0
          && exact.packages.length === needed.length) {
          const mountStarted = performance.now();
          if (exact.packages.length > 0 && !exact.mounted) {
            throw new Error('complete package lock closed without committing');
          }
          const lockMount = exact.mounted
            ? { newlyMounted: exact.mounted }
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
            if (this.packageSourceEpoch === sourceEpoch) {
              this.resolutionCache.record(config, sourceEpoch, outcome);
            }
            emitProgress(report, {
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
            settleObservations(true);
            return outcome;
          }
        }
      }
      emitProgress(report, {
        stage: 'resolve',
        message: 'Cached package closure was stale or incomplete; resolving normally.',
        fromCache: false,
        durationMs: performance.now() - lockStarted,
        metrics: { persistentLockHit: 0, lockReadMs },
      });
    } else {
      emitProgress(report, {
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
      (ev) => emitProgress(report, { ...ev }),
      validatedIndex ?? seedIndex,
      source,
      observeVersions,
    );
    // The loop's final resolve happened after its final mount, so a satisfied
    // outcome belongs to the current package generation. Do not memoize a
    // blocked/network outcome forever: an unchanged project must be able to
    // retry when a registry or proxy recovers.
    if (outcome.step.satisfied) {
      if (this.packageSourceEpoch === sourceEpoch) {
        this.resolutionCache.record(config, sourceEpoch, outcome);
      }
      await lockCache.writeResolutionLock(
        config,
        authority,
        outcome.step,
        outcome.versionIndex,
      ).catch(() => {});
    }
    emitProgress(report, {
      stage: 'resolve',
      message: outcome.step.satisfied
        ? `Resolved package closure (${outcome.step.context_closure.length} packages).`
        : `Package resolution stopped with ${outcome.step.missing.length} missing packages.`,
      fromCache: false,
      durationMs: performance.now() - lockStarted,
      fileCount: outcome.step.context_closure.length,
      metrics: {
        persistentLockHit: 0,
        mountedPackages: outcome.mounted.length,
        missingPackages: outcome.step.missing.length,
      },
    });
    settleObservations(outcome.step.satisfied);
    return outcome;
    } catch (error) {
      settleObservations(false);
      throw error;
    }
  }

  async snapshot(url: string, report: ProgressCb | null = null): Promise<SnapshotResult> {
    await this.prepareBarrier;
    const cached = this.snapshotCache.get(url);
    if (cached) {
      emitProgress(report, { stage: 'snapshot', label: url, message: `Reusing snapshot for ${url}.`, fromCache: true, durationMs: 0 });
      return cached;
    }
    const generation = this.projectGeneration;
    const started = performance.now();
    const res: SnapshotResult = await this.call('snapshot', url);
    if (generation !== this.projectGeneration) return this.snapshot(url, report);
    this.snapshotCache.set(url, res);
    emitProgress(report, {
      stage: 'snapshot',
      label: url,
      message: `Prepared full definition for ${url}.`,
      durationMs: performance.now() - started,
      metrics: { wasmSnapshotMs: res.snapshotMs },
    });
    return res;
  }

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — needs no mounted packages beyond the resources passed in. */
  async expandValueSet(valueSetJson: string, resourcesJson: string): Promise<ExpandResult> {
    return this.call('expandValueSet', valueSetJson, resourcesJson);
  }

  // ---- the complete public site-generation API ---------------------------

  async prepare(
    project: ProjectRevision,
    spec: GeneratorSpec,
    report: ProgressCb | null = null,
  ): Promise<Build> {
    let settlePrepare!: () => void;
    const gate = new Promise<void>((resolve) => { settlePrepare = resolve; });
    this.prepareBarrier = gate;
    this.projectGeneration += 1;
    this.snapshotCache.clear();
    const startedMs = epochMs();
    try {
      // A label is only resolver addressing, not package identity. If a local
      // drop changed the effective bytes behind a mounted exact coordinate,
      // discard the old Worker before asking Rust to resolve again.
      await this.localPackageAuthority.reconcile(() => this.recycleWorker(report));
      const packageSource = packageSourceSnapshot();
      const packageLocalEpoch = localPackageEpoch();
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
      await this.acquireForProject(project.config, report, packageSource, packageLocalEpoch);
      if (spec.generator === 'publisher') {
        await this.ensureTemplatePackages(
          spec.templateCoordinate,
          report,
          packageSource,
          packageLocalEpoch,
        );
        await this.acquireForProject(project.config, report, packageSource, packageLocalEpoch);
      }
      emitProgress(report, {
        operation: 'prepare',
        stage: 'compile',
        message: 'Compiling definitions and preparing the site…',
        fileCount: Object.keys(project.fsh).length,
      });
      const result = await this.call('prepare', project, spec);
      this.projectGeneration += 1;
      this.snapshotCache.clear();
      for (const event of result.events) emitProgress(report, event);
      emitProgress(report, spanEvent('site.prepare.rpc', 'window', startedMs, {
        stage: 'site-build',
        label: result.buildId,
        message: `Prepared ${result.generator} SiteBuild ${result.buildId}.`,
        fileCount: Object.keys(project.fsh).length,
      }));
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
      this.localPackageAuthority.commit();
      return build;
    } catch (error) {
      // A candidate can mount successfully and still fail later compilation or
      // site preparation. Restore the prior local store and require a clean
      // Worker on the recovery attempt so candidate bytes cannot remain hidden
      // behind the same mounted label.
      if (this.localPackageAuthority.rollback()) this.invalidatePackageAuthority();
      if (error instanceof BuildFailure) throw error;
      throw new BuildFailure({
        operation: 'prepare',
        phase: 'preparation',
        code: 'internal',
        message: String(error),
        retryable: false,
      });
    } finally {
      settlePrepare();
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
    source: PackageSourceSnapshot,
    localEpoch: number,
  ): Promise<void> {
    const { obtainAndMountPackage } = await import('./packageResolver');
    this.synchronizePackageAuthority(source, localEpoch);
    const host = {
      resolveStep: (config: string, index?: VersionIndex) => this.resolveStep(config, index),
      openMount: (labels: readonly string[]) => this.openPackageMount(labels, report, source),
      bakedBundle: (label: string) => this.bakedByLabel.get(label),
      fetchBaked: (bundle: BakedBundleEntry, report: ProgressCb) => this.loadBundle(bundle, 'Loading (template)', false, report),
    };
    for (let round = 0; round < 24; round += 1) {
      const step: TemplateResolution = await this.call('resolveTemplate', coordinate);
      if (step.satisfied) return;
      if (!step.missing) throw new Error(`Template ${coordinate} is unresolved without a missing coordinate`);
      const mounted = await obtainAndMountPackage(host, step.missing, (event) => {
        emitProgress(report, { ...event });
      }, source);
      if (!mounted) throw new Error(`Template ${coordinate} requires unavailable ${step.missing}`);
    }
    throw new Error(`Template ${coordinate} dependency chain exceeded 24 packages`);
  }

  get initialized() {
    return this.inited;
  }
}
