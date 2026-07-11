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

import type { EngineOps, Op, WorkerRequest, WorkerReply, BundleSpec, PackageMountInput, PreparedMountMetrics, SiteTreeFile, StockSiteOptions } from './protocol';
import { ClosedBuildHandle } from '@cycle/core/closed-build';
import type { CycleSiteBuildPayload } from '@cycle/core/json-site-build';
import { openCycleSiteBuildPayload } from '@cycle/core/open-site-build';
import type { PortableCycleSiteBuildView } from '@cycle/core/open-site-build';
import type { CyclePreviewRenderer } from '../preview/render';
import { MountedLabels } from './mountedLabels';
import { cycleBuildRecipe, cycleOutputRecipe } from './cycleCacheIdentity';

// The wasm glue is a static asset (not bundled by Vite), so we resolve it against
// the document base at runtime. `import.meta.env.BASE_URL` is Vite's base path.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** The wasm-bindgen `Session` class surface (string-envelope methods). */
interface WasmSession {
  init(bundlesJson: string): string;
  mount(bundlesJson: string): string;
  mountPreparedBatch(bytes: Uint8Array, manifestJson: string): string;
  beginPreparedMount(expectedPackages: number): string;
  stagePreparedMount(bytes: Uint8Array, expectedKey: string): string;
  commitPreparedMount(): string;
  abortPreparedMount(): string;
  packageStorageMetrics(): string;
  prepareAndMount(bundlesJson: string): string;
  takePrepared(label: string): Uint8Array;
  resolveProject(config: string, versionIndexJson: string): string;
  compile(filesJson: string, config: string, predefinedJson: string): string;
  compileProject(filesJson: string, config: string, predefinedJson: string, siteFilesJson: string): string;
  setLocalResources(json: string): string;
  snapshot(input: string): string;
  buildSiteDb(inputJson: string): string;
  buildSiteDbFromCompile(inputJson: string): string;
  buildSiteBuildFromCompile(inputJson: string): string;
  expandValueSet(valueSetJson: string, resourcesJson: string): string;
  mountSite(filesJson: string, optionsJson: string): string;
  mountTemplate(coord: string): string;
  produceStockSite(): string;
  openStockBuild(templateCoord: string): string;
  renderStockPage(handle: string, name: string): string;
  renderLiquid(source: string, dataJson: string): string;
  renderMarkdown(md: string, optsJson: string): string;
  listPages(): string;
  renderPage(name: string): string;
  renderFragment(ref: string, kind: string): string;
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
  const env = JSON.parse(envelopeJson) as
    | { apiVersion: number; ok: true; op: string; result: T }
    | { apiVersion: number; ok: false; op: string; error: { message: string } };
  if (env.apiVersion !== 1) throw new Error(`unsupported engine apiVersion ${env.apiVersion}`);
  if (!env.ok) throw new Error(`${env.op}: ${env.error.message}`);
  return env.result;
}

/** Labels currently mounted in the engine — so `mountBundles` is idempotent and
 *  the UI's lazy loader never re-fetches an already-mounted package. */
const mountedLabels = new MountedLabels();

/** One atomically installed external-builder runtime. Its proof-bearing handle,
 * typed view, and prepared renderer can never refer to different builds. */
interface CycleBuildRuntime {
  build: ClosedBuildHandle;
  view: PortableCycleSiteBuildView;
  renderer: CyclePreviewRenderer;
  buildId: string;
}

let cycleBuild: CycleBuildRuntime | null = null;

const CYCLE_BUILD_CACHE = 'cycle-closed-build';
const CYCLE_OUTPUT_CACHE = 'cycle-site-output';
const JSON_MEDIA = 'application/vnd.fhir.site-build+json';

async function installCycleBuild(
  handoff: CycleSiteBuildPayload,
  started: number,
  fromCache: boolean,
): Promise<EngineOps['buildSite']['result']> {
  const { build, view } = await openCycleSiteBuildPayload(handoff);
  const render = await import('../preview/render');
  const renderer = render.createCycleRenderer(view);
  const pages = renderer.listPages();
  renderer.listOutputs();
  const assets = view.assets().map((asset) => ({ name: asset.Name, mime: asset.Mime }));
  const buildId = build.manifest.buildId;
  cycleBuild = { build, view, renderer, buildId };
  return { buildId, pages, assets, buildMs: performance.now() - started, fromCache };
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// ---- op handlers (exactly the protocol's EngineOps table) -------------------

type Handlers = { [K in Op]: (...args: EngineOps[K]['args']) => Promise<EngineOps[K]['result']> };

const handlers: Handlers = {
  async init(bundles: BundleSpec[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const serializeStarted = performance.now();
    const input = JSON.stringify(bundles);
    const inputBytes = new TextEncoder().encode(input).byteLength;
    const serializeMs = performance.now() - serializeStarted;
    const wasmStarted = performance.now();
    const { mounted } = unwrap<{ mounted: number }>(s.init(input));
    const wasmMs = performance.now() - wasmStarted;
    mountedLabels.replace(bundles.map((bundle) => bundle.label));
    const version = JSON.parse(wasmMod!.Session.version());
    return { mounted, version, initMs: performance.now() - t0, serializeMs, wasmMs, inputBytes };
  },

  /** Incrementally mount additional bundles (lazy per-bundle loading, spec §1).
   *  Idempotent: labels already mounted are skipped both here and in the engine. */
  async mountBundles(bundles: BundleSpec[]) {
    const s = await ensureSession();
    const t0 = performance.now();
    const fresh: BundleSpec[] = mountedLabels.fresh(bundles);
    const serializeStarted = performance.now();
    const input = fresh.length > 0 ? JSON.stringify(fresh) : '[]';
    const inputBytes = new TextEncoder().encode(input).byteLength;
    const serializeMs = performance.now() - serializeStarted;
    const wasmStarted = performance.now();
    const mounted = fresh.length > 0
      ? unwrap<{ mounted: number }>(s.mount(input)).mounted
      : mountedLabels.size;
    const wasmMs = performance.now() - wasmStarted;
    mountedLabels.add(fresh);
    return {
      mounted,
      newlyMounted: fresh.map((b) => b.label),
      mountMs: performance.now() - t0,
      serializeMs,
      wasmMs,
      inputBytes,
    };
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
    let packageIdentities: Array<{ label: string; cacheKey: string }> = [];
    const preparedStored: string[] = [];
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
      packageIdentities = prepared.map(({ pointer }) => ({
        label: pointer.label,
        cacheKey: pointer.cacheKey,
      }));
    } else {
      const serializeStarted = performance.now();
      const input = JSON.stringify(raw.map(({ spec }) => spec));
      serializeMs = performance.now() - serializeStarted;
      const wasmStarted = performance.now();
      const result = unwrap<{
        mounted: number;
        added: number;
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
        mountMs: number;
      }>(s.prepareAndMount(input));
      inputBytes = result.inputJsonBytes;
      wasmMs = performance.now() - wasmStarted;
      mounted = result.mounted;
      preparedMetrics = {
        mode: 'cold-prepare',
        added: result.added,
        artifactBytes: result.artifactBytes,
        preparedMembers: result.preparedMembers,
        inputJsonBytes: result.inputJsonBytes,
        base64Bytes: result.base64Bytes,
        decodedSourceBytes: result.decodedSourceBytes,
        normalizedBytes: result.normalizedBytes,
        mountMemberBodyCopies: result.mountMemberBodyCopies,
        decodeValidatePrepareMs: result.decodeValidatePrepareMs,
        jsonParseMs: result.jsonParseMs,
        base64DecodeMs: result.base64DecodeMs,
        normalizationMs: result.normalizationMs,
        indexingMs: result.indexingMs,
        artifactEncodeMs: result.artifactEncodeMs,
        engineMountMs: result.mountMs,
      };
      packageIdentities = result.artifacts.map(({ label, cacheKey }) => ({ label, cacheKey }));
      const cache = await import('./preparedPackageCache');
      const transportByLabel = new Map(raw.map(({ spec, transportIdentity }) => [spec.label, transportIdentity]));
      for (const artifact of result.artifacts) {
        // Always drain the Rust export, even if OPFS is unavailable; exports are
        // deliberately one-shot and should not retain duplicate package bytes.
        const bytes = s.takePrepared(artifact.label);
        const transportIdentity = transportByLabel.get(artifact.label);
        if (!transportIdentity) throw new Error(`missing transport identity for ${artifact.label}`);
        const stored = await cache.writePreparedPackage({
          schema: 2,
          label: artifact.label,
          transportIdentity,
          cacheKey: artifact.cacheKey,
          artifactSha256: artifact.artifactSha256,
          bytes: artifact.bytes,
        }, bytes).catch(() => false);
        if (stored) preparedStored.push(artifact.label);
      }
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
      preparedStored,
      preparedMetrics,
      packageIdentities,
    };
  },

  /** Resolve a project's package sets against the CURRENTLY MOUNTED bundles
   *  (task #32). Resolution logic lives entirely in Rust; this is a thin marshal. */
  async resolveProject(config, versionIndex) {
    const s = await ensureSession();
    return unwrap(s.resolveProject(config, versionIndex ? JSON.stringify(versionIndex) : ''));
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

  async compile(config, files, predefined, siteFiles) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(
      s.compileProject(
        JSON.stringify(files),
        config,
        JSON.stringify(predefined),
        JSON.stringify(siteFiles),
      ),
    );
    const buildMs = performance.now() - t0;
    const packageStorage = unwrap(s.packageStorageMetrics());
    return { ...out, buildMs, fileCount: Object.keys(files).length, packageStorage } as EngineOps['compile']['result'];
  },

  async snapshot(url) {
    const s = await ensureSession();
    const t0 = performance.now();
    const out = unwrap<Record<string, unknown>>(s.snapshot(url));
    return { ...out, snapshotMs: performance.now() - t0 } as EngineOps['snapshot']['result'];
  },

  // ---- closed Cycle external-builder path ----

  async buildSite(config, files, predefined, siteFiles, buildEpochSecs, projectRevision, snapshotSourcesIdentity) {
    const s = await ensureSession();
    const t0 = performance.now();
    const input = {
      config,
      fsh: files,
      predefined,
      site_files: siteFiles,
      build_epoch_secs: buildEpochSecs,
      target: 'cycle-site/v2',
    };
    // The matching compileProject call already established the semantic
    // revision. FSH/predefined bodies are equality assertions at the Rust trust
    // boundary, never inputs to a second compile.
    const handoff = unwrap<CycleSiteBuildPayload>(s.buildSiteBuildFromCompile(JSON.stringify(input)));
    // Install/verify before publishing the pointer. A semantically invalid
    // payload can therefore never become a persistent fast-path hit.
    const result = await installCycleBuild(handoff, t0, false);
    const cache = await import('../storage/derivedArtifactCache');
    const bytes = new TextEncoder().encode(JSON.stringify(handoff));
    await cache.writeDerivedArtifact(
      CYCLE_BUILD_CACHE,
      cycleBuildRecipe(projectRevision, buildEpochSecs, __ENGINE_COMMIT__, __ENGINE_RECIPE__, snapshotSourcesIdentity),
      bytes,
      JSON_MEDIA,
    ).catch(() => null);
    return result;
  },

  async restoreCycleSite(projectRevision, buildEpochSecs, snapshotSourcesIdentity) {
    const t0 = performance.now();
    const cache = await import('../storage/derivedArtifactCache');
    const cached = await cache.readDerivedArtifact(
      CYCLE_BUILD_CACHE,
      cycleBuildRecipe(projectRevision, buildEpochSecs, __ENGINE_COMMIT__, __ENGINE_RECIPE__, snapshotSourcesIdentity),
      JSON_MEDIA,
    );
    if (!cached) return null;
    try {
      const handoff = JSON.parse(new TextDecoder().decode(cached.bytes)) as CycleSiteBuildPayload;
      return await installCycleBuild(handoff, t0, true);
    } catch {
      // The ContentStore object is authentic but no longer semantically usable.
      // Recipe versioning normally prevents this; treat it as a miss, never as
      // authority or a reason to skip normal site production.
      return null;
    }
  },

  async renderPage(file) {
    if (!cycleBuild) throw new Error('renderPage before buildSite');
    const t0 = performance.now();
    const cache = await import('../storage/derivedArtifactCache');
    const recipe = cycleOutputRecipe(cycleBuild.buildId, 'page', file, __CYCLE_RENDER_RECIPE__);
    const cached = await cache.readDerivedArtifact(CYCLE_OUTPUT_CACHE, recipe, 'text/html');
    if (cached) {
      return { file, html: new TextDecoder().decode(cached.bytes), renderMs: performance.now() - t0, fromCache: true };
    }
    const { html } = cycleBuild.renderer.renderPage(file);
    await cache.writeDerivedArtifact(
      CYCLE_OUTPUT_CACHE,
      recipe,
      new TextEncoder().encode(html),
      'text/html',
    ).catch(() => null);
    return { file, html, renderMs: performance.now() - t0, fromCache: false };
  },

  async assetBytes(name) {
    if (!cycleBuild) return null;
    try {
      const cache = await import('../storage/derivedArtifactCache');
      const recipe = cycleOutputRecipe(cycleBuild.buildId, 'asset', name, __CYCLE_RENDER_RECIPE__);
      const cached = await cache.readDerivedArtifact(CYCLE_OUTPUT_CACHE, recipe);
      if (cached?.content.mediaType) {
        return {
          name,
          mime: cached.content.mediaType,
          base64: base64(new Uint8Array(cached.bytes)),
          fromCache: true,
        };
      }
      const output = cycleBuild.renderer.renderOutput(name);
      const bytes = typeof output.content === 'string'
        ? new TextEncoder().encode(output.content)
        : output.content;
      await cache.writeDerivedArtifact(CYCLE_OUTPUT_CACHE, recipe, bytes, output.mime).catch(() => null);
      return { name: output.file, mime: output.mime, base64: base64(bytes), fromCache: false };
    } catch {
      return null;
    }
  },

  // ---- F6 stock-template render surface (engine-side pages/fragments) ----

  async mountSite(files: Record<string, SiteTreeFile>, options?: StockSiteOptions) {
    const s = await ensureSession();
    return unwrap(s.mountSite(JSON.stringify(files), options ? JSON.stringify(options) : ''));
  },

  /** Materialize a template `id#ver` chain from the MOUNTED bundle packages and
   *  merge it into the engine site tree (Rust: walk_base_chain + union-copy +
   *  config deep-merge, byte-exact, no ant). The whole base chain must already
   *  be mounted (the host fetched it on the resolve→fetch→mount path). A custom-
   *  ant template surfaces here as `mountTemplate <coord>: … never execute ant`
   *  (unwrap re-throws it as an Error the adapter maps to a friendly message). */
  async mountTemplate(coord: string) {
    const s = await ensureSession();
    return unwrap<{ files: number }>(s.mountTemplate(coord));
  },

  /** Source-driven stock site (task #45): produce the artifact page shells + the
   *  `_data` model from the current compile + mounted template, merging both into
   *  the engine site tree. Replaces the pre-baked `{id}-stock.json` bundle. */
  async produceStockSite() {
    const s = await ensureSession();
    return unwrap<{ pages: number; data: number }>(s.produceStockSite());
  },

  async openStockBuild(templateCoord) {
    const s = await ensureSession();
    const result = unwrap<EngineOps['openStockBuild']['result']>(s.openStockBuild(templateCoord));
    return { ...result, packageStorage: unwrap(s.packageStorageMetrics()) };
  },

  async renderStockPage(handle, name) {
    const s = await ensureSession();
    const t0 = performance.now();
    const result = unwrap<Omit<EngineOps['renderStockPage']['result'], 'renderMs'>>(
      s.renderStockPage(handle, name),
    );
    return { ...result, renderMs: performance.now() - t0 };
  },

  async listSitePages() {
    const s = await ensureSession();
    return unwrap(s.listPages());
  },

  async renderSitePage(name) {
    const s = await ensureSession();
    const t0 = performance.now();
    const { html } = unwrap<{ html: string }>(s.renderPage(name));
    return { html, renderMs: performance.now() - t0 };
  },

  async renderFragment(ref, kind) {
    const s = await ensureSession();
    return unwrap(s.renderFragment(ref, kind));
  },

  // ---- generic native Rust content surface (not Cycle LiquidJS) ----

  async renderLiquid(source, data) {
    const s = await ensureSession();
    return unwrap(s.renderLiquid(source, data ? JSON.stringify(data) : ''));
  },

  async renderMarkdown(md, opts) {
    const s = await ensureSession();
    return unwrap(s.renderMarkdown(md, opts ? JSON.stringify(opts) : ''));
  },
};

async function handleRequest(msg: WorkerRequest): Promise<void> {
  const reply = (r: WorkerReply) => (self as unknown as Worker).postMessage(r);
  try {
    const handler = handlers[msg.op] as (...args: unknown[]) => Promise<unknown>;
    if (!handler) throw new Error(`unknown op: ${msg.op}`);
    reply({ id: msg.id, ok: true, result: await handler(...msg.args) });
  } catch (err) {
    const e2 = err as Error;
    reply({ id: msg.id, ok: false, error: String(e2?.stack ?? e2) });
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
