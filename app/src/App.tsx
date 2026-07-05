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
const TEMPLATE_KEY = 'igEditor.templateCoord';
const DEFAULT_TEMPLATE = 'hl7.fhir.template#1.0.0';
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
  // Project-open progress: while a baked project is opening/switching (US Core,
  // demo IG) we surface the SAME staged progress the boot path shows — otherwise
  // the ~14 MB of bundle fetch + mount + compile + snapshot looks hung (mobile).
  // `openingSince` is the start ms so the overlay can show elapsed seconds even on
  // indeterminate stages; null = not opening.
  const [openingSince, setOpeningSince] = useState<number | null>(null);
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
  // Live template loader (#40): the selected stock template#version + the last
  // load error (custom-ant refusal etc.). The coord persists across reloads.
  const [templateCoord, setTemplateCoord] = useState<string>(
    () => localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE,
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  // Curated templates' live version catalogs (#40 default UX): fetched from the
  // registry (OPFS-cached, TTL, last-known-good, pinned fallback) so the selector
  // offers a version list with NO typing. Null until first load.
  const [templateCatalogs, setTemplateCatalogs] = useState<Record<string, import('./adapters/templateCatalog').TemplateCatalog> | null>(null);
  // Whether the user has EXPLICITLY chosen a template this session (persisted key
  // present). If not, the boot catalog load defaults the coord to the family's
  // latest PUBLISHED version rather than the hardcoded DEFAULT_TEMPLATE.
  const userPickedTemplateRef = useRef<boolean>(localStorage.getItem(TEMPLATE_KEY) != null);
  // The last template that loaded cleanly, so a failed load can fall back to it
  // (the selector never wedges — a bad template reverts to the previous one).
  const lastGoodTemplateRef = useRef<string>(
    localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE,
  );
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

  // ---- template catalogs (#40 default UX): load the curated families' live
  // version lists on boot (registry → OPFS/TTL/last-known-good/pinned fallback).
  // If the user hasn't explicitly picked a template, default the coord to the
  // current family's LATEST PUBLISHED version (not the hardcoded 1.0.0), so the
  // selector opens on a real, newest release with zero typing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { getCuratedCatalogs } = await import('./adapters/templateCatalog');
      const cats = await getCuratedCatalogs();
      if (cancelled) return;
      setTemplateCatalogs(cats);
      if (!userPickedTemplateRef.current) {
        // Default to the DEFAULT_TEMPLATE family's latest published version.
        const hash = DEFAULT_TEMPLATE.lastIndexOf('#');
        const defId = hash < 0 ? DEFAULT_TEMPLATE : DEFAULT_TEMPLATE.slice(0, hash);
        const latest = cats[defId]?.latest ?? cats[defId]?.versions[0];
        if (latest) {
          const coord = `${defId}#${latest}`;
          if (coord !== templateCoord) {
            setTemplateCoord(coord);
            lastGoodTemplateRef.current = coord;
            // Do NOT persist — this is a derived default, not a user choice, so a
            // future newer release still becomes the default on the next visit.
          }
        }
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
      // Live template loader (#40): tell the stock adapter which template#version
      // to materialize BEFORE init. Surface the template fetch/materialize stages
      // (chain fetch, mountTemplate) through the shared progress → status line.
      if (genId === 'hl7.fhir.template') {
        stockAdapter.setTemplate(localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE);
        engine.setProgress((ev) => {
          setProgress(ev);
          setStatus(ev.message);
        });
      }
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
      // Template loaded cleanly — remember it as the fallback + clear any prior
      // load error (#40).
      if (genId === 'hl7.fhir.template') {
        const coord = localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
        lastGoodTemplateRef.current = coord;
        setTemplateError(null);
      }
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
      throw e; // let selectTemplate see the failure so it can fall back
    } finally {
      setSiteBuilding(false);
      if (genId === 'hl7.fhir.template') engine.setProgress(null);
    }
  }, []);

  // Template switch: persist + rebuild the preview for the new generator.
  const switchGenerator = useCallback((id: string) => {
    localStorage.setItem(GENERATOR_KEY, id);
    setGeneratorId(id);
    setSitePages(null);
    if (storeRef.current && engineRef.current) {
      void runBuildSite(storeRef.current, engineRef.current, id).catch(() => {});
    }
  }, [runBuildSite]);

  // Live template loader (#40): select a template#version (known or write-your-own).
  // Persist it, re-init the stock adapter; on failure (custom-ant refusal, chain
  // unfetchable) surface the message and FALL BACK to the previous good template
  // so the selector never wedges.
  const selectTemplate = useCallback((coord: string) => {
    const previous = lastGoodTemplateRef.current;
    userPickedTemplateRef.current = true; // an explicit choice — persist + honor it.
    localStorage.setItem(TEMPLATE_KEY, coord);
    setTemplateCoord(coord);
    setTemplateError(null);
    setSitePages(null);
    if (!storeRef.current || !engineRef.current) return;
    void runBuildSite(storeRef.current, engineRef.current, 'hl7.fhir.template').catch((e) => {
      // Revert to the last template that loaded — never leave the preview wedged.
      setTemplateError(String(e).replace(/^Error:\s*/, ''));
      localStorage.setItem(TEMPLATE_KEY, previous);
      setTemplateCoord(previous);
      if (previous !== coord && storeRef.current && engineRef.current) {
        void runBuildSite(storeRef.current, engineRef.current, 'hl7.fhir.template').catch(() => {});
      }
    });
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
      if (!hasError) void runBuildSite(st, engine, localStorage.getItem(GENERATOR_KEY) || 'cycle').catch(() => {});
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
    const engine = engineRef.current;
    // Surface the SAME staged progress the boot path shows for the whole open:
    // manifest fetch → package acquisition (bundle fetch/mount) → compile →
    // snapshot data mount → site render. Every stage flows through `setProgress`;
    // `openingSince` keeps the overlay mounted (with elapsed seconds) across the
    // inner cb swaps runCompile/runBuildSite make. Without this the open is a bare
    // "Loading …" statusline while ~14 MB streams — indistinguishable from hung.
    setOpeningSince(Date.now());
    const emit = (ev: ProgressEvent) => {
      setProgress(ev);
      setStatus(ev.message);
    };
    emit({ stage: 'manifest', message: `Loading ${projectId} project files…` });
    engine?.setProgress(emit);
    localStorage.setItem(PROJECT_KEY, projectId);
    projectIdRef.current = projectId;
    try {
      const meta = await loadProject(store, projectId, emit);
      setProjectLoaded(true);
      emit({ stage: 'bundle-mount', message: `Loaded ${meta.name} — ${meta.fileCount} files. Compiling…` });
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
      // runCompile drives acquisition (bundle fetch/mount), compile, snapshot, and
      // the site render — all of which report through the engine progress cb we
      // set above. Await it so the overlay stays up until the project is usable.
      if (engine) await runCompile(store, engine);
      emit({ stage: 'ready', message: `${meta.name} ready.` });
    } catch (e) {
      emit({ stage: 'ready', message: `Failed to open ${projectId}: ${String(e)}` });
    } finally {
      engine?.setProgress(null);
      setOpeningSince(null);
    }
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
                  currentTemplate={templateCoord}
                  onSelectTemplate={selectTemplate}
                  templateError={templateError}
                  templateCatalogs={templateCatalogs}
                />
              ) : (
                <div className="panel-empty">Engine not ready.</div>
              )}
            </div>
          </section>
        </div>
      )}

      {openingSince != null && progress && (
        <OpenProgress progress={progress} since={openingSince} />
      )}
      {projectLoaded && progress && !engineReady && openingSince == null && (
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

/** Human stage labels for the project-open overlay. Keeps the tiny per-item
 *  `message` (which names the specific bundle/file) but headlines the PHASE so a
 *  narrow screen still reads what's happening. */
const OPEN_STAGE_LABEL: Record<ProgressEvent['stage'], string> = {
  wasm: 'Starting engine',
  manifest: 'Loading project',
  resolve: 'Resolving packages',
  'bundle-fetch': 'Fetching packages',
  'bundle-cache-hit': 'Loading packages',
  'bundle-mount': 'Mounting packages',
  'registry-fetch': 'Fetching from registry',
  'package-blocked': 'Package unavailable',
  'lazy-fetch': 'Fetching snapshot data',
  ready: 'Ready',
};

/** Project-open progress (US Core / demo IG): a mobile-safe banner under the
 *  status line. Reuses the same staged `ProgressEvent` the boot path emits, adds
 *  a determinate-or-animated bar, a distinct cache marker, and a ticking elapsed
 *  counter so nothing ever looks hung. Wraps on narrow widths — never overflows. */
function OpenProgress({ progress, since }: { progress: ProgressEvent; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.round((now - since) / 1000));
  const pct = progress.fraction != null ? Math.round(progress.fraction * 100) : null;
  const determinate = pct != null;
  const done = progress.stage === 'ready';
  return (
    <div className="open-progress" data-stage={progress.stage} role="status" aria-live="polite">
      <div className="open-progress-bar">
        <div
          className={`open-progress-fill${determinate ? '' : ' indeterminate'}`}
          style={determinate ? { width: `${pct}%` } : undefined}
        />
      </div>
      <div className="open-progress-line">
        {!done && <span className="open-progress-spinner" aria-hidden="true" />}
        <span className="open-progress-stage">{OPEN_STAGE_LABEL[progress.stage]}</span>
        {progress.fromCache && <span className="open-progress-cache">⚡ from cache</span>}
        <span className="open-progress-msg">{progress.message}</span>
        <span className="open-progress-elapsed">{elapsed}s</span>
      </div>
    </div>
  );
}
