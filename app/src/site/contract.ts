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

export interface ProjectInput {
  projectId: string;
  config: string;
  files: Record<string, string>;
  predefined: Record<string, unknown>;
  /** Exact authored site bytes accepted by Rust compileProject. Source binary
   * transport remains private to prepare; output bytes never use this shape. */
  siteFiles: Record<string, string>;
  buildEpochSecs: number;
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

/** `compiled` is presentation metadata produced by the same prepare call. */
export interface PrepareResult {
  handle: BuildHandle;
  buildId: string;
  generator: GeneratorSpec['generator'];
  compiled: CompileResult;
}

export type OutputKind = 'page' | 'asset' | 'auxiliary';

export interface OutputDescriptor {
  path: string;
  kind: OutputKind;
  mediaType: string;
  content?: ContentRef;
  title?: string;
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
