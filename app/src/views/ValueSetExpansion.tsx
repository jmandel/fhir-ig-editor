// ValueSet expansion tab (spec §6). For the selected ValueSet:
//   • Tier 1 — run `expand_enumerable` LIVE in the engine (recompute on every
//     compile, since expansion is a pure function of IG content). Render the
//     contains[] table + the used-codesystem versions.
//   • On NotEnumerable — show the PRECISE "needs terminology server" state,
//     including the refusal verbatim (which include, why).
//   • Tier 2 — if a tx endpoint is configured, offer "Expand via server":
//     POST $expand, cache in OPFS by content hash (VS + referenced local
//     resources + server identity), and show the cached result with its
//     used-codesystem pins + a refresh action. Honest states throughout:
//     no endpoint / fetching / cached@version / error.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineClient } from '../worker/client';
import type { CompiledResource, ExpandResult, ExpansionConcept, NotEnumerable, UsedCodeSystem } from '../worker/protocol';
import { getTxEndpoint, txServerIdentity } from '../vfs/txSettings';
import { cacheKey, readTxCache, writeTxCache, deleteTxCache, type TxCacheEntry } from '../vfs/txCache';
import { txExpand } from '../vfs/txClient';

/** All the systems a compose's includes/excludes name — used to gather the
 *  IG-local resources to hand tier-1 (resolver) + tier-2 (tx-resource). */
function referencedSystems(vs: unknown): { systems: Set<string>; valueSets: Set<string> } {
  const systems = new Set<string>();
  const valueSets = new Set<string>();
  const compose = (vs as { compose?: { include?: unknown[]; exclude?: unknown[] } })?.compose;
  for (const side of [compose?.include, compose?.exclude]) {
    if (!Array.isArray(side)) continue;
    for (const comp of side) {
      const c = comp as { system?: string; valueSet?: string[] };
      if (c.system) systems.add(c.system.split('|')[0]);
      for (const v of c.valueSet ?? []) valueSets.add(v.split('|')[0]);
    }
  }
  return { systems, valueSets };
}

/** From all compiled resources, gather the CodeSystem/ValueSet bodies the compose
 *  references (by url), which both tiers need as local content. */
function gatherReferenced(vs: unknown, all: CompiledResource[]): unknown[] {
  const { systems, valueSets } = referencedSystems(vs);
  const out: unknown[] = [];
  for (const r of all) {
    if (!r.url) continue;
    const base = r.url.split('|')[0];
    if (r.resourceType === 'CodeSystem' && systems.has(base)) {
      try { out.push(JSON.parse(r.text)); } catch { /* skip */ }
    } else if (r.resourceType === 'ValueSet' && valueSets.has(base)) {
      try { out.push(JSON.parse(r.text)); } catch { /* skip */ }
    }
  }
  return out;
}

function ContainsTable({ contains }: { contains: ExpansionConcept[] }) {
  return (
    <table className="vs-contains">
      <thead>
        <tr><th>System</th><th>Code</th><th>Display</th></tr>
      </thead>
      <tbody>
        {contains.map((c, i) => (
          <tr key={`${c.system}|${c.code}|${i}`} className={c.inactive ? 'inactive' : undefined}>
            <td className="vs-sys" title={c.system}>{shortSystem(c.system)}</td>
            <td className="vs-code">{c.code}{c.inactive && <span className="vs-inactive-badge">inactive</span>}</td>
            <td className="vs-display">{c.display ?? <span className="muted">—</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function shortSystem(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function UsedSystems({ used }: { used: UsedCodeSystem[] }) {
  if (used.length === 0) return null;
  return (
    <div className="vs-used">
      <div className="vs-used-title">Code system versions</div>
      <ul>
        {used.map((u) => (
          <li key={u.system}>
            <code>{shortSystem(u.system)}</code>
            {u.version ? <span className="vs-ver"> │ {u.version}</span> : <span className="muted"> │ (unversioned)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The precise "needs terminology server" state — the refusal shown verbatim. */
function RefusalState({
  refusal,
  vs,
  referenced,
  onExpanded,
}: {
  refusal: NotEnumerable;
  vs: unknown;
  referenced: unknown[];
  onExpanded: (e: TxCacheEntry) => void;
}) {
  const endpoint = getTxEndpoint();
  const [state, setState] = useState<'idle' | 'fetching' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const runServer = useCallback(async () => {
    if (!endpoint) return;
    setState('fetching');
    setError(null);
    const res = await txExpand(endpoint, vs, referenced);
    if (!res.ok) {
      setState('error');
      setError(res.error);
      return;
    }
    const hash = await cacheKey(vs, referenced, txServerIdentity());
    const entry: TxCacheEntry = {
      hash,
      valueSet: (vs as { url?: string }).url ?? '(anonymous)',
      server: endpoint,
      fetchedAt: new Date().toISOString(),
      expansion: res.expansion,
      usedCodeSystems: res.usedCodeSystems,
    };
    await writeTxCache(entry);
    setState('idle');
    onExpanded(entry);
  }, [endpoint, vs, referenced, onExpanded]);

  return (
    <div className="vs-refusal">
      <div className="vs-refusal-head">
        <span className="vs-refusal-badge">Needs terminology server</span>
        <span className="vs-refusal-kind">{refusal.kind}</span>
      </div>
      {/* The refusal string, VERBATIM (spec §6: which include, why). */}
      <pre className="vs-refusal-reason">{refusal.display}</pre>
      <div className="vs-refusal-detail">
        This ValueSet cannot be expanded in-engine: it draws on external code-system
        content the editor does not hold. Tier-1 refuses rather than return a
        silently partial expansion.
      </div>
      {endpoint ? (
        <div className="vs-tx-action">
          <button className="btn btn-primary" disabled={state === 'fetching'} onClick={runServer}>
            {state === 'fetching' ? 'Expanding via server…' : 'Expand via server'}
          </button>
          <span className="vs-tx-endpoint">via {endpoint}</span>
          {state === 'error' && <div className="vs-tx-error">Server error: {error}</div>}
        </div>
      ) : (
        <div className="vs-tx-noendpoint">
          No terminology server configured. Set one in Settings to expand this
          ValueSet against a live <code>$expand</code>.
        </div>
      )}
    </div>
  );
}

/** A cached tier-2 result view (shown with its pins + a refresh action). */
function CachedServerExpansion({
  entry,
  vs,
  referenced,
  onRefreshed,
  onCleared,
}: {
  entry: TxCacheEntry;
  vs: unknown;
  referenced: unknown[];
  onRefreshed: (e: TxCacheEntry) => void;
  onCleared: () => void;
}) {
  const endpoint = getTxEndpoint();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expansion = entry.expansion as { contains?: ExpansionConcept[]; total?: number };
  const contains = expansion.contains ?? [];

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    setBusy(true);
    setError(null);
    const res = await txExpand(endpoint, vs, referenced);
    if (!res.ok) {
      setError(res.error);
      setBusy(false);
      return;
    }
    const hash = await cacheKey(vs, referenced, txServerIdentity());
    const next: TxCacheEntry = { ...entry, hash, server: endpoint, fetchedAt: new Date().toISOString(), expansion: res.expansion, usedCodeSystems: res.usedCodeSystems };
    await writeTxCache(next);
    setBusy(false);
    onRefreshed(next);
  }, [endpoint, vs, referenced, entry, onRefreshed]);

  return (
    <div className="vs-cached">
      <div className="vs-cached-head">
        <span className="vs-cached-badge">Server expansion (cached)</span>
        <span className="vs-cached-meta">
          {contains.length} codes · from {shortSystem(entry.server)} · {new Date(entry.fetchedAt).toLocaleString()}
        </span>
        <span className="vs-cached-actions">
          <button className="btn" disabled={busy} onClick={refresh}>{busy ? 'Refreshing…' : 'Refresh'}</button>
          <button className="btn" disabled={busy} onClick={async () => { await deleteTxCache(entry.hash); onCleared(); }}>Clear</button>
        </span>
      </div>
      {error && <div className="vs-tx-error">Refresh failed: {error}</div>}
      <UsedSystems used={entry.usedCodeSystems} />
      <ContainsTable contains={contains} />
    </div>
  );
}

export function ValueSetExpansion({
  resource,
  allResources,
  engine,
  settingsVersion,
}: {
  resource: CompiledResource;
  allResources: CompiledResource[];
  engine: EngineClient;
  /** Bumped when tx settings change, to re-evaluate the endpoint-gated UI. */
  settingsVersion: number;
}) {
  const vs = useMemo(() => {
    try { return JSON.parse(resource.text); } catch { return null; }
  }, [resource.text]);

  const referenced = useMemo(
    () => (vs ? gatherReferenced(vs, allResources) : []),
    [vs, allResources],
  );

  const [tier1, setTier1] = useState<ExpandResult | null>(null);
  const [cached, setCached] = useState<TxCacheEntry | null>(null);
  const [loading, setLoading] = useState(true);
  // A genuine engine/worker failure (wasm not loaded, postMessage rejection) — a
  // DISTINCT state from a NotEnumerable refusal, so we never mislabel an engine
  // error as "needs terminology server" (which would offer a bogus tx action).
  const [engineError, setEngineError] = useState<string | null>(null);

  // Tier-1 live expansion: recompute whenever the VS text or referenced local
  // resources change (pure function of IG content — spec §6 tier 1).
  useEffect(() => {
    let cancelled = false;
    if (!vs) { setTier1(null); setLoading(false); return; }
    setLoading(true);
    setEngineError(null);
    engine
      .expandValueSet(resource.text, JSON.stringify(referenced))
      .then((r) => { if (!cancelled) { setTier1(r); setLoading(false); } })
      .catch((e) => { if (!cancelled) { setTier1(null); setEngineError(String(e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [engine, resource.text, referenced, vs]);

  // Load any cached tier-2 server expansion for the current content+server.
  useEffect(() => {
    let cancelled = false;
    if (!vs) return;
    (async () => {
      const hash = await cacheKey(vs, referenced, txServerIdentity());
      const hit = await readTxCache(hash);
      if (!cancelled) setCached(hit);
    })();
    return () => { cancelled = true; };
  }, [vs, referenced, settingsVersion]);

  if (!vs || vs.resourceType !== 'ValueSet') {
    return <div className="panel-empty">Not a ValueSet.</div>;
  }

  return (
    <div className="vs-expansion">
      <div className="vs-title">
        <span className="vs-title-name">{vs.name ?? vs.id ?? vs.url}</span>
        {vs.experimental && <span className="vs-exp-badge">experimental</span>}
      </div>

      {loading && <div className="vs-loading">Expanding…</div>}

      {!loading && engineError && (
        <div className="vs-engine-error">
          <div className="vs-engine-error-head">Expansion engine error</div>
          <pre className="vs-refusal-reason">{engineError}</pre>
          <div className="vs-refusal-detail">
            This is an engine/worker failure, not a terminology-service boundary —
            the ValueSet could not be evaluated at all. Retry after the engine
            finishes loading, or check the console.
          </div>
        </div>
      )}

      {!loading && !engineError && tier1?.ok && (
        <div className="vs-tier1">
          <div className="vs-tier1-head">
            <span className="vs-ok-badge">Expanded in-engine</span>
            <span className="vs-count">{tier1.total} code{tier1.total === 1 ? '' : 's'}</span>
            <span className="vs-timing">{tier1.expandMs.toFixed(1)} ms</span>
          </div>
          <UsedSystems used={tier1.usedCodeSystems} />
          <ContainsTable contains={tier1.contains} />
        </div>
      )}

      {!loading && !engineError && tier1 && !tier1.ok && (
        cached ? (
          <CachedServerExpansion
            entry={cached}
            vs={vs}
            referenced={referenced}
            onRefreshed={setCached}
            onCleared={() => setCached(null)}
          />
        ) : (
          <RefusalState
            refusal={tier1.notEnumerable}
            vs={vs}
            referenced={referenced}
            onExpanded={setCached}
          />
        )
      )}
    </div>
  );
}
