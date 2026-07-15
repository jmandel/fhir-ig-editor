// Worker protocol. The UI thread and engine worker share these message shapes;
// the site subset implements the four-operation contract in ARCHITECTURE.md.
// Every request carries an `id`; the worker replies with the same id.

import type {
  BuildError,
  BuildEvent,
  BundleInput,
  CompilationDefinition,
  CompilationDiagnostic,
  CompilationOutcome,
  CompilationResource,
  ContentRef,
  GeneratorSpec,
  OutputCatalog,
  PreparedProjectResult,
  PreparedExport,
  ProjectRevision,
  ResolutionStep,
  SiteOutput,
  TemplateResolution,
  VersionIndex,
} from '../site/contract.generated';

export type {
  BuildError,
  BuildEvent,
  BundleCompressionMetrics,
  BundleInput,
  MissingPackage,
  MissingReason,
  MutableVersionRequest,
  PackageRequest,
  PackageMountResult,
  PreparedExport,
  PreparedStageResult,
  PrepareMountResult,
  RequestedSet,
  ResolutionStep,
  VersionIndex,
} from '../site/contract.generated';

// Presentation names retained at call sites while their complete structure is
// generated from the canonical Rust compilation contract.
export type DefinitionLocation = CompilationDefinition;
export type CompiledResource = CompilationResource;
export type Diagnostic = CompilationDiagnostic;
export type CompileResult = CompilationOutcome;

export interface EngineVersion {
  version: string;
  commit: string;
  engine: string;
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
  events: BuildEvent[];
}

/** Result of an incremental transactional package mount. */
export interface MountResult {
  /** Total packages mounted in the engine after this call. */
  mounted: number;
  /** Labels newly mounted by THIS call (already-mounted labels are skipped). */
  newlyMounted: string[];
  events: BuildEvent[];
}

/** Private streaming transaction used while package carriers are still being
 * acquired. Slots are resolver positions, not arrival positions. */
export interface PackageMountTicket {
  ticket: number;
  labels: string[];
}

export interface PackageMountStageResult {
  ticket: number;
  index: number;
  label: string;
  events: BuildEvent[];
}

export interface PackageMountAbortResult {
  ticket: number;
  aborted: boolean;
}

/** Worker-only projection of the generated Rust prepare result. It omits the
 * closed SiteBuild after the Worker has opened its renderer, but introduces no
 * independently declared payload fields. */
export type PrepareTransportResult = Pick<PreparedProjectResult, 'compiled' | 'events'> & {
  buildId: PreparedProjectResult['site']['buildId'];
  generator: PreparedProjectResult['site']['generator'];
};

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

// ---- the op table (ledger #2: ONE protocol shape) --------------------------
//
// Every engine operation is one row here: its positional args and its result
// type. The worker implements exactly this table (a handler per op); the client
// exposes exactly this table (`call(op, ...args)`). Adding an operation = adding
// a row + a handler — no new message shapes, no per-op plumbing.

/** A package bundle to mount: a label + its inflated `{name: base64}` files. */
export type BundleSpec = BundleInput;

export type PreparedPackagePointer = PreparedExport & {
  schema: typeof import('../site/contract.generated').PREPARED_PACKAGE_FORMAT_VERSION;
  transportIdentity: string;
};

export type PackageMountInput =
  | { kind: 'raw'; spec: BundleSpec; transportIdentity: string }
  | { kind: 'tgz'; label: string; bytes: ArrayBuffer; transportIdentity: string }
  | { kind: 'prepared'; pointer: PreparedPackagePointer };

export type { TemplateResolution } from '../site/contract.generated';

export interface EngineOps {
  init: { args: []; result: InitResult };
  /** Private ordered package-acquisition transaction. */
  openPackageMount: { args: [labels: string[]]; result: PackageMountTicket };
  stagePackageMount: {
    args: [ticket: number, index: number, input: PackageMountInput];
    result: PackageMountStageResult;
  };
  commitPackageMount: { args: [ticket: number]; result: MountResult };
  abortPackageMount: { args: [ticket: number]; result: PackageMountAbortResult };
  resolveProject: { args: [config: string, versionIndex?: VersionIndex]; result: ResolutionStep };
  expandValueSet: { args: [valueSetJson: string, resourcesJson: string]; result: ExpandResult };
  snapshot: { args: [url: string]; result: SnapshotResult };
  /** Private acquisition handshake; only EngineClient.prepare drives it. */
  resolveTemplate: { args: [coordinate: string]; result: TemplateResolution };
  // The complete public site-generation surface.
  prepare: { args: [project: ProjectRevision, spec: GeneratorSpec]; result: PrepareTransportResult };
  outputs: { args: [handle: string]; result: OutputCatalog };
  render: { args: [handle: string, path: string]; result: ContentRef };
  finalize: { args: [handle: string]; result: SiteOutput };
}

export type Op = keyof EngineOps;

export type WorkerRequest = {
  [K in Op]: { id: number; op: K; args: EngineOps[K]['args'] };
}[Op];

// ---- reply messages (worker -> UI) ----------------------------------------

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: BuildError<CompileResult> };
