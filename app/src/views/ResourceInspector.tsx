// Right-hand inspector for one compiled resource: tabs for JSON, Differential,
// and Snapshot tree. Only StructureDefinitions get differential/snapshot tabs.

import { useState } from 'react';
import type { CompiledResource } from '../worker/protocol';
import type { EngineClient } from '../worker/client';
import { ResourceJson } from './ResourceJson';
import { DifferentialTable } from './DifferentialTable';
import { SnapshotTree } from './SnapshotTree';
import { isStructureDefinition, type StructureDefinition } from './elements';

type Tab = 'json' | 'differential' | 'snapshot';

export function ResourceInspector({
  resource,
  engine,
}: {
  resource: CompiledResource;
  engine: EngineClient;
}) {
  const [tab, setTab] = useState<Tab>('snapshot');

  let sd: StructureDefinition | null = null;
  try {
    const parsed = JSON.parse(resource.text);
    if (isStructureDefinition(parsed)) sd = parsed;
  } catch {
    /* non-JSON should not happen for compiled output */
  }
  const isSd = sd != null && resource.url != null;
  // Non-SD resources only have a JSON view.
  const effectiveTab: Tab = isSd ? tab : 'json';

  return (
    <div className="inspector">
      <div className="inspector-tabs">
        {isSd && (
          <>
            <TabBtn active={effectiveTab === 'snapshot'} onClick={() => setTab('snapshot')}>
              Snapshot tree
            </TabBtn>
            <TabBtn active={effectiveTab === 'differential'} onClick={() => setTab('differential')}>
              Differential
            </TabBtn>
          </>
        )}
        <TabBtn active={effectiveTab === 'json'} onClick={() => setTab('json')}>
          JSON
        </TabBtn>
        <span className="inspector-name" title={resource.filename}>
          {resource.resourceType}/{resource.id}
        </span>
      </div>
      <div className="inspector-body">
        {effectiveTab === 'json' && <ResourceJson resource={resource} />}
        {effectiveTab === 'differential' && sd && <DifferentialTable sd={sd} />}
        {effectiveTab === 'snapshot' && isSd && sd && (
          <SnapshotTree engine={engine} url={resource.url!} id={resource.id ?? resource.filename} />
        )}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button className={`tab-btn${active ? ' active' : ''}`} onClick={onClick}>
      {children}
    </button>
  );
}
