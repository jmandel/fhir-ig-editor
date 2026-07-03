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
  | { id: number; type: 'snapshot'; url: string };

/** A package bundle to mount: a label + its inflated `{name: base64}` files. */
export interface BundleSpec {
  label: string;
  files: Record<string, string>;
}

// ---- reply messages (worker -> UI) ----------------------------------------

export type WorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
