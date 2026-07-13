/** The public site-generation contract used by UI and preview hosts.
 * Worker/package/renderer transport types stay in contract.generated.ts and
 * are not re-exported through this functional Build facade. */

import type {
  CompilationOutcome,
  ContentRef,
  OutputCatalog,
  SiteOutput,
} from './contract.generated';

export type {
  BuildError,
  BuildEvent,
  CompilationDefinition,
  CompilationOutcome,
  CompilationResource,
  ContentRef,
  GeneratorSpec,
  OutputCatalog,
  OutputDescriptor,
  OutputResourceSubject,
  ProjectRevision,
  SiteOutput,
} from './contract.generated';

/** Immutable host facade over one retained SiteBuild. Lifecycle addressing is
 * private to the host; persisted authority remains ClosedSiteBuild +
 * ContentStore. */
export interface Build {
  readonly compilation: CompilationOutcome;
  outputs(): Promise<OutputCatalog>;
  render(path: string): Promise<ContentRef>;
  finalize(): Promise<SiteOutput>;
}
