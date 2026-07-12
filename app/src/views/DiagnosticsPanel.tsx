// Problems panel: exact source navigation plus fail-closed artifact consequences.

import type { OutputDescriptor } from '../site/contract';
import type { CompiledResource, Diagnostic } from '../worker/protocol';
import { primaryPageForResource, resourceForDefinition } from './artifactSelection';

interface Props {
  diagnostics: Diagnostic[];
  resources: CompiledResource[];
  pages: OutputDescriptor[] | null;
  publishedLabel: 'Published page' | 'Previous published page';
  onNavigate: (file: string, line: number, owner: CompiledResource | null) => void;
  onOpenDefinition: (resource: CompiledResource) => void;
  onOpenPreview: (page: OutputDescriptor, resource: CompiledResource) => void;
}

const icon: Record<Diagnostic['severity'], string> = {
  error: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

export function DiagnosticsPanel({
  diagnostics,
  resources,
  pages,
  publishedLabel,
  onNavigate,
  onOpenDefinition,
  onOpenPreview,
}: Props) {
  if (diagnostics.length === 0) {
    return <div className="panel-empty">No problems — compile is clean.</div>;
  }
  return (
    <div className="diagnostics">
      {diagnostics.map((diagnostic, index) => {
        const owner = resourceForDefinition(resources, diagnostic.ownerDefinition);
        const page = primaryPageForResource(pages, owner);
        const body = (
          <>
            <span className="diag-icon" aria-hidden="true">{icon[diagnostic.severity]}</span>
            <span className="diag-msg">{diagnostic.message}</span>
            {diagnostic.file ? (
              <span className="diag-loc">
                {diagnostic.file}
                {diagnostic.line ? `:${diagnostic.line}` : ''}
              </span>
            ) : null}
          </>
        );
        return (
          <div key={index} className={`diag diag-${diagnostic.severity}`}>
            {diagnostic.file ? (
              <button
                type="button"
                className="diag-source"
                onClick={() => onNavigate(diagnostic.file!, diagnostic.line ?? 1, owner)}
              >
                {body}
              </button>
            ) : <div className="diag-source">{body}</div>}
            {owner || page ? (
              <span className="diag-actions">
                {owner ? (
                  <button
                    type="button"
                    aria-label={`Open definition ${owner.resourceType}/${owner.id} for: ${diagnostic.message}`}
                    onClick={() => onOpenDefinition(owner)}
                  >
                    Definition
                  </button>
                ) : null}
                {page && owner ? (
                  <button
                    type="button"
                    aria-label={`${publishedLabel}: ${page.title ?? page.path} for ${owner.resourceType}/${owner.id}`}
                    onClick={() => onOpenPreview(page, owner)}
                  >
                    {publishedLabel}
                  </button>
                ) : null}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
