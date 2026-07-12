// The editor shell. It captures exact project snapshots, coordinates serialized
// compile/site builds in the worker, publishes only the latest preview
// generation, and wires Monaco/resource/snapshot/diagnostic views.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { EngineClient, PrepareError } from './worker/client';
import type { BlockedPackage } from './worker/client';
import {
  type Workspace,
  type WorkspaceCapture,
  WorkspaceRepository,
} from './vfs/workspace';
import { loadProject, CATALOG_IGS } from './vfs/demoIg';
import type { CompiledResource, CompileResult, Diagnostic, EngineVersion } from './worker/protocol';
import type { GeneratorSpec, OutputDescriptor } from './site/contract';
import {
  ensurePreviewServiceWorker,
  wirePreviewResponder,
  publishPreviewSource,
  restorePersistedPreviewSource,
} from './preview/previewWindow';
import { LatestTaskQueue, editDebounceMs, type TaskLease } from './build/latestTaskQueue';
import { getCuratedCatalogs, type TemplateCatalog } from './adapters/templateCatalog';

const GENERATOR_KEY = 'igEditor.siteGenerator';
const PROJECT_KEY = 'igEditor.project';
const TEMPLATE_KEY = 'igEditor.templateCoord';
const DEFAULT_TEMPLATE = 'hl7.fhir.template#1.0.0';
const TINY_PROJECT_ID = 'tiny';
const CYCLE_GENERATOR = 'cycle';
const PUBLISHER_GENERATOR = 'hl7.fhir.template';
const GENERATORS = [
  { id: CYCLE_GENERATOR, label: 'Cycle site generator (LiquidJS)' },
  { id: PUBLISHER_GENERATOR, label: 'FHIR IG Publisher template (Rust)' },
] as const;
const WORKSPACE_MODES: Array<[WorkspaceMode, string]> = [
  ['author', 'Author'],
  ['explore', 'Explore'],
  ['preview', 'Site preview'],
];
import { CodeEditor } from './editor/CodeEditor';
import { FileTree } from './editor/FileTree';
import { DiagnosticsPanel } from './views/DiagnosticsPanel';
import { ResourceInspector } from './views/ResourceInspector';
import { BuildStatus } from './views/BuildStatus';
import { PreviewPane } from './views/PreviewPane';
import { TxSettings } from './views/TxSettings';
import { PackageSettings } from './views/PackageSettings';
import { BuildSettings } from './views/BuildSettings';
import { ArtifactTrail } from './views/ArtifactTrail';
import {
  mergeResourcesByIdentity,
  primaryPageForResource,
  resourceForPage,
  resourceIdentity,
  soleResourceDeclaredIn,
} from './views/artifactSelection';
import {
  deriveBuildState,
  ProjectOverview,
  settledBuildStatus,
  type WorkspaceMode,
} from './views/ProjectOverview';
import type { ProgressEvent } from './worker/protocol';
import { presentProgress } from './progressPresentation';


interface BuildOutcome {
  ok: boolean;
  error?: string;
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

function projectDisplayName(projectId: string): string {
  if (projectId === TINY_PROJECT_ID) return 'The Guide That Describes Its Editor';
  if (projectId === 'cycle') return 'Period Tracking Implementation Guide';
  return CATALOG_IGS.find((guide) => guide.id === projectId)?.name ?? projectId;
}

function defaultGeneratorFor(projectId: string): string {
  return projectId === 'cycle' ? CYCLE_GENERATOR : PUBLISHER_GENERATOR;
}

function initialWorkspaceFor(projectId: string): WorkspaceMode {
  return projectId === TINY_PROJECT_ID || projectId === 'cycle' ? 'author' : 'explore';
}

function initialSourcePath(workspace: Workspace): string | null {
  return workspace.list().find((path) => path.endsWith('.fsh'))
    ?? workspace.list().find((path) => /^input\/pagecontent\/.*\.md$/.test(path))
    ?? workspace.list()[0]
    ?? null;
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
  const problemsRef = useRef<HTMLDetailsElement | null>(null);
  // Engine work is serialized; leases prevent obsolete immutable build handles
  // from publishing UI or Service Worker generations.
  const buildQueueRef = useRef(new LatestTaskQueue());
  const openRequestRef = useRef(0);
  const [workspaces, setWorkspaces] = useState<WorkspaceRepository | null>(null);
  const [projectWorkspace, setProjectWorkspace] = useState<Workspace | null>(null);
  const projectWorkspaceRef = useRef<Workspace | null>(null);
  const projectIdRef = useRef<string>(localStorage.getItem(PROJECT_KEY) || TINY_PROJECT_ID);
  const [version, setVersion] = useState<EngineVersion | null>(null);
  const [initMs, setInitMs] = useState<number | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  // Cold-start progress (spec §1): staged phase + per-bundle progress.
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  // Project-open progress: while a baked project is opening/switching (US Core,
  // tiny guide) we surface the SAME staged progress the boot path shows — otherwise
  // the package fetch + mount + compile + site preparation looks hung (mobile).
  // `openingSince` is the start ms so the overlay can show elapsed seconds even on
  // staged work; null = not opening.
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
  // Authored local resources (input/{resources,examples}/**.json) for Explore.
  // SUSHI consumes them without re-emitting them as compiler outputs, so retain
  // their exact source declarations beside the byte-exact compiled list.
  const [predefinedResources, setPredefinedResources] = useState<CompileResult['resources']>([]);
  const [compiling, setCompiling] = useState(false);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [resourceFilter, setResourceFilter] = useState('');
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [projectName, setProjectName] = useState(() => projectDisplayName(projectIdRef.current));
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    () => initialWorkspaceFor(projectIdRef.current),
  );
  // Expensive surfaces mount on first use, then remain mounted so Monaco state
  // and preview scroll/history survive mode switches without doing hidden work
  // during an ordinary published-guide open.
  const [activatedModes, setActivatedModes] = useState<Set<WorkspaceMode>>(
    () => new Set([initialWorkspaceFor(projectIdRef.current)]),
  );
  const activateWorkspace = useCallback((mode: WorkspaceMode) => {
    setActivatedModes((current) => current.has(mode) ? current : new Set([...current, mode]));
    setWorkspaceMode(mode);
  }, []);
  const leaveProblemsFor = useCallback((mode: WorkspaceMode) => {
    if (problemsRef.current) problemsRef.current.open = false;
    activateWorkspace(mode);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${mode}`)?.focus());
  }, [activateWorkspace]);
  const [previewStale, setPreviewStale] = useState(false);

  // task #32: packages the runtime resolver could not obtain from any source.
  const [blockedPackages, setBlockedPackages] = useState<BlockedPackage[]>([]);
  // Site preview (immutable BuildHandle-driven).
  const [generatorId, setGeneratorId] = useState<string>(
    () => localStorage.getItem(GENERATOR_KEY) || defaultGeneratorFor(projectIdRef.current),
  );
  const [sitePages, setSitePages] = useState<OutputDescriptor[] | null>(null);
  const [selectedSitePage, setSelectedSitePage] = useState('index.html');
  const [siteIgId, setSiteIgId] = useState(projectIdRef.current);
  // Use a process-epoch seed so a reloaded editor always advances beyond cache
  // generations retained by an older Service Worker session.
  const siteGenerationRef = useRef(Date.now());
  const [siteBuilding, setSiteBuilding] = useState(false);
  const [siteError, setSiteError] = useState<string | null>(null);
  // Live template loader (#40): the selected Publisher template#version + the last
  // load error (custom-ant refusal etc.). The coord persists across reloads.
  const [templateCoord, setTemplateCoord] = useState<string>(
    () => projectIdRef.current === TINY_PROJECT_ID
      ? DEFAULT_TEMPLATE
      : localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE,
  );
  // Tiny starts from the exact teaching template without destroying the user's
  // remembered template for larger guides. An explicit Tiny-only experiment is
  // kept separately for the lifetime of the open project.
  const tinyTemplateRef = useRef(DEFAULT_TEMPLATE);
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
  const [previewCapable, setPreviewCapable] = useState<boolean | null>(null);
  const resources = useMemo(
    () => compile ? mergeResourcesByIdentity(compile.resources, predefinedResources) : [],
    [compile, predefinedResources],
  );

  // ---- boot: engine + project-scoped workspaces ----------------------------
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
      const repository = await WorkspaceRepository.create();
      const workspace = await repository.open(projectIdRef.current);
      if (cancelled) return;
      setWorkspaces(repository);
      setProjectWorkspace(workspace);
      projectWorkspaceRef.current = workspace;

      // The preview host survives editor/worker restarts. Restore its validated
      // immutable pointer immediately so a persisted project can display the
      // last verified response while exact package resolution + prepare run.
      // This remains explicitly stale: only the successor prepare/publication
      // below can establish that today's closed input identity is unchanged.
      if (workspace) {
        void restorePersistedPreviewSource(projectIdRef.current).then((publication) => {
          if (cancelled || !publication || projectIdRef.current !== publication.source.igId) return;
          const pages = publication.source.catalog.outputs.filter((output) => output.kind === 'page');
          if (pages.length === 0) return;
          siteGenerationRef.current = Math.max(siteGenerationRef.current, publication.generation);
          setSiteIgId(publication.source.igId);
          setSitePages(pages);
          setSelectedSitePage((current) => {
            if (pages.some((page) => page.path === current)) return current;
            return pages.find((page) => page.path === 'en/index.html' || page.path === 'index.html')?.path
              ?? pages[0].path;
          });
          setPreviewStale(true);
        });
      }

      const res = await engine.init((ev) => {
        recordRuntimeMetric(ev);
        setProgress(ev);
      });
      if (cancelled) return;
      setVersion(res.version);
      setInitMs(res.initMs);
      setEngineReady(true);
      const readyEvent: ProgressEvent = { stage: 'ready', message: `Engine ready — mounted ${res.mounted} packages.` };
      recordRuntimeMetric(readyEvent);
      setProgress(readyEvent);

      // If OPFS already has a project (reload), compile it immediately.
      if (workspace) {
        setProjectLoaded(true);
        setProjectName(workspace.name || projectDisplayName(projectIdRef.current));
        const first = initialSourcePath(workspace);
        if (first) {
          setActivePath(first);
          setActiveText(workspace.read(first) ?? '');
        }
        void runCompile(workspace, engine);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!projectWorkspace) {
      setPaths([]);
      return;
    }
    const update = () => setPaths(projectWorkspace.list());
    projectWorkspace.listeners.add(update);
    update();
    return () => {
      projectWorkspace.listeners.delete(update);
    };
  }, [projectWorkspace]);

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
      if (!userPickedTemplateRef.current && projectIdRef.current !== TINY_PROJECT_ID) {
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
    capture: WorkspaceCapture,
    engine: EngineClient,
    genId: string,
    selectedTemplate: string,
    lease: TaskLease,
  ) => {
    const project = capture.revision;
    const report = (ev: ProgressEvent) => {
      if (!lease.isLatest()) return;
      recordRuntimeMetric(ev);
      setProgress(ev);
    };
    if (lease.isLatest()) {
      setSiteBuilding(true);
      setSiteError(null);
    }
    const showCompiled = (compiled: CompileResult) => {
      if (!lease.isLatest()) return;
      setCompile(compiled);
      setPredefinedResources(capture.predefinedDisplay);
      const allResources = mergeResourcesByIdentity(compiled.resources, capture.predefinedDisplay);
      setSelectedResource((current) => {
        if (current && allResources.some((resource) => resourceIdentity(resource) === current)) return current;
        // Prefer the exact artifact declared by the first authored FSH file.
        // The tiny guide keeps its one teaching profile in 00-EditorUser.fsh,
        // making the initial Source -> Definition -> Published-page trail
        // causal instead of whichever StructureDefinition sorts first.
        const firstFsh = Object.keys(project.files).filter((path) => path.endsWith('.fsh')).sort()[0];
        const firstDeclared = firstFsh ? soleResourceDeclaredIn(allResources, firstFsh) : null;
        if (firstDeclared) return resourceIdentity(firstDeclared);
        const first = allResources.find((resource) => resource.resourceType === 'StructureDefinition' && resource.url);
        return first ? resourceIdentity(first) : allResources[0] ? resourceIdentity(allResources[0]) : null;
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
        if (project.projectId !== TINY_PROJECT_ID) lastGoodTemplateRef.current = selectedTemplate;
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
      setSelectedSitePage((current) => {
        if (pages.some((page) => page.path === current)) return current;
        return pages.find((page) => page.path === 'en/index.html' || page.path === 'index.html')?.path
          ?? pages[0]?.path
          ?? 'index.html';
      });
      setPreviewStale(false);
    } catch (e) {
      if (lease.isLatest()) {
        if (e instanceof PrepareError && e.compiled) showCompiled(e.compiled);
        setSiteError(String(e));
        setPreviewStale(true);
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
    workspace: Workspace,
    engine: EngineClient,
    genId: string,
  ) => {
    const capture = workspace.capture(1700000000);
    const project = capture.revision;
    const selectedTemplate = project.projectId === TINY_PROJECT_ID
      ? tinyTemplateRef.current
      : localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
    await buildQueueRef.current.enqueue((lease) =>
      performBuildSite(capture, engine, genId, selectedTemplate, lease),
    );
  }, [performBuildSite]);

  // Template switch: persist + rebuild the preview for the new generator.
  const switchGenerator = useCallback((id: string) => {
    localStorage.setItem(GENERATOR_KEY, id);
    setGeneratorId(id);
    setPreviewStale(true);
    if (projectWorkspaceRef.current && engineRef.current) {
      void enqueueSiteBuild(projectWorkspaceRef.current, engineRef.current, id).catch(() => {});
    }
  }, [enqueueSiteBuild]);

  // Live template loader (#40): select a template#version (known or write-your-own).
  // Persist it, prepare a new immutable Publisher build; on failure (custom-ant refusal, chain
  // unfetchable) surface the message and FALL BACK to the previous good template
  // so the selector never wedges.
  const selectTemplate = useCallback((coord: string) => {
    const tiny = projectIdRef.current === TINY_PROJECT_ID;
    const previous = tiny ? tinyTemplateRef.current : lastGoodTemplateRef.current;
    if (tiny) {
      tinyTemplateRef.current = coord;
    } else {
      userPickedTemplateRef.current = true; // an explicit choice — persist + honor it.
      localStorage.setItem(TEMPLATE_KEY, coord);
    }
    setTemplateCoord(coord);
    setTemplateError(null);
    setPreviewStale(true);
    if (!projectWorkspaceRef.current || !engineRef.current) return;
    void enqueueSiteBuild(projectWorkspaceRef.current, engineRef.current, PUBLISHER_GENERATOR).catch((e) => {
      // Revert to the last template that loaded — never leave the preview wedged.
      setTemplateError(String(e).replace(/^Error:\s*/, ''));
      if (tiny) tinyTemplateRef.current = previous;
      else localStorage.setItem(TEMPLATE_KEY, previous);
      setTemplateCoord(previous);
      if (previous !== coord && projectWorkspaceRef.current && engineRef.current) {
        void enqueueSiteBuild(projectWorkspaceRef.current, engineRef.current, PUBLISHER_GENERATOR).catch(() => {});
      }
    });
  }, [enqueueSiteBuild]);

  // ---- prepare full project + selected generator in one worker request ------
  const runCompile = useCallback(async (workspace: Workspace, engine: EngineClient): Promise<BuildOutcome> => {
    if (!engine.initialized) return { ok: false, error: 'engine is not initialized' };
    // Snapshot before entering the queue: loading another IG or typing while an
    // older wasm operation finishes cannot change this request's inputs midway.
    const capture = workspace.capture(1700000000);
    const project = capture.revision;
    const genId = localStorage.getItem(GENERATOR_KEY) || defaultGeneratorFor(project.projectId);
    const selectedTemplate = project.projectId === TINY_PROJECT_ID
      ? tinyTemplateRef.current
      : localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
    let failure: unknown = null;
    const outcome = await buildQueueRef.current.enqueue(async (lease) => {
      if (lease.isLatest()) setCompiling(true);
      try {
        await performBuildSite(capture, engine, genId, selectedTemplate, lease);
        if (lease.isLatest()) setBlockedPackages([]);
      } catch (e) {
        failure = e;
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
        if (lease.isLatest()) setCompiling(false);
      }
    });
    if (!outcome.latest) return { ok: false, error: 'build superseded by a newer request' };
    return failure == null ? { ok: true } : { ok: false, error: String(failure) };
  }, [performBuildSite]);

  // ---- debounced compile on edit ------------------------------------------
  const debounceRef = useRef<number | null>(null);
  const scheduleCompile = useCallback((editedPath: string) => {
    if (!projectWorkspace || !engineRef.current) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const editedWorkspace = projectWorkspace;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      if (projectWorkspaceRef.current !== editedWorkspace) return;
      void runCompile(editedWorkspace, engineRef.current!);
    }, editDebounceMs(editedPath));
  }, [projectWorkspace, runCompile]);

  // ---- open a baked project -------------------------------------------------
  const openProject = useCallback(async (projectId: string) => {
    if (!workspaces) return;
    const requestId = ++openRequestRef.current;
    const engine = engineRef.current;
    // Supersede current work immediately. Source acquisition targets an
    // inactive project workspace, so the current working copy stays coherent
    // if fetch/verification/import fails.
    buildQueueRef.current.invalidate();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setCompiling(false);
    setSiteBuilding(false);
    // Surface the SAME staged progress the boot path shows for the whole open:
    // manifest fetch → package acquisition (bundle fetch/mount) → compile →
    // site render. Every stage flows through `setProgress`;
    // `openingSince` keeps the overlay mounted (with elapsed seconds) across the
    // inner cb swaps runCompile/runBuildSite make. Without this the open is a bare
    // "Loading …" statusline while ~14 MB streams — indistinguishable from hung.
    setOpeningSince(Date.now());
    setOpenError(null); // clear any prior failure the moment a new open starts
    setSiteError(null);
    const emit = (ev: ProgressEvent) => {
      if (openRequestRef.current !== requestId) return;
      recordRuntimeMetric(ev);
      setProgress(ev);
    };
    emit({ stage: 'manifest', message: `Loading ${projectId} project files…` });
    try {
      const meta = await loadProject(workspaces, projectId, emit);
      if (openRequestRef.current !== requestId) return;
      // The previous project remains editable while source acquisition runs.
      // Cancel an edit timer created during that interval before swapping owners;
      // its callback also checks owner identity as a final stale-work guard.
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const nextWorkspace = meta.workspace;
      // Publish the active workspace pointer only after its complete generation
      // exists. A failed source import never makes localStorage disagree with
      // the working tree restored on the next boot.
      localStorage.setItem(PROJECT_KEY, projectId);
      projectIdRef.current = projectId;
      projectWorkspaceRef.current = nextWorkspace;
      setProjectWorkspace(nextWorkspace);
      setCompile(null);
      setPredefinedResources([]);
      setSelectedResource(null);
      setPreviewStale(false);
      if (siteIgId !== projectId) setSitePages(null);
      // The teaching guide starts from one exact standard-HL7 template without
      // overwriting the user's remembered template preference for other guides.
      if (projectId === TINY_PROJECT_ID) {
        tinyTemplateRef.current = DEFAULT_TEMPLATE;
        setTemplateCoord(DEFAULT_TEMPLATE);
        setTemplateError(null);
      } else {
        setTemplateCoord(localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE);
      }
      const defaultGen = defaultGeneratorFor(projectId);
      const initialMode = initialWorkspaceFor(projectId);
      setActivatedModes(new Set([initialMode]));
      setWorkspaceMode(initialMode);
      localStorage.setItem(GENERATOR_KEY, defaultGen);
      setGeneratorId(defaultGen);
      setProjectName(meta.name || projectDisplayName(projectId));
      setProjectLoaded(true);
      emit({ stage: 'bundle-mount', message: `Loaded ${meta.name} — ${meta.fileCount} files. Compiling…` });
      // Open the first FSH file (or first pagecontent md for FSH-less projects).
      const first = initialSourcePath(nextWorkspace);
      if (first) {
        setActivePath(first);
        setActiveText(nextWorkspace.read(first) ?? '');
      }
      // runCompile drives acquisition (bundle fetch/mount), compile, and the site
      // render — all of which report through the engine progress cb we
      // set above. Await it so the overlay stays up until the project is usable.
      if (engine) {
        const outcome = await runCompile(nextWorkspace, engine);
        if (openRequestRef.current !== requestId) return;
        if (!outcome.ok) throw new Error(outcome.error ?? 'build failed');
      }
      emit({ stage: 'ready', message: `${meta.name} ready.` });
    } catch (e) {
      if (openRequestRef.current !== requestId) return;
      // Surface the failure VISIBLY (persistent banner) — a fetch/CORS/HTTP/parse
      // error must never be a silent dead click (the exact US Core 404 bug).
      const message = String(e).replace(/^Error:\s*/, '');
      setOpenError({ projectId, message });
    } finally {
      if (openRequestRef.current === requestId) {
        engine?.setProgress(null);
        setOpeningSince(null);
      }
    }
  }, [workspaces, runCompile, siteIgId]);
  const openDemo = useCallback(() => openProject(TINY_PROJECT_ID), [openProject]);

  // ---- edit handling -------------------------------------------------------
  const onEdit = useCallback(
    (text: string) => {
      if (!projectWorkspace || !activePath) return;
      setActiveText(text);
      void projectWorkspace.write(activePath, text);
      setPreviewStale(true);
      scheduleCompile(activePath);
    },
    [projectWorkspace, activePath, scheduleCompile],
  );

  const selectFile = useCallback(
    (path: string, knownOwner?: CompiledResource | null) => {
      if (!projectWorkspace) return;
      setActivePath(path);
      setActiveText(projectWorkspace.read(path) ?? '');
      setRevealLine(undefined);
      const declared = knownOwner === undefined
        ? soleResourceDeclaredIn(resources, path)
        : knownOwner;
      setSelectedResource(declared ? resourceIdentity(declared) : null);
      activateWorkspace('author');
    },
    [projectWorkspace, resources, activateWorkspace],
  );

  const navigateTo = useCallback(
    (file: string, line: number, owner: CompiledResource | null) => {
      selectFile(file, owner);
      // force a new object identity so the reveal effect re-fires on same line
      setRevealLine(line);
      if (problemsRef.current) problemsRef.current.open = false;
      requestAnimationFrame(() => document.getElementById('workspace-tab-author')?.focus());
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

  const activeResource = resources.find((resource) => resourceIdentity(resource) === selectedResource) ?? null;
  const currentProjectPages = siteIgId === projectIdRef.current ? sitePages : null;
  const selectedResourcePage = primaryPageForResource(currentProjectPages, activeResource);
  const shownSitePage = currentProjectPages
    ?.find((candidate) => candidate.path === selectedSitePage) ?? null;
  const shownSiteResource = resourceForPage(resources, shownSitePage);
  const trailResource = workspaceMode === 'preview' ? shownSiteResource : activeResource;
  const trailPage = workspaceMode === 'preview'
    ? (shownSiteResource ? shownSitePage : null)
    : selectedResourcePage;
  const normalizedResourceFilter = resourceFilter.trim().toLocaleLowerCase();
  const filteredResources = normalizedResourceFilter
    ? resources.filter((resource) => `${resource.resourceType ?? ''}/${resource.id ?? ''} ${resource.filename}`.toLocaleLowerCase().includes(normalizedResourceFilter))
    : resources;
  const selectSitePage = (path: string) => {
    setSelectedSitePage(path);
    const page = currentProjectPages?.find((candidate) => candidate.path === path);
    const resource = resourceForPage(resources, page);
    setSelectedResource(resource ? resourceIdentity(resource) : null);
  };
  const onWorkspaceTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, mode: WorkspaceMode) => {
    const current = WORKSPACE_MODES.findIndex(([candidate]) => candidate === mode);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % WORKSPACE_MODES.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + WORKSPACE_MODES.length) % WORKSPACE_MODES.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = WORKSPACE_MODES.length - 1;
    else return;
    event.preventDefault();
    const nextMode = WORKSPACE_MODES[next][0];
    activateWorkspace(nextMode);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${nextMode}`)?.focus());
  };
  const buildState = deriveBuildState({
    previewStale,
    compiling,
    siteBuilding,
    hasPublishedPreview: Boolean(currentProjectPages),
    hasError: Boolean(siteError),
  });
  const statusMessage = openingSince != null
    ? null
    : openError
      ? `Couldn't open ${openError.projectId}.`
      : siteError
        ? buildState === 'failed-preview'
          ? 'Site rebuild failed; showing the previous preview.'
          : 'Site build failed.'
        : compiling || siteBuilding || !engineReady
          ? progress?.message ?? 'Starting…'
          : settledBuildStatus(buildState, projectName);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◈</span> FHIR IG Editor
        </div>
        {projectLoaded && <span className="topbar-project">{projectName}</span>}
        <div className="topbar-actions">
          {workspaces && !workspaces.persistent && (
            <span className="badge-warn" title="OPFS unavailable — project is in-memory only">
              in-memory
            </span>
          )}
          {projectLoaded && (
            <BuildSettings
              generatorId={generatorId}
              generators={[...GENERATORS]}
              onSelectGenerator={switchGenerator}
              currentTemplate={templateCoord}
              onSelectTemplate={selectTemplate}
              templateCatalogs={templateCatalogs}
              templateError={templateError}
            >
              <BuildStatus
                version={version}
                initMs={initMs}
                buildMs={compile?.buildMs ?? null}
                resourceCount={compile ? resources.length : null}
                fileCount={compile?.fileCount ?? null}
                compiling={compiling}
              />
              <PackageSettings
                onChange={() => setSettingsVersion((value) => value + 1)}
                onDropTgz={async (bytes) => {
                  const label = (await engineRef.current?.ingestLocalTgz(bytes)) ?? '';
                  if (projectWorkspace && engineRef.current) void runCompile(projectWorkspace, engineRef.current);
                  return label;
                }}
              />
              <TxSettings onChange={() => setSettingsVersion((value) => value + 1)} />
            </BuildSettings>
          )}
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
              Switch guide…
            </option>
            <option value={TINY_PROJECT_ID}>Tiny FSH demo (HL7 Publisher)</option>
            <option value="cycle">Period Tracking IG (Cycle external builder)</option>
            {CATALOG_IGS.map((ig) => (
              <option key={ig.id} value={ig.id}>
                {ig.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className={`statusline${openingSince != null ? ' suppressed' : ''}`}>
        {statusMessage}
      </div>

      <div className="status-area">
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
      </div>

      {!projectLoaded ? (
        <div className="welcome">
          <div className="welcome-card">
            <div className="welcome-eyebrow">FHIR authoring, compiled and published in your browser</div>
            <h1>See one guide from source to published page</h1>
            <p>Make a small FSH change, inspect the definition it creates, and navigate the resulting implementation guide—all without installing a toolchain.</p>
            <div className="welcome-actions">
              <section className="welcome-action-card featured">
                <span className="welcome-step">Start here</span>
                <h2>Edit a tiny FSH guide</h2>
                <p>Open a focused example, change a rule, and watch its definition and site update.</p>
                <button className="btn btn-primary" disabled={!engineReady} onClick={openDemo}>
                  {engineReady ? 'Edit the tiny guide' : 'Starting engine…'}
                </button>
              </section>
              <section className="welcome-action-card">
                <span className="welcome-step">Explore</span>
                <h2>Explore a published guide</h2>
                <p>Browse the source, profiles, diagnostics, and real site for a guide you know.</p>
                <select
                  className="btn landing-ig-select"
                  disabled={!engineReady}
                  value=""
                  onChange={(event) => { if (event.target.value) void openProject(event.target.value); }}
                >
                  <option value="" disabled>Choose a guide…</option>
                  {CATALOG_IGS.map((guide) => <option key={guide.id} value={guide.id}>{guide.name}</option>)}
                </select>
              </section>
            </div>
            {!engineReady && progress && <StartupProgress progress={progress} />}
            {version && (
              <div className="welcome-engine">
                {version.engine} · {version.commit}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="workspace-shell">
          <ProjectOverview
            projectId={projectIdRef.current}
            projectName={projectName}
            paths={paths}
            resources={resources}
            pages={currentProjectPages}
            diagnostics={diagnostics}
            buildState={buildState}
            onOpenMode={activateWorkspace}
            onOpenProblems={() => {
              if (!problemsRef.current) return;
              problemsRef.current.open = true;
              requestAnimationFrame(() => {
                problemsRef.current?.querySelector<HTMLElement>('button, summary')?.focus();
              });
            }}
          />
          <ArtifactTrail
            resource={trailResource}
            page={trailPage}
            currentMode={workspaceMode}
            activeSourcePath={activePath}
            selectedPagePath={selectedSitePage}
            onOpenSource={() => {
              if (!trailResource?.definition || !projectWorkspace) return;
              setSelectedResource(resourceIdentity(trailResource));
              setActivePath(trailResource.definition.path);
              setActiveText(projectWorkspace.read(trailResource.definition.path) ?? '');
              setRevealLine(trailResource.definition.line);
              activateWorkspace('author');
            }}
            onOpenDefinition={() => {
              if (trailResource) setSelectedResource(resourceIdentity(trailResource));
              activateWorkspace('explore');
            }}
            onOpenPreview={() => {
              if (!trailPage) return;
              setSelectedSitePage(trailPage.path);
              activateWorkspace('preview');
            }}
          />
          <nav className="inspect-tabs workspace-tabs" role="tablist" aria-label="Workspace mode">
            {WORKSPACE_MODES.map(([mode, label]) => (
              <button
                key={mode}
                id={`workspace-tab-${mode}`}
                role="tab"
                aria-selected={workspaceMode === mode}
                aria-controls={`workspace-panel-${mode}`}
                tabIndex={workspaceMode === mode ? 0 : -1}
                className={`inspect-tab${workspaceMode === mode ? ' active' : ''}`}
                onClick={() => activateWorkspace(mode)}
                onKeyDown={(event) => onWorkspaceTabKeyDown(event, mode)}
              >
                {label}
                {mode === 'preview' && siteBuilding && <span className="tab-busy">Building</span>}
              </button>
            ))}
          </nav>
          <div className="workspace-views" data-mode={workspaceMode}>
            <section id="workspace-panel-author" role="tabpanel" aria-labelledby="workspace-tab-author" className="workspace-view author-workspace" hidden={workspaceMode !== 'author'}>
              <aside className="sidebar source-sidebar">
                <div className="sidebar-header">Source files</div>
                <FileTree paths={paths} active={activePath} errorCounts={errorCounts} onSelect={selectFile} />
              </aside>
              <label className="mobile-picker">
                Source file
                <select value={activePath ?? ''} onChange={(event) => selectFile(event.target.value)}>
                  <option value="" disabled>Select a source file…</option>
                  {paths.map((path) => <option key={path} value={path}>{path}</option>)}
                </select>
              </label>
              <main className="editor-pane">
                {activatedModes.has('author') && activePath ? (
                  <CodeEditor path={activePath} value={activeText} diagnostics={fileDiagnostics} onChange={onEdit} revealLine={revealLine} />
                ) : <div className="panel-empty">Select a source file to edit.</div>}
              </main>
            </section>

            <section id="workspace-panel-explore" role="tabpanel" aria-labelledby="workspace-tab-explore" className="workspace-view explore-workspace" hidden={workspaceMode !== 'explore'}>
              <aside className="sidebar resource-sidebar">
                <div className="sidebar-header">Definitions</div>
                <label className="resource-filter">
                  <span className="sr-only">Filter definitions</span>
                  <input
                    type="search"
                    placeholder="Filter definitions…"
                    value={resourceFilter}
                    onChange={(event) => setResourceFilter(event.target.value)}
                  />
                </label>
                <div className="resource-list">
                  {filteredResources.map((resource) => (
                    <button
                      key={resourceIdentity(resource)}
                      className={`res-row${selectedResource === resourceIdentity(resource) ? ' active' : ''}`}
                      onClick={() => { setSelectedResource(resourceIdentity(resource)); activateWorkspace('explore'); }}
                      title={resource.filename}
                    >
                      <span className="res-type">{resource.resourceType}</span>
                      <span className="res-id">{resource.id}</span>
                    </button>
                  ))}
                </div>
              </aside>
              <label className="mobile-picker">
                Definition
                <select value={selectedResource ?? ''} onChange={(event) => setSelectedResource(event.target.value)}>
                  <option value="" disabled>Select a definition…</option>
                  {filteredResources.map((resource) => {
                    const identity = resourceIdentity(resource);
                    return <option key={identity} value={identity}>{resource.resourceType}/{resource.id}</option>;
                  })}
                </select>
              </label>
              <section className="definition-pane">
                {workspaceMode === 'explore' && !siteBuilding && activeResource && engineRef.current ? (
                  <ResourceInspector resource={activeResource} allResources={resources} engine={engineRef.current} settingsVersion={settingsVersion} />
                ) : <div className="panel-empty">Definitions will appear as soon as compilation completes.</div>}
              </section>
            </section>

            <section id="workspace-panel-preview" role="tabpanel" aria-labelledby="workspace-tab-preview" className="workspace-view preview-workspace" hidden={workspaceMode !== 'preview'}>
              {activatedModes.has('preview') && engineRef.current ? (
                <PreviewPane
                  igId={siteIgId}
                  pages={currentProjectPages}
                  building={siteBuilding}
                  error={siteError}
                  previewCapable={previewCapable}
                  currentPage={selectedSitePage}
                  onSelectPage={selectSitePage}
                />
              ) : <div className="panel-empty">Engine not ready.</div>}
            </section>
          </div>
        </div>
      )}

      {projectLoaded && (
        <details ref={problemsRef} className="problems">
          <summary className="problems-header">
            Problems
            {diagnostics.length > 0 && <span className="problems-count">{diagnostics.length}</span>}
          </summary>
          <DiagnosticsPanel
            diagnostics={diagnostics}
            resources={resources}
            pages={currentProjectPages}
            publishedLabel={['stale', 'rebuilding', 'failed-preview'].includes(buildState)
              ? 'Previous published page'
              : 'Published page'}
            onNavigate={navigateTo}
            onOpenDefinition={(resource) => {
              setSelectedResource(resourceIdentity(resource));
              leaveProblemsFor('explore');
            }}
            onOpenPreview={(page, resource) => {
              setSelectedResource(resourceIdentity(resource));
              setSelectedSitePage(page.path);
              leaveProblemsFor('preview');
            }}
          />
        </details>
      )}
    </div>
  );
}

/** Cold-start progress uses the same honest transport presentation as project
 * opening: work is a status, while byte downloads get a measured counter/bar. */
function StartupProgress({ progress }: { progress: ProgressEvent }) {
  const presentation = presentProgress(progress);
  const pct = presentation.fraction != null ? Math.round(presentation.fraction * 100) : null;
  return (
    <div className="startup-progress" data-stage={progress.stage}>
      {pct != null && (
        <div className="startup-bar" role="progressbar" aria-label="Download progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="startup-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="startup-msg">
        {progress.fromCache && <span className="startup-cache">⚡ cached</span>}
        {progress.message}
        {presentation.byteLabel && <span className="progress-bytes">{presentation.byteLabel}</span>}
      </div>
    </div>
  );
}

/** Human stage labels for the project-open overlay. Keeps the tiny per-item
 *  `message` (which names the specific bundle/file) but headlines the PHASE so a
 *  narrow screen still reads what's happening. */
const OPEN_STAGE_LABEL: Record<ProgressEvent['stage'], string> = {
  wasm: 'Starting engine',
  manifest: 'Downloading project',
  'project-cache-hit': 'Reusing project',
  'project-verify': 'Verifying project',
  'project-unpack': 'Unpacking project',
  'project-store': 'Storing project',
  compile: 'Compiling project',
  snapshot: 'Preparing snapshots',
  'site-build': 'Building site',
  'preview-publish': 'Publishing preview',
  resolve: 'Resolving packages',
  'bundle-fetch': 'Fetching packages',
  'bundle-cache-hit': 'Loading packages',
  'bundle-unpack': 'Unpacking packages',
  'bundle-mount': 'Mounting packages',
  'registry-fetch': 'Fetching from registry',
  'package-blocked': 'Package unavailable',
  'lazy-fetch': 'Fetching snapshot data',
  ready: 'Ready',
};

/** Project-open progress is deliberately a single signal. Download stages show
 * measured MB (and a bar only when total bytes are known); compile/build stages
 * show their named work phase without a competing indefinite animation. */
function OpenProgress({ progress, since }: { progress: ProgressEvent; since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(0, Math.round((now - since) / 1000));
  const presentation = presentProgress(progress);
  const pct = presentation.fraction != null ? Math.round(presentation.fraction * 100) : null;
  return (
    <div className="open-progress" data-stage={progress.stage} role="status" aria-live="polite">
      {pct != null && (
        <div className="open-progress-bar" role="progressbar" aria-label="Download progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="open-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="open-progress-line">
        <span className="open-progress-stage">{OPEN_STAGE_LABEL[progress.stage]}</span>
        {progress.fromCache && <span className="open-progress-cache">⚡ from cache</span>}
        <span className="open-progress-msg">{progress.message}</span>
        {presentation.byteLabel && <span className="progress-bytes">{presentation.byteLabel}</span>}
        <span className="open-progress-elapsed">{elapsed}s</span>
      </div>
    </div>
  );
}
