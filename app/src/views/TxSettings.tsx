// Tier-2 terminology settings UI (spec §6 tier 2): configure a `$expand`
// endpoint. Default is none. A small inline popover, opened from the topbar.

import { useState } from 'react';
import { getTxEndpoint, setTxEndpoint } from '../vfs/txSettings';

export function TxSettings({ onChange }: { onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(getTxEndpoint());
  const current = getTxEndpoint();

  const save = () => {
    setTxEndpoint(value);
    onChange();
    setOpen(false);
  };

  return (
    <div className="tx-settings">
      <button
        className="btn"
        onClick={() => { setValue(getTxEndpoint()); setOpen((o) => !o); }}
        title="Terminology server settings"
      >
        ⚙ Terminology{current ? ' ●' : ''}
      </button>
      {open && (
        <div className="tx-settings-pop">
          <div className="tx-settings-title">Terminology server ($expand endpoint)</div>
          <p className="tx-settings-help">
            For ValueSets whose compose can't be expanded in-engine (external
            code systems like SNOMED), the editor can call a live{' '}
            <code>$expand</code>. Leave blank for none — un-expandable ValueSets
            then show a precise "needs terminology server" state, never a partial
            expansion. A hosted server such as <code>https://tx.fhir.org/r4</code>{' '}
            is the realistic choice (needs CORS, or a pass-through proxy).
          </p>
          <input
            className="tx-settings-input"
            type="url"
            placeholder="https://tx.fhir.org/r4"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
          />
          <div className="tx-settings-actions">
            <button className="btn btn-primary" onClick={save}>Save</button>
            <button className="btn" onClick={() => { setValue(''); }}>Clear</button>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {current && <div className="tx-settings-current">Current: <code>{current}</code></div>}
        </div>
      )}
    </div>
  );
}
