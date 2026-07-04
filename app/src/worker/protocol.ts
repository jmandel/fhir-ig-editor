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
}

/** Result of an incremental `mountBundles` call (lazy per-bundle mount). */
export interface MountResult {
  /** Total packages mounted in the engine after this call. */
  mounted: number;
  /** Labels newly mounted by THIS call (already-mounted labels are skipped). */
  newlyMounted: string[];
  mountMs: number;
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
  /** 0..1 overall progress across the eager bundle set, when computable. */
  fraction?: number;
  fromCache?: boolean;
}

// ---- M2 site preview ------------------------------------------------------

/** One page the preview can render, as returned by `listPages`. */
export interface PagePreviewDescriptor {
  file: string;
  title: string;
  kind: 'narrative' | 'artifacts' | 'profile' | 'valueset' | 'codesystem' | 'example' | 'generic';
}

/** Result of building the site.db rows + enumerating renderable pages. */
export interface SitePreviewResult {
  pages: PagePreviewDescriptor[];
  /** Asset names -> mime, so the UI can serve them into the iframe on demand. */
  assets: { name: string; mime: string }[];
  buildMs: number;
}

/** A rendered page's HTML + the assets it may reference (served via blob URLs). */
export interface RenderPageResult {
  file: string;
  html: string;
  renderMs: number;
}

/** The inputs the worker needs to build the site.db rows (beyond the FSH compile
 *  inputs): the site-content files (pagecontent/images/includes) as base64. */
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

/** The engine's `resolve_project` answer (mirrors package_store::ResolutionStep).
 *  The host loop drives resolve → fetch each `missing` → mount → resolve until
 *  `satisfied`. */
export interface ResolutionStep {
  compile_set: PackageRequestCoord[];
  context_closure: PackageRequestCoord[];
  missing: MissingPackage[];
  satisfied: boolean;
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

/** Site-tree file value for `mountSite`: UTF-8 text or base64 bytes. */
export type SiteTreeFile = string | { b64: string };

/** Options for the stock-template render surface (engine `mountSite`). */
export interface StockSiteOptions {
  activeTables?: boolean;
  runUuid?: string;
  /** Merge into the mounted tree instead of replacing (overlay fast-path). */
  merge?: boolean;
}

export interface EngineOps {
  init: { args: [bundles: BundleSpec[]]; result: InitResult };
  mountBundles: { args: [bundles: BundleSpec[]]; result: MountResult };
  resolveProject: { args: [config: string, versionIndex?: VersionIndex]; result: ResolutionStep };
  expandValueSet: { args: [valueSetJson: string, resourcesJson: string]; result: ExpandResult };
  compile: {
    args: [config: string, files: Record<string, string>, predefined: Record<string, unknown>];
    result: CompileResult;
  };
  snapshot: { args: [url: string]; result: SnapshotResult };
  // M2 cycle-generator preview path (rows built in the worker, TS render there).
  buildSite: {
    args: [
      config: string,
      files: Record<string, string>,
      predefined: Record<string, unknown>,
      siteFiles: Record<string, string>,
      buildEpochSecs: number,
    ];
    result: SitePreviewResult;
  };
  renderPage: { args: [file: string]; result: RenderPageResult };
  assetBytes: { args: [name: string]; result: { name: string; mime: string; base64: string } | null };
  // F6 stock-template render surface (engine-side pages/fragments).
  mountSite: { args: [files: Record<string, SiteTreeFile>, options?: StockSiteOptions]; result: { mounted: number } };
  // Live template loader (#40): materialize a template `id#ver` chain from the
  // MOUNTED bundle packages (base-chain walk + union-copy, in Rust) and merge
  // its tree (includes/*→_includes/*) into the site tree. The host must have
  // fetched+mounted the whole base chain first (Rust decides which packages via
  // walk_base_chain; JS fetches them on the SAME resolve→fetch→mount path).
  mountTemplate: { args: [coord: string]; result: { files: number } };
  listSitePages: { args: []; result: { pages: string[] } };
  renderSitePage: { args: [name: string]; result: { html: string; renderMs: number } };
  renderFragment: { args: [ref: string, kind: string]; result: { html: string } };
  // ContentApi (TS-liquid sunset): the engine renders all content.
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
