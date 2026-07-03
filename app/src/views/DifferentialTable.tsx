// Differential table (spec §7, M1): the constraints the profile author wrote,
// straight from the SD's `differential.element`.

import { cardinality, flags, typeDisplay, type StructureDefinition } from './elements';

export function DifferentialTable({ sd }: { sd: StructureDefinition }) {
  const elements = sd.differential?.element ?? [];
  if (elements.length === 0) {
    return <div className="panel-empty">No differential elements.</div>;
  }
  return (
    <div className="table-scroll">
      <table className="sd-table">
        <thead>
          <tr>
            <th>Path</th>
            <th>Card</th>
            <th>Type</th>
            <th>Flags</th>
            <th>Short</th>
          </tr>
        </thead>
        <tbody>
          {elements.map((e, i) => (
            <tr key={i}>
              <td className="mono">{e.id ?? e.path}</td>
              <td className="mono">{cardinality(e)}</td>
              <td className="mono">{typeDisplay(e)}</td>
              <td className="mono">{flags(e)}</td>
              <td>{e.short ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
