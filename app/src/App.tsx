// The editor shell. It captures exact project snapshots, coordinates serialized
// compile/site builds in the worker, publishes only the latest preview
// generation, and wires Monaco/resource/snapshot/diagnostic views.

import { lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { BuildFailure } from './worker/client';
import type { BlockedPackage, EngineClient } from './worker/client';
import type { EngineStartup, EngineStartupFailure } from './worker/engineStartup';
import type {
  Workspace,
  WorkspaceCapture,
  WorkspaceRepository,
} from './vfs/workspace';
import { workspaceStartup } from './vfs/workspaceStartup';
import { loadProject, CATALOG_IGS } from './vfs/demoIg';
import type { CompileResult, Diagnostic, EngineVersion } from './worker/protocol';
import type { GeneratorSpec, OutputDescriptor } from './site/contract';
import {
  ensurePreviewServiceWorker,
  wirePreviewResponder,
  publishPreviewSource,
  restorePersistedPreviewSource,
} from './preview/previewWindow';
import { LatestTaskQueue, type TaskLease } from './build/latestTaskQueue';
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
import { FileTree } from './editor/FileTree';
import { DiagnosticsPanel } from './views/DiagnosticsPanel';
import { ResourceInspector } from './views/ResourceInspector';
import { LazyPane } from './views/LazyPane';
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
import type { ResourceView } from './views/resourceView';
import {
  definitionsArePending,
  deriveBuildState,
  ProjectOverview,
  settledBuildStatus,
  type WorkspaceMode,
} from './views/ProjectOverview';
import type { BuildEvent } from './worker/protocol';
import { presentProgress } from './progressPresentation';
import { epochMs, pointEvent, spanEvent } from './performance/timeline';

const CodeEditor = lazy(async () => {
  const module = await import('./editor/CodeEditor');
  return { default: module.CodeEditor };
});


interface BuildOutcome {
  ok: boolean;
  error?: string;
}

function generatorSpec(
  id: string,
  templateCoordinate: string,
  buildEpochSecs: number,
): GeneratorSpec {
  return id === CYCLE_GENERATOR
    ? { generator: 'cycle', buildEpochSecs, liquidAssetDirs: [] }
    : {
        generator: 'publisher',
        templateCoordinate,
        buildEpochSecs,
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

function startupFailureMessage(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '');
  return message || 'Unknown startup failure.';
}

type AppStartupStage = EngineStartupFailure['stage'] | 'project-store';

class AppStartupFailure extends Error {
  constructor(readonly stage: AppStartupStage, cause: unknown) {
    super(startupFailureMessage(cause), { cause });
    this.name = 'AppStartupFailure';
  }
}

/** Machine-readable trace consumed by the persistent-profile benchmark. */
function recordRuntimeMetric(event: BuildEvent): void {
  const debug = (window as unknown as {
    __igDebug?: { metrics?: Array<{ at: number; event: BuildEvent }> };
  }).__igDebug;
  debug?.metrics?.push({ at: performance.now(), event });
}

function useWidePreviewCompanion(onBeforeNarrow: () => void): boolean {
  const onBeforeNarrowRef = useRef(onBeforeNarrow);
  onBeforeNarrowRef.current = onBeforeNarrow;
  const [wide, setWide] = useState(
    () => typeof window !== 'undefined'
      && typeof window.matchMedia === 'function'
      && window.matchMedia('(min-width: 1200px)').matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(min-width: 1200px)');
    const update = () => {
      // Run before React hides the companion so focus inside its iframe can be
      // returned to the selected workspace tab rather than falling to <body>.
      if (!query.matches) onBeforeNarrowRef.current();
      setWide(query.matches);
    };
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return wide;
}

export function App({ startup }: { startup: EngineStartup }) {
  const engineRef = useRef<EngineClient | null>(startup.engine);
  const bootstrapMetricsRecordedRef = useRef(false);
  const previewWorkerStartupRef = useRef<Promise<boolean> | null>(null);
  const templateCatalogStartupRef = useRef<Promise<Record<string, TemplateCatalog>> | null>(null);
  const bootFailureHandledRef = useRef(false);
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
  const [bootError, setBootError] = useState<string | null>(null);
  // Cold-start progress (spec §1): staged phase + per-bundle progress.
  const [progress, setProgress] = useState<BuildEvent | null>(null);
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
  const [compileMs, setCompileMs] = useState<number | null>(null);
  // Authored local resources (input/{resources,examples}/**.json) for Explore.
  // SUSHI consumes them without re-emitting them as compiler outputs, so retain
  // their exact source declarations beside the byte-exact compiled list.
  const [predefinedResources, setPredefinedResources] = useState<ResourceView[]>([]);
  const [compiling, setCompiling] = useState(false);
  const [selectedResource, setSelectedResource] = useState<string | null>(null);
  const [resourceFilter, setResourceFilter] = useState('');
  const [projectLoaded, setProjectLoaded] = useState(false);
  const [projectName, setProjectName] = useState(() => projectDisplayName(projectIdRef.current));
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    () => initialWorkspaceFor(projectIdRef.current),
  );
  const previewPanelRef = useRef<HTMLElement | null>(null);
  const restoreFocusBeforeNarrowing = useCallback(() => {
    // Selected Preview remains visible and full-width below the breakpoint;
    // only a companion beside Author/Explore is about to disappear.
    if (workspaceMode === 'preview') return;
    const panel = previewPanelRef.current;
    if (!panel || !document.activeElement || !panel.contains(document.activeElement)) return;
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${workspaceMode}`)?.focus());
  }, [workspaceMode]);
  const widePreviewCompanion = useWidePreviewCompanion(restoreFocusBeforeNarrowing);
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
  // Site preview (immutable Build-driven).
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
    let bootFailed = false;
    const failBoot = (failure: { error: Error; stage: AppStartupStage }) => {
      if (cancelled || bootFailed) return;
      bootFailed = true;
      // StrictMode replays the effect with the same component state. Replayed
      // terminal failure must stop that setup too, without emitting a second
      // failure span or disposing the already-retired owner again.
      if (bootFailureHandledRef.current) return;
      bootFailureHandledRef.current = true;
      const message = startupFailureMessage(failure.error);
      recordRuntimeMetric(pointEvent('app.boot-failed', 'window', {
        stage: failure.stage,
        message,
      }));
      buildQueueRef.current.invalidate();
      engineRef.current = null;
      setOpeningSince(null);
      setCompiling(false);
      setSiteBuilding(false);
      setEngineReady(false);
      setBootError(message);
      // A startup failure or terminal Worker crash can only recover by loading a
      // fresh page. Retire all page-process ownership while the stable reload
      // surface remains visible.
      startup.dispose(failure.error);
    };
    const unsubscribeStartup = startup.subscribe((event) => {
      if (!cancelled) setProgress(event);
    });
    const unsubscribeFailure = startup.subscribeFailure(failBoot);
    void (async () => {
      if (bootFailed) return;
      const effectStartedMs = epochMs();
      const engine = startup.engine;
      engineRef.current = engine;
      const bootstrap = (window as unknown as {
        __igBootstrapTiming?: {
          navigationStartedMs: number;
          mainStartedMs: number;
          appModuleStartedMs: number;
          appModuleReadyMs: number;
          reactRenderStartedMs: number;
        };
      }).__igBootstrapTiming;
      if (bootstrap && !bootstrapMetricsRecordedRef.current) {
        bootstrapMetricsRecordedRef.current = true;
        recordRuntimeMetric(spanEvent('app.bootstrap', 'window', bootstrap.navigationStartedMs, {
          stage: 'manifest',
          message: 'Loaded application modules.',
        }, bootstrap.mainStartedMs));
        recordRuntimeMetric(spanEvent('app.module-import', 'window', bootstrap.appModuleStartedMs, {
          stage: 'manifest',
          message: 'Loaded the editor application module.',
        }, bootstrap.appModuleReadyMs));
        recordRuntimeMetric(spanEvent('app.react.commit', 'window', bootstrap.reactRenderStartedMs, {
          stage: 'manifest',
          message: 'Mounted application shell.',
        }, effectStartedMs));
        recordRuntimeMetric(pointEvent('app.boot-effect', 'window', {
          stage: 'manifest',
          message: 'Started application boot.',
        }, effectStartedMs));
      }
      // Preview-window (task #37): register the SW + render responder early so an
      // "Open site in new window" tab can be answered as soon as it exists.
      wirePreviewResponder((buildId, path) => {
        const build = engine.open(buildId);
        if (!build) return Promise.reject(new Error(`unknown build ${buildId}`));
        return build.render(path);
      });
      if (!previewWorkerStartupRef.current) {
        const previewWorkerStartedMs = epochMs();
        previewWorkerStartupRef.current = ensurePreviewServiceWorker().then((ok) => {
          recordRuntimeMetric(spanEvent('preview.service-worker', 'window', previewWorkerStartedMs, {
            stage: 'preview-publish',
            message: ok ? 'Preview Service Worker ready.' : 'Preview Service Worker unavailable.',
            fromCache: undefined,
          }));
          return ok;
        });
      }
      void previewWorkerStartupRef.current.then((ok) => {
        if (!cancelled) setPreviewCapable(ok);
      });
      const workspaceResult = workspaceStartup.open(
        projectIdRef.current,
        recordRuntimeMetric,
      ).then((result) => {
        if (cancelled || bootFailed) return result;
        const { repository, workspace } = result;
        setWorkspaces(repository);
        setProjectWorkspace(workspace);
        projectWorkspaceRef.current = workspace;

        // The preview host survives editor/worker restarts. Restore its validated
        // immutable pointer immediately so a persisted project can display the
        // last verified response while exact package resolution + prepare run.
        // This remains explicitly stale: only the successor prepare/publication
        // below can establish that today's closed input identity is unchanged.
        if (workspace) {
          const restoreStartedMs = epochMs();
          void restorePersistedPreviewSource(projectIdRef.current).then((publication) => {
            recordRuntimeMetric(spanEvent('preview.restore', 'window', restoreStartedMs, {
              stage: publication ? 'project-cache-hit' : 'project-verify',
              message: publication ? 'Restored prior verified preview.' : 'No prior preview restored.',
              fromCache: Boolean(publication),
            }));
            if (cancelled
              || bootFailed
              || !publication
              || projectIdRef.current !== publication.source.igId) return;
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
        return result;
      });

      // The process owner started this before App was imported. Workspace open,
      // stale-preview restoration, manifest fetch, and Worker/WASM startup have
      // therefore progressed concurrently; this is only their join point.
      const guardedWorkspaceResult = workspaceResult.catch((error: unknown) => {
        throw new AppStartupFailure('project-store', error);
      });
      const [{ workspace }, res] = await Promise.all([guardedWorkspaceResult, startup.ready]);
      if (cancelled || bootFailed) return;
      setVersion(res.version);
      setInitMs(res.events.find((event) => event.phase === 'engine.startup')?.durationMs ?? null);
      setEngineReady(true);

      // If OPFS already has a project (reload), compile it immediately.
      if (workspace) {
        setProjectLoaded(true);
        setProjectName(workspace.name || projectDisplayName(projectIdRef.current));
        const first = initialSourcePath(workspace);
        if (first) {
          setActivePath(first);
          setActiveText(workspace.read(first) ?? '');
        }
        setOpeningSince(Date.now());
        void runCompile(workspace, engine).finally(() => {
          if (!cancelled) setOpeningSince(null);
        });
      }
    })().catch((error: unknown) => {
      if (error instanceof AppStartupFailure) {
        failBoot({ error, stage: error.stage });
      } else {
        // EngineStartup publishes its more precise manifest/WASM classification
        // before this join rejection. This fallback covers only an unexpected
        // failure in the remaining boot coordinator.
        failBoot({ error: error instanceof Error ? error : new Error(String(error)), stage: 'wasm' });
      }
    });
    return () => {
      cancelled = true;
      unsubscribeStartup();
      unsubscribeFailure();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startup]);

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
    if (!templateCatalogStartupRef.current) {
      const catalogsStartedMs = epochMs();
      templateCatalogStartupRef.current = getCuratedCatalogs().then((cats) => {
        recordRuntimeMetric(spanEvent('template.catalogs', 'window', catalogsStartedMs, {
          stage: 'manifest',
          message: 'Loaded curated template catalogs.',
          fileCount: Object.keys(cats).length,
        }));
        return cats;
      }, (error: unknown) => {
        recordRuntimeMetric(pointEvent('template.catalogs.failed', 'window', {
          stage: 'manifest',
          message: `Template catalogs unavailable: ${startupFailureMessage(error)}`,
        }));
        throw error;
      });
    }
    void templateCatalogStartupRef.current.then((cats) => {
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
    }).catch(() => {
      // Catalogs have their own stale/pinned fallback ladder. An unexpected
      // failure is already recorded above and does not invalidate the engine.
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- one project crossing -> immutable Build -> atomic publication --------
  const performBuildSite = useCallback(async (
    capture: WorkspaceCapture,
    engine: EngineClient,
    genId: string,
    selectedTemplate: string,
    lease: TaskLease,
  ) => {
    const project = capture.revision;
    const report = (ev: BuildEvent) => {
      if (!lease.isLatest()) return;
      recordRuntimeMetric(ev);
      if (typeof ev.metrics?.compileProjectMs === 'number') {
        setCompileMs(ev.metrics.compileProjectMs);
      }
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
        const firstFsh = Object.keys(project.fsh).filter((path) => path.endsWith('.fsh')).sort()[0];
        const firstDeclared = firstFsh ? soleResourceDeclaredIn(allResources, firstFsh) : null;
        if (firstDeclared) return resourceIdentity(firstDeclared);
        const first = allResources.find((resource) => resource.resourceType === 'StructureDefinition' && resource.url);
        return first ? resourceIdentity(first) : allResources[0] ? resourceIdentity(allResources[0]) : null;
      });
    };
    try {
      const siteStartedMs = epochMs();
      const build = await engine.prepare(
        project,
        generatorSpec(genId, selectedTemplate, capture.buildEpochSecs),
        report,
      );
      // Compilation remains useful UI state even if catalog validation,
      // rendering, or preview publication subsequently fails.
      showCompiled(build.compilation);
      if (!lease.isLatest()) return;
      const catalog = await build.outputs();
      const pages = catalog.outputs.filter((output) => output.kind === 'page');
      report(spanEvent('site.pipeline-to-catalog', 'window', siteStartedMs, {
        stage: 'site-build',
        message: `Prepared ${pages.length} site pages.`,
        fileCount: pages.length,
      }));
      if (!lease.isLatest()) return;
      // Template loaded cleanly — remember it as the fallback + clear any prior
      // load error (#40).
      if (genId === PUBLISHER_GENERATOR) {
        if (capture.projectId !== TINY_PROJECT_ID) lastGoodTemplateRef.current = selectedTemplate;
        setTemplateError(null);
      }
      const nextGeneration = siteGenerationRef.current + 1;
      const publishStartedMs = epochMs();
      report(pointEvent('preview.publish-start', 'window', {
        stage: 'preview-publish',
        message: 'Publishing preview generation…',
      }, publishStartedMs));
      const published = await publishPreviewSource(
        {
          igId: capture.projectId,
          buildId: catalog.buildId,
          catalog,
        },
        nextGeneration,
        () => lease.isLatest(),
      );
      if (!published || !lease.isLatest()) return;
      report(spanEvent('preview.publish', 'window', publishStartedMs, {
        stage: 'preview-publish',
        message: `Published preview generation ${nextGeneration}.`,
        fileCount: pages.length,
      }));
      // Swap React state only after the SW acknowledges this exact handle/catalog.
      siteGenerationRef.current = nextGeneration;
      setSiteIgId(capture.projectId);
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
        if (e instanceof BuildFailure && e.detail.successfulCompilation) {
          showCompiled(e.detail.successfulCompilation);
        }
        setSiteError(String(e));
        setPreviewStale(true);
        throw e; // let selectTemplate see the failure so it can fall back
      }
    } finally {
      setSiteBuilding(false);
    }
  }, []);

  const enqueueSiteBuild = useCallback(async (
    workspace: Workspace,
    engine: EngineClient,
    genId: string,
  ) => {
    await buildQueueRef.current.enqueue((lease) => {
      const capture = workspace.capture(1700000000);
      const selectedTemplate = capture.projectId === TINY_PROJECT_ID
        ? tinyTemplateRef.current
        : localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
      return performBuildSite(capture, engine, genId, selectedTemplate, lease);
    });
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
  const executeCompile = useCallback(async (
    workspace: Workspace,
    engine: EngineClient,
    lease: TaskLease,
  ): Promise<BuildOutcome> => {
    if (!engine.initialized) return { ok: false, error: 'engine is not initialized' };
    // Capture only once this request owns the serialized engine. Workspace
    // projections are immutable and structurally shared, so edits can replace
    // a pending request without repeatedly encoding the whole project.
    const capture = workspace.capture(1700000000);
    const genId = localStorage.getItem(GENERATOR_KEY) || defaultGeneratorFor(capture.projectId);
    const selectedTemplate = capture.projectId === TINY_PROJECT_ID
      ? tinyTemplateRef.current
      : localStorage.getItem(TEMPLATE_KEY) || DEFAULT_TEMPLATE;
    let failure: unknown = null;
    if (lease.isLatest()) setCompiling(true);
    try {
      await performBuildSite(capture, engine, genId, selectedTemplate, lease);
      if (lease.isLatest()) setBlockedPackages([]);
    } catch (e) {
      failure = e;
      if (lease.isLatest() && e instanceof BuildFailure && e.detail.phase === 'compilation') {
        setPredefinedResources([]);
        setCompile({
          resources: [],
          diagnostics: [{ severity: 'error', message: `compile failed: ${String(e)}` }],
        });
        setCompileMs(0);
      }
    } finally {
      if (lease.isLatest()) setCompiling(false);
    }
    return failure == null ? { ok: true } : { ok: false, error: String(failure) };
  }, [performBuildSite]);

  const runCompile = useCallback(async (workspace: Workspace, engine: EngineClient): Promise<BuildOutcome> => {
    const outcome = await buildQueueRef.current.enqueue((lease) => executeCompile(workspace, engine, lease));
    if (!outcome.latest) return { ok: false, error: 'build superseded by a newer request' };
    return outcome.value;
  }, [executeCompile]);

  // ---- leading, latest-only compile on edit -------------------------------
  const scheduleCompile = useCallback(() => {
    if (!projectWorkspace || !engineRef.current) return;
    const editedWorkspace = projectWorkspace;
    const engine = engineRef.current;
    // enqueueLatest revokes the running lease immediately. Before work starts,
    // same-turn edits coalesce; during wasm, they replace the sole pending
    // successor. No fixed typing delay and no unbounded build backlog remain.
    void buildQueueRef.current.enqueueLatest(async (lease) => {
      if (projectWorkspaceRef.current !== editedWorkspace || engineRef.current !== engine) {
        return { ok: false, error: 'workspace changed before build started' } satisfies BuildOutcome;
      }
      return executeCompile(editedWorkspace, engine, lease);
    }).catch(() => {});
  }, [projectWorkspace, executeCompile]);

  // ---- open a baked project -------------------------------------------------
  const openProject = useCallback(async (projectId: string) => {
    if (!workspaces) return;
    const requestId = ++openRequestRef.current;
    const engine = engineRef.current;
    // Supersede current work immediately. Source acquisition targets an
    // inactive project workspace, so the current working copy stays coherent
    // if fetch/verification/import fails.
    buildQueueRef.current.invalidate();
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
    const emit = (ev: BuildEvent) => {
      if (openRequestRef.current !== requestId) return;
      recordRuntimeMetric(ev);
      setProgress(ev);
    };
    emit({ stage: 'manifest', message: `Loading ${projectId} project files…` });
    try {
      const meta = await loadProject(workspaces, projectId, emit);
      if (openRequestRef.current !== requestId) return;
      // The previous project remains editable while source acquisition runs.
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
      emit({ stage: 'bundle-mount', message: `Loaded ${meta.name} — ${meta.fileCount} files. Preparing guide…` });
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
      scheduleCompile();
    },
    [projectWorkspace, activePath, scheduleCompile],
  );

  const selectFile = useCallback(
    (path: string, knownOwner?: ResourceView | null) => {
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
    (file: string, line: number, owner: ResourceView | null) => {
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
  const previewCompanion = widePreviewCompanion
    && workspaceMode !== 'preview'
    && activatedModes.has('preview')
    && Boolean(currentProjectPages);
  const previewVisible = workspaceMode === 'preview' || previewCompanion;
  const previousPreviewVisibleRef = useRef(previewVisible);
  useEffect(() => {
    const wasVisible = previousPreviewVisibleRef.current;
    previousPreviewVisibleRef.current = previewVisible;
    if (!wasVisible || previewVisible) return;
    const panel = previewPanelRef.current;
    if (!panel || !document.activeElement || !panel.contains(document.activeElement)) return;
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${workspaceMode}`)?.focus());
  }, [previewVisible, workspaceMode]);
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
  const definitionsPending = definitionsArePending(buildState, resources.length);
  const statusMessage = openingSince != null
    ? null
    : bootError
      ? 'Editor startup failed.'
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
                buildMs={compileMs}
                resourceCount={compile ? resources.length : null}
                fileCount={projectLoaded ? paths.filter((path) => path.endsWith('.fsh')).length : null}
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
        {bootError && (
          <div className="open-error" role="alert">
            <div className="open-error-body">
              <strong>Couldn't start the editor.</strong> {bootError}
            </div>
            <div className="open-error-actions">
              <button className="btn" onClick={() => window.location.reload()}>
                Reload editor
              </button>
            </div>
          </div>
        )}
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
        {!bootError && projectLoaded && progress && !engineReady && openingSince == null && (
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
                  {engineReady ? 'Edit the tiny guide' : bootError ? 'Startup failed' : 'Starting engine…'}
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
            {!bootError && !engineReady && progress && <StartupProgress progress={progress} />}
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
                {workspaceMode === mode && (
                  <span
                    className={`workspace-state-indicator state-${buildState}`}
                    title={statusMessage ?? undefined}
                    aria-hidden="true"
                  />
                )}
                {mode === 'explore' && definitionsPending && <span className="tab-busy">Preparing</span>}
                {mode === 'preview' && siteBuilding && <span className="tab-busy">Building</span>}
              </button>
            ))}
          </nav>
          <div
            className="workspace-views"
            data-mode={workspaceMode}
            data-preview-companion={previewCompanion ? 'true' : undefined}
          >
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
                  <LazyPane loading="Loading source editor…">
                    <CodeEditor path={activePath} value={activeText} diagnostics={fileDiagnostics} onChange={onEdit} revealLine={revealLine} />
                  </LazyPane>
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
                    disabled={definitionsPending}
                    value={resourceFilter}
                    onChange={(event) => setResourceFilter(event.target.value)}
                  />
                </label>
                <div className="resource-list">
                  {definitionsPending && (
                    <div className="resource-list-pending">Preparing definitions…</div>
                  )}
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
                <select disabled={definitionsPending} value={selectedResource ?? ''} onChange={(event) => setSelectedResource(event.target.value)}>
                  <option value="" disabled>
                    {definitionsPending ? 'Waiting for compilation…' : 'Select a definition…'}
                  </option>
                  {filteredResources.map((resource) => {
                    const identity = resourceIdentity(resource);
                    return <option key={identity} value={identity}>{resource.resourceType}/{resource.id}</option>;
                  })}
                </select>
              </label>
              <section className="definition-pane">
                {workspaceMode === 'explore' && definitionsPending ? (
                  <div className="panel-empty definition-pending">
                    <span>Definitions will appear when compilation completes.</span>
                  </div>
                ) : workspaceMode === 'explore' && activeResource && engineRef.current ? (
                  <ResourceInspector resource={activeResource} allResources={resources} engine={engineRef.current} settingsVersion={settingsVersion} />
                ) : <div className="panel-empty">Select a compiled definition to inspect.</div>}
              </section>
            </section>

            <section
              ref={previewPanelRef}
              id="workspace-panel-preview"
              role={previewCompanion ? 'region' : 'tabpanel'}
              aria-labelledby="workspace-tab-preview"
              aria-busy={siteBuilding}
              className="workspace-view preview-workspace"
              hidden={!previewVisible}
            >
              {activatedModes.has('preview') && engineRef.current ? (
                <PreviewPane
                  igId={siteIgId}
                  pages={currentProjectPages}
                  building={siteBuilding}
                  error={siteError}
                  previewCapable={previewCapable}
                  currentPage={selectedSitePage}
                  onSelectPage={selectSitePage}
                  onPageLoad={(path, startedMs, endedMs) => {
                    recordRuntimeMetric(spanEvent('preview.page-load', 'window', startedMs, {
                      stage: 'ready',
                      label: path,
                      message: `Displayed preview page ${path}.`,
                    }, endedMs));
                  }}
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
function StartupProgress({ progress }: { progress: BuildEvent }) {
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
const OPEN_STAGE_LABEL: Record<BuildEvent['stage'], string> = {
  wasm: 'Starting engine',
  manifest: 'Downloading project',
  'project-cache-hit': 'Reusing project',
  'project-verify': 'Verifying project',
  'project-unpack': 'Unpacking project',
  'project-store': 'Storing project',
  compile: 'Compiling project',
  snapshot: 'Preparing full definition',
  'site-build': 'Building site',
  'preview-publish': 'Publishing preview',
  resolve: 'Resolving packages',
  'bundle-fetch': 'Fetching packages',
  'bundle-cache-hit': 'Loading packages',
  'bundle-unpack': 'Verifying packages',
  'bundle-mount': 'Mounting packages',
  'registry-fetch': 'Fetching from registry',
  'package-blocked': 'Package unavailable',
  'lazy-fetch': 'Loading package',
  ready: 'Ready',
};

/** Project-open progress is deliberately a single signal. Download stages show
 * measured MB (and a bar only when total bytes are known); compile/build stages
 * show their named work phase without a competing indefinite animation. */
function OpenProgress({ progress, since }: { progress: BuildEvent; since: number }) {
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
      <div
        className="open-progress-bar"
        role={pct != null ? 'progressbar' : undefined}
        aria-hidden={pct == null ? true : undefined}
        aria-label={pct != null ? 'Download progress' : undefined}
        aria-valuenow={pct ?? undefined}
        aria-valuemin={pct != null ? 0 : undefined}
        aria-valuemax={pct != null ? 100 : undefined}
      >
        <div className="open-progress-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      <div className="open-progress-line">
        <span className="open-progress-heading">
          <span className="open-progress-stage">{OPEN_STAGE_LABEL[progress.stage]}</span>
          {progress.fromCache && <span className="open-progress-cache">⚡ from cache</span>}
        </span>
        <span className="open-progress-msg" title={progress.message}>{progress.message}</span>
        {presentation.downloading && (
          <span className="progress-bytes" data-empty={presentation.byteLabel == null ? 'true' : undefined}>
            {presentation.byteLabel ?? '\u00a0'}
          </span>
        )}
        <span className="open-progress-elapsed">{elapsed}s</span>
      </div>
    </div>
  );
}
