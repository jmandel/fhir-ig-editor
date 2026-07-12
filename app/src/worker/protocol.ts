// Worker protocol. The UI thread and engine worker share these message shapes;
// the site subset implements the four-operation contract in ARCHITECTURE.md.
// Every request carries an `id`; the worker replies with the same id.

import type {
  GeneratorSpec,
  OutputCatalog,
  ProjectRevision,
  PrepareResult,
  RenderedOutput,
  SiteOutput,
} from '../site/contract';

export interface EngineVersion {
  version: string;
  commit: string;
  engine: string;
}

/** One compiled FHIR resource, as the wasm `compile()` returns it. */
export interface DefinitionLocation {
  kind: 'fsh-declaration' | 'predefined-resource';
  path: string;
  /** One-based declaration line. */
  line: number;
  /** Zero-based declaration column. */
  column: number;
}

export interface CompiledResource {
  filename: string;
  /** Byte-identical SUSHI JSON output. */
  text: string;
  resourceType?: string;
  id?: string;
  url?: string;
  /** Exact primary authored declaration, when one exists. */
  definition?: DefinitionLocation;
}

/** SUSHI-exact diagnostic, threaded from the engine (compiler → wasm_api). */
export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Project-relative file path (e.g. `input/fsh/Profiles.fsh`), when known. */
  file?: string;
  /** 1-based line, when known. */
  line?: number;
  /** Exact declaration whose compiled/published consequence is affected. */
  ownerDefinition?: DefinitionLocation;
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

/** Result of an incremental transactional package mount. */
export interface MountResult {
  /** Total packages mounted in the engine after this call. */
  mounted: number;
  /** Labels newly mounted by THIS call (already-mounted labels are skipped). */
  newlyMounted: string[];
  mountMs: number;
  serializeMs: number;
  wasmMs: number;
  inputBytes: number;
  /** Rust-side phases and allocation/index facts for the prepared mount path. */
  preparedMetrics?: PreparedMountMetrics;
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
 * phase. During a transport, `bytes` is the number of response-body bytes read
 * so far and `totalBytes` is the expected response size when known. A declared
 * total must never be reported as bytes already downloaded. `fromCache` marks
 * a warm-start OPFS hit (no network). */
export interface ProgressEvent {
  stage:
    | 'wasm'
    | 'manifest'
    | 'project-cache-hit'
    | 'project-verify'
    | 'project-unpack'
    | 'project-store'
    | 'compile'
    | 'snapshot'
    | 'site-build'
    | 'preview-publish'
    | 'resolve'
    | 'bundle-fetch'
    | 'bundle-cache-hit'
    | 'bundle-unpack'
    | 'bundle-mount'
    | 'registry-fetch'
    | 'package-blocked'
    | 'ready'
    | 'lazy-fetch';
  label?: string;
  /** Response-body bytes downloaded so far for the current transport. */
  bytes?: number;
  /** Expected response-body bytes for the current transport, when known. */
  totalBytes?: number;
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
  schema: 3;
  label: string;
  transportIdentity: string;
  cacheKey: string;
  artifactSha256: string;
  bytes: number;
}

export type PackageMountInput =
  | { kind: 'raw'; spec: BundleSpec; transportIdentity: string }
  | { kind: 'prepared'; pointer: PreparedPackagePointer };

export interface TemplateResolution {
  satisfied: boolean;
  chain: string[];
  missing?: string;
}

export interface EngineOps {
  init: { args: []; result: InitResult };
  mountPackages: { args: [packages: PackageMountInput[]]; result: MountResult };
  resolveProject: { args: [config: string, versionIndex?: VersionIndex]; result: ResolutionStep };
  expandValueSet: { args: [valueSetJson: string, resourcesJson: string]; result: ExpandResult };
  snapshot: { args: [url: string]; result: SnapshotResult };
  /** Private acquisition handshake; only EngineClient.prepare drives it. */
  resolveTemplate: { args: [coordinate: string]; result: TemplateResolution };
  // The complete public site-generation surface.
  prepare: { args: [project: ProjectRevision, spec: GeneratorSpec]; result: PrepareResult };
  outputs: { args: [handle: string]; result: OutputCatalog };
  render: { args: [handle: string, path: string]; result: RenderedOutput };
  finalize: { args: [handle: string]; result: SiteOutput };
}

export type Op = keyof EngineOps;

export type WorkerRequest = {
  [K in Op]: { id: number; op: K; args: EngineOps[K]['args'] };
}[Op];

// ---- reply messages (worker -> UI) ----------------------------------------

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | {
      id: number;
      ok: false;
      error: string;
      /** Operation metadata only: lets prepare distinguish a compiler failure
       * from a later generator failure without adding another domain value. */
      detail?:
        | { operation: 'prepare'; stage: 'compile' }
        | { operation: 'prepare'; stage: 'site'; compiled: CompileResult };
    };
