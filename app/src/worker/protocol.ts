// Worker protocol (docs/fhir-ig-editor-spec.md §4). The UI thread and the engine
// worker exchange these message shapes. Kept in one file so both sides stay in
// lockstep. Every request carries an `id`; the worker replies with the same id.

export interface EngineVersion {
  version: string;
  commit: string;
  engine: string;
}

/** One compiled FHIR resource, as the wasm `compile()` returns it. */
export interface CompiledResource {
  filename: string;
  /** Byte-identical SUSHI JSON output. */
  text: string;
  resourceType?: string;
  id?: string;
  url?: string;
}

/** SUSHI-exact diagnostic, threaded from the engine (compiler → wasm_api). */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Project-relative file path (e.g. `input/fsh/Profiles.fsh`), when known. */
  file?: string;
  /** 1-based line, when known. */
  line?: number;
}

export interface CompileResult {
  resources: CompiledResource[];
  diagnostics: Diagnostic[];
  /** Wall-clock ms measured across the wasm call boundary in the worker. */
  buildMs: number;
  fileCount: number;
  packageStorage?: PackageStorageMetrics;
}

export interface PackageStorageMetrics {
  compressedRetainedBytes: number;
  declaredRawBytes: number;
  chunksInflated: number;
  rawInflatedBytes: number;
  cacheHits: number;
  cachedRawBytes: number;
}

export interface SnapshotResult {
  /** The full SD with generated `snapshot.element`, or null on failure. */
  snapshot: unknown | null;
  messages: string[];
  snapshotMs: number;
}

export interface InitResult {
  mounted: number;
  version: EngineVersion;
  initMs: number;
  serializeMs: number;
  wasmMs: number;
  inputBytes: number;
}

/** Result of an incremental `mountBundles` call (lazy per-bundle mount). */
export interface MountResult {
  /** Total packages mounted in the engine after this call. */
  mounted: number;
  /** Labels newly mounted by THIS call (already-mounted labels are skipped). */
  newlyMounted: string[];
  mountMs: number;
  serializeMs: number;
  wasmMs: number;
  inputBytes: number;
  /** Raw packages whose binary PreparedPackage was durably published to OPFS. */
  preparedStored?: string[];
  /** Rust-side phases and allocation/index facts for the prepared mount path. */
  preparedMetrics?: PreparedMountMetrics;
  /** Exact normalized package artifacts installed by this transaction. */
  packageIdentities?: Array<{ label: string; cacheKey: string }>;
}

export interface PreparedMountMetrics {
  mode: 'cold-prepare' | 'warm-binary';
  added: number;
  artifactBytes: number;
  engineMountMs: number;
  /** Cold: base64 decode + normalize + index + encode. */
  decodeValidatePrepareMs?: number;
  preparedMembers?: number;
  mountMemberBodyCopies?: number;
  inputJsonBytes?: number;
  base64Bytes?: number;
  decodedSourceBytes?: number;
  normalizedBytes?: number;
  jsonParseMs?: number;
  base64DecodeMs?: number;
  normalizationMs?: number;
  indexingMs?: number;
  artifactEncodeMs?: number;
  /** Warm: validate indexed binary package ranges. */
  decodeValidateMs?: number;
  packages?: number;
  retainedBlobBytes?: number;
  /** Largest whole artifact held by JS while staging. The compact warm path
   * never constructs a closure-sized concatenation. */
  maxStagedArtifactBytes?: number;
  jsBatchBytes?: number;
  compressedRetainedBytes?: number;
  declaredRawBytes?: number;
  chunksInflated?: number;
  rawInflatedBytes?: number;
  chunkCacheHits?: number;
  cachedRawBytes?: number;
  indexedMembers?: number;
  memberBodyCopies?: number;
  manifestJsonBytes?: number;
  manifestParseMs?: number;
}

// ---- cold-start progress (spec §1 / §11: measure first load) --------------

/** A staged progress event surfaced during cold/warm start. `stage` names the
 *  phase; `bundle`/`bytes`/`totalBytes` are present during per-bundle fetch so
 *  the UI can show "inflating hl7.fhir.r4.core (3.8 MB)". `fromCache` marks a
 *  warm-start OPFS hit (no network). */
export interface ProgressEvent {
  stage:
    | 'wasm'
    | 'manifest'
    | 'project-cache-hit'
    | 'project-unpack'
    | 'project-store'
    | 'compile'
    | 'snapshot'
    | 'site-build'
    | 'preview-publish'
    | 'resolve'
    | 'bundle-fetch'
    | 'bundle-cache-hit'
    | 'bundle-mount'
    | 'registry-fetch'
    | 'package-blocked'
    | 'ready'
    | 'lazy-fetch';
  label?: string;
  /** Bytes fetched/inflated for the current bundle (compressed tgz size). */
  bytes?: number;
  /** Human message for the status line (kept for back-compat with setStatus). */
  message: string;
  /** 0..1 overall progress across a bounded operation, when computable. */
  fraction?: number;
  fromCache?: boolean;
  /** Stage wall time. Optional because progress-start events have not completed. */
  durationMs?: number;
  /** Bytes consumed/produced by this stage, distinct from the transport size. */
  inputBytes?: number;
  outputBytes?: number;
  fileCount?: number;
  /** Machine-readable substage measurements for benchmark collection. */
  metrics?: Record<string, number>;
}

// ---- closed Cycle site-build preview --------------------------------------

/** One page the preview can render, as returned by `listPages`. */
export interface PagePreviewDescriptor {
  file: string;
  title: string;
  kind: 'narrative' | 'artifacts' | 'profile' | 'valueset' | 'codesystem' | 'example' | 'generic';
}

/** Result of closing the typed Cycle SiteBuild + enumerating renderable pages. */
export interface SitePreviewResult {
  /** Content-derived identity of the closed SiteBuild consumed by Cycle. */
  buildId: string;
  pages: PagePreviewDescriptor[];
  /** Asset names -> mime, so the UI can serve them into the iframe on demand. */
  assets: { name: string; mime: string }[];
  buildMs: number;
  /** True when the verified ClosedSiteBuild came from persistent ContentStore. */
  fromCache?: boolean;
}

/** A rendered page's HTML + the assets it may reference (served via blob URLs). */
export interface RenderPageResult {
  file: string;
  html: string;
  renderMs: number;
  fromCache?: boolean;
}

/** Site-content inputs (pagecontent/images/includes), transported as base64 to
 *  the compile/projection boundary. V2 assets become raw CAS artifacts. */
export interface SiteContentInput {
  /** project-relative path -> base64 bytes (pagecontent/images/includes). */
  siteFiles: Record<string, string>;
  buildEpochSecs: number;
}

// ---- request messages (UI -> worker) --------------------------------------

// ---- tier-1 ValueSet expansion (spec §6 tier 1) ---------------------------

/** One expansion member row (`expansion.contains[i]`). */
export interface ExpansionConcept {
  system: string;
  code: string;
  display?: string;
  inactive?: boolean;
}

/** A used-codesystem version the expansion drew from. */
export interface UsedCodeSystem {
  system: string;
  version?: string;
}

/** A precise refusal from the tier-1 evaluator — the "needs terminology server"
 *  state, carrying WHICH compose element and WHY (shown verbatim per spec §6). */
export interface NotEnumerable {
  /** `"include"` or `"exclude"`. */
  component: string;
  /** 0-based index of the offending element within that side. */
  index: number;
  system?: string;
  /** Machine-readable refusal class (the UI branches on this). */
  kind:
    | 'ExternalSystemFilter'
    | 'UnresolvableOrIncompleteSystem'
    | 'UnresolvableValueSet'
    | 'NestedNotEnumerable'
    | 'UnsupportedLocalFilter'
    | 'Malformed'
    | 'CycleGuard';
  /** The verbatim single-line refusal reason. */
  reason: string;
  /** `component[index]: reason` — the full Display string. */
  display: string;
}

/** Result of a tier-1 `expandValueSet` call: either an expansion or a refusal. */
export type ExpandResult =
  | {
      ok: true;
      total: number;
      contains: ExpansionConcept[];
      usedCodeSystems: UsedCodeSystem[];
      copyright: string[];
      expandMs: number;
    }
  | { ok: false; notEnumerable: NotEnumerable; expandMs: number };

// ---- package resolution (task #32: runtime arbitrary-IG loading) ----------

/** A concrete package coordinate the engine resolved. */
export interface PackageRequestCoord {
  package_id: string;
  version: string;
}

/** Why a referenced package is not yet satisfiable from the mounted set. */
export type MissingReason =
  | { kind: 'not_mounted' }
  | { kind: 'unresolved_version'; requested: string };

/** A package the resolver needs but that is not yet mounted / resolvable. */
export interface MissingPackage {
  package_id: string;
  version: string;
  reason: MissingReason;
  /** Which set surfaced it. */
  set: 'compile' | 'context';
}

/** A version-selection input whose answer can change without config changes.
 * Persistent resolution locks must refresh its candidate universe and ask Rust
 * to verify the resulting exact closure before compilation. */
export interface MutableVersionRequest {
  package_id: string;
  requested: string;
  resolved_version: string | null;
  set: 'compile' | 'context';
}

/** The engine's `resolve_project` answer (mirrors package_store::ResolutionStep).
 *  The host loop drives resolve → fetch each `missing` → mount → resolve until
 *  `satisfied`. */
export interface ResolutionStep {
  resolver_schema: number;
  compile_set: PackageRequestCoord[];
  context_closure: PackageRequestCoord[];
  /** Package manifests read to prove the closure, including compatibility-
   * filtered dependencies which are not themselves compile/render inputs. */
  resolution_support: PackageRequestCoord[];
  missing: MissingPackage[];
  satisfied: boolean;
  mutable_requests: MutableVersionRequest[];
}

/** Host-supplied version index for `latest`/`current`/`M.N.x` resolution
 *  (`{ versions: { "<id>": ["<ver>", ...] } }`). Data in, decisions in Rust. */
export interface VersionIndex {
  versions: Record<string, string[]>;
}

// ---- the op table (ledger #2: ONE protocol shape) --------------------------
//
// Every engine operation is one row here: its positional args and its result
// type. The worker implements exactly this table (a handler per op); the client
// exposes exactly this table (`call(op, ...args)`). Adding an operation = adding
// a row + a handler — no new message shapes, no per-op plumbing.

/** A package bundle to mount: a label + its inflated `{name: base64}` files. */
export interface BundleSpec {
  label: string;
  files: Record<string, string>;
}

export interface PreparedPackagePointer {
  schema: 2;
  label: string;
  transportIdentity: string;
  cacheKey: string;
  artifactSha256: string;
  bytes: number;
}

export type PackageMountInput =
  | { kind: 'raw'; spec: BundleSpec; transportIdentity: string }
  | { kind: 'prepared'; pointer: PreparedPackagePointer };

/** Site-tree file value for `mountSite`: UTF-8 text or base64 bytes. */
export type SiteTreeFile = string | { b64: string };

/** Options for the stock-template render surface (engine `mountSite`). */
export interface StockSiteOptions {
  activeTables?: boolean;
  runUuid?: string;
  /** Merge into the mounted tree instead of replacing (overlay fast-path). */
  merge?: boolean;
  /** Whether a registered include miss may invoke the native fragment resolver.
   * External/callback-free builders set false; Publisher templates default true. */
  artifactResolution?: boolean;
}

/** Opaque, content-derived handle for one frozen stock-template generation.
 * `siteBuild` is the renderer-neutral predecessor manifest; page renders return
 * successor manifests and CAS batches without consulting an ambient last site. */
export interface StockBuildOpenResult {
  handle: string;
  buildId: string;
  siteBuild: unknown;
  pages: string[];
  packageStorage?: PackageStorageMetrics;
}

export interface StockArtifactTransition {
  /** Typed Need<ArtifactKey> values discovered while Liquid evaluated. */
  requested: unknown[];
  /** Requested generated artifacts whose bytes the page actually consumed. */
  read: unknown[];
  /** Exact ArtifactRecords installed by the resolution batch. */
  resolved: unknown[];
}

export interface StockPageRenderResult {
  html: string;
  /** Affine handle for the immutable successor; the predecessor is retired
   * after a successful transition, so use this for the next lazy page. */
  handle: string;
  predecessorBuildId: string;
  buildId: string;
  siteBuild: unknown;
  /** SHA-256 -> base64 bytes newly introduced by this transition. */
  objects: Record<string, string>;
  transition: StockArtifactTransition;
  nonReadyFragments: number;
  renderMs: number;
}

export interface EngineOps {
  init: { args: [bundles: BundleSpec[]]; result: InitResult };
  mountBundles: { args: [bundles: BundleSpec[]]; result: MountResult };
  mountPackages: { args: [packages: PackageMountInput[]]; result: MountResult };
  resolveProject: { args: [config: string, versionIndex?: VersionIndex]; result: ResolutionStep };
  expandValueSet: { args: [valueSetJson: string, resourcesJson: string]; result: ExpandResult };
  compile: {
    args: [
      config: string,
      files: Record<string, string>,
      predefined: Record<string, unknown>,
      siteFiles: Record<string, string>,
    ];
    result: CompileResult;
  };
  snapshot: { args: [url: string]; result: SnapshotResult };
  // Closed Cycle external-builder path (verified semantic view + shared renderer live in the worker).
  buildSite: {
    args: [
      config: string,
      files: Record<string, string>,
      predefined: Record<string, unknown>,
      siteFiles: Record<string, string>,
      buildEpochSecs: number,
      /** Exact ProjectRevision + PackageLock digest computed by EngineClient. */
      projectRevision: string,
      snapshotSourcesIdentity: string,
    ];
    result: SitePreviewResult;
  };
  /** Install a previously verified closed Cycle build without snapshot/site
   * production. A miss is null and has no engine-side mutation. */
  restoreCycleSite: {
    args: [projectRevision: string, buildEpochSecs: number, snapshotSourcesIdentity: string];
    result: SitePreviewResult | null;
  };
  renderPage: { args: [file: string]; result: RenderPageResult };
  assetBytes: { args: [name: string]; result: { name: string; mime: string; base64: string; fromCache?: boolean } | null };
  // F6 stock-template render surface (engine-side pages/fragments).
  mountSite: { args: [files: Record<string, SiteTreeFile>, options?: StockSiteOptions]; result: { mounted: number } };
  // Live template loader (#40): materialize a template `id#ver` chain from the
  // MOUNTED bundle packages (base-chain walk + union-copy, in Rust) and merge
  // its tree (includes/*→_includes/*) into the site tree. The host must have
  // fetched+mounted the whole base chain first (Rust decides which packages via
  // walk_base_chain; JS fetches them on the SAME resolve→fetch→mount path).
  mountTemplate: { args: [coord: string]; result: { files: number } };
  // Source-driven stock site (task #45): synthesize the per-artifact page SHELLS
  // + the `_data/*` site-data model from the CURRENT compile (compiled + predefined
  // resources) and the mounted template's `config.json`/`layouts`, merging them
  // into the engine site tree (shells at the root, `_data/*` under `_data/`). This
  // replaces the pre-baked `{id}-stock.json` warm-start bundle: mount resources →
  // mountTemplate → produceStockSite → stage pagecontent → render.
  produceStockSite: { args: []; result: { pages: number; data: number } };
  // Freeze the final mounted generation as an explicit SiteBuild predecessor,
  // then render only through immutable successor handles.
  openStockBuild: { args: [templateCoord: string]; result: StockBuildOpenResult };
  renderStockPage: { args: [handle: string, name: string]; result: StockPageRenderResult };
  listSitePages: { args: []; result: { pages: string[] } };
  renderSitePage: { args: [name: string]; result: { html: string; renderMs: number } };
  renderFragment: { args: [ref: string, kind: string]; result: { html: string } };
  // Generic native content operations. Cycle uses its shared LiquidJS policy.
  renderLiquid: { args: [source: string, data?: Record<string, unknown>]; result: { html: string } };
  renderMarkdown: { args: [md: string, opts?: { rougeWrappers?: boolean }]; result: { html: string } };
}

export type Op = keyof EngineOps;

export type WorkerRequest = {
  [K in Op]: { id: number; op: K; args: EngineOps[K]['args'] };
}[Op];

// ---- reply messages (worker -> UI) ----------------------------------------

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
