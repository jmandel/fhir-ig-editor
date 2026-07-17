#!/usr/bin/env node
// Run the canonical project benchmark across a repeatable project/mode matrix.
// This file is orchestration only: run-project-benchmark.sh remains the single
// owner of browser setup, measurement, contracts, and raw receipt semantics.

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactIdentity, benchmarkRecipeIdentity } from './benchmark-identity.mjs';

const HELP = `Usage:
  node scripts/benchmark-matrix.mjs [app/dist]

Runs sequentially and writes every raw project receipt plus aggregate.json to
BENCH_OUTPUT_DIR. The aggregate JSON is also the only stdout output.

Environment:
  BENCH_PROJECTS=tiny,ips,uscore,mcode   (default shown)
  BENCH_MODES=fast,throttled             (default shown; two composite modes)
  BENCH_REPEATS=3                        (default 3)
  BENCH_OUTPUT_DIR=/tmp/results          (default timestamped /tmp directory)
  BENCH_RESUME=1                         reuse only fully validated matching receipts
  BENCH_NETWORK_PROFILE=none             (applies to both modes)
  BENCH_FAST_NETWORK_PROFILE=none        (mode-specific override)
  BENCH_THROTTLED_NETWORK_PROFILE=none   (mode-specific override)
  BENCH_FAST_CPU_THROTTLE=1              (default 1)
  BENCH_THROTTLED_CHROME_CPU_QUOTA_PERCENT=25
                                           (whole-Chrome quota; integer; 0 disables)
  BENCH_WIDE_PREVIEW=0                     (set 1 only with fast mode)
  BENCH_SERVER_PORT_BASE=43000            (one unique port per run)
  BENCH_CDP_PORT_BASE=45000               (one unique port per run)

For a cheap smoke run:
  BENCH_PROJECTS=tiny BENCH_MODES=fast BENCH_REPEATS=1 \\
    node scripts/benchmark-matrix.mjs app/dist
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const runner = join(scriptDir, 'run-project-benchmark.sh');
const dist = resolve(repoRoot, process.argv[2] || 'app/dist');

function listSetting(name, fallback) {
  const values = (process.env[name] || fallback)
    .split(/[\s,]+/u)
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return [...new Set(values)];
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function throttleSetting(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${name} must be a number greater than or equal to 1`);
  }
  return value;
}

function quotaSetting(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error(`${name} must be an integer from 0 through 100`);
  }
  return value === 0 ? null : value;
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/gu, '-');
}

function summary(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    samples: sorted.length,
    median,
    min: sorted[0],
    max: sorted.at(-1),
  };
}

function aggregateNumericObjects(objects) {
  const keys = new Set(objects.flatMap((object) => Object.keys(object || {})));
  return Object.fromEntries([...keys].sort().flatMap((key) => {
    const value = summary(objects.map((object) => object?.[key]));
    return value == null ? [] : [[key, value]];
  }));
}

function eventForPhase(phase, phaseName) {
  return [...(phase.runtimeMetrics || [])].reverse()
    .find(({ event }) => event?.phase === phaseName)?.event || null;
}

function cacheObservations(phase) {
  const result = {};
  for (const { event } of phase.runtimeMetrics || []) {
    if (typeof event?.fromCache !== 'boolean') continue;
    const key = event.phase || `stage:${event.stage || 'unknown'}`;
    const current = result[key] || { hits: 0, observations: 0 };
    current.observations += 1;
    current.hits += event.fromCache ? 1 : 0;
    result[key] = current;
  }
  return result;
}

function aggregateCacheObservations(phases) {
  const perPhase = phases.map(cacheObservations);
  const keys = new Set(perPhase.flatMap((observations) => Object.keys(observations)));
  return Object.fromEntries([...keys].sort().map((key) => {
    const hits = perPhase.reduce((total, observations) => total + (observations[key]?.hits || 0), 0);
    const observations = perPhase.reduce(
      (total, value) => total + (value[key]?.observations || 0),
      0,
    );
    return [key, {
      hits,
      observations,
      hitRate: observations === 0 ? null : hits / observations,
    }];
  }));
}

function aggregatePhase(phases) {
  const prepareMetrics = phases.map((phase) => {
    const metrics = eventForPhase(phase, 'site.prepare')?.metrics || {};
    return Object.fromEntries(Object.entries(metrics).filter(([key, value]) =>
      Number.isFinite(value) && (key.endsWith('Ms') || key.endsWith('CacheHit'))));
  });
  const operationDurations = phases.map((phase) => Object.fromEntries(
    Object.entries(phase.operationTotals || {}).flatMap(([operation, metrics]) =>
      Number.isFinite(metrics?.summedDurationMs) ? [[operation, metrics.summedDurationMs]] : []),
  ));
  const phaseDurations = phases.map((phase) => Object.fromEntries(
    Object.entries(phase.phaseTotals || {}).flatMap(([name, metrics]) =>
      Number.isFinite(metrics?.summedDurationMs) ? [[name, metrics.summedDurationMs]] : []),
  ));
  const phaseCacheHits = phases.map((phase) => Object.fromEntries(
    Object.entries(phase.phaseTotals || {}).flatMap(([name, metrics]) =>
      Number.isFinite(metrics?.cacheHits) ? [[name, metrics.cacheHits]] : []),
  ));
  const network = phases.map((phase) => phase.network || {});

  return {
    durationMs: summary(phases.map((phase) => phase.durationMs)),
    criticalElapsedMs: summary(phases.map((phase) => phase.criticalElapsedMs)),
    observationElapsedMs: summary(phases.map((phase) => phase.observationElapsedMs)),
    summedWorkMs: aggregateNumericObjects(phases.map((phase) => phase.summedWork || {})),
    transferredBytes: summary(network.map((value) => value.encodedBytes)),
    packageLikeTransferredBytes: summary(network.map((value) => value.packageLikeEncodedBytes)),
    network: {
      requestCount: summary(network.map((value) => value.requestCount)),
      completedRequestCount: summary(network.map((value) => value.completedRequestCount)),
      crossedIntoPhaseCount: summary(network.map((value) => value.crossedIntoPhaseCount)),
      crossedOutOfPhaseCount: summary(network.map((value) => value.crossedOutOfPhaseCount)),
      pendingRequestCount: summary(network.map((value) => value.pendingRequestCount)),
      cacheServedCount: summary(network.map((value) => value.cacheServedCount)),
      cacheServedRatio: summary(network.map((value) =>
        value.requestCount > 0 ? value.cacheServedCount / value.requestCount : 0)),
    },
    memorySamples: summary(phases.map((phase) => phase.memory?.sampleCount)),
    memoryBytes: aggregateNumericObjects(phases.map((phase) => Object.fromEntries(
      Object.entries(phase.memory || {}).filter(([key, value]) =>
        key.endsWith('Bytes') && Number.isFinite(value)),
    ))),
    operationSummedDurationMs: aggregateNumericObjects(operationDurations),
    phaseSummedDurationMs: aggregateNumericObjects(phaseDurations),
    phaseCacheHits: aggregateNumericObjects(phaseCacheHits),
    prepareMetrics: aggregateNumericObjects(prepareMetrics),
    cacheObservations: aggregateCacheObservations(phases),
  };
}

function validateReceipt(receipt, expected) {
  if (receipt == null || typeof receipt !== 'object') throw new Error('receipt is not an object');
  if (receipt.ok !== true) throw new Error(receipt.error || 'receipt reports ok=false');
  if (receipt.environment?.projectId !== expected.project) {
    throw new Error(`receipt project ${receipt.environment?.projectId} != ${expected.project}`);
  }
  if (receipt.environment?.cpuThrottle !== expected.cpuThrottle
      || receipt.environment?.mobile !== expected.mobile
      || receipt.environment?.widePreview !== expected.widePreview
      || receipt.environment?.networkProfile !== expected.networkProfile
      || receipt.environment?.processCpuQuotaPercent !== expected.processCpuQuotaPercent
      || receipt.environment?.executionClass !== expected.executionClass) {
    throw new Error(`receipt environment does not match requested mode ${expected.mode}`);
  }
  if (expected.networkProfile !== 'none') {
    const coverage = receipt.instrumentation?.networkRuleCoverage;
    if (coverage?.ruleIds?.length !== 1
        || coverage.page?.provenRequestCount <= 0
        || coverage.page?.unprovenRequestCount !== 0
        || coverage.dedicatedWorker?.unprovenRequestCount !== 0
        || coverage.engineWorker?.provenRequestCount <= 0
        || coverage.engineWorker?.unprovenRequestCount !== 0
        || !Array.isArray(coverage.unprofiledWorkerEntries)) {
      throw new Error('receipt does not prove the requested network rule on page and Worker requests');
    }
  }
  for (const phaseName of ['coldStart', 'warmHardReload', 'cyclePreparation', 'sameWorkerReopen']) {
    if (!Number.isFinite(receipt.phases?.[phaseName]?.durationMs)) {
      throw new Error(`receipt is missing ${phaseName}.durationMs`);
    }
    if (receipt.phases[phaseName].network?.pendingRequestCount !== 0
        || receipt.phases[phaseName].network?.crossedIntoPhaseCount !== 0
        || receipt.phases[phaseName].network?.crossedOutOfPhaseCount !== 0) {
      throw new Error(`receipt ${phaseName} network boundary is open`);
    }
  }
  if (!Number.isFinite(receipt.phases?.representativeEdit?.criticalElapsedMs)) {
    throw new Error('receipt is missing representativeEdit.criticalElapsedMs');
  }
  const expectedDebounceMs = 0;
  if (receipt.phases.representativeEdit.explicitDebounceMs !== expectedDebounceMs
      || receipt.phases.representativeEdit.scheduling !== 'leading-latest-only') {
    throw new Error(
      `receipt edit debounce ${receipt.phases.representativeEdit.explicitDebounceMs}ms `
      + `or scheduler ${receipt.phases.representativeEdit.scheduling} does not match the leading latest-only contract`,
    );
  }
  if (receipt.contracts?.firstPreview?.coldRenderObserved !== true
      || receipt.contracts?.firstPreview?.coldPageLoaded !== true
      || receipt.contracts?.representativeEdit?.renderObserved !== true
      || receipt.contracts?.representativeEdit?.hotUpdateObserved !== true
      || receipt.contracts?.representativeEdit?.exactRenderObserved !== true
      || !receipt.contracts?.representativeEdit?.renderBuildId
      || receipt.contracts?.representativeEdit?.previousPreviewRetained !== true
      || receipt.contracts?.representativeEdit?.previousPreviewContinuouslyVisible
        !== expected.widePreview
      || receipt.contracts?.representativeEdit?.exactSuccessorVisible !== true) {
    throw new Error('receipt did not prove first render/page-load and edited hot update');
  }
  const bindings = receipt.phases?.representativeEdit?.previewBindings;
  const previousBinding = bindings?.previousVisible;
  const retainedBinding = bindings?.retainedWhileAuthoring;
  const successorBinding = bindings?.successorVisible;
  const validSha = (value) => /^[0-9a-f]{64}$/u.test(value || '');
  if (previousBinding?.generator !== expected.project
      || previousBinding?.path !== receipt.contracts.representativeEdit.previewPath
      || previousBinding?.mounted !== true
      || previousBinding?.visible !== true
      || previousBinding?.fallback !== false
      || previousBinding?.readyState !== 'complete'
      || !Number.isSafeInteger(previousBinding?.generation)
      || !validSha(previousBinding?.contentSha256)
      || retainedBinding?.generator !== previousBinding.generator
      || retainedBinding?.path !== previousBinding.path
      || retainedBinding?.generation !== previousBinding.generation
      || retainedBinding?.contentSha256 !== previousBinding.contentSha256
      || retainedBinding?.mounted !== true
      || retainedBinding?.visible !== expected.widePreview
      || retainedBinding?.fallback !== false
      || successorBinding?.generator !== previousBinding.generator
      || successorBinding?.path !== previousBinding.path
      || successorBinding?.generation <= previousBinding.generation
      || successorBinding?.contentSha256 === previousBinding.contentSha256
      || !validSha(successorBinding?.contentSha256)
      || successorBinding?.mounted !== true
      || successorBinding?.visible !== true
      || successorBinding?.fallback !== false
      || successorBinding?.readyState !== 'complete') {
    throw new Error('receipt does not bind the retained and successor preview documents exactly');
  }
  if (expected.widePreview) {
    const continuity = bindings?.widePreviewContinuity;
    const baseline = bindings?.widePreviewBaseline;
    if (baseline?.sameIframeNode !== true
        || baseline?.iframeCount !== 1
        || baseline?.authorSelected !== true
        || baseline?.previewRole !== 'region'
        || baseline?.viewportWidth !== 1440
        || baseline?.primaryWidth < 720
        || baseline?.previewWidth < 420
        || baseline?.sideBySide !== true
        || continuity?.sameIframeNode !== true
        || continuity?.maximumPreviewIframeCount !== 1
        || continuity?.previousVerifiedVisibleDuringBuild !== true
        || continuity?.successorObserved !== true
        || continuity?.primaryWorkspaceStayedSelected !== true
        || continuity?.currentUrlStateAndHistoryLengthPreserved !== true
        || continuity?.scrollPreserved !== true
        || !(continuity?.baselineScrollY > 0)
        || continuity?.layout?.sideBySide !== true) {
      throw new Error('receipt does not prove wide preview continuity');
    }
  }
  const selectedPipeline = receipt.phases?.representativeEdit?.selectedPagePipeline;
  const commonSelectedPipelineInvalid = !selectedPipeline?.buildId
      || selectedPipeline.buildId !== receipt.contracts.representativeEdit.renderBuildId
      || selectedPipeline.path !== receipt.contracts.representativeEdit.previewPath
      || !Number.isFinite(selectedPipeline.render?.startMs)
      || !Number.isFinite(selectedPipeline.render?.endMs)
      || !Number.isFinite(selectedPipeline.render?.durationMs)
      || !Number.isFinite(selectedPipeline.readyAtMs)
      || !Number.isFinite(selectedPipeline.successorVisibleAtMs)
      || selectedPipeline.render.startMs > selectedPipeline.render.endMs;
  const canonicalPipelineOk = selectedPipeline?.mode === 'canonical-render'
    && selectedPipeline.render.endMs <= selectedPipeline.successorVisibleAtMs;
  if (commonSelectedPipelineInvalid
      || !canonicalPipelineOk) {
    throw new Error('receipt is missing the exact selected-page render stage');
  }
  if (!receipt.provenance?.artifact?.sha256
      || !receipt.provenance?.engine?.commit
      || !receipt.provenance?.host?.architecture) {
    throw new Error('receipt provenance is incomplete');
  }
  if (receipt.provenance?.runner?.recipeSha256 !== expected.runnerRecipeSha256) {
    throw new Error(
      `receipt runner recipe ${receipt.provenance?.runner?.recipeSha256 || 'missing'} `
      + `!= ${expected.runnerRecipeSha256}`,
    );
  }
}

function runChild(environment) {
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn('bash', [runner, dist], {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
    }));
  });
}

async function emit(report, outputDir) {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(outputDir, 'aggregate.json'), json);
  process.stdout.write(json);
}

async function main() {
  const projects = listSetting('BENCH_PROJECTS', 'tiny,ips,uscore,mcode');
  const modes = listSetting('BENCH_MODES', 'fast,throttled');
  const repeats = positiveInteger('BENCH_REPEATS', 3);
  const networkDefault = process.env.BENCH_NETWORK_PROFILE || 'none';
  const widePreview = process.env.BENCH_WIDE_PREVIEW === '1';
  if (process.env.BENCH_WIDE_PREVIEW != null
      && !['0', '1'].includes(process.env.BENCH_WIDE_PREVIEW)) {
    throw new Error('BENCH_WIDE_PREVIEW must be 0 or 1');
  }
  const modeSettings = {
    fast: {
      executionClass: 'fast',
      cpuThrottle: throttleSetting('BENCH_FAST_CPU_THROTTLE', 1),
      mobile: false,
      widePreview,
      networkProfile: process.env.BENCH_FAST_NETWORK_PROFILE || networkDefault,
      processCpuQuotaPercent: null,
    },
    throttled: {
      executionClass: 'throttled',
      cpuThrottle: 1,
      mobile: true,
      widePreview: false,
      networkProfile: process.env.BENCH_THROTTLED_NETWORK_PROFILE || networkDefault,
      processCpuQuotaPercent: quotaSetting(
        'BENCH_THROTTLED_CHROME_CPU_QUOTA_PERCENT',
        25,
      ),
    },
  };
  for (const mode of modes) {
    if (!Object.hasOwn(modeSettings, mode)) {
      throw new Error(`unknown BENCH_MODES value ${mode}; expected fast or throttled`);
    }
    const setting = modeSettings[mode];
    if (setting.cpuThrottle > 1 && setting.processCpuQuotaPercent != null) {
      throw new Error(
        `${mode} requests both page CPU throttling and a whole-Chrome CPU quota; `
        + 'set one control to 1/0 so benchmark slowdown has a single cause',
      );
    }
    if (widePreview && setting.mobile) {
      throw new Error('BENCH_WIDE_PREVIEW is available only in a non-mobile mode');
    }
  }

  const serverPortBase = positiveInteger('BENCH_SERVER_PORT_BASE', 43000);
  const cdpPortBase = positiveInteger('BENCH_CDP_PORT_BASE', 45000);
  const runCount = projects.length * modes.length * repeats;
  if (serverPortBase + runCount > 65536 || cdpPortBase + runCount > 65536) {
    throw new Error('benchmark matrix ports exceed 65535');
  }
  const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const outputDir = resolve(process.env.BENCH_OUTPUT_DIR
    || `/tmp/fhir-ig-benchmark-matrix-${timestamp}`);
  await mkdir(outputDir, { recursive: true });
  const resume = process.env.BENCH_RESUME === '1';
  const artifact = await artifactIdentity(dist);
  const runnerRecipeSha256 = await benchmarkRecipeIdentity(repoRoot);

  const baseReport = {
    schemaVersion: 2,
    benchmark: 'fhir-ig-editor-performance-matrix',
    ok: false,
    generatedAt: new Date().toISOString(),
    configuration: {
      dist,
      outputDir,
      resume,
      artifact,
      runnerRecipeSha256,
      projects,
      modes,
      repeats,
      basePath: process.env.BASE_PATH || '/fhir-ig-editor/',
      widePreview,
      modeSettings: Object.fromEntries(modes.map((mode) => [mode, modeSettings[mode]])),
      dimensions: {
        project: 'four representative guides',
        executionClass: 'two composite fast/throttled modes; no Cartesian CPU/network/device expansion',
        cacheState: 'cold, persistent-cache, and retained-runtime phases run sequentially in every receipt',
        edit: 'one declarative representative source edit per project',
      },
    },
    receipts: [],
    aggregates: {},
  };
  const completed = new Map();
  let index = 0;

  for (const project of projects) {
    for (const mode of modes) {
      const setting = modeSettings[mode];
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const filename = `${safeName(project)}--${safeName(mode)}--${repeat}.json`;
        const serverPort = serverPortBase + index;
        const cdpPort = cdpPortBase + index;
        index += 1;
        process.stderr.write(
          `[benchmark-matrix] ${project}/${mode} repeat ${repeat}/${repeats} `
          + `(ports ${serverPort}/${cdpPort})\n`,
        );
        let child = null;
        let receipt;
        let reused = false;
        try {
          if (resume) {
            const existing = await readFile(join(outputDir, filename), 'utf8').catch(() => null);
            if (existing != null) {
              try {
                const candidate = JSON.parse(existing);
                validateReceipt(candidate, { project, mode, runnerRecipeSha256, ...setting });
                if (candidate.provenance.artifact.sha256 !== artifact.sha256
                    || candidate.provenance.artifact.fileCount !== artifact.fileCount
                    || candidate.provenance.artifact.byteLength !== artifact.byteLength) {
                  throw new Error(`receipt artifact does not match frozen dist ${artifact.sha256}`);
                }
                receipt = candidate;
                reused = true;
              } catch (error) {
                process.stderr.write(
                  `[benchmark-matrix] ${filename} is not reusable; rerunning: `
                  + `${String(error?.message || error)}\n`,
                );
              }
            }
          }
          if (!reused) {
            child = await runChild({
              BASE_PATH: process.env.BASE_PATH || '/fhir-ig-editor/',
              BENCH_PROJECT: project,
              BENCH_EXECUTION_CLASS: setting.executionClass,
              BENCH_CPU_THROTTLE: String(setting.cpuThrottle),
              BENCH_MOBILE: setting.mobile ? '1' : '0',
              BENCH_WIDE_PREVIEW: setting.widePreview ? '1' : '0',
              BENCH_NETWORK_PROFILE: setting.networkProfile,
              BENCH_CHROME_CPU_QUOTA_PERCENT: setting.processCpuQuotaPercent == null
                ? ''
                : String(setting.processCpuQuotaPercent),
              BENCH_EDIT: '1',
              BENCH_EXPECTED_RUNNER_RECIPE_SHA256: runnerRecipeSha256,
              SERVER_PORT: String(serverPort),
              CDP_PORT: String(cdpPort),
            });
            await writeFile(join(outputDir, filename), child.stdout);
            receipt = JSON.parse(child.stdout);
          }
          validateReceipt(receipt, { project, mode, runnerRecipeSha256, ...setting });
          if (receipt.provenance.artifact.sha256 !== artifact.sha256
              || receipt.provenance.artifact.fileCount !== artifact.fileCount
              || receipt.provenance.artifact.byteLength !== artifact.byteLength) {
            throw new Error(`receipt artifact does not match frozen dist ${artifact.sha256}`);
          }
          if (child && (child.code !== 0 || child.signal != null)) {
            throw new Error(`child exited with code ${child.code} signal ${child.signal}`);
          }
          if (reused) process.stderr.write(`[benchmark-matrix] reused validated ${filename}\n`);
        } catch (error) {
          baseReport.failure = {
            project,
            mode,
            repeat,
            receipt: filename,
            childExitCode: child?.code ?? null,
            childSignal: child?.signal ?? null,
            error: String(error?.message || error),
          };
          await emit(baseReport, outputDir);
          process.exitCode = 1;
          return;
        }

        baseReport.receipts.push({
          project,
          mode,
          repeat,
          file: relative(outputDir, join(outputDir, filename)),
          serverPort,
          cdpPort,
          executionClass: receipt.environment.executionClass,
          processCpuQuotaPercent: receipt.environment.processCpuQuotaPercent,
          artifactSha256: receipt.provenance.artifact.sha256,
          engineCommit: receipt.provenance.engine.commit,
          reused,
        });
        const key = `${project}\u0000${mode}`;
        const values = completed.get(key) || [];
        values.push(receipt);
        completed.set(key, values);
      }
    }
  }

  for (const project of projects) {
    baseReport.aggregates[project] = {};
    for (const mode of modes) {
      const reports = completed.get(`${project}\u0000${mode}`) || [];
      baseReport.aggregates[project][mode] = {
        samples: reports.length,
        phases: Object.fromEntries(
          [
            'coldStart',
            'warmHardReload',
            'representativeEdit',
            'cyclePreparation',
            'sameWorkerReopen',
          ].map((phaseName) => [
            phaseName,
            aggregatePhase(reports.map((report) => report.phases[phaseName])),
          ]),
        ),
        processMemory: aggregateNumericObjects(reports.map((report) => ({
          observedPeakProcessTreeRssBytes:
            report.instrumentation?.processMemory?.observedPeakProcessTreeRssBytes,
          observedPeakProcessCount:
            report.instrumentation?.processMemory?.observedPeakProcessCount,
        }))),
      };
    }
  }
  baseReport.ok = true;
  await emit(baseReport, outputDir);
}

main().catch((error) => {
  process.stderr.write(`[benchmark-matrix] ${error?.stack || error}\n`);
  process.exitCode = 1;
});
