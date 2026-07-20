import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const WORKER = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');
const CYCLE_RUNTIME = readFileSync(new URL('../src/worker/cycleRuntime.ts', import.meta.url), 'utf8');
const VITE_CONFIG = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

describe('lazy Cycle worker capability', () => {
  test('keeps every executable Cycle edge outside Publisher worker startup', () => {
    expect(WORKER).not.toMatch(/from ['"]@cycle\//u);
    expect(WORKER).toContain("import type { CycleBuildRuntime } from './cycleRuntime'");
    expect(WORKER).toContain("let cycleRuntimeModulePromise: Promise<typeof import('./cycleRuntime')> | null = null");
    expect(WORKER).toContain("cycleRuntimeModulePromise ??= import('./cycleRuntime')");
    expect(WORKER).not.toContain("const cycleRuntimeModulePromise = import('./cycleRuntime')");

    for (const module of [
      'closed-build',
      'open-site-build',
      'renderer-package',
      'output-receipt',
    ]) {
      expect(CYCLE_RUNTIME).toContain(`from '@cycle/core/${module}'`);
    }
    expect(CYCLE_RUNTIME).not.toContain("from './engine.worker'");
  });

  test('uses deterministic Node-style CommonJS initialization', () => {
    expect(VITE_CONFIG).toContain('commonjsOptions: { strictRequires: true }');
    expect(VITE_CONFIG).not.toContain('maxParallelFileOps');
  });

  test('loads the capability only in the Cycle preparation branch', () => {
    const cycleStart = WORKER.indexOf("} else if (prepared.generator === 'cycle') {");
    const publisherStart = WORKER.indexOf('} else {', cycleStart);
    const cycleBranch = WORKER.slice(
      cycleStart,
      publisherStart,
    );
    expect(cycleBranch).toContain('await loadCycleRuntimeModule()');
    expect(cycleBranch).toContain('await openCycleBuildRuntime(');
    expect(WORKER).toContain('Cycle transport omitted its closed SiteBuild');
    expect(cycleBranch.indexOf('await openCycleBuildRuntime('))
      .toBeLessThan(cycleBranch.indexOf('siteBuilds.install('));

    const publisherBranch = WORKER.slice(
      publisherStart,
      WORKER.indexOf('return {', publisherStart),
    );
    expect(publisherBranch).not.toContain('loadCycleRuntimeModule');
    expect(publisherBranch).toContain("kind: 'publisher'");
    expect(WORKER).toContain('Publisher transport redundantly returned its closed SiteBuild');

    const retainedBranch = WORKER.slice(
      WORKER.indexOf('if (retainedBeforeHostOpen)'),
      cycleStart,
    );
    expect(retainedBranch).toContain('siteBuilds.touch(prepared.buildId)');
    expect(retainedBranch).not.toContain('loadCycleRuntimeModule');
    expect(retainedBranch).not.toContain('openCycleBuildRuntime');
  });

  test('preserves the closed non-page and four-operation runtime semantics', () => {
    expect(CYCLE_RUNTIME).toContain('session.openRenderer(');
    expect(CYCLE_RUNTIME).toContain('rendererPackage.manifest.packageId');
    expect(CYCLE_RUNTIME).toContain('const render = async (path: string)');
    expect(CYCLE_RUNTIME).toContain("if (output.kind !== 'page') await runtime.render(output.file)");
    expect(CYCLE_RUNTIME).toContain('assertClosedNonPageCatalog(publicCatalog)');
    expect(CYCLE_RUNTIME).toContain('finalizeEnvelope: async () =>');
    expect(CYCLE_RUNTIME).toContain('return session.finalize(buildId)');

    const render = WORKER.slice(
      WORKER.indexOf('async render(handle, path)'),
      WORKER.indexOf('async finalize(handle)'),
    );
    const finalize = WORKER.slice(
      WORKER.indexOf('async finalize(handle)'),
      WORKER.indexOf('\n};', WORKER.indexOf('async finalize(handle)')),
    );
    expect(render).toContain('return runtime.render(path)');
    expect(finalize).toContain('await runtime.finalizeEnvelope()');
  });
});
