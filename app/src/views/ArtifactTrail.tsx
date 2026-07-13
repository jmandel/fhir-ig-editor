import type { OutputDescriptor } from '../site/contract';
import type { ResourceView } from './resourceView';
import type { WorkspaceMode } from './ProjectOverview';

interface Props {
  resource: ResourceView | null;
  page: OutputDescriptor | null;
  currentMode: WorkspaceMode;
  activeSourcePath: string | null;
  selectedPagePath: string;
  onOpenSource: () => void;
  onOpenDefinition: () => void;
  onOpenPreview: () => void;
}

/** One selected FHIR artifact followed across its three concrete views. Missing
 * links stay explicit; the UI never invents source or page ownership. */
export function ArtifactTrail({
  resource,
  page,
  currentMode,
  activeSourcePath,
  selectedPagePath,
  onOpenSource,
  onOpenDefinition,
  onOpenPreview,
}: Props) {
  if (!resource) {
    return (
      <div className="artifact-trail artifact-trail-empty">
        Select a compiled definition to follow it from source to published page.
      </div>
    );
  }
  const identity = resource.resourceType && resource.id
    ? `${resource.resourceType}/${resource.id}`
    : resource.filename;
  return (
    <nav className="artifact-trail" aria-label={`Artifact trail for ${identity}`}>
      <span className="artifact-trail-subject" title={identity}>{identity}</span>
      <TrailStep
        label="Source"
        detail={resource.definition ? `${resource.definition.path}:${resource.definition.line}` : 'No declaration link'}
        disabled={!resource.definition}
        current={currentMode === 'author' && resource.definition?.path === activeSourcePath}
        onClick={onOpenSource}
      />
      <span className="artifact-trail-arrow" aria-hidden="true">→</span>
      <TrailStep
        label="Definition"
        detail="Compiled FHIR"
        current={currentMode === 'explore'}
        onClick={onOpenDefinition}
      />
      <span className="artifact-trail-arrow" aria-hidden="true">→</span>
      <TrailStep
        label="Published page"
        detail={page?.title ?? page?.path ?? 'Renderer did not declare one'}
        disabled={!page}
        current={currentMode === 'preview' && page?.path === selectedPagePath}
        onClick={onOpenPreview}
      />
    </nav>
  );
}

function TrailStep({
  label,
  detail,
  disabled = false,
  current = false,
  onClick,
}: {
  label: string;
  detail: string;
  disabled?: boolean;
  current?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="artifact-trail-step"
      disabled={disabled}
      aria-current={current ? 'step' : undefined}
      onClick={onClick}
    >
      <strong>{label}</strong>
      <span title={detail}>{detail}</span>
    </button>
  );
}
