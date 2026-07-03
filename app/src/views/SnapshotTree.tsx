// Snapshot element tree (spec §7, M1 — "the walk engine's output"). Generated
// on-demand by the worker's generate_snapshot(url), rendered as an indented tree
// with cardinality / type / flags. This is the headline M1 view: the full
// resolved element set, not just the author's differential.

import { useEffect, useState } from 'react';
import type { EngineClient } from '../worker/client';
import {
  cardinality,
  depthOf,
  flags,
  isStructureDefinition,
  tailOf,
  typeDisplay,
  type StructureDefinition,
} from './elements';

interface Props {
  engine: EngineClient;
  url: string;
  id: string;
}

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; sd: StructureDefinition; ms: number }
  | { status: 'error'; messages: string[] };

export function SnapshotTree({ engine, url, id }: Props) {
  const [state, setState] = useState<State>({ status: 'idle' });

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    engine
      .snapshot(url)
      .then((res) => {
        if (!live) return;
        if (res.snapshot && isStructureDefinition(res.snapshot)) {
          setState({ status: 'ready', sd: res.snapshot, ms: res.snapshotMs });
        } else {
          setState({ status: 'error', messages: res.messages.length ? res.messages : ['no snapshot produced'] });
        }
      })
      .catch((e) => live && setState({ status: 'error', messages: [String(e)] }));
    return () => {
      live = false;
    };
  }, [engine, url, id]);

  if (state.status === 'loading' || state.status === 'idle') {
    return <div className="panel-empty">Generating snapshot…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="panel-error">
        Snapshot failed:
        <ul>
          {state.messages.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }

  const elements = state.sd.snapshot?.element ?? [];
  return (
    <div className="snapshot">
      <div className="snapshot-meta">
        {elements.length} elements · generated in {state.ms.toFixed(0)} ms (walk engine)
      </div>
      <div className="table-scroll">
        <table className="sd-table">
          <thead>
            <tr>
              <th>Element</th>
              <th>Card</th>
              <th>Type</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {elements.map((e, i) => {
              const d = depthOf(e.path);
              return (
                <tr key={i} className={e.mustSupport ? 'ms-row' : ''}>
                  <td className="mono" style={{ paddingLeft: 8 + d * 16 }}>
                    <span className="el-name">{tailOf(e.path)}</span>
                    {e.sliceName ? <span className="el-slice">:{e.sliceName}</span> : null}
                  </td>
                  <td className="mono">{cardinality(e)}</td>
                  <td className="mono">{typeDisplay(e)}</td>
                  <td className="mono">{flags(e)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
