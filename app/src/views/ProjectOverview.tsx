import { useMemo } from 'react';
import type { CompiledResource, Diagnostic } from '../worker/protocol';
import type { OutputDescriptor } from '../site/contract';

export type WorkspaceMode = 'author' | 'explore' | 'preview';
export type BuildState = 'checking' | 'building' | 'ready' | 'stale' | 'rebuilding' | 'failed' | 'failed-preview';

export function deriveBuildState(input: {
  previewStale: boolean;
  compiling: boolean;
  siteBuilding: boolean;
  hasPublishedPreview: boolean;
  hasError: boolean;
}): BuildState {
  const busy = input.compiling || input.siteBuilding;
  if (busy) return input.hasPublishedPreview ? 'rebuilding' : 'building';
  if (input.hasError) return input.hasPublishedPreview ? 'failed-preview' : 'failed';
  if (input.previewStale && input.hasPublishedPreview) return 'stale';
  return input.hasPublishedPreview ? 'ready' : 'checking';
}

interface Props {
  projectId: string;
  projectName: string;
  paths: string[];
  resources: CompiledResource[];
  pages: OutputDescriptor[] | null;
  diagnostics: Diagnostic[];
  buildState: BuildState;
  onOpenMode: (mode: WorkspaceMode) => void;
}

export function ProjectOverview({
  projectId,
  projectName,
  paths,
  resources,
  pages,
  diagnostics,
  buildState,
  onOpenMode,
}: Props) {
  const summary = useMemo(
    () => summarizeProject(paths, resources, pages, diagnostics),
    [paths, resources, pages, diagnostics],
  );
  return (
    <section className="project-overview" aria-labelledby="project-overview-title">
      <div className="overview-lead">
        <div>
          <div className="overview-eyebrow">FHIR implementation guide</div>
          <h1 id="project-overview-title">{projectName}</h1>
          <div className="overview-identity">
            <code>{projectId}</code>
            {summary.fhirVersion && <span>FHIR {summary.fhirVersion}</span>}
          </div>
        </div>
        <BuildStateBadge state={buildState} />
      </div>
      <div className="overview-stats" aria-label="Project summary">
        <Stat value={summary.files} label="source files" />
        <Stat value={summary.profiles} label="profiles" />
        <Stat value={summary.extensions} label="extensions" />
        <Stat value={summary.valueSets} label="value sets" />
        <Stat value={summary.examples} label="examples" />
        <Stat value={summary.pages} label="site pages" pending={pages == null} />
      </div>
      <div className="overview-actions">
        <button className="btn btn-primary" onClick={() => onOpenMode('author')}>Edit source</button>
        <button className="btn" onClick={() => onOpenMode('explore')}>Explore definitions</button>
        <button className="btn" disabled={!pages?.length} onClick={() => onOpenMode('preview')}>
          {pages?.length
            ? ['stale', 'rebuilding', 'failed-preview'].includes(buildState)
              ? 'Open previous preview'
              : 'Open verified preview'
            : 'Preview is building…'}
        </button>
        <span className={summary.errors ? 'overview-problems has-errors' : 'overview-problems'}>
          {summary.errors
            ? `${summary.errors} error${summary.errors === 1 ? '' : 's'}`
            : summary.warnings
              ? `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`
              : 'No reported problems'}
        </span>
      </div>
    </section>
  );
}

export function BuildStateBadge({ state }: { state: BuildState }) {
  const labels: Record<BuildState, string> = {
    checking: 'Checking',
    building: 'Building preview',
    ready: 'Ready',
    stale: 'Preview out of date',
    rebuilding: 'Rebuilding — showing previous preview',
    failed: 'Build failed',
    'failed-preview': 'Rebuild failed — showing previous preview',
  };
  return <span className={`project-state state-${state}`} role="status">{labels[state]}</span>;
}

function Stat({ value, label, pending = false }: { value: number; label: string; pending?: boolean }) {
  return (
    <div className="overview-stat">
      <strong>{pending ? '…' : value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function summarizeProject(
  paths: string[],
  resources: CompiledResource[],
  pages: OutputDescriptor[] | null,
  diagnostics: Diagnostic[],
) {
  let profiles = 0;
  let extensions = 0;
  let valueSets = 0;
  let fhirVersion: string | null = null;
  for (const resource of resources) {
    if (resource.resourceType === 'ValueSet') valueSets++;
    if (resource.resourceType === 'ImplementationGuide' && !fhirVersion) {
      try {
        const value = (JSON.parse(resource.text) as { fhirVersion?: unknown }).fhirVersion;
        fhirVersion = Array.isArray(value)
          ? (typeof value[0] === 'string' ? value[0] : null)
          : (typeof value === 'string' ? value : null);
      } catch { /* diagnostic owns malformed input */ }
    }
    if (resource.resourceType !== 'StructureDefinition') continue;
    let type = '';
    try { type = String((JSON.parse(resource.text) as { type?: unknown }).type ?? ''); } catch { /* diagnostic owns malformed input */ }
    if (type === 'Extension') extensions++;
    else profiles++;
  }
  return {
    fhirVersion,
    files: paths.length,
    profiles,
    extensions,
    valueSets,
    examples: pages?.filter((page) => page.pageKind === 'example').length ?? 0,
    pages: pages?.length ?? 0,
    errors: diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length,
    warnings: diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length,
  };
}
