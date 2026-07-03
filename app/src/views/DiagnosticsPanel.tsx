// Problems panel: the compile's diagnostics, click-to-navigate (file+line).

import type { Diagnostic } from '../worker/protocol';

interface Props {
  diagnostics: Diagnostic[];
  onNavigate: (file: string, line: number) => void;
}

const icon: Record<Diagnostic['severity'], string> = {
  error: '⛔',
  warning: '⚠',
  info: 'ℹ',
};

export function DiagnosticsPanel({ diagnostics, onNavigate }: Props) {
  if (diagnostics.length === 0) {
    return <div className="panel-empty">No problems — compile is clean.</div>;
  }
  return (
    <div className="diagnostics">
      {diagnostics.map((d, i) => (
        <div
          key={i}
          className={`diag diag-${d.severity}${d.file ? ' navigable' : ''}`}
          onClick={() => d.file && onNavigate(d.file, d.line ?? 1)}
        >
          <span className="diag-icon">{icon[d.severity]}</span>
          <span className="diag-msg">{d.message}</span>
          {d.file ? (
            <span className="diag-loc">
              {d.file}
              {d.line ? `:${d.line}` : ''}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
