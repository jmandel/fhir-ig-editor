import { useRef, useState, type ReactNode } from 'react';
import { CURATED_TEMPLATES, isVerified, type TemplateCatalog } from '../adapters/templateCatalog';

const PUBLISHER_GENERATOR = 'hl7.fhir.template';
const ADVANCED = '__advanced__';
const CUSTOM_CURRENT = '__custom_current__';

interface Props {
  generatorId: string;
  generators: { id: string; label: string }[];
  onSelectGenerator: (id: string) => void;
  currentTemplate: string;
  onSelectTemplate: (coordinate: string) => void;
  templateCatalogs: Record<string, TemplateCatalog> | null;
  templateError: string | null;
  children?: ReactNode;
}

/** Advanced build configuration. The default workspace talks about outcomes;
 * generator, template, package, and terminology machinery stays available in
 * one disclosure without becoming the primary navigation. */
export function BuildSettings({
  generatorId,
  generators,
  onSelectGenerator,
  currentTemplate,
  onSelectTemplate,
  templateCatalogs,
  templateError,
  children,
}: Props) {
  const [currentId, currentVersion] = splitCoordinate(currentTemplate);
  const curated = CURATED_TEMPLATES.some((template) => template.id === currentId);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customCoordinate, setCustomCoordinate] = useState('');
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const familyValue = advancedOpen ? ADVANCED : curated ? currentId : CUSTOM_CURRENT;
  const catalog = templateCatalogs?.[currentId] ?? null;
  const versions = catalog?.versions ? [...catalog.versions] : [];
  if (currentVersion && !versions.includes(currentVersion)) versions.unshift(currentVersion);

  const loadCustom = () => {
    const coordinate = customCoordinate.trim();
    if (!coordinate.includes('#')) return;
    onSelectTemplate(coordinate);
    setAdvancedOpen(false);
  };
  const closeDrawer = () => {
    if (detailsRef.current) detailsRef.current.open = false;
  };

  return (
    <details ref={detailsRef} className="build-settings">
      <summary className="btn" title="Generator, template, packages, and terminology">
        Build settings
      </summary>
      <div
        className="build-settings-panel"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeDrawer();
          }
        }}
      >
        <div className="build-settings-heading">
          <div>
            <strong>Build settings</strong>
            <span>Advanced controls for the current guide</span>
          </div>
          <button className="btn build-settings-close" onClick={closeDrawer}>Close</button>
        </div>
        <label className="preview-generator-select">
          <span>Generator</span>
          <select value={generatorId} onChange={(event) => onSelectGenerator(event.target.value)}>
            {generators.map((generator) => (
              <option key={generator.id} value={generator.id}>{generator.label}</option>
            ))}
          </select>
        </label>
        {generatorId === PUBLISHER_GENERATOR && (
          <>
            <label className="preview-template-select">
              <span>Template</span>
              <select
                value={familyValue}
                onChange={(event) => {
                  const id = event.target.value;
                  if (id === ADVANCED) {
                    setAdvancedOpen(true);
                    setCustomCoordinate(curated ? '' : currentTemplate);
                    return;
                  }
                  setAdvancedOpen(false);
                  const nextCatalog = templateCatalogs?.[id];
                  const version = nextCatalog?.latest
                    ?? nextCatalog?.versions[0]
                    ?? CURATED_TEMPLATES.find((template) => template.id === id)?.verified[0]
                    ?? '';
                  if (version) onSelectTemplate(`${id}#${version}`);
                }}
              >
                {CURATED_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>{template.label}</option>
                ))}
                {!curated && <option value={CUSTOM_CURRENT}>{currentId || 'custom'} (custom)</option>}
                <option value={ADVANCED}>Advanced / custom template…</option>
              </select>
            </label>
            {!advancedOpen && curated && (
              <label className="preview-template-version">
                <span>Version</span>
                <select
                  value={currentVersion}
                  onChange={(event) => onSelectTemplate(`${currentId}#${event.target.value}`)}
                >
                  {versions.map((version) => (
                    <option key={version} value={version}>
                      {version}
                      {isVerified(currentId, version) ? ' ✓ verified' : ''}
                      {catalog?.latest === version ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
                {catalog?.fromFallback && <span className="preview-template-offline">offline</span>}
              </label>
            )}
            {advancedOpen && (
              <div className="preview-template-own">
                <input
                  aria-label="Custom template coordinate"
                  placeholder="id#version"
                  value={customCoordinate}
                  onChange={(event) => setCustomCoordinate(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') loadCustom(); }}
                />
                <button className="btn" disabled={!customCoordinate.includes('#')} onClick={loadCustom}>Load</button>
                <button className="btn" onClick={() => setAdvancedOpen(false)}>Cancel</button>
              </div>
            )}
          </>
        )}
        <div className="build-settings-tools">{children}</div>
        {templateError && (
          <div className="preview-template-error" role="alert">{templateError}</div>
        )}
      </div>
    </details>
  );
}

function splitCoordinate(coordinate: string): [string, string] {
  const hash = coordinate.lastIndexOf('#');
  return hash < 0 ? [coordinate, ''] : [coordinate.slice(0, hash), coordinate.slice(hash + 1)];
}
