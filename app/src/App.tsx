// The editor shell. It captures exact project snapshots, coordinates serialized
// compile/site builds in the worker, publishes only the latest preview
// generation, and wires Monaco/resource/snapshot/diagnostic views.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EngineClient, PrepareError } from './worker/client';
import type { BlockedPackage } from './worker/client';
import { ProjectStore } from './vfs/store';
import { loadProject, CATALOG_IGS } from './vfs/demoIg';
import type { CompileResult, Diagnostic, EngineVersion } from './worker/protocol';
import type { GeneratorSpec, OutputDescriptor, ProjectInput } from './site/contract';
import {
  ensurePreviewServiceWorker,
  wirePreviewResponder,
  publishPreviewSource,
} from './preview/previewWindow';
import { LatestTaskQueue, type TaskLease } from './build/latestTaskQueue';
import { getCuratedCatalogs, type TemplateCatalog } from './adapters/templateCatalog';

const GENERATOR_KEY = 'igEditor.siteGenerator';
const PROJECT_KEY = 'igEditor.project';
const TEMPLATE_KEY = 'igEditor.templateCoord';
const DEFAULT_TEMPLATE = 'hl7.fhir.template#1.0.0';
const CYCLE_GENERATOR = 'cycle';
const PUBLISHER_GENERATOR = 'hl7.fhir.template';
const GENERATORS = [
  { id: CYCLE_GENERATOR, label: 'Cycle site generator (LiquidJS)' },
  { id: PUBLISHER_GENERATOR, label: 'FHIR IG Publisher template (Rust)' },
] as const;
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

interface ProjectBuildSnapshot extends ProjectInput {
  predefinedDisplay: CompileResult['resources'];
}

function generatorSpec(id: string, templateCoordinate: string): GeneratorSpec {
  return id === CYCLE_GENERATOR
    ? { generator: 'cycle' }
    : {
        generator: 'publisher',
        templateCoordinate,
        activeTables: true,
        runUuid: 'e0e0e0e0-0000-4000-8000-igeditor0000',
      };
}

function captureProject(st: ProjectStore, projectId: string): ProjectBuildSnapshot {
  return {
    projectId,
    config: st.config(),
    files: st.fshFiles(),
    predefined: st.predefinedResources(),
    predefinedDisplay: st.predefinedDisplayResources(),
    siteFiles: st.siteFiles(),
    // A fixed injected timestamp keeps rebuilds deterministic.
    buildEpochSecs: 1700000000,
  };
}

/** Machine-readable trace consumed by the persistent-profile benchmark. */
function recordRuntimeMetric(event: ProgressEvent): void {
  const debug = (window as unknown as {
    __igDebug?: { metrics?: Array<{ at: number; event: ProgressEvent }> };
  }).__igDebug;
  debug?.metrics?.push({ at: performance.now(), event });
}

export function App() {
  const engineRef = useRef<EngineClient | null>(null);
  // Engine work is serialized; leases prevent obsolete immutable build handles
  // from publishing UI or Service Worker generations.
  const buildQueueRef = useRef(new LatestTaskQueue());
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
  // A project-open FAILURE (manifest/network/CORS/parse). Kept as a persistent,
  // dismissible banner — the open overlay clears on error, so without this the
  // failure would only flash in the status line (the silent dead-click bug).
  const [openError, setOpenError] = useState<{ projectId: string; message: string } | null>(null);
  // Bumped when the tx endpoint changes, so the VS tab re-evaluates.
  const [settingsVersion, setSettingsVersion] = useState(0);

  const [paths, setPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [activeText, setActiveText] = useState('');
  const [revealLine, setRevealLine] = useState<number | undefined>(undefined);

  const [compile, setCompile] = useState<CompileResult | null>(null);
  // Predefined conformance resources (input/resources/**.json) for the resource
  // panel — a predefined-resource IG (US Core / IPS: 0 FSH) has SUSHI emit
  // nothing, so without these the panel is empty though the IG is full of
  // profiles. Captured at compile time (parallel to `compile.resources`, which
  // stays byte-exact SUSHI output).
  const [predefinedResources, setPredefinedResources] = useState<CompileResult['resources']>([]);
  const [compiling, setCompiling] = useState(false);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [projectLoaded, setProjectLoaded] = useState(false);

  // task #32: packages the runtime resolver could not obtain from any source.
  const [blockedPackages, setBlockedPackages] = useState<BlockedPackage[]>([]);
  // Site preview (immutable BuildHandle-driven).
  const [inspectTab, setInspectTab] = useState<'resource' | 'preview'>('resource');
  const [generatorId, setGeneratorId] = useState<string>(
    () => localStorage.getItem(GENERATOR_KEY) || 'cycle',
  );
  const [sitePages, setSitePages] = useState<OutputDescriptor[] | null>(null);
  const [siteIgId, setSiteIgId] = useState(projectIdRef.current);
  // Use a process-epoch seed so a reloaded editor always advances beyond cache
  // generations retained by an older Service Worker session.
  const siteGenerationRef = useRef(Date.now());
  const [siteBuilding, setSiteBuilding] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  // Live template loader (#40): the selected Publisher template#version + the last
  // load error (custom-ant refusal etc.). The coord persists across reloads.
  const [templateCoord, setTemplateCoord] = useState<string>(
    () => localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE,
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  // Curated templates' live version catalogs (#40 default UX): fetched from the
  // registry (OPFS-cached, TTL, last-known-good, pinned fallback) so the selector
  // offers a version list with NO typing. Null until first load.
  const [templateCatalogs, setTemplateCatalogs] = useState<Record<string, TemplateCatalog> | null>(null);
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
      (window as unknown as { __igDebug?: unknown }).__igDebug = { engine, metrics: [] };
      // Preview-window (task #37): register the SW + render responder early so an
      // "Open site in new window" tab can be answered as soon as it exists.
      wirePreviewResponder((handle, path) => engine.render(handle, path));
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
        recordRuntimeMetric(ev);
        setProgress(ev);
        setStatus(ev.message);
      });
      if (cancelled) return;
      setVersion(res.version);
      setInitMs(res.initMs);
      setEngineReady(true);
      const readyEvent: ProgressEvent = { stage: 'ready', message: `Engine ready — mounted ${res.mounted} packages.` };
      recordRuntimeMetric(readyEvent);
      setProgress(readyEvent);
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

  // ---- one project crossing -> immutable BuildHandle -> atomic publication --
  const performBuildSite = useCallback(async (
    project: ProjectBuildSnapshot,
    engine: EngineClient,
    genId: string,
    selectedTemplate: string,
    lease: TaskLease,
  ) => {
    const report = (ev: ProgressEvent) => {
      if (!lease.isLatest()) return;
      recordRuntimeMetric(ev);
      setProgress(ev);
      setStatus(ev.message);
    };
    if (lease.isLatest()) {
      setSiteBuilding(true);
      setSiteError(null);
    }
    const showCompiled = (compiled: CompileResult) => {
      if (!lease.isLatest()) return;
      setCompile(compiled);
      const sushiNames = new Set(compiled.resources.map((resource) => resource.filename));
      const predef = project.predefinedDisplay.filter((resource) => !sushiNames.has(resource.filename));
      setPredefinedResources(predef);
      const allResources = [...compiled.resources, ...predef];
      setSelectedResource((current) => {
        if (current && allResources.some((resource) => resource.filename === current)) return current;
        const first = allResources.find((resource) => resource.resourceType === 'StructureDefinition' && resource.url);
        return first?.filename ?? allResources[0]?.filename ?? null;
      });
    };
    try {
      report({ stage: 'site-build', message: `Preparing ${genId} site…` });
      const siteStarted = performance.now();
      engine.setProgress(report);
      const prepared = await engine.prepare(project, generatorSpec(genId, selectedTemplate));
      // Compilation remains useful UI state even if catalog validation,
      // rendering, or preview publication subsequently fails.
      showCompiled(prepared.compiled);
      const catalog = await engine.outputs(prepared.handle);
      const pages = catalog.outputs.filter((output) => output.kind === 'page');
      report({
        stage: 'site-build',
        message: `Prepared ${pages.length} site pages.`,
        durationMs: performance.now() - siteStarted,
        fileCount: pages.length,
      });
      if (!lease.isLatest()) return;
      // Template loaded cleanly — remember it as the fallback + clear any prior
      // load error (#40).
      if (genId === PUBLISHER_GENERATOR) {
        lastGoodTemplateRef.current = selectedTemplate;
        setTemplateError(null);
      }
      const nextGeneration = siteGenerationRef.current + 1;
      report({ stage: 'preview-publish', message: 'Publishing preview generation…' });
      const publishStarted = performance.now();
      const published = await publishPreviewSource(
        {
          igId: project.projectId,
          handle: prepared.handle,
          buildId: prepared.buildId,
          catalog,
        },
        nextGeneration,
        () => lease.isLatest(),
      );
      if (!published || !lease.isLatest()) return;
      report({
        stage: 'preview-publish',
        message: `Published preview generation ${nextGeneration}.`,
        durationMs: performance.now() - publishStarted,
        fileCount: pages.length,
      });
      // Swap React state only after the SW acknowledges this exact handle/catalog.
      siteGenerationRef.current = nextGeneration;
      setSiteIgId(project.projectId);
      setSitePages(pages);
    } catch (e) {
      if (lease.isLatest()) {
        if (e instanceof PrepareError && e.compiled) showCompiled(e.compiled);
        setSiteError(String(e));
        throw e; // let selectTemplate see the failure so it can fall back
      }
    } finally {
      // The queue does not start the next engine operation until this returns, so
      // clearing transient flags/callbacks here cannot clobber a newer task.
      setSiteBuilding(false);
      engine.setProgress(null);
    }
  }, []);

  const enqueueSiteBuild = useCallback(async (
    st: ProjectStore,
    engine: EngineClient,
    genId: string,
  ) => {
    const project = captureProject(st, projectIdRef.current);
    const selectedTemplate = localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
    await buildQueueRef.current.enqueue((lease) =>
      performBuildSite(project, engine, genId, selectedTemplate, lease),
    );
  }, [performBuildSite]);

  // Template switch: persist + rebuild the preview for the new generator.
  const switchGenerator = useCallback((id: string) => {
    localStorage.setItem(GENERATOR_KEY, id);
    setGeneratorId(id);
    if (storeRef.current && engineRef.current) {
      void enqueueSiteBuild(storeRef.current, engineRef.current, id).catch(() => {});
    }
  }, [enqueueSiteBuild]);

  // Live template loader (#40): select a template#version (known or write-your-own).
  // Persist it, prepare a new immutable Publisher build; on failure (custom-ant refusal, chain
  // unfetchable) surface the message and FALL BACK to the previous good template
  // so the selector never wedges.
  const selectTemplate = useCallback((coord: string) => {
    const previous = lastGoodTemplateRef.current;
    userPickedTemplateRef.current = true; // an explicit choice — persist + honor it.
    localStorage.setItem(TEMPLATE_KEY, coord);
    setTemplateCoord(coord);
    setTemplateError(null);
    if (!storeRef.current || !engineRef.current) return;
    void enqueueSiteBuild(storeRef.current, engineRef.current, PUBLISHER_GENERATOR).catch((e) => {
      // Revert to the last template that loaded — never leave the preview wedged.
      setTemplateError(String(e).replace(/^Error:\s*/, ''));
      localStorage.setItem(TEMPLATE_KEY, previous);
      setTemplateCoord(previous);
      if (previous !== coord && storeRef.current && engineRef.current) {
        void enqueueSiteBuild(storeRef.current, engineRef.current, PUBLISHER_GENERATOR).catch(() => {});
      }
    });
  }, [enqueueSiteBuild]);

  // ---- prepare full project + selected generator in one worker request ------
  const runCompile = useCallback(async (st: ProjectStore, engine: EngineClient) => {
    if (!engine.initialized) return;
    // Snapshot before entering the queue: loading another IG or typing while an
    // older wasm operation finishes cannot change this request's inputs midway.
    const project = captureProject(st, projectIdRef.current);
    const genId = localStorage.getItem(GENERATOR_KEY) || 'cycle';
    const selectedTemplate = localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
    await buildQueueRef.current.enqueue(async (lease) => {
      if (lease.isLatest()) setCompiling(true);
      try {
        await performBuildSite(project, engine, genId, selectedTemplate, lease);
        if (lease.isLatest()) setBlockedPackages([]);
      } catch (e) {
        if (lease.isLatest() && e instanceof PrepareError && e.stage === 'compile') {
          setPredefinedResources([]);
          setCompile({
            resources: [],
            diagnostics: [{ severity: 'error', message: `compile failed: ${String(e)}` }],
            buildMs: 0,
            fileCount: 0,
          });
        }
      } finally {
        setCompiling(false);
      }
    });
  }, [performBuildSite]);

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
    // Supersede a compile/site build immediately, before the potentially slow
    // catalog fetch mutates the shared ProjectStore.
    buildQueueRef.current.invalidate();
    setSiteBuilding(false);
    // Surface the SAME staged progress the boot path shows for the whole open:
    // manifest fetch → package acquisition (bundle fetch/mount) → compile →
    // snapshot data mount → site render. Every stage flows through `setProgress`;
    // `openingSince` keeps the overlay mounted (with elapsed seconds) across the
    // inner cb swaps runCompile/runBuildSite make. Without this the open is a bare
    // "Loading …" statusline while ~14 MB streams — indistinguishable from hung.
    setOpeningSince(Date.now());
    setOpenError(null); // clear any prior failure the moment a new open starts
    const emit = (ev: ProgressEvent) => {
      recordRuntimeMetric(ev);
      setProgress(ev);
      setStatus(ev.message);
    };
    emit({ stage: 'manifest', message: `Loading ${projectId} project files…` });
    engine?.setProgress(emit);
    localStorage.setItem(PROJECT_KEY, projectId);
    projectIdRef.current = projectId;
    // The `cycle` generator is bespoke to the cycle demo IG; every other IG (the
    // catalog / published IGs) renders with the Publisher generator. Default
    // the preview generator per project so a published IG never opens with the
    // Cycle-specific generator selected.
    const defaultGen = projectId === 'cycle' ? CYCLE_GENERATOR : PUBLISHER_GENERATOR;
    localStorage.setItem(GENERATOR_KEY, defaultGen);
    setGeneratorId(defaultGen);
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
      // Surface the failure VISIBLY (persistent banner) — a fetch/CORS/HTTP/parse
      // error must never be a silent dead click (the exact US Core 404 bug).
      const message = String(e).replace(/^Error:\s*/, '');
      setStatus(`Failed to open ${projectId}: ${message}`);
      setOpenError({ projectId, message });
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

  const resources = compile ? [...compile.resources, ...predefinedResources] : [];
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
              setSettingsVersion((v) => v + 1);
            }}
            onDropTgz={async (bytes) => {
              const label = (await engineRef.current?.ingestLocalTgz(bytes)) ?? '';
              if (store && engineRef.current) void runCompile(store, engineRef.current);
              return label;
            }}
          />
          <TxSettings onChange={() => setSettingsVersion((v) => v + 1)} />
          <button className="btn" disabled={!engineReady} onClick={openDemo}>
            Open demo IG
          </button>
          <select
            className="btn btn-featured open-ig-select"
            disabled={!engineReady}
            value=""
            title="Open a published HL7 IG (baked source, loads from this site)"
            onChange={(e) => {
              const id = e.target.value;
              e.target.value = '';
              if (id) void openProject(id);
            }}
          >
            <option value="" disabled>
              Open published IG…
            </option>
            {CATALOG_IGS.map((ig) => (
              <option key={ig.id} value={ig.id}>
                {ig.name}
              </option>
            ))}
          </select>
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
                  igId={siteIgId}
                  generatorId={generatorId}
                  generators={[...GENERATORS]}
                  onSelectGenerator={switchGenerator}
                  pages={sitePages}
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

      {openError && (
        <div className="open-error" role="alert">
          <div className="open-error-body">
            <strong>Couldn't open {openError.projectId}.</strong> {openError.message}
          </div>
          <div className="open-error-actions">
            <button className="btn" onClick={() => void openProject(openError.projectId)}>
              Retry
            </button>
            <button className="btn" onClick={() => setOpenError(null)} aria-label="Dismiss">
              Dismiss
            </button>
          </div>
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

/** Cold-start progress: the current stage + a bar across a bounded operation,
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
  'project-cache-hit': 'Reusing project',
  'project-unpack': 'Unpacking project',
  'project-store': 'Storing project',
  compile: 'Compiling project',
  snapshot: 'Preparing snapshots',
  'site-build': 'Building site',
  'preview-publish': 'Publishing preview',
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
