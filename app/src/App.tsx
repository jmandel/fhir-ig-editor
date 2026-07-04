// The editor shell. Wires: engine worker (init + debounced compile + on-demand
// snapshot), the OPFS project store, Monaco editing, and the M1 views
// (diagnostics, JSON, differential, snapshot tree, build timings).
//
// Flow (spec §4): file edit → 300ms debounce → worker.compile(all files) →
// { resources, diagnostics, buildMs } → markers + panels. Snapshots are
// on-demand + memoized per profile URL.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineClient } from './worker/client';
import type { BlockedPackage } from './worker/client';
import { ProjectStore } from './vfs/store';
import { loadProject } from './vfs/demoIg';
import type { CompileResult, Diagnostic, EngineVersion } from './worker/protocol';
import { getSiteGenerator, listSiteGenerators, registerSiteGenerator } from './adapters/types';
import type { PageInfo } from './adapters/types';
import { cycleAdapter } from './adapters/cycleAdapter';
import { stockAdapter } from './adapters/stockAdapter';
import {
  ensurePreviewServiceWorker,
  wirePreviewResponder,
  updatePreviewSource,
} from './preview/previewWindow';

// Adapter API v1 build-time registry: the selectable site generators.
registerSiteGenerator(cycleAdapter);
registerSiteGenerator(stockAdapter);
const GENERATOR_KEY = 'igEditor.siteGenerator';
const PROJECT_KEY = 'igEditor.project';
import { CodeEditor } from './editor/CodeEditor';
import { FileTree } from './editor/FileTree';
import { DiagnosticsPanel } from './views/DiagnosticsPanel';
import { ResourceInspector } from './views/ResourceInspector';
import { BuildStatus } from './views/BuildStatus';
import { PreviewPane } from './views/PreviewPane';
import { TxSettings } from './views/TxSettings';
import { PackageSettings } from './views/PackageSettings';
import type { ProgressEvent } from './worker/protocol';

const DEBOUNCE_MS = 300;

export function App() {
  const engineRef = useRef<EngineClient | null>(null);
  const [store, setStore] = useState<ProjectStore | null>(null);
  const storeRef = useRef<ProjectStore | null>(null);
  const projectIdRef = useRef<string>(localStorage.getItem(PROJECT_KEY) || 'cycle');
  const [version, setVersion] = useState<EngineVersion | null>(null);
  const [initMs, setInitMs] = useState<number | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [status, setStatus] = useState('Booting…');
  // Cold-start progress (spec §1): staged phase + per-bundle progress.
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  // Bumped when the tx endpoint changes, so the VS tab re-evaluates.
  const [settingsVersion, setSettingsVersion] = useState(0);

  const [paths, setPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeText, setActiveText] = useState('');
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);

  const [compile, setCompile] = useState<CompileResult | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);

  // task #32: packages the runtime resolver could not obtain from any source.
  const [blockedPackages, setBlockedPackages] = useState<BlockedPackage[]>([]);
  // The last config we ran package acquisition for (so we don't re-resolve the
  // whole closure on every keystroke — only when dependencies/fhirVersion change).
  const acquiredConfigRef = useRef<string | null>(null);

  // Site preview (adapter-driven).
  const [inspectTab, setInspectTab] = useState<'resource' | 'preview'>('resource');
  const [generatorId, setGeneratorId] = useState<string>(
    () => localStorage.getItem(GENERATOR_KEY) || 'cycle',
  );
  const [sitePages, setSitePages] = useState<PageInfo[] | null>(null);
  const [siteGeneration, setSiteGeneration] = useState(0);
  const [siteBuilding, setSiteBuilding] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  // Preview-window (task #37): whether the SW-backed preview is supported here.
  const [previewCapable, setPreviewCapable] = useState(false);

  // ---- boot: engine + store ------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const engine = new EngineClient();
      engineRef.current = engine;
      // Debug/verification hook: the e2e + fidelity harnesses drive the engine
      // directly (render every page, hash outputs) without UI scraping.
      (window as unknown as { __igDebug?: unknown }).__igDebug = { engine };
      // Preview-window (task #37): register the SW + render responder early so an
      // "Open site in new window" tab can be answered as soon as it exists.
      wirePreviewResponder();
      void ensurePreviewServiceWorker().then((ok) => {
        if (!cancelled) setPreviewCapable(ok);
      });
      const st = await ProjectStore.create();
      if (cancelled) return;
      setStore(st);
      storeRef.current = st;
      st.listeners.add(() => setPaths(st.list()));
      setPaths(st.list());

      const res = await engine.init((ev) => {
        setProgress(ev);
        setStatus(ev.message);
      });
      if (cancelled) return;
      setVersion(res.version);
      setInitMs(res.initMs);
      setEngineReady(true);
      setProgress({ stage: 'ready', message: `Engine ready — mounted ${res.mounted} packages.` });
      setStatus(`Engine ready — mounted ${res.mounted} packages.`);

      // If OPFS already has a project (reload), compile it immediately.
      if (st.list().length > 0) {
        setProjectLoaded(true);
        void runCompile(st, engine);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- site preview build: adapter init for this compile generation. -------
  const runBuildSite = useCallback(async (st: ProjectStore, engine: EngineClient, genId: string) => {
    setSiteBuilding(true);
    setSiteError(null);
    try {
      const adapter = getSiteGenerator(genId);
      if (!adapter) throw new Error(`no site generator '${genId}'`);
      // A fixed injected timestamp keeps rebuilds deterministic (spec §2c). The
      // absolute value is irrelevant for the preview; only stability matters.
      await adapter.init({
        engine,
        fragments: { fragment: (ref, kind) => engine.renderFragment(ref, kind).then((r) => r.html) },
        content: {
          renderLiquid: (src, data) => engine.renderLiquid(src, data).then((r) => r.html),
          renderMarkdown: (md, opts) => engine.renderMarkdown(md, opts).then((r) => r.html),
        },
        project: {
          projectId: projectIdRef.current,
          config: st.config(),
          files: st.fshFiles(),
          predefined: st.predefinedResources(),
          siteFiles: st.siteFiles(),
          buildEpochSecs: 1700000000,
        },
      });
      setSitePages(await adapter.listPages());
      // Preview-window (task #37): point the render responder at the freshly
      // (re)initialized adapter + a monotonic generation. This drives cache naming,
      // the SW answer ladder, and the smart hot-reload of any open preview tabs.
      setSiteGeneration((g) => {
        const nextGen = g + 1;
        updatePreviewSource({ generatorId: genId, adapter, generation: nextGen });
        return nextGen;
      });
    } catch (e) {
      setSitePages(null);
      setSiteError(String(e));
    } finally {
      setSiteBuilding(false);
    }
  }, []);

  // Template switch: persist + rebuild the preview for the new generator.
  const switchGenerator = useCallback((id: string) => {
    localStorage.setItem(GENERATOR_KEY, id);
    setGeneratorId(id);
    setSitePages(null);
    if (storeRef.current && engineRef.current) {
      void runBuildSite(storeRef.current, engineRef.current, id);
    }
  }, [runBuildSite]);

  // ---- compile (full project) ----------------------------------------------
  const runCompile = useCallback(async (st: ProjectStore, engine: EngineClient) => {
    if (!engine.initialized) return;
    setCompiling(true);
    try {
      const cfg = st.config();
      // task #32: ensure this project's package closure is mounted before compiling.
      // Runs only when the config (deps/fhirVersion) changed since the last
      // acquisition — the loop is a no-op once the closure is mounted, so this is
      // cheap on subsequent keystrokes. Blocked packages surface in the UI.
      if (cfg !== acquiredConfigRef.current) {
        engine.setProgress((ev) => {
          setProgress(ev);
          setStatus(ev.message);
        });
        try {
          const outcome = await engine.acquireForProject(cfg);
          setBlockedPackages(outcome.blocked);
          acquiredConfigRef.current = cfg;
        } catch (e) {
          // Acquisition failure is non-fatal: compile with whatever is mounted and
          // let the compiler's own diagnostics report unresolved references.
          setStatus(`Package acquisition warning: ${String(e)}`);
        } finally {
          engine.setProgress(null);
        }
      }
      const result = await engine.compile(cfg, st.fshFiles(), st.predefinedResources());
      setCompile(result);
      // Default-select the first StructureDefinition for the inspector.
      setSelectedResource((cur) => {
        if (cur && result.resources.some((r) => r.filename === cur)) return cur;
        const firstSd = result.resources.find((r) => r.resourceType === 'StructureDefinition' && r.url);
        return firstSd?.filename ?? result.resources[0]?.filename ?? null;
      });
      // Rebuild the site preview rows (only when the compile had no fatal errors —
      // a broken IG can't produce a coherent site.db). Fire-and-forget.
      const hasError = result.diagnostics.some((d) => d.severity === 'error');
      if (!hasError) void runBuildSite(st, engine, localStorage.getItem(GENERATOR_KEY) || 'cycle');
      else setSiteError('Fix the FSH errors to update the site preview.');
    } catch (e) {
      setCompile({
        resources: [],
        diagnostics: [{ severity: 'error', message: `compile failed: ${String(e)}` }],
        buildMs: 0,
        fileCount: 0,
      });
    } finally {
      setCompiling(false);
    }
  }, [runBuildSite]);

  // ---- debounced compile on edit ------------------------------------------
  const debounceRef = useRef<number | null>(null);
  const scheduleCompile = useCallback(() => {
    if (!store || !engineRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void runCompile(store, engineRef.current!);
    }, DEBOUNCE_MS);
  }, [store, runCompile]);

  // ---- open a baked project -------------------------------------------------
  const openProject = useCallback(async (projectId: string) => {
    if (!store) return;
    setStatus(`Loading ${projectId}…`);
    localStorage.setItem(PROJECT_KEY, projectId);
    projectIdRef.current = projectId;
    const meta = await loadProject(store, projectId);
    setProjectLoaded(true);
    setStatus(`Loaded ${meta.name} — ${meta.fileCount} files.`);
    // Open the first FSH file (or first pagecontent md for FSH-less projects).
    const first =
      store.list().find((p) => p.endsWith('.fsh')) ??
      store.list().find((p) => /^input\/pagecontent\/.*\.md$/.test(p)) ??
      store.list()[0] ??
      null;
    if (first) {
      setActivePath(first);
      setActiveText(store.read(first) ?? '');
    }
    if (engineRef.current) void runCompile(store, engineRef.current);
  }, [store, runCompile]);
  const openDemo = useCallback(() => openProject('cycle'), [openProject]);

  // ---- edit handling -------------------------------------------------------
  const onEdit = useCallback(
    (text: string) => {
      if (!store || !activePath) return;
      setActiveText(text);
      void store.write(activePath, text);
      scheduleCompile();
    },
    [store, activePath, scheduleCompile],
  );

  const selectFile = useCallback(
    (path: string) => {
      if (!store) return;
      setActivePath(path);
      setActiveText(store.read(path) ?? '');
      setRevealLine(undefined);
    },
    [store],
  );

  const navigateTo = useCallback(
    (file: string, line: number) => {
      selectFile(file);
      // force a new object identity so the reveal effect re-fires on same line
      setRevealLine(line);
    },
    [selectFile],
  );

  // ---- derived: diagnostics grouping --------------------------------------
  const diagnostics: Diagnostic[] = compile?.diagnostics ?? [];
  const fileDiagnostics = useMemo(
    () => (activePath ? diagnostics.filter((d) => d.file === activePath) : []),
    [diagnostics, activePath],
  );
  const errorCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const d of diagnostics) if (d.file) m[d.file] = (m[d.file] ?? 0) + 1;
    return m;
  }, [diagnostics]);

  const resources = compile?.resources ?? [];
  const activeResource = resources.find((r) => r.filename === selectedResource) ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span> FHIR IG Editor
        </div>
        <BuildStatus
          version={version}
          initMs={initMs}
          buildMs={compile?.buildMs ?? null}
          resourceCount={compile ? resources.length : null}
          fileCount={compile?.fileCount ?? null}
          compiling={compiling}
        />
        <div className="topbar-actions">
          {store && !store.persistent && (
            <span className="badge-warn" title="OPFS unavailable — project is in-memory only">
              in-memory
            </span>
          )}
          <PackageSettings
            onChange={() => {
              // A registry/proxy/local-package change may unblock packages — allow
              // the next compile to re-run acquisition.
              acquiredConfigRef.current = null;
              setSettingsVersion((v) => v + 1);
            }}
            onDropTgz={async (bytes) => {
              const label = (await engineRef.current?.ingestLocalTgz(bytes)) ?? '';
              // A newly-provided package may satisfy a previously-blocked closure.
              acquiredConfigRef.current = null;
              if (store && engineRef.current) void runCompile(store, engineRef.current);
              return label;
            }}
          />
          <TxSettings onChange={() => setSettingsVersion((v) => v + 1)} />
          <button className="btn" disabled={!engineReady} onClick={openDemo}>
            Open demo IG
          </button>
          <button className="btn" disabled={!engineReady} onClick={() => void openProject('uscore')}>
            Open US Core
          </button>
        </div>
      </header>

      <div className="statusline">{status}</div>

      {blockedPackages.length > 0 && (
        <div className="blocked-banner" role="alert">
          <strong>
            {blockedPackages.length} package{blockedPackages.length > 1 ? 's' : ''} could not be
            loaded:
          </strong>
          <ul>
            {blockedPackages.map((b) => (
              <li key={`${b.packageId}#${b.version}`}>
                <code>
                  {b.packageId}#{b.version}
                </code>{' '}
                — {b.why}
                <div className="blocked-remedies">
                  Remedies: {b.remedies.join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!projectLoaded ? (
        <div className="welcome">
          <div className="welcome-card">
            <h1>Edit a FHIR IG in your browser</h1>
            <p>
              The rust_sushi compiler and the snapshot walk engine run entirely as WebAssembly in a
              Web Worker — no server. Edit FSH, see live diagnostics, compiled JSON, the differential,
              and the generated snapshot element tree. Works offline after the first load.
            </p>
            <button className="btn btn-primary" disabled={!engineReady} onClick={openDemo}>
              {engineReady ? 'Open the demo IG (cycle)' : 'Starting engine…'}
            </button>
            {!engineReady && progress && <StartupProgress progress={progress} />}
            {version && (
              <div className="welcome-engine">
                {version.engine} · {version.commit}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="workbench">
          <aside className="sidebar">
            <div className="sidebar-header">Files</div>
            <FileTree
              paths={paths}
              active={activePath}
              errorCounts={errorCounts}
              onSelect={selectFile}
            />
            {resources.length > 0 && (
              <>
                <div className="sidebar-header">Compiled resources</div>
                <div className="resource-list">
                  {resources.map((r) => (
                    <div
                      key={r.filename}
                      className={`res-row${selectedResource === r.filename ? ' active' : ''}`}
                      onClick={() => setSelectedResource(r.filename)}
                      title={r.filename}
                    >
                      <span className="res-type">{r.resourceType}</span>
                      <span className="res-id">{r.id}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>

          <main className="editor-pane">
            {activePath ? (
              <CodeEditor
                path={activePath}
                value={activeText}
                diagnostics={fileDiagnostics}
                onChange={onEdit}
                revealLine={revealLine}
              />
            ) : (
              <div className="panel-empty">Select a file to edit.</div>
            )}
          </main>

          <section className="inspect-pane">
            <div className="inspect-tabs">
              <button
                className={`inspect-tab${inspectTab === 'resource' ? ' active' : ''}`}
                onClick={() => setInspectTab('resource')}
              >
                Resource
              </button>
              <button
                className={`inspect-tab${inspectTab === 'preview' ? ' active' : ''}`}
                onClick={() => setInspectTab('preview')}
              >
                Site preview
                {siteBuilding && <span className="tab-spinner" />}
              </button>
            </div>
            <div className="inspect-body">
              {inspectTab === 'resource' ? (
                activeResource && engineRef.current ? (
                  <ResourceInspector
                    resource={activeResource}
                    allResources={resources}
                    engine={engineRef.current}
                    settingsVersion={settingsVersion}
                  />
                ) : (
                  <div className="panel-empty">No resource selected.</div>
                )
              ) : engineRef.current ? (
                <PreviewPane
                  adapter={getSiteGenerator(generatorId) ?? cycleAdapter}
                  generators={listSiteGenerators().map((g) => ({ id: g.id, label: g.label }))}
                  onSelectGenerator={switchGenerator}
                  pages={sitePages}
                  generation={siteGeneration}
                  building={siteBuilding}
                  error={siteError}
                  previewCapable={previewCapable}
                />
              ) : (
                <div className="panel-empty">Engine not ready.</div>
              )}
            </div>
          </section>
        </div>
      )}

      {projectLoaded && progress && !engineReady && (
        <div className="lazy-progress" title={progress.message}>{progress.message}</div>
      )}

      {projectLoaded && (
        <footer className="problems">
          <div className="problems-header">
            Problems
            {diagnostics.length > 0 && <span className="problems-count">{diagnostics.length}</span>}
          </div>
          <DiagnosticsPanel diagnostics={diagnostics} onNavigate={navigateTo} />
        </footer>
      )}
    </div>
  );
}

/** Cold-start progress: the current stage + a bar across the eager bundle set,
 *  with the per-bundle byte size when fetching (spec §1). */
function StartupProgress({ progress }: { progress: ProgressEvent }) {
  const pct = progress.fraction != null ? Math.round(progress.fraction * 100) : null;
  return (
    <div className="startup-progress" data-stage={progress.stage}>
      <div className="startup-bar">
        <div className="startup-bar-fill" style={{ width: pct != null ? `${pct}%` : '35%' }} />
      </div>
      <div className="startup-msg">
        {progress.fromCache && <span className="startup-cache">⚡ cached</span>}
        {progress.message}
      </div>
    </div>
  );
}
