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
declare const __CYCLE_RENDER_RECIPE__: string;

import type {
  CompileResult,
  EngineOps,
  Op,
  PackageMountInput,
  PackageMountResult,
  PrepareMountResult,
  PreparedStageResult,
  WorkerReply,
  WorkerRequest,
} from './protocol';
import { ClosedBuildHandle } from '@cycle/core/closed-build';
import { openCycleGenerator } from '@cycle/core/open-site-build';
import type { CycleGenerator, CycleGeneratorOutput } from '@cycle/core/open-site-build';
import {
  CycleRendererPackage,
  type CycleRendererPackageManifest,
} from '@cycle/core/renderer-package';
import {
  CYCLE_OUTPUT_SCHEMA,
  CYCLE_RENDERER_IDENTITY,
  rendererOutputDeclaration,
} from '@cycle/core/output-receipt';
import type {
  BuildError,
  ContentRef,
  OutputCatalog,
  OutputDescriptor,
  PreparedProjectResult,
  SiteOutput,
} from '../site/contract.generated';
import { PREPARED_PACKAGE_FORMAT_VERSION } from '../site/contract.generated';
import { contentStore } from '../storage/contentStore';
import { assertClosedNonPageCatalog } from '../site/catalog';
import { MountedLabels } from './mountedLabels';
import { BuildRuntimeRegistry } from './buildRuntimeRegistry';
import { unwrapApiEnvelope } from './envelope';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** The wasm-bindgen `Session` class surface (string-envelope methods). */
interface WasmSession {
  init(bundlesJson: string): string;
  beginPreparedMount(expectedPackages: number): string;
  stagePreparedMount(bytes: Uint8Array, expectedKey: string): string;
  commitPreparedMount(): string;
  abortPreparedMount(): string;
  prepareArtifacts(bundlesJson: string): string;
  prepareAndMount(bundlesJson: string): string;
  takePrepared(label: string): Uint8Array;
  resolveProject(config: string, versionIndexJson: string): string;
  resolveTemplate(coordinate: string): string;
  prepareProject(projectRevisionJson: string, generatorSpecJson: string): string;
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
  default: (input?: unknown) => Promise<unknown>;
  Session: (new () => WasmSession) & { version(): string };
};

let session: WasmSession | null = null;
let wasmMod: WasmModule | null = null;

async function ensureSession(): Promise<WasmSession> {
  if (session) return session;
  // Runtime bytes are keyed by their exact emitted digest. The source commit is
  // retained for release diagnostics, but cannot distinguish dirty/same-commit
  // rebuilds and therefore must not authorize HTTP-cache reuse.
  const v = encodeURIComponent(__ENGINE_RECIPE__);
  const mod = (await import(/* @vite-ignore */ `${BASE}pkg/wasm_api.js?v=${v}`)) as WasmModule;
  await mod.default(`${BASE}pkg/wasm_api_bg.wasm?v=${v}`);
  wasmMod = mod;
  session = new mod.Session();
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

function unwrapBuild<T>(envelopeJson: string): T {
  return unwrapApiEnvelope<T, BuildError<CompileResult>>(
    envelopeJson,
    (error) => new EngineBuildFailure(error),
  );
}

/** Labels currently mounted in the engine, keeping transactional package
 * acquisition idempotent without relying on package labels as cache identity. */
const mountedLabels = new MountedLabels();

interface CycleBuildRuntime {
  kind: 'cycle';
  generator: CycleGenerator;
  buildId: string;
  catalog: CycleGeneratorOutput[];
  publicCatalog: OutputCatalog;
  rendered: Map<string, ContentRef>;
}

interface PublisherBuildRuntime {
  kind: 'publisher';
  buildId: string;
}

type SiteBuildRuntime = CycleBuildRuntime | PublisherBuildRuntime;
const siteBuilds = new BuildRuntimeRegistry<SiteBuildRuntime>();

interface LoadedCycleRendererPackage {
  package: CycleRendererPackage;
  manifest: CycleRendererPackageManifest;
  contentByPath: ReadonlyMap<string, ContentRef>;
}

let cycleRendererPackagePromise: Promise<LoadedCycleRendererPackage> | null = null;

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

async function loadCycleRendererPackage(): Promise<LoadedCycleRendererPackage> {
  if (cycleRendererPackagePromise) return cycleRendererPackagePromise;
  const pending = (async () => {
    const root = `${BASE}data/cycle/renderer-package/`;
    const response = await fetch(`${root}manifest.json`);
    if (!response.ok) throw new Error(`Cycle renderer package manifest -> ${response.status}`);
    const manifest = await response.json() as CycleRendererPackageManifest;
    const memory = new Map<string, Uint8Array>();
    const unique = new Map(manifest.files.map((file) => [file.content.sha256, file.content]));
    await Promise.all([...unique.values()].map(async (content) => {
      const cached = await contentStore.get(content);
      if (cached) return;
      const bodyResponse = await fetch(`${root}objects/${content.sha256}`);
      if (!bodyResponse.ok) throw new Error(`Cycle renderer package object ${content.sha256} -> ${bodyResponse.status}`);
      const bytes = new Uint8Array(await bodyResponse.arrayBuffer());
      memory.set(content.sha256, bytes);
      await storeExactContent(bytes, content);
    }));
    const packageValue = await CycleRendererPackage.open(manifest, {
      get: async (content) => {
        const stored = await contentStore.get(content);
        return stored ? new Uint8Array(stored) : memory.get(content.sha256) ?? null;
      },
    });
    return {
      package: packageValue,
      manifest,
      contentByPath: new Map(manifest.files.map((file) => [file.path, file.content])),
    };
  })();
  cycleRendererPackagePromise = pending;
  try {
    return await pending;
  } catch (error) {
    if (cycleRendererPackagePromise === pending) cycleRendererPackagePromise = null;
    throw error;
  }
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

function publicCycleDescriptor(
  output: CycleGeneratorOutput,
  packaged?: ContentRef,
): OutputDescriptor {
  return {
    path: output.file,
    kind: output.kind,
    mediaType: output.mime,
    ...(packaged ? { content: packaged } : {}),
    ...(output.title ? { title: output.title } : {}),
    ...(output.pageKind ? { pageKind: output.pageKind } : {}),
    ...(output.subject ? {
      subject: { ...output.subject },
      subjectPage: output.subjectPage,
    } : {}),
  };
}

async function renderCycleOutput(
  session: WasmSession,
  buildId: string,
  runtime: CycleBuildRuntime,
  path: string,
): Promise<ContentRef> {
  const prior = runtime.rendered.get(path);
  if (prior) return prior;
  const descriptor = runtime.publicCatalog.outputs.find((output) => output.path === path);
  const rendererDescriptor = runtime.catalog.find((output) => output.file === path);
  if (!descriptor) throw new Error(`render: path ${path} is not declared by outputs`);
  if (!rendererDescriptor) throw new Error(`render: Cycle renderer omitted ${path}`);
  if (descriptor.content) {
    const stored = await contentStore.get(descriptor.content);
    if (!stored) throw new Error(`ContentStore is missing Cycle output ${path}`);
    const { mediaType: _mediaType, ...file } = rendererOutputDeclaration(rendererDescriptor);
    session.admitOutput(
      buildId,
      JSON.stringify({ ...file, content: descriptor.content }),
      new Uint8Array(stored),
    );
    runtime.rendered.set(path, descriptor.content);
    return descriptor.content;
  }
  const content = await runtime.generator.render(path);
  const stored = await contentStore.get(content);
  if (!stored) throw new Error(`ContentStore is missing Cycle output ${path}`);
  const { mediaType: _mediaType, ...file } = rendererOutputDeclaration(rendererDescriptor);
  session.admitOutput(
    buildId,
    JSON.stringify({ ...file, content }),
    new Uint8Array(stored),
  );
  runtime.rendered.set(path, content);
  descriptor.content = content;
  return content;
}

async function finalizeCycleOutput(
  session: WasmSession,
  handle: string,
  runtime: CycleBuildRuntime,
): Promise<SiteOutput> {
  for (const descriptor of runtime.catalog) {
    const rendered = await renderCycleOutput(session, handle, runtime, descriptor.file);
    if (!rendered.mediaType) {
      throw new Error(`Cycle renderer emitted ${descriptor.file} without a media type`);
    }
  }
  return unwrapBuild<SiteOutput>(session.finalize(handle));
}

// ---- op handlers (exactly the protocol's EngineOps table) -------------------

type Handlers = { [K in Op]: (...args: EngineOps[K]['args']) => Promise<EngineOps[K]['result']> };

const handlers: Handlers = {
  async init() {
    const s = await ensureSession();
    const t0 = performance.now();
    const wasmStarted = performance.now();
    const { mounted } = unwrap<{ mounted: number }>(s.init('[]'));
    const wasmMs = performance.now() - wasmStarted;
    mountedLabels.replace([]);
    const version = JSON.parse(wasmMod!.Session.version());
    return {
      mounted,
      version,
      events: [{
        stage: 'wasm',
        message: 'Started compiler engine.',
        durationMs: performance.now() - t0,
        inputBytes: 2,
        metrics: { workerSerializeMs: 0, wasmMs },
      }],
    };
  },

  /** Preferred package seam. Warm compact `.fpp` artifacts are authenticated in
   * OPFS and cold raw packages are normalized/published one at a time. Both stage
   * in resolver order and become mounted through one atomic Rust commit. */
  async mountPackages(packages: PackageMountInput[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const fresh = mountedLabels.fresh(packages.map((item) => ({
      label: item.kind === 'raw' ? item.spec.label : item.pointer.label,
      item,
    })));
    if (fresh.length === 0) {
      return {
        mounted: mountedLabels.size,
        newlyMounted: [],
        events: [{
          stage: 'bundle-mount',
          message: 'Packages already mounted.',
          durationMs: 0,
          fromCache: true,
          inputBytes: 0,
        }],
      };
    }
    const inputs = fresh.map(({ item }) => item);
    const rawCount = inputs.filter((item) => item.kind === 'raw').length;
    const preparedCount = inputs.length - rawCount;
    let serializeMs = 0;
    const wasmStarted = performance.now();
    let inputBytes = 0;
    const cache = await import('./preparedPackageCache');
    const totals = {
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
    };
    let commitResult!: PackageMountResult;
    let commitSucceeded = false;
    let maxStagedArtifactBytes = 0;
    unwrap(s.beginPreparedMount(inputs.length));
    try {
      // Warm and cold packages share one ordered staging transaction. Rust sees
      // no mounted mutation until every authenticated/canonical carrier is
      // staged and the single commit succeeds.
      for (const item of inputs) {
        if (item.kind === 'prepared') {
          const { pointer } = item;
          const artifact = await cache.readPreparedPackage(pointer);
          if (!artifact) throw new Error(`prepared-package cache miss: ${pointer.label}`);
          inputBytes += artifact.byteLength;
          maxStagedArtifactBytes = Math.max(maxStagedArtifactBytes, artifact.byteLength);
          const staged = unwrap<PreparedStageResult>(
            s.stagePreparedMount(new Uint8Array(artifact), pointer.cacheKey),
          );
          if (staged.label !== pointer.label) {
            throw new Error(
              `prepared-package pointer label ${pointer.label} selected artifact ${staged.label}`,
            );
          }
          continue;
        }

        const { spec, transportIdentity } = item;
        const serializeStarted = performance.now();
        const input = JSON.stringify([spec]);
        serializeMs += performance.now() - serializeStarted;
        const result = unwrap<PrepareMountResult>(s.prepareArtifacts(input));
        if (result.artifacts.length !== 1 || result.artifacts[0].label !== spec.label) {
          throw new Error(`prepareArtifacts returned the wrong artifact for ${spec.label}`);
        }
        totals.artifactBytes += result.artifactBytes;
        totals.preparedMembers += result.preparedMembers;
        totals.inputJsonBytes += result.inputJsonBytes;
        totals.base64Bytes += result.base64Bytes;
        totals.decodedSourceBytes += result.decodedSourceBytes;
        totals.normalizedBytes += result.normalizedBytes;
        totals.decodeValidatePrepareMs += result.decodeValidatePrepareMs;
        totals.jsonParseMs += result.jsonParseMs;
        totals.base64DecodeMs += result.base64DecodeMs;
        totals.normalizationMs += result.normalizationMs;
        totals.indexingMs += result.indexingMs;
        totals.artifactEncodeMs += result.artifactEncodeMs;
        inputBytes += result.inputJsonBytes;

        const artifact = result.artifacts[0];
        const bytes = s.takePrepared(artifact.label);
        maxStagedArtifactBytes = Math.max(maxStagedArtifactBytes, bytes.byteLength);
        await cache.writePreparedPackage({
          schema: PREPARED_PACKAGE_FORMAT_VERSION,
          label: artifact.label,
          transportIdentity,
          cacheKey: artifact.cacheKey,
          artifactSha256: artifact.artifactSha256,
          bytes: artifact.bytes,
        }, bytes).catch(() => {});
        unwrap(s.stagePreparedMount(bytes, artifact.cacheKey));
      }
      commitResult = unwrap<PackageMountResult>(s.commitPreparedMount());
      commitSucceeded = true;
    } finally {
      if (!commitSucceeded) {
        try { unwrap(s.abortPreparedMount()); } catch { /* preserve the original staging error */ }
      }
    }
    const wasmMs = performance.now() - wasmStarted;
    const mounted = commitResult.mounted;
    const committedLabels = fresh.map(({ label }) => ({ label }));
    mountedLabels.add(committedLabels);
    return {
      mounted,
      newlyMounted: committedLabels.map(({ label }) => label),
      events: [{
        stage: 'bundle-mount',
        message: `Mounted ${committedLabels.map(({ label }) => label).join(', ')}.`,
        durationMs: performance.now() - t0,
        inputBytes,
        metrics: {
          workerSerializeMs: serializeMs,
          wasmMs,
          preparedWarmBinary: rawCount === 0 ? 1 : 0,
          preparedColdPrepare: preparedCount === 0 ? 1 : 0,
          preparedMixed: rawCount > 0 && preparedCount > 0 ? 1 : 0,
          preparedAdded: commitResult.added,
          preparedPackages: commitResult.packages,
          preparedArtifactBytes: commitResult.artifactBytes,
          preparedMembers: totals.preparedMembers,
          preparedInputJsonBytes: totals.inputJsonBytes,
          preparedBase64Bytes: totals.base64Bytes,
          preparedDecodedSourceBytes: totals.decodedSourceBytes,
          preparedNormalizedBytes: totals.normalizedBytes,
          preparedMountMemberBodyCopies: commitResult.memberBodyCopies,
          preparedDecodeValidatePrepareMs: totals.decodeValidatePrepareMs,
          preparedJsonParseMs: totals.jsonParseMs,
          preparedBase64DecodeMs: totals.base64DecodeMs,
          preparedNormalizationMs: totals.normalizationMs,
          preparedIndexingMs: totals.indexingMs,
          preparedArtifactEncodeMs: totals.artifactEncodeMs,
          preparedEngineMountMs: commitResult.mountMs,
          preparedRetainedBlobBytes: commitResult.retainedBlobBytes,
          preparedMaxStagedArtifactBytes: maxStagedArtifactBytes,
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
        },
      }],
    };
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
    const rustBoundaryStarted = performance.now();
    let result: PreparedProjectResult;
    result = unwrapBuild<PreparedProjectResult>(s.prepareProject(
      JSON.stringify(project),
      JSON.stringify(spec),
    ));
    const rustBoundaryMs = performance.now() - rustBoundaryStarted;
    const compiled = result.compiled;
    const prepared = result.site;
    try {
      if (prepared.generator !== spec.generator) {
        throw new Error('prepare: Rust returned a different generator');
      }
      const hostPrepareStarted = performance.now();
      if (prepared.generator === 'cycle') {
        const rendererPackage = await loadCycleRendererPackage();
        const closed = await ClosedBuildHandle.open(prepared.siteBuild, {
          get: async (content) => {
            const bytes = s.readContent(prepared.buildId, content.sha256);
            await storeExactContent(bytes, content);
            return bytes;
          },
        });
        const generator = await openCycleGenerator(closed, rendererPackage.package, {
          get: async (content) => {
            const bytes = await contentStore.get(content);
            return bytes ? new Uint8Array(bytes) : null;
          },
          put: async (bytes, mediaType) => {
            const content = await contentStore.put(bytes, mediaType);
            if (!content) throw new Error('Cycle output ContentStore is unavailable');
            if (!content.mediaType) throw new Error('Cycle output ContentStore omitted media type');
            return { ...content, mediaType: content.mediaType };
          },
        });
        const catalog = generator.outputs();
        const publicCatalog: OutputCatalog = {
          buildId: prepared.buildId,
          outputs: catalog.map((output) => publicCycleDescriptor(
            output,
            rendererPackage.contentByPath.get(output.file),
          )),
        };
        s.openRenderer(
          prepared.buildId,
          JSON.stringify({ ...CYCLE_RENDERER_IDENTITY, recipeSha256: __CYCLE_RENDER_RECIPE__ }),
          CYCLE_OUTPUT_SCHEMA,
          JSON.stringify({ rendererPackageId: rendererPackage.manifest.packageId }),
          JSON.stringify(catalog.map((output) => output.file)),
        );
        const runtime: CycleBuildRuntime = {
          kind: 'cycle',
          generator,
          buildId: prepared.buildId,
          catalog,
          publicCatalog,
          rendered: new Map(),
        };
        // Preview assets are a closed catalog, never a live mutable-adapter query.
        // Materialize every non-page before publication; pages alone stay lazy.
        for (const output of catalog) {
          if (output.kind !== 'page') {
            await renderCycleOutput(s, prepared.buildId, runtime, output.file);
          }
        }
        assertClosedNonPageCatalog(publicCatalog);
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
            stage: 'site-build',
            label: prepared.buildId,
            message: `Opened ${prepared.generator} renderer for ${prepared.buildId}.`,
            durationMs: performance.now() - hostPrepareStarted,
            metrics: {
              rustBoundaryMs,
              hostPrepareMs: performance.now() - hostPrepareStarted,
            },
          },
        ],
      };
    } catch (error) {
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
    if (runtime.kind === 'cycle') return runtime.publicCatalog;
    const catalog = unwrapBuild<OutputCatalog>(s.outputs(handle));
    for (const output of catalog.outputs) {
      if (output.content) await publishRustContent(s, handle, output.content);
    }
    assertClosedNonPageCatalog(catalog);
    return catalog;
  },

  async render(handle, path) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`render: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return renderCycleOutput(s, handle, runtime, path);
    const content = unwrapBuild<ContentRef>(s.render(handle, path));
    await publishRustContent(s, handle, content);
    return content;
  },

  async finalize(handle) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`finalize: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return finalizeCycleOutput(s, handle, runtime);
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
