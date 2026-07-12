// Per-stage build timings + engine identity (spec §7: build timings; §9 M0 gate:
// engine version + build time shown).

import type { EngineVersion } from '../worker/protocol';

interface Props {
  version: EngineVersion | null;
  initMs: number | null;
  buildMs: number | null;
  resourceCount: number | null;
  fileCount: number | null;
  compiling: boolean;
}

export function BuildStatus({
  version,
  initMs,
  buildMs,
  resourceCount,
  fileCount,
  compiling,
}: Props) {
  return (
    <div className="build-status">
      <div className="bs-group">
        <span className="bs-label">engine</span>
        <span className="bs-val" title={version?.engine}>
          {version ? `${version.engine} @ ${version.commit}` : '—'}
        </span>
      </div>
      <div className="bs-group">
        <span className="bs-label">mount</span>
        <span className="bs-val">{initMs != null ? `${initMs.toFixed(0)} ms` : '—'}</span>
      </div>
      <div className="bs-group">
        <span className="bs-label">compile</span>
        <span className={`bs-val${compiling ? ' pulse' : ''}`}>
          {compiling ? 'preparing…' : buildMs != null ? `${buildMs.toFixed(0)} ms` : '—'}
        </span>
      </div>
      <div className="bs-group">
        <span className="bs-label">resources</span>
        <span className="bs-val">
          {resourceCount != null ? resourceCount : '—'}
          {fileCount != null ? ` from ${fileCount} FSH` : ''}
        </span>
      </div>
    </div>
  );
}
