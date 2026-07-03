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

export type WorkerRequest =
  | { id: number; type: 'init'; bundles: BundleSpec[] }
  | {
      id: number;
      type: 'compile';
      config: string;
      files: Record<string, string>;
      predefined: Record<string, unknown>;
    }
  | { id: number; type: 'snapshot'; url: string }
  | {
      id: number;
      type: 'buildSite';
      config: string;
      files: Record<string, string>;
      predefined: Record<string, unknown>;
      siteFiles: Record<string, string>;
      buildEpochSecs: number;
    }
  | { id: number; type: 'renderPage'; file: string }
  | { id: number; type: 'assetBytes'; name: string };

/** A package bundle to mount: a label + its inflated `{name: base64}` files. */
export interface BundleSpec {
  label: string;
  files: Record<string, string>;
}

// ---- reply messages (worker -> UI) ----------------------------------------

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
