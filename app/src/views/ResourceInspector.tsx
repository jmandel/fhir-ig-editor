// Right-hand inspector for one compiled resource: tabs for JSON, Differential,
// and Snapshot tree (StructureDefinitions), and Expansion (ValueSets).

import { useState } from 'react';
import type { CompiledResource } from '../worker/protocol';
import type { EngineClient } from '../worker/client';
import { ResourceJson } from './ResourceJson';
import { DifferentialTable } from './DifferentialTable';
import { SnapshotTree } from './SnapshotTree';
import { ValueSetExpansion } from './ValueSetExpansion';
import { isStructureDefinition, type StructureDefinition } from './elements';

type Tab = 'json' | 'differential' | 'snapshot' | 'expansion';

export function ResourceInspector({
  resource,
  allResources,
  engine,
  settingsVersion,
}: {
  resource: CompiledResource;
  allResources: CompiledResource[];
  engine: EngineClient;
  settingsVersion: number;
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
  const isValueSet = resource.resourceType === 'ValueSet';

  // Effective tab: SDs default to snapshot; ValueSets default to expansion;
  // everything else only has JSON.
  let effectiveTab: Tab;
  if (isSd) effectiveTab = tab === 'expansion' ? 'snapshot' : tab;
  else if (isValueSet) effectiveTab = tab === 'expansion' || tab === 'json' ? tab : 'expansion';
  else effectiveTab = 'json';

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
        {isValueSet && (
          <TabBtn active={effectiveTab === 'expansion'} onClick={() => setTab('expansion')}>
            Expansion
          </TabBtn>
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
        {effectiveTab === 'expansion' && isValueSet && (
          <ValueSetExpansion
            resource={resource}
            allResources={allResources}
            engine={engine}
            settingsVersion={settingsVersion}
          />
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
