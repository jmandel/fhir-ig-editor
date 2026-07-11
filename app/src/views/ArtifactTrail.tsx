import type { OutputDescriptor } from '../site/contract';
import type { CompiledResource } from '../worker/protocol';

interface Props {
  resource: CompiledResource | null;
  page: OutputDescriptor | null;
  onOpenSource: () => void;
  onOpenDefinition: () => void;
  onOpenPreview: () => void;
}

/** One selected FHIR artifact followed across its three concrete views. Missing
 * links stay explicit; the UI never invents source or page ownership. */
export function ArtifactTrail({ resource, page, onOpenSource, onOpenDefinition, onOpenPreview }: Props) {
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
        onClick={onOpenSource}
      />
      <span className="artifact-trail-arrow" aria-hidden="true">→</span>
      <TrailStep label="Definition" detail="Compiled FHIR" onClick={onOpenDefinition} />
      <span className="artifact-trail-arrow" aria-hidden="true">→</span>
      <TrailStep
        label="Published page"
        detail={page?.title ?? page?.path ?? 'Renderer did not declare one'}
        disabled={!page}
        onClick={onOpenPreview}
      />
    </nav>
  );
}

function TrailStep({
  label,
  detail,
  disabled = false,
  onClick,
}: {
  label: string;
  detail: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button className="artifact-trail-step" disabled={disabled} onClick={onClick}>
      <strong>{label}</strong>
      <span title={detail}>{detail}</span>
    </button>
  );
}
