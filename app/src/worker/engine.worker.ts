// Engine Web Worker (spec §4). Owns the wasm-bindgen module (rust_sushi compiler
// + snapshot walk engine, wasm32-unknown-unknown / web target). The UI thread
// never blocks: all engine work happens here.
//
// Engine calls go through the wasm `Session` handle (the consolidated API):
// every method returns ONE apiVersion-stamped JSON envelope, unwrapped in ONE
// place (`unwrap`). The protocol to the UI is the typed op table in protocol.ts —
// this file is a handler per op, nothing else (ledger #2).
//
// The wasm module is emitted by scripts/build-wasm.sh into app/public/pkg/ and
// served as a static asset; we import it at runtime via the app base URL.
declare const __ENGINE_COMMIT__: string;
declare const __ENGINE_RECIPE__: string;

import type {
  CompileResult,
  EngineOps,
  MountResult,
  Op,
  PackageMountAbortResult,
  PackageMountInput,
  PackageMountResult,
  PackageMountStageResult,
  PackageMountTicket,
  PrepareMountResult,
  PreparedStageResult,
  WorkerReply,
  WorkerRequest,
} from './protocol';
import type {
  BuildError,
  BuildEvent,
  ContentRef,
  GeneratorSpec,
  OutputCatalog,
  PreparedProjectResult,
  ProjectRevision,
  SiteOutput,
} from '../site/contract.generated';
import { PREPARED_PACKAGE_FORMAT_VERSION } from '../site/contract.generated';
import { contentStore } from '../storage/contentStore';
import { assertClosedNonPageCatalog } from '../site/catalog';
import { MountedLabels } from './mountedLabels';
import { BuildRuntimeRegistry } from './buildRuntimeRegistry';
import { unwrapApiEnvelope } from './envelope';
import { epochMs, pointEvent, spanEvent } from '../performance/timeline';
import type { CycleBuildRuntime } from './cycleRuntime';

/** Private raw Session transport. The generated PreparedProjectResult remains
 * the complete native/core contract; this tagged browser projection makes the
 * one host-boundary difference explicit and statically checkable. */
type BrowserPrepareSite =
  | {
    buildId: string;
    generator: 'publisher';
    siteBuild?: never;
  }
  | {
    buildId: string;
    generator: 'cycle';
    siteBuild: PreparedProjectResult['site']['siteBuild'];
  };

type BrowserPreparedProjectResult = Omit<PreparedProjectResult, 'site'> & {
  site: BrowserPrepareSite;
};

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** The wasm-bindgen `Session` class surface (string-envelope methods). */
interface WasmSession {
  init(bundlesJson: string): string;
  beginPreparedMount(expectedPackages: number): string;
  stagePreparedMount(
    index: number,
    bytes: Uint8Array,
    expectedKey: string,
    expectedLabel: string,
  ): string;
  commitPreparedMount(): string;
  abortPreparedMount(): string;
  prepareArtifacts(bundlesJson: string): string;
  prepareTgzArtifact(label: string, bytes: Uint8Array): string;
  takePrepared(label: string): Uint8Array;
  resolveProject(config: string, versionIndexJson: string): string;
  resolveTemplate(coordinate: string): string;
  prepareProject(projectRevision: ProjectRevision | string, generatorSpec: GeneratorSpec | string): string;
  releaseBuild(handle: string): boolean;
  snapshot(input: string): string;
  outputs(handle: string): string;
  render(handle: string, path: string): string;
  finalize(handle: string): string;
  readContent(handle: string, sha256: string): Uint8Array;
  openRenderer(
    handle: string,
    rendererJson: string,
    outputSchema: string,
    optionsJson: string,
    pathsJson: string,
  ): void;
  admitOutput(handle: string, fileJson: string, bytes: Uint8Array): void;
  expandValueSet(valueSetJson: string, resourcesJson: string): string;
}

type WasmModule = {
  default: (input?: unknown) => Promise<{ memory?: WebAssembly.Memory }>;
  Session: (new () => WasmSession) & { version(): string };
};

let session: WasmSession | null = null;
let wasmMod: WasmModule | null = null;
let wasmMemory: WebAssembly.Memory | null = null;
const workerModuleReadyMs = epochMs();
let sessionStartupEvents: BuildEvent[] = [];

interface ActivePackageMount {
  ticket: number;
  labels: string[];
  staged: Set<number>;
  startedMs: number;
  serializeMs: number;
  wasmMs: number;
  inputBytes: number;
  rawCount: number;
  preparedCount: number;
  maxStagedArtifactBytes: number;
  totals: {
    artifactBytes: number;
    preparedMembers: number;
    inputJsonBytes: number;
    base64Bytes: number;
    decodedSourceBytes: number;
    normalizedBytes: number;
    decodeValidatePrepareMs: number;
    jsonParseMs: number;
    base64DecodeMs: number;
    normalizationMs: number;
    indexingMs: number;
    artifactEncodeMs: number;
  };
}

let packageMountSequence = 0;
let activePackageMount: ActivePackageMount | null = null;

function currentWasmMemoryBytes(): number {
  return wasmMemory?.buffer.byteLength ?? 0;
}

async function ensureSession(): Promise<WasmSession> {
  if (session) return session;
  const events: BuildEvent[] = [pointEvent(
    'engine.worker.ready',
    'worker',
    { stage: 'wasm', message: 'Compiler Worker module evaluated.' },
    workerModuleReadyMs,
  )];
  // Runtime bytes are keyed by their exact emitted digest. The source commit is
  // retained for release diagnostics, but cannot distinguish dirty/same-commit
  // rebuilds and therefore must not authorize HTTP-cache reuse.
  const v = encodeURIComponent(__ENGINE_RECIPE__);
  const glueStarted = epochMs();
  const mod = (await import(/* @vite-ignore */ `${BASE}pkg/wasm_api.js?v=${v}`)) as WasmModule;
  events.push(spanEvent('engine.wasm.glue-import', 'worker', glueStarted, {
    stage: 'wasm',
    message: 'Loaded WASM JavaScript glue.',
  }));

  const wasmPath = `${BASE}pkg/wasm_api_bg.wasm?v=${v}`;
  const wasmUrl = new URL(wasmPath, self.location.href).href;
  const fetchStarted = epochMs();
  const response = await fetch(wasmUrl);
  if (!response.ok) throw new Error(`fetch compiler WASM -> ${response.status}`);
  const responseStarted = epochMs();
  const compileStarted = epochMs();
  let module: WebAssembly.Module;
  let streaming = 0;
  const wasmMime = response.headers.get('Content-Type')?.split(';', 1)[0].trim();
  if (typeof WebAssembly.compileStreaming === 'function' && wasmMime === 'application/wasm') {
    streaming = 1;
    module = await WebAssembly.compileStreaming(Promise.resolve(response));
  } else {
    module = await WebAssembly.compile(await response.arrayBuffer());
  }
  const compiledAt = epochMs();
  const resource = performance.getEntriesByName(wasmUrl)
    .filter((entry) => entry.entryType === 'resource')
    .at(-1);
  const resourceTiming = resource as PerformanceResourceTiming | undefined;
  const resourceStart = resourceTiming ? performance.timeOrigin + resourceTiming.fetchStart : fetchStarted;
  const responseStart = resourceTiming ? performance.timeOrigin + resourceTiming.responseStart : responseStarted;
  const responseEnd = resourceTiming ? performance.timeOrigin + resourceTiming.responseEnd : compiledAt;
  events.push(spanEvent('engine.wasm.fetch', 'worker', resourceStart, {
    stage: 'wasm',
    message: 'Fetched compiler WASM.',
    inputBytes: resourceTiming?.encodedBodySize,
    // A zero transfer with a nonempty decoded body is a browser-cache hit; CDP
    // benchmark data distinguishes memory from disk cache when that matters.
    fromCache: resourceTiming
      ? resourceTiming.transferSize === 0 && resourceTiming.decodedBodySize > 0
      : undefined,
    metrics: {
      transferBytes: resourceTiming?.transferSize ?? 0,
      encodedBodyBytes: resourceTiming?.encodedBodySize ?? 0,
      decodedBodyBytes: resourceTiming?.decodedBodySize ?? 0,
      responseStatus: response.status,
    },
  }, responseEnd));
  events.push(spanEvent('engine.wasm.download', 'worker', responseStart, {
    stage: 'wasm',
    message: 'Received compiler WASM response body.',
    inputBytes: resourceTiming?.encodedBodySize,
  }, responseEnd));
  events.push(spanEvent('engine.wasm.compile', 'worker', compileStarted, {
    stage: 'wasm',
    message: streaming
      ? 'Streaming-compiled compiler WASM.'
      : 'Compiled compiler WASM after download.',
    metrics: { streaming },
  }, compiledAt));

  const instantiateStarted = epochMs();
  const exports = await mod.default({ module_or_path: module });
  const instantiatedAt = epochMs();
  wasmMemory = exports.memory ?? null;
  events.push(spanEvent('engine.wasm.instantiate-and-start', 'worker', instantiateStarted, {
    stage: 'wasm',
    message: 'Instantiated compiler WASM.',
    metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
  }, instantiatedAt));
  wasmMod = mod;
  const sessionStarted = epochMs();
  session = new mod.Session();
  events.push(spanEvent('engine.session.construct', 'worker', sessionStarted, {
    stage: 'wasm',
    message: 'Constructed compiler session.',
    metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
  }));
  sessionStartupEvents = events;
  return session;
}

/** Unwrap a Session result envelope: `{apiVersion, ok, op, result|error}`.
 *  Domain errors arrive as `ok:false` (never thrown across the wasm boundary);
 *  we re-throw them here so the worker's single catch turns them into the
 *  protocol's error reply. */
function unwrap<T>(envelopeJson: string): T {
  return unwrapApiEnvelope<T, { message: string }>(
    envelopeJson,
    (error, operation) => new Error(`${operation}: ${error.message}`),
  );
}

class EngineBuildFailure extends Error {
  constructor(readonly detail: BuildError<CompileResult>) {
    super(detail.message);
    this.name = 'EngineBuildFailure';
  }
}

type TgzPreparationFailureKind = 'integrity' | 'resource-limit';

class TgzPreparationError extends Error {
  constructor(readonly kind: TgzPreparationFailureKind, message: string) {
    super(message);
    this.name = 'TgzPreparationError';
  }
}

function unwrapTgzPreparation<T>(envelopeJson: string): T {
  return unwrapApiEnvelope<T, { kind: TgzPreparationFailureKind; message: string }>(
    envelopeJson,
    (error) => new TgzPreparationError(error.kind, error.message),
  );
}

/** Keep malformed bytes and local resource-policy exhaustion distinct at the
 * private Worker boundary. Only malformed registry bytes may justify trying
 * the next registry; a deterministic per-call policy result must stay final. */
function tgzPreparationFailure(label: string, error: unknown): EngineBuildFailure {
  if (error instanceof TgzPreparationError && error.kind === 'resource-limit') {
    return new EngineBuildFailure({
      operation: 'lifecycle',
      phase: 'package-transport',
      code: 'resource-limit',
      message: `Package ${JSON.stringify(label)} exceeds this editor's current in-browser preparation resource policy. The package may still be valid; the policy uses a per-call working-set estimate and is not a whole-browser memory-safety guarantee. Trying another registry will not help. Use a native FHIR publishing workflow for this guide, or ask the editor maintainer to review the policy. Details: ${error.message}`,
      retryable: false,
    });
  }
  return new EngineBuildFailure({
    operation: 'lifecycle',
    phase: 'package-transport',
    code: 'integrity',
    message: `TGZ package ${JSON.stringify(label)} could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
    retryable: true,
  });
}

function packageMountInputLabel(input: PackageMountInput): string {
  return input.kind === 'raw'
    ? input.spec.label
    : input.kind === 'tgz'
      ? input.label
      : input.pointer.label;
}

function unwrapBuild<T>(envelopeJson: string): T {
  return unwrapApiEnvelope<T, BuildError<CompileResult>>(
    envelopeJson,
    (error) => new EngineBuildFailure(error),
  );
}

/** Labels currently mounted in the engine, keeping transactional package
 * acquisition idempotent without relying on package labels as cache identity. */
const mountedLabels = new MountedLabels();

interface PublisherBuildRuntime {
  kind: 'publisher';
  buildId: string;
}

type SiteBuildRuntime = CycleBuildRuntime | PublisherBuildRuntime;
const siteBuilds = new BuildRuntimeRegistry<SiteBuildRuntime>();

// Dynamic import is itself module-cached, but one explicit promise documents
// and proves the intended per-Worker capability lifetime. A failed module load
// is terminal for this Worker; recovery must create a fresh Worker rather than
// pretending the browser module registry can retry it in place.
let cycleRuntimeModulePromise: Promise<typeof import('./cycleRuntime')> | null = null;

function loadCycleRuntimeModule(): Promise<typeof import('./cycleRuntime')> {
  cycleRuntimeModulePromise ??= import('./cycleRuntime');
  return cycleRuntimeModulePromise;
}

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.mediaType === right.mediaType;
}

async function storeExactContent(bytes: Uint8Array, expected: ContentRef): Promise<void> {
  const stored = await contentStore.put(bytes, expected.mediaType);
  if (!stored || !sameContentRef(stored, expected)) {
    throw new Error(`ContentStore rejected ${expected.sha256}`);
  }
}

// A Worker owns one ContentStore instance for its lifetime. Once an exact
// reference has been read back or successfully published, immutable CAS bytes
// cannot change underneath it. Remember that verification so a prose-only
// successor does not re-read and re-hash every unchanged runtime asset merely
// because `outputs` returned the same ContentRefs again. Worker recycling drops
// this observation and therefore re-verifies persistent OPFS state.
const publishedRustContent = new Set<string>();

function publishedRustContentKey(content: ContentRef): string {
  return `${content.sha256}\u0000${content.byteLength}\u0000${content.mediaType ?? ''}`;
}

async function publishRustContent(
  session: WasmSession,
  handle: string,
  content: ContentRef,
): Promise<void> {
  const key = publishedRustContentKey(content);
  if (publishedRustContent.has(key)) return;
  if (await contentStore.get(content)) {
    publishedRustContent.add(key);
    return;
  }
  await storeExactContent(session.readContent(handle, content.sha256), content);
  publishedRustContent.add(key);
}

// ---- op handlers (exactly the protocol's EngineOps table) -------------------

type Handlers = { [K in Op]: (...args: EngineOps[K]['args']) => Promise<EngineOps[K]['result']> };

const handlers: Handlers = {
  async init() {
    const s = await ensureSession();
    const initStarted = epochMs();
    if (activePackageMount) {
      try { unwrap(s.abortPreparedMount()); } catch { /* init replaces all state below */ }
      activePackageMount = null;
    }
    const { mounted } = unwrap<{ mounted: number }>(s.init('[]'));
    const initializedAt = epochMs();
    mountedLabels.replace([]);
    const version = JSON.parse(wasmMod!.Session.version());
    return {
      mounted,
      version,
      events: [
        ...sessionStartupEvents,
        spanEvent('engine.session.init', 'worker', initStarted, {
          stage: 'wasm',
          message: 'Initialized compiler session.',
          inputBytes: 2,
          metrics: {
            workerSerializeMs: 0,
            wasmMs: initializedAt - initStarted,
            wasmMemoryBytes: currentWasmMemoryBytes(),
          },
        }, initializedAt),
      ],
    };
  },

  /** Open one resolver-ordered, all-or-nothing package transaction before its
   * carriers finish arriving. No package becomes visible until commit. */
  async openPackageMount(labels: string[]): Promise<PackageMountTicket> {
    const s = await ensureSession();
    if (activePackageMount) {
      throw new Error(`package mount ticket ${activePackageMount.ticket} is already active`);
    }
    if (labels.length === 0) throw new Error('package mount requires at least one label');
    const fresh = mountedLabels.fresh(labels.map((label) => ({ label })));
    if (fresh.length !== labels.length) {
      const freshLabels = new Set(fresh.map(({ label }) => label));
      const mounted = labels.find((label) => !freshLabels.has(label));
      throw new Error(`package mount expected label is already mounted: ${mounted}`);
    }
    unwrap(s.beginPreparedMount(labels.length));
    const ticket = ++packageMountSequence;
    activePackageMount = {
      ticket,
      labels: [...labels],
      staged: new Set(),
      startedMs: epochMs(),
      serializeMs: 0,
      wasmMs: 0,
      inputBytes: 0,
      rawCount: 0,
      preparedCount: 0,
      maxStagedArtifactBytes: 0,
      totals: {
        artifactBytes: 0,
        preparedMembers: 0,
        inputJsonBytes: 0,
        base64Bytes: 0,
        decodedSourceBytes: 0,
        normalizedBytes: 0,
        decodeValidatePrepareMs: 0,
        jsonParseMs: 0,
        base64DecodeMs: 0,
        normalizationMs: 0,
        indexingMs: 0,
        artifactEncodeMs: 0,
      },
    };
    return { ticket, labels: [...labels] };
  },

  /** Authenticate/prepare one carrier and stage it at its resolver position.
   * Calls may arrive in any order; a failed slot remains retryable. */
  async stagePackageMount(
    ticket: number,
    index: number,
    item: PackageMountInput,
  ): Promise<PackageMountStageResult> {
    const s = await ensureSession();
    const active = activePackageMount;
    if (!active || active.ticket !== ticket) {
      throw new Error(`package mount ticket ${ticket} is not active`);
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= active.labels.length) {
      throw new Error(`package mount slot ${index} is outside ticket ${ticket}`);
    }
    if (active.staged.has(index)) {
      throw new Error(`package mount slot ${index} is already staged`);
    }
    const expectedLabel = active.labels[index];
    const receivedLabel = packageMountInputLabel(item);
    if (receivedLabel !== expectedLabel) {
      throw new Error(
        `package mount slot ${index} expects ${expectedLabel}, received ${receivedLabel}`,
      );
    }

    const phaseEvents: BuildEvent[] = [];
    let wasmMs = 0;
    const cache = await import('./preparedPackageCache');
    if (item.kind === 'prepared') {
      const { pointer } = item;
      const cacheReadStartedMs = epochMs();
      const artifact = await cache.readPreparedPackage(pointer);
      if (!artifact) throw new Error(`prepared-package cache miss: ${pointer.label}`);
      phaseEvents.push(spanEvent('package.prepared-cache-read', 'worker', cacheReadStartedMs, {
        stage: 'bundle-cache-hit',
        label: pointer.label,
        message: `Read prepared package ${pointer.label}.`,
        fromCache: true,
        inputBytes: artifact.byteLength,
        metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
      }));
      active.inputBytes += artifact.byteLength;
      active.maxStagedArtifactBytes = Math.max(active.maxStagedArtifactBytes, artifact.byteLength);
      const stageStartedMs = epochMs();
      const stageWasmStarted = performance.now();
      unwrap<PreparedStageResult>(
        s.stagePreparedMount(index, new Uint8Array(artifact), pointer.cacheKey, pointer.label),
      );
      wasmMs += performance.now() - stageWasmStarted;
      phaseEvents.push(spanEvent('package.stage', 'worker', stageStartedMs, {
        stage: 'bundle-mount',
        label: pointer.label,
        message: `Staged prepared package ${pointer.label}.`,
        inputBytes: artifact.byteLength,
        metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
      }));
      active.preparedCount += 1;
    } else {
      const transportIdentity = item.transportIdentity;
      let result: PrepareMountResult;
      let label: string;
      if (item.kind === 'tgz') {
        label = item.label;
        active.inputBytes += item.bytes.byteLength;
        const prepareStartedMs = epochMs();
        const prepareWasmStarted = performance.now();
        try {
          result = unwrapTgzPreparation<PrepareMountResult>(
            s.prepareTgzArtifact(item.label, new Uint8Array(item.bytes)),
          );
        } catch (error) {
          throw tgzPreparationFailure(item.label, error);
        } finally {
          wasmMs += performance.now() - prepareWasmStarted;
        }
        phaseEvents.push(spanEvent('package.prepare', 'worker', prepareStartedMs, {
          stage: 'bundle-unpack',
          label,
          message: `Prepared package ${label} from TGZ.`,
          inputBytes: item.bytes.byteLength,
          metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
        }));
      } else {
        label = item.spec.label;
        const serializeStarted = performance.now();
        const input = JSON.stringify([item.spec]);
        active.serializeMs += performance.now() - serializeStarted;
        active.inputBytes += input.length;
        const prepareStartedMs = epochMs();
        const prepareWasmStarted = performance.now();
        result = unwrap<PrepareMountResult>(s.prepareArtifacts(input));
        wasmMs += performance.now() - prepareWasmStarted;
        phaseEvents.push(spanEvent('package.prepare', 'worker', prepareStartedMs, {
          stage: 'bundle-unpack',
          label,
          message: `Prepared compatibility package ${label}.`,
          inputBytes: input.length,
          metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
        }));
      }
      if (result.artifacts.length !== 1 || result.artifacts[0].label !== label) {
        throw new Error(`package preparation returned the wrong artifact for ${label}`);
      }
      active.totals.artifactBytes += result.artifactBytes;
      active.totals.preparedMembers += result.preparedMembers;
      active.totals.inputJsonBytes += result.inputJsonBytes;
      active.totals.base64Bytes += result.base64Bytes;
      active.totals.decodedSourceBytes += result.decodedSourceBytes;
      active.totals.normalizedBytes += result.normalizedBytes;
      active.totals.decodeValidatePrepareMs += result.decodeValidatePrepareMs;
      active.totals.jsonParseMs += result.jsonParseMs;
      active.totals.base64DecodeMs += result.base64DecodeMs;
      active.totals.normalizationMs += result.normalizationMs;
      active.totals.indexingMs += result.indexingMs;
      active.totals.artifactEncodeMs += result.artifactEncodeMs;
      const artifact = result.artifacts[0];
      const takeWasmStarted = performance.now();
      const bytes = s.takePrepared(artifact.label);
      wasmMs += performance.now() - takeWasmStarted;
      active.maxStagedArtifactBytes = Math.max(active.maxStagedArtifactBytes, bytes.byteLength);
      const cacheWriteStartedMs = epochMs();
      const cacheStored = await cache.writePreparedPackage({
        schema: PREPARED_PACKAGE_FORMAT_VERSION,
        label: artifact.label,
        transportIdentity,
        cacheKey: artifact.cacheKey,
        artifactSha256: artifact.artifactSha256,
        bytes: artifact.bytes,
      }, bytes).then(() => true, () => false);
      phaseEvents.push(spanEvent('package.prepared-cache-write', 'worker', cacheWriteStartedMs, {
        stage: 'project-store',
        label: artifact.label,
        message: cacheStored
          ? `Stored prepared package ${artifact.label}.`
          : `Prepared package ${artifact.label}; persistent cache unavailable.`,
        outputBytes: cacheStored ? bytes.byteLength : 0,
        metrics: {
          cacheWriteSucceeded: cacheStored ? 1 : 0,
          wasmMemoryBytes: currentWasmMemoryBytes(),
        },
      }));
      const stageStartedMs = epochMs();
      const stageWasmStarted = performance.now();
      unwrap(s.stagePreparedMount(index, bytes, artifact.cacheKey, artifact.label));
      wasmMs += performance.now() - stageWasmStarted;
      phaseEvents.push(spanEvent('package.stage', 'worker', stageStartedMs, {
        stage: 'bundle-mount',
        label: artifact.label,
        message: `Staged prepared package ${artifact.label}.`,
        inputBytes: bytes.byteLength,
        metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
      }));
      active.rawCount += 1;
    }
    active.wasmMs += wasmMs;
    active.staged.add(index);
    return { ticket, index, label: expectedLabel, events: phaseEvents };
  },

  async commitPackageMount(ticket: number): Promise<MountResult> {
    const s = await ensureSession();
    const active = activePackageMount;
    if (!active || active.ticket !== ticket) {
      throw new Error(`package mount ticket ${ticket} is not active`);
    }
    if (active.staged.size !== active.labels.length) {
      const error = new Error(
        `package mount ticket ${ticket} has ${active.staged.size}/${active.labels.length} staged slots`,
      );
      try { unwrap(s.abortPreparedMount()); } catch { /* report the precise slot error below */ }
      activePackageMount = null;
      throw error;
    }
    const commitStartedMs = epochMs();
    let commitResult: PackageMountResult;
    try {
      commitResult = unwrap<PackageMountResult>(s.commitPreparedMount());
    } finally {
      activePackageMount = null;
    }
    const commitAt = epochMs();
    const committedLabels = active.labels.map((label) => ({ label }));
    mountedLabels.add(committedLabels);
    const commitEvent = spanEvent('package.commit', 'worker', commitStartedMs, {
      stage: 'bundle-mount',
      message: `Committed ${active.labels.length} prepared package${active.labels.length === 1 ? '' : 's'} atomically.`,
      fileCount: active.labels.length,
      metrics: { wasmMemoryBytes: currentWasmMemoryBytes() },
    }, commitAt);
    return {
      mounted: commitResult.mounted,
      newlyMounted: committedLabels.map(({ label }) => label),
      events: [commitEvent, {
        phase: 'package.mount.transaction',
        source: 'worker',
        startMs: active.startedMs,
        stage: 'bundle-mount',
        message: `Mounted ${committedLabels.map(({ label }) => label).join(', ')}.`,
        durationMs: Math.max(0, commitAt - active.startedMs),
        inputBytes: active.inputBytes,
        metrics: {
          workerSerializeMs: active.serializeMs,
          wasmMs: active.wasmMs + Math.max(0, commitAt - commitStartedMs),
          preparedWarmBinary: active.rawCount === 0 ? 1 : 0,
          preparedColdPrepare: active.preparedCount === 0 ? 1 : 0,
          preparedMixed: active.rawCount > 0 && active.preparedCount > 0 ? 1 : 0,
          preparedAdded: commitResult.added,
          preparedPackages: commitResult.packages,
          preparedArtifactBytes: commitResult.artifactBytes,
          preparedMembers: active.totals.preparedMembers,
          preparedInputJsonBytes: active.totals.inputJsonBytes,
          preparedBase64Bytes: active.totals.base64Bytes,
          preparedDecodedSourceBytes: active.totals.decodedSourceBytes,
          preparedNormalizedBytes: active.totals.normalizedBytes,
          preparedMountMemberBodyCopies: commitResult.memberBodyCopies,
          preparedDecodeValidatePrepareMs: active.totals.decodeValidatePrepareMs,
          preparedJsonParseMs: active.totals.jsonParseMs,
          preparedBase64DecodeMs: active.totals.base64DecodeMs,
          preparedNormalizationMs: active.totals.normalizationMs,
          preparedIndexingMs: active.totals.indexingMs,
          preparedArtifactEncodeMs: active.totals.artifactEncodeMs,
          preparedEngineMountMs: commitResult.mountMs,
          preparedRetainedBlobBytes: commitResult.retainedBlobBytes,
          preparedMaxStagedArtifactBytes: active.maxStagedArtifactBytes,
          preparedJsBatchBytes: 0,
          preparedCompressedRetainedBytes: commitResult.compressedRetainedBytes,
          preparedDeclaredRawBytes: commitResult.declaredRawBytes,
          preparedChunksInflated: commitResult.chunksInflated,
          preparedRawInflatedBytes: commitResult.rawInflatedBytes,
          preparedChunkCacheHits: commitResult.cacheHits,
          preparedCachedRawBytes: commitResult.cachedRawBytes,
          preparedIndexedMembers: commitResult.indexedMembers,
          preparedMemberBodyCopies: commitResult.memberBodyCopies,
          preparedManifestJsonBytes: commitResult.manifestJsonBytes,
          preparedManifestParseMs: commitResult.manifestParseMs,
          preparedDecodeValidateMs: commitResult.decodeValidateMs,
          wasmMemoryBytes: currentWasmMemoryBytes(),
        },
      }],
    };
  },

  async abortPackageMount(ticket: number): Promise<PackageMountAbortResult> {
    const s = await ensureSession();
    const active = activePackageMount;
    if (!active || active.ticket !== ticket) {
      return { ticket, aborted: false };
    }
    let aborted = false;
    try {
      aborted = unwrap<{ aborted: boolean }>(s.abortPreparedMount()).aborted;
    } finally {
      activePackageMount = null;
    }
    return { ticket, aborted };
  },

  /** Resolve a project's package sets against the CURRENTLY MOUNTED bundles
   *  (task #32). Resolution logic lives entirely in Rust; this is a thin marshal. */
  async resolveProject(config, versionIndex) {
    const s = await ensureSession();
    return unwrap(s.resolveProject(config, versionIndex ? JSON.stringify(versionIndex) : ''));
  },

  async resolveTemplate(coordinate) {
    const s = await ensureSession();
    return unwrap(s.resolveTemplate(coordinate));
  },

  /** Tier-1 in-engine ValueSet expansion (spec §6 tier 1). Pure function of IG
   *  content — no tx, no mounted packages needed beyond the resources passed in. */
  async expandValueSet(valueSetJson, resourcesJson) {
    const s = await ensureSession();
    const t0 = performance.now();
    const raw = unwrap<Record<string, unknown>>(s.expandValueSet(valueSetJson, resourcesJson)) as {
      ok: boolean;
      expansion?: { total?: number; contains?: unknown[] };
      usedCodeSystems?: unknown[];
      copyright?: string[];
      notEnumerable?: unknown;
    };
    const expandMs = performance.now() - t0;
    if (raw.ok) {
      return {
        ok: true,
        total: raw.expansion!.total ?? raw.expansion!.contains?.length ?? 0,
        contains: raw.expansion!.contains ?? [],
        usedCodeSystems: raw.usedCodeSystems ?? [],
        copyright: raw.copyright ?? [],
        expandMs,
      } as EngineOps['expandValueSet']['result'];
    }
    return { ok: false, notEnumerable: raw.notEnumerable, expandMs } as EngineOps['expandValueSet']['result'];
  },

  async snapshot(url) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(s.snapshot(url));
    return { ...out, snapshotMs: performance.now() - t0 } as EngineOps['snapshot']['result'];
  },

  // ---- complete four-operation site facade --------------------------------

  async prepare(project, spec) {
    const s = await ensureSession();
    const typedInputStartedMs = epochMs();
    const typedInputEvent = spanEvent('site.prepare.typed-input', 'worker', typedInputStartedMs, {
      operation: 'prepare',
      stage: 'compile',
      message: 'Passed the complete typed project revision and generator specification to Rust.',
    });
    const rustBoundaryStartedMs = epochMs();
    const rustBoundaryStarted = performance.now();
    const result = unwrapBuild<BrowserPreparedProjectResult>(s.prepareProject(project, spec));
    const rustBoundaryMs = performance.now() - rustBoundaryStarted;
    result.events = [
      typedInputEvent,
      ...result.events.map((event) => ({
        ...event,
        source: event.source ?? 'rust' as const,
        startMs: event.startMs ?? (event.phase === 'site.prepare' ? rustBoundaryStartedMs : undefined),
        metrics: {
          ...event.metrics,
          wasmMemoryBytes: currentWasmMemoryBytes(),
        },
      })),
    ];
    const compiled = result.compiled;
    const prepared = result.site;
    const retainedBeforeHostOpen = siteBuilds.get(prepared.buildId);
    try {
      if (prepared.generator !== spec.generator) {
        throw new Error('prepare: Rust returned a different generator');
      }
      const hostPrepareStarted = performance.now();
      const hostPrepareStartedMs = epochMs();
      let cycleRuntimeModuleMs = 0;
      let reusedHostRuntime = false;
      if (prepared.generator === 'cycle' && !prepared.siteBuild) {
        throw new Error('prepare: Cycle transport omitted its closed SiteBuild');
      }
      if (prepared.generator !== 'cycle' && prepared.siteBuild != null) {
        throw new Error('prepare: Publisher transport redundantly returned its closed SiteBuild');
      }
      if (retainedBeforeHostOpen) {
        if (retainedBeforeHostOpen.kind !== prepared.generator) {
          throw new Error('prepare: retained host runtime has a different generator');
        }
        if (siteBuilds.touch(prepared.buildId) !== retainedBeforeHostOpen) {
          throw new Error('prepare: exact retained host runtime disappeared');
        }
        reusedHostRuntime = true;
      } else if (prepared.generator === 'cycle') {
        const moduleStarted = performance.now();
        const { openCycleBuildRuntime } = await loadCycleRuntimeModule();
        cycleRuntimeModuleMs = performance.now() - moduleStarted;
        const runtime = await openCycleBuildRuntime(s, prepared.buildId, prepared.siteBuild);
        siteBuilds.install(prepared.buildId, runtime);
      } else {
        siteBuilds.install(prepared.buildId, { kind: 'publisher', buildId: prepared.buildId });
      }
      return {
        buildId: prepared.buildId,
        generator: prepared.generator,
        compiled,
        events: [
          ...result.events,
          {
            phase: 'site.open-renderer',
            source: 'worker',
            startMs: hostPrepareStartedMs,
            stage: 'site-build',
            label: prepared.buildId,
            message: `${reusedHostRuntime ? 'Reused' : 'Opened'} ${prepared.generator} renderer for ${prepared.buildId}.`,
            durationMs: performance.now() - hostPrepareStarted,
            metrics: {
              rustBoundaryMs,
              hostPrepareMs: performance.now() - hostPrepareStarted,
              cycleRuntimeModuleMs,
              wasmMemoryBytes: currentWasmMemoryBytes(),
            },
          },
        ],
      };
    } catch (error) {
      // Rust has already installed the closed target when host-side Cycle
      // renderer opening begins. If that final host step rejects a genuinely
      // new handle, release it here so a failed prepare cannot consume the
      // predecessor slot. An exact retained handle remains owned by its prior
      // successful Build and must not be dropped.
      if (!retainedBeforeHostOpen && !siteBuilds.get(prepared.buildId)) {
        s.releaseBuild(prepared.buildId);
      }
      if (error instanceof EngineBuildFailure) throw error;
      throw new EngineBuildFailure({
        operation: 'prepare',
        phase: 'renderer',
        code: 'renderer-failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        successfulCompilation: compiled,
      });
    }
  },

  async outputs(handle) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`outputs: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return runtime.outputs();
    const catalog = unwrapBuild<OutputCatalog>(s.outputs(handle));
    for (const output of catalog.outputs) {
      if (output.content) await publishRustContent(s, handle, output.content);
    }
    assertClosedNonPageCatalog(catalog);
    return catalog;
  },

  async releaseBuild(handle) {
    const s = await ensureSession();
    const rustReleased = s.releaseBuild(handle);
    const hostReleased = siteBuilds.release(handle);
    if (rustReleased !== hostReleased) {
      throw new Error(`releaseBuild: runtime registries disagree for ${handle}`);
    }
    return rustReleased;
  },

  async render(handle, path) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`render: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return runtime.render(path);
    const content = unwrapBuild<ContentRef>(s.render(handle, path));
    await publishRustContent(s, handle, content);
    return content;
  },

  async finalize(handle) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`finalize: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return unwrapBuild<SiteOutput>(await runtime.finalizeEnvelope());
    const catalog = unwrapBuild<OutputCatalog>(s.outputs(handle));
    for (const output of catalog.outputs) {
      if (!output.content) {
        const content = unwrapBuild<ContentRef>(s.render(handle, output.path));
        await publishRustContent(s, handle, content);
      } else {
        await publishRustContent(s, handle, output.content);
      }
    }
    return unwrapBuild<SiteOutput>(s.finalize(handle));
  },
};

async function handleRequest(msg: WorkerRequest): Promise<void> {
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  try {
    const handler = handlers[msg.op] as (...args: unknown[]) => Promise<unknown>;
    if (!handler) throw new Error(`unknown op: ${msg.op}`);
    reply({ id: msg.id, ok: true, result: await handler(...msg.args) });
  } catch (err) {
    const operation = (
      msg.op === 'prepare'
      || msg.op === 'outputs'
      || msg.op === 'render'
      || msg.op === 'finalize'
    ) ? msg.op : 'lifecycle';
    const error: BuildError<CompileResult> = err instanceof EngineBuildFailure
      ? err.detail
      : {
      operation,
      phase: operation === 'render'
        ? 'renderer'
        : operation === 'finalize'
          ? 'finalization'
          : operation === 'prepare'
            ? 'preparation'
            : 'lifecycle',
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
      retryable: false,
    };
    reply({
      id: msg.id,
      ok: false,
      error,
    });
  }
}

// The Session and installed Cycle runtime are one mutable authority. Serialize
// at the worker boundary as well as in the React host so direct/reused protocol
// clients cannot let an older async CAS verification overwrite a newer build.
let requestTail: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  requestTail = requestTail.then(
    () => handleRequest(message),
    () => handleRequest(message),
  );
};
