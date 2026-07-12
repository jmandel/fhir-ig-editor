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

import type { EngineOps, Op, WorkerRequest, WorkerReply, PackageMountInput, PreparedMountMetrics, CompileResult } from './protocol';
import { ClosedBuildHandle } from '@cycle/core/closed-build';
import type { ClosedSiteBuild } from '@cycle/core/closed-build';
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
  ContentRef,
  OutputCatalog,
  OutputDescriptor,
  RenderedOutput,
  RustPrepareMetrics,
  SiteOutput,
  SiteOutputFile,
} from '../site/contract';
import { contentStore } from '../storage/contentStore';
import { assertClosedNonPageCatalog } from '../site/catalog';
import { MountedLabels } from './mountedLabels';
import { BuildRuntimeRegistry } from './buildRuntimeRegistry';

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
  packageStorageMetrics(): string;
  prepareArtifacts(bundlesJson: string): string;
  prepareAndMount(bundlesJson: string): string;
  takePrepared(label: string): Uint8Array;
  resolveProject(config: string, versionIndexJson: string): string;
  resolveTemplate(coordinate: string): string;
  prepareProject(filesJson: string, config: string, predefinedJson: string, siteFilesJson: string, generatorSpecJson: string): string;
  snapshot(input: string): string;
  outputs(handle: string): string;
  render(handle: string, path: string): string;
  finalize(handle: string, externalInputJson?: string): string;
  readContent(handle: string, sha256: string): Uint8Array;
  expandValueSet(valueSetJson: string, resourcesJson: string): string;
}

type WasmModule = {
  default: (input?: unknown) => Promise<unknown>;
  Session: (new () => WasmSession) & { version(): string };
};

let session: WasmSession | null = null;
let wasmMod: WasmModule | null = null;

// console_error_panic_hook reports the useful Rust panic text to this worker's
// console before wasm aborts with an otherwise opaque `RuntimeError: unreachable`.
// Preserve that request-local text so the ordinary typed error reply can expose
// it to the UI and browser gate.
const workerConsoleError = console.error.bind(console);
let lastWorkerConsoleError = '';
console.error = (...args: unknown[]) => {
  lastWorkerConsoleError = args.map((value) => String(value)).join(' ');
  workerConsoleError(...args);
};

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
  const env = JSON.parse(envelopeJson) as
    | { apiVersion: number; ok: true; op: string; result: T }
    | { apiVersion: number; ok: false; op: string; error: { message: string } };
  if (env.apiVersion !== 1) throw new Error(`unsupported engine apiVersion ${env.apiVersion}`);
  if (!env.ok) throw new Error(`${env.op}: ${env.error.message}`);
  return env.result;
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
  rendered: Map<string, RenderedOutput>;
  rendererPackageId: string;
}

interface PublisherBuildRuntime {
  kind: 'publisher';
  buildId: string;
}

type SiteBuildRuntime = CycleBuildRuntime | PublisherBuildRuntime;
const siteBuilds = new BuildRuntimeRegistry<SiteBuildRuntime>();

class PrepareOperationError extends Error {
  constructor(
    message: string,
    readonly stage: 'compile' | 'site',
    readonly compiled?: CompileResult,
  ) {
    super(message);
    this.name = 'PrepareOperationError';
  }
}

interface RustPrepareResult {
  handle: string;
  buildId: string;
  generator: 'cycle' | 'publisher';
  siteBuild: ClosedSiteBuild;
  metrics: RustPrepareMetrics;
}

type RustPreparedProjectWire =
  | {
      status: 'prepared';
      compiled: Record<string, unknown>;
      site: RustPrepareResult;
      compileMs: number;
    }
  | {
      status: 'siteFailed';
      compiled: Record<string, unknown>;
      compileMs: number;
      error: string;
    };

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
  if (await contentStore.get(content)) return;
  await storeExactContent(session.readContent(handle, content.sha256), content);
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

async function renderCycleOutput(runtime: CycleBuildRuntime, path: string): Promise<RenderedOutput> {
  const prior = runtime.rendered.get(path);
  if (prior) return prior;
  const descriptor = runtime.publicCatalog.outputs.find((output) => output.path === path);
  if (!descriptor) throw new Error(`render: path ${path} is not declared by outputs`);
  if (descriptor.content) {
    const ready = { path, mediaType: descriptor.mediaType, content: descriptor.content };
    runtime.rendered.set(path, ready);
    return ready;
  }
  const output = runtime.generator.render(path);
  const bytes = typeof output.content === 'string'
    ? new TextEncoder().encode(output.content)
    : output.content;
  const content = await contentStore.put(bytes, output.mime);
  if (!content) throw new Error(`ContentStore could not publish Cycle output ${path}`);
  const ready = { path, mediaType: output.mime, content };
  runtime.rendered.set(path, ready);
  descriptor.content = content;
  return ready;
}

async function finalizeCycleOutput(
  session: WasmSession,
  handle: string,
  runtime: CycleBuildRuntime,
): Promise<SiteOutput> {
  const files: SiteOutputFile[] = [];
  for (const descriptor of runtime.catalog) {
    const rendered = await renderCycleOutput(runtime, descriptor.file);
    files.push({
      ...rendererOutputDeclaration(descriptor),
      content: rendered.content,
    });
  }
  return unwrap<SiteOutput>(session.finalize(handle, JSON.stringify({
    renderer: { ...CYCLE_RENDERER_IDENTITY, recipeSha256: __CYCLE_RENDER_RECIPE__ },
    outputSchema: CYCLE_OUTPUT_SCHEMA,
    options: { rendererPackageId: runtime.rendererPackageId },
    catalog: runtime.catalog.map((output) => output.file),
    files,
  })));
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
    return { mounted, version, initMs: performance.now() - t0, serializeMs: 0, wasmMs, inputBytes: 2 };
  },

  /** Preferred package seam. Warm compact `.fpp` artifacts are authenticated in
   * OPFS, staged into WASM one at a time, and committed together. A cold raw batch
   * is normalized/mounted once and publishes the resulting artifacts. */
  async mountPackages(packages: PackageMountInput[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const fresh = mountedLabels.fresh(packages.map((item) => ({
      label: item.kind === 'raw' ? item.spec.label : item.pointer.label,
      item,
    })));
    if (fresh.length === 0) {
      return { mounted: mountedLabels.size, newlyMounted: [], mountMs: 0, serializeMs: 0, wasmMs: 0, inputBytes: 0 };
    }
    const inputs = fresh.map(({ item }) => item);
    const raw = inputs.filter((item): item is Extract<PackageMountInput, { kind: 'raw' }> => item.kind === 'raw');
    const prepared = inputs.filter((item): item is Extract<PackageMountInput, { kind: 'prepared' }> => item.kind === 'prepared');
    if (raw.length > 0 && prepared.length > 0) {
      throw new Error('mountPackages requires an all-raw or all-prepared transaction');
    }

    let serializeMs = 0;
    let wasmMs = 0;
    let inputBytes = 0;
    let mounted = mountedLabels.size;
    let preparedMetrics: PreparedMountMetrics | undefined;
    if (prepared.length > 0) {
      const cache = await import('./preparedPackageCache');
      const wasmStarted = performance.now();
      let committed = false;
      let maxStagedArtifactBytes = 0;
      unwrap(s.beginPreparedMount(prepared.length));
      let result: {
        mounted: number;
        added: number;
        packages: number;
        manifestJsonBytes: number;
        artifactBytes: number;
        retainedBlobBytes: number;
        indexedMembers: number;
        memberBodyCopies: number;
        manifestParseMs: number;
        decodeValidateMs: number;
        mountMs: number;
        compressedRetainedBytes: number;
        declaredRawBytes: number;
        chunksInflated: number;
        rawInflatedBytes: number;
        cacheHits: number;
        cachedRawBytes: number;
      };
      try {
        // Read, authenticate, transfer, and release one compact artifact at a
        // time. Rust retains staged packages but mutates no mounted state until
        // the final commit succeeds.
        for (const { pointer } of prepared) {
          const artifact = await cache.readPreparedPackage(pointer);
          if (!artifact) throw new Error(`prepared-package cache miss: ${pointer.label}`);
          inputBytes += artifact.byteLength;
          maxStagedArtifactBytes = Math.max(maxStagedArtifactBytes, artifact.byteLength);
          unwrap(s.stagePreparedMount(new Uint8Array(artifact), pointer.cacheKey));
        }
        result = unwrap(s.commitPreparedMount());
        committed = true;
      } finally {
        if (!committed) {
          try { unwrap(s.abortPreparedMount()); } catch { /* preserve the original cache/decode error */ }
        }
      }
      inputBytes = result.artifactBytes + result.manifestJsonBytes;
      wasmMs = performance.now() - wasmStarted;
      mounted = result.mounted;
      preparedMetrics = {
        mode: 'warm-binary',
        added: result.added,
        packages: result.packages,
        manifestJsonBytes: result.manifestJsonBytes,
        artifactBytes: result.artifactBytes,
        retainedBlobBytes: result.retainedBlobBytes,
        maxStagedArtifactBytes,
        jsBatchBytes: 0,
        compressedRetainedBytes: result.compressedRetainedBytes,
        declaredRawBytes: result.declaredRawBytes,
        chunksInflated: result.chunksInflated,
        rawInflatedBytes: result.rawInflatedBytes,
        chunkCacheHits: result.cacheHits,
        cachedRawBytes: result.cachedRawBytes,
        indexedMembers: result.indexedMembers,
        memberBodyCopies: result.memberBodyCopies,
        manifestParseMs: result.manifestParseMs,
        decodeValidateMs: result.decodeValidateMs,
        engineMountMs: result.mountMs,
      };
    } else {
      const cache = await import('./preparedPackageCache');
      const wasmStarted = performance.now();
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
      type ColdArtifactResult = {
        artifacts: Array<{ label: string; cacheKey: string; artifactSha256: string; bytes: number }>;
        artifactBytes: number;
        preparedMembers: number;
        inputJsonBytes: number;
        base64Bytes: number;
        decodedSourceBytes: number;
        normalizedBytes: number;
        mountMemberBodyCopies: number;
        decodeValidatePrepareMs: number;
        jsonParseMs: number;
        base64DecodeMs: number;
        normalizationMs: number;
        indexingMs: number;
        artifactEncodeMs: number;
      };
      type PreparedCommitResult = {
        mounted: number;
        added: number;
        packages: number;
        manifestJsonBytes: number;
        artifactBytes: number;
        retainedBlobBytes: number;
        indexedMembers: number;
        memberBodyCopies: number;
        manifestParseMs: number;
        decodeValidateMs: number;
        mountMs: number;
        compressedRetainedBytes: number;
        declaredRawBytes: number;
        chunksInflated: number;
        rawInflatedBytes: number;
        cacheHits: number;
        cachedRawBytes: number;
      };
      let commitResult!: PreparedCommitResult;
      let committed = false;
      let maxStagedArtifactBytes = 0;
      unwrap(s.beginPreparedMount(raw.length));
      try {
        for (const { spec, transportIdentity } of raw) {
          const serializeStarted = performance.now();
          const input = JSON.stringify([spec]);
          serializeMs += performance.now() - serializeStarted;
          const result = unwrap<ColdArtifactResult>(s.prepareArtifacts(input));
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

          const artifact = result.artifacts[0];
          const bytes = s.takePrepared(artifact.label);
          maxStagedArtifactBytes = Math.max(maxStagedArtifactBytes, bytes.byteLength);
          await cache.writePreparedPackage({
            schema: 2,
            label: artifact.label,
            transportIdentity,
            cacheKey: artifact.cacheKey,
            artifactSha256: artifact.artifactSha256,
            bytes: artifact.bytes,
          }, bytes).catch(() => {});
          unwrap(s.stagePreparedMount(bytes, artifact.cacheKey));
        }
        commitResult = unwrap<PreparedCommitResult>(s.commitPreparedMount());
        committed = true;
      } finally {
        if (!committed) {
          try { unwrap(s.abortPreparedMount()); } catch { /* preserve the original preparation error */ }
        }
      }
      inputBytes = totals.inputJsonBytes;
      wasmMs = performance.now() - wasmStarted;
      mounted = commitResult.mounted;
      preparedMetrics = {
        mode: 'cold-prepare',
        added: commitResult.added,
        artifactBytes: totals.artifactBytes,
        preparedMembers: totals.preparedMembers,
        inputJsonBytes: totals.inputJsonBytes,
        base64Bytes: totals.base64Bytes,
        decodedSourceBytes: totals.decodedSourceBytes,
        normalizedBytes: totals.normalizedBytes,
        mountMemberBodyCopies: commitResult.memberBodyCopies,
        decodeValidatePrepareMs: totals.decodeValidatePrepareMs,
        jsonParseMs: totals.jsonParseMs,
        base64DecodeMs: totals.base64DecodeMs,
        normalizationMs: totals.normalizationMs,
        indexingMs: totals.indexingMs,
        artifactEncodeMs: totals.artifactEncodeMs,
        engineMountMs: commitResult.mountMs,
        maxStagedArtifactBytes,
        jsBatchBytes: 0,
        compressedRetainedBytes: commitResult.compressedRetainedBytes,
        declaredRawBytes: commitResult.declaredRawBytes,
        chunksInflated: commitResult.chunksInflated,
        rawInflatedBytes: commitResult.rawInflatedBytes,
        chunkCacheHits: commitResult.cacheHits,
        cachedRawBytes: commitResult.cachedRawBytes,
        indexedMembers: commitResult.indexedMembers,
        memberBodyCopies: commitResult.memberBodyCopies,
        manifestJsonBytes: commitResult.manifestJsonBytes,
        manifestParseMs: commitResult.manifestParseMs,
        decodeValidateMs: commitResult.decodeValidateMs,
      };
    }
    const committed = fresh.map(({ label }) => ({ label }));
    mountedLabels.add(committed);
    return {
      mounted,
      newlyMounted: committed.map(({ label }) => label),
      mountMs: performance.now() - t0,
      serializeMs,
      wasmMs,
      inputBytes,
      preparedMetrics,
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
    const rustSpec = { ...spec, buildEpochSecs: project.buildEpochSecs };
    const rustBoundaryStarted = performance.now();
    let result: RustPreparedProjectWire;
    try {
      result = unwrap<RustPreparedProjectWire>(s.prepareProject(
        JSON.stringify(project.files),
        project.config,
        JSON.stringify(project.predefined),
        JSON.stringify(project.siteFiles),
        JSON.stringify(rustSpec),
      ));
    } catch (error) {
      // A failed outer envelope means Rust never reported a successful compile.
      // Site failures use the typed `siteFailed` result below.
      throw new PrepareOperationError(String(error), 'compile');
    }
    const rustBoundaryMs = performance.now() - rustBoundaryStarted;
    const compiled = {
      ...result.compiled,
      buildMs: result.compileMs,
      fileCount: Object.keys(project.files).length,
    } as CompileResult;
    if (result.status === 'siteFailed') {
      throw new PrepareOperationError(result.error, 'site', compiled);
    }
    const prepared = result.site;
    try {
      compiled.packageStorage = unwrap(s.packageStorageMetrics());
      if (prepared.generator !== spec.generator || prepared.handle !== prepared.buildId) {
        throw new Error('prepare: Rust returned an inconsistent immutable build handle');
      }
      const hostPrepareStarted = performance.now();
      if (prepared.generator === 'cycle') {
        const rendererPackage = await loadCycleRendererPackage();
        const closed = await ClosedBuildHandle.open(prepared.siteBuild, {
          get: async (content) => {
            const bytes = s.readContent(prepared.handle, content.sha256);
            await storeExactContent(bytes, content);
            return bytes;
          },
        });
        const generator = await openCycleGenerator(closed, rendererPackage.package);
        const catalog = generator.outputs();
        const publicCatalog: OutputCatalog = {
          buildId: prepared.buildId,
          outputs: catalog.map((output) => publicCycleDescriptor(
            output,
            rendererPackage.contentByPath.get(output.file),
          )),
        };
        const runtime: CycleBuildRuntime = {
          kind: 'cycle',
          generator,
          buildId: prepared.buildId,
          catalog,
          publicCatalog,
          rendered: new Map(),
          rendererPackageId: rendererPackage.manifest.packageId,
        };
        // Preview assets are a closed catalog, never a live mutable-adapter query.
        // Materialize every non-page before publication; pages alone stay lazy.
        for (const output of catalog) {
          if (output.kind !== 'page') await renderCycleOutput(runtime, output.file);
        }
        assertClosedNonPageCatalog(publicCatalog);
        siteBuilds.install(prepared.handle, runtime);
      } else {
        siteBuilds.install(prepared.handle, { kind: 'publisher', buildId: prepared.buildId });
      }
      return {
        handle: prepared.handle,
        buildId: prepared.buildId,
        generator: prepared.generator,
        compiled,
        metrics: {
          compileProjectMs: compiled.buildMs,
          // The combined Rust boundary includes compilation. Report only the
          // remaining site-preparation boundary under this metric's name.
          rustPrepareMs: Math.max(0, rustBoundaryMs - compiled.buildMs),
          hostPrepareMs: performance.now() - hostPrepareStarted,
          rust: prepared.metrics,
        },
      };
    } catch (error) {
      throw new PrepareOperationError(String(error), 'site', compiled);
    }
  },

  async outputs(handle) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`outputs: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return runtime.publicCatalog;
    const catalog = unwrap<OutputCatalog>(s.outputs(handle));
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
    if (runtime.kind === 'cycle') return renderCycleOutput(runtime, path);
    const rendered = unwrap<RenderedOutput>(s.render(handle, path));
    await publishRustContent(s, handle, rendered.content);
    return rendered;
  },

  async finalize(handle) {
    const s = await ensureSession();
    const runtime = siteBuilds.get(handle);
    if (!runtime) throw new Error(`finalize: unknown build handle ${handle}`);
    if (runtime.kind === 'cycle') return finalizeCycleOutput(s, handle, runtime);
    const catalog = unwrap<OutputCatalog>(s.outputs(handle));
    for (const output of catalog.outputs) {
      if (!output.content) {
        const rendered = unwrap<RenderedOutput>(s.render(handle, output.path));
        await publishRustContent(s, handle, rendered.content);
      } else {
        await publishRustContent(s, handle, output.content);
      }
    }
    return unwrap<SiteOutput>(s.finalize(handle));
  },
};

async function handleRequest(msg: WorkerRequest): Promise<void> {
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  lastWorkerConsoleError = '';
  try {
    const handler = handlers[msg.op] as (...args: unknown[]) => Promise<unknown>;
    if (!handler) throw new Error(`unknown op: ${msg.op}`);
    reply({ id: msg.id, ok: true, result: await handler(...msg.args) });
  } catch (err) {
    const e2 = err as Error;
    const detail = err instanceof PrepareOperationError
      ? err.stage === 'site'
        ? { operation: 'prepare' as const, stage: 'site' as const, compiled: err.compiled! }
        : { operation: 'prepare' as const, stage: 'compile' as const }
      : undefined;
    const consoleContext = lastWorkerConsoleError
      ? `\nWorker console: ${lastWorkerConsoleError}`
      : '';
    reply({
      id: msg.id,
      ok: false,
      error: `${String(e2?.stack ?? e2)}${consoleContext}`,
      ...(detail ? { detail } : {}),
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
