/** The complete public site-generation contract shared by the UI, worker, and
 * preview host. These are scoped operation views over PreparedGuide/SiteBuild/
 * SiteOutput, not additional stored domain values. */

import type { CompileResult } from '../worker/protocol';

export type BuildHandle = string;

export interface ContentRef {
  sha256: string;
  byteLength: number;
  mediaType?: string;
}

export interface ProjectRevision {
  readonly projectId: string;
  readonly config: string;
  readonly files: Readonly<Record<string, string>>;
  readonly predefined: Readonly<Record<string, unknown>>;
  /** Exact authored site bytes accepted by Rust compileProject. Source binary
   * transport remains private to prepare; output bytes never use this shape. */
  readonly siteFiles: Readonly<Record<string, string>>;
  readonly buildEpochSecs: number;
}

export type GeneratorSpec =
  | {
      generator: 'cycle';
      liquidAssetDirs?: string[];
      branch?: string;
      revision?: string;
    }
  | {
      generator: 'publisher';
      templateCoordinate: string;
      activeTables?: boolean;
      runUuid?: string;
    };

/** Rust-internal phases of the existing prepare operation. This is diagnostic
 * metadata only: it does not participate in SiteBuild identity or caching. */
export interface RustPrepareMetrics {
  totalMs: number;
  projectRevisionMs: number;
  packageLockMs: number;
  preparedGuideKeyMs: number;
  preparedGuideMs: number;
  snapshotCompletedLocalCacheHit: boolean;
  preparedGuideCacheHit: boolean;
  siteBuildCacheHit: boolean;
  templateMaterializeMs: number;
  publisherRuntimeMs: number;
  publisherModelMs: number;
  renderModelMs: number;
  catalogMs: number;
}

/** Measurements across the worker's one prepare request. `rustPrepareMs`
 * includes the envelope boundary around the detailed Rust phases;
 * `hostPrepareMs` is target-specific worker work after Rust returns. */
export interface PrepareMetrics {
  compileProjectMs: number;
  rustPrepareMs: number;
  hostPrepareMs: number;
  rust: RustPrepareMetrics;
}

/** `compiled` and `metrics` are presentation metadata produced by the same
 * prepare call, not additional domain handoffs. */
export interface PrepareResult {
  handle: BuildHandle;
  buildId: string;
  generator: GeneratorSpec['generator'];
  compiled: CompileResult;
  metrics: PrepareMetrics;
}

export type OutputKind = 'page' | 'asset' | 'auxiliary';

export interface ResourceSubject {
  resourceType: string;
  id: string;
}

export interface OutputDescriptor {
  path: string;
  kind: OutputKind;
  mediaType: string;
  content?: ContentRef;
  title?: string;
  /** Exact resource represented by a renderer-declared resource page. */
  subject?: ResourceSubject;
  subjectPage?: 'primary' | 'companion';
  pageKind?:
    | 'narrative'
    | 'artifacts'
    | 'profile'
    | 'profile-companion'
    | 'valueset'
    | 'codesystem'
    | 'example'
    | 'toc'
    | 'validation'
    | 'generic';
}

export interface OutputCatalog {
  buildId: string;
  outputs: OutputDescriptor[];
}

export interface RenderedOutput {
  path: string;
  mediaType: string;
  content: ContentRef;
  nonReadyFragments?: number;
}

export interface OutputProducer {
  id: string;
  version: string;
}

export interface RendererImplementation extends OutputProducer {
  recipeSha256: string;
}

export interface SiteOutputFile {
  path: string;
  content: ContentRef;
  producer: OutputProducer;
  source?: string;
  owner?: string;
}

/** Canonical Rust `site-output/v1`; the editor never recomputes its identities. */
export interface SiteOutput {
  schemaVersion: 'site-output/v1';
  inputBuildId: string;
  renderer: RendererImplementation;
  outputSchema: string;
  options: Record<string, string>;
  cacheKey: string;
  files: SiteOutputFile[];
  outputId: string;
}
