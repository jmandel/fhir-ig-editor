// Package-acquisition settings UI (task #32 step 4c/4d): configure the FHIR
// package registries + an optional CORS proxy, and drop local `.tgz` packages for
// air-gapped / blocked networks. A small inline popover, opened from the topbar.

import { useRef, useState } from 'react';
import {
  DEFAULT_REGISTRIES,
  getPackageProxy,
  getRegistries,
  setPackageProxy,
  setRegistries,
} from '../vfs/packageSettings';

export function PackageSettings({
  onChange,
  onDropTgz,
}: {
  onChange: () => void;
  /** Called with each dropped/selected `.tgz`'s bytes; returns its label. */
  onDropTgz: (bytes: ArrayBuffer) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [registries, setReg] = useState(getRegistries().join('\n'));
  const [proxy, setProxy] = useState(getPackageProxy());
  const [dropped, setDropped] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const active = getPackageProxy() || getRegistries().join(',') !== DEFAULT_REGISTRIES.join(',');

  const save = () => {
    setRegistries(registries.split(/[\n,]+/));
    setPackageProxy(proxy);
    onChange();
    setOpen(false);
  };

  const ingest = async (files: FileList | null) => {
    if (!files) return;
    setErr(null);
    for (const f of Array.from(files)) {
      try {
        const label = await onDropTgz(await f.arrayBuffer());
        setDropped((d) => (d.includes(label) ? d : [...d, label]));
      } catch (e) {
        setErr(`${f.name}: ${String(e)}`);
      }
    }
  };

  return (
    <div
      className="tx-settings"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        void ingest(e.dataTransfer.files);
        if (!open) setOpen(true);
      }}
    >
      <button
        className="btn"
        onClick={() => {
          setReg(getRegistries().join('\n'));
          setProxy(getPackageProxy());
          setOpen((o) => !o);
        }}
        title="Package sources (registry / proxy / local .tgz)"
      >
        ⚙ Packages{active ? ' ●' : ''}
      </button>
      {open && (
        <div className="tx-settings-pop">
          <div className="tx-settings-title">FHIR package sources</div>
          <p className="tx-settings-help">
            Missing packages an IG needs are fetched from the prebuilt bundles,
            then the registries below (both send <code>Access-Control-Allow-Origin: *</code>,
            so no proxy is needed in most browsers). For locked-down networks, set a
            pass-through proxy; for air-gapped use, <strong>drop package <code>.tgz</code>
            files here</strong> and they win over the network.
          </p>

          <label className="tx-settings-title">Registries (one per line, in try order)</label>
          <textarea
            className="tx-settings-input"
            rows={2}
            value={registries}
            onChange={(e) => setReg(e.target.value)}
            spellCheck={false}
          />

          <label className="tx-settings-title">Proxy URL (optional)</label>
          <input
            className="tx-settings-input"
            type="url"
            placeholder="https://my-cors-proxy.example (wraps as ?url=<tarball>)"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            spellCheck={false}
          />

          <div className="tx-settings-title" style={{ marginTop: 8 }}>
            Local packages (drag .tgz here or browse)
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".tgz,application/gzip,application/tar+gzip"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void ingest(e.target.files)}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Add .tgz…
          </button>
          {dropped.length > 0 && (
            <ul className="tx-settings-current">
              {dropped.map((l) => (
                <li key={l}>
                  <code>{l}</code>
                </li>
              ))}
            </ul>
          )}
          {err && <div className="tx-settings-current" style={{ color: '#c0392b' }}>{err}</div>}

          <div className="tx-settings-actions">
            <button className="btn btn-primary" onClick={save}>
              Save
            </button>
            <button
              className="btn"
              onClick={() => {
                setReg(DEFAULT_REGISTRIES.join('\n'));
                setProxy('');
              }}
            >
              Reset
            </button>
            <button className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
