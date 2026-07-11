// Right-hand inspector for one compiled resource: tabs for JSON, Differential,
// and Snapshot tree (StructureDefinitions), and Expansion (ValueSets).

import { useState, type KeyboardEvent } from 'react';
import type { CompiledResource } from '../worker/protocol';
import type { EngineClient } from '../worker/client';
import { ResourceJson } from './ResourceJson';
import { DifferentialTable } from './DifferentialTable';
import { SnapshotTree } from './SnapshotTree';
import { ValueSetExpansion } from './ValueSetExpansion';
import { isStructureDefinition, type StructureDefinition } from './elements';
import { resourceIdentity } from './artifactSelection';

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
  // Differential and JSON are already available from compilation. Snapshot
  // generation (and its deferred R5 support package) starts only after the user
  // explicitly chooses that inspector.
  const [tab, setTab] = useState<Tab>('differential');

  let sd: StructureDefinition | null = null;
  try {
    const parsed = JSON.parse(resource.text);
    if (isStructureDefinition(parsed)) sd = parsed;
  } catch {
    /* non-JSON should not happen for compiled output */
  }
  const isSd = sd != null && resource.url != null;
  const isValueSet = resource.resourceType === 'ValueSet';

  // Profiles open on their authored differential; other resources open as
  // compiled JSON. Both representations are local and require no engine work.
  let effectiveTab: Tab;
  if (isSd) effectiveTab = tab === 'expansion' ? 'json' : tab;
  else if (isValueSet) effectiveTab = tab === 'expansion' || tab === 'json' ? tab : 'json';
  else effectiveTab = 'json';

  return (
    <div className="inspector">
      <div className="inspector-tabs">
        {isSd && (
          <>
            <TabBtn id="snapshot" active={effectiveTab === 'snapshot'} onClick={() => setTab('snapshot')}>
              Generate snapshot
            </TabBtn>
            <TabBtn id="differential" active={effectiveTab === 'differential'} onClick={() => setTab('differential')}>
              Differential
            </TabBtn>
          </>
        )}
        {isValueSet && (
          <TabBtn id="expansion" active={effectiveTab === 'expansion'} onClick={() => setTab('expansion')}>
            Expansion
          </TabBtn>
        )}
        <TabBtn id="json" active={effectiveTab === 'json'} onClick={() => setTab('json')}>
          JSON
        </TabBtn>
        <span className="inspector-name" title={resource.filename}>
          {resource.resourceType}/{resource.id}
        </span>
      </div>
      <div
        id="inspector-panel"
        className="inspector-body"
        role="tabpanel"
        aria-labelledby={`inspector-tab-${effectiveTab}`}
      >
        {effectiveTab === 'json' && <ResourceJson resource={resource} />}
        {effectiveTab === 'differential' && sd && <DifferentialTable sd={sd} />}
        {effectiveTab === 'snapshot' && isSd && sd && (
          <SnapshotTree engine={engine} url={resource.url!} id={resourceIdentity(resource)} />
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
  id,
  active,
  onClick,
  children,
}: {
  id: Tab;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = tabs.indexOf(event.currentTarget);
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].click();
    tabs[next].focus();
  };
  return (
    <button
      id={`inspector-tab-${id}`}
      role="tab"
      aria-selected={active}
      aria-controls="inspector-panel"
      tabIndex={active ? 0 : -1}
      className={`tab-btn${active ? ' active' : ''}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </button>
  );
}
