import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CONTRACT = readFileSync(new URL('../src/site/contract.ts', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');
const PROTOCOL = readFileSync(new URL('../src/worker/protocol.ts', import.meta.url), 'utf8');
const INSPECTOR = readFileSync(new URL('../src/views/ResourceInspector.tsx', import.meta.url), 'utf8');

describe('prepare timing sidecar', () => {
  test('exposes the duplicate-path phases without adding a site operation', () => {
    for (const field of [
      'projectRevisionMs',
      'packageLockMs',
      'preparedGuideKeyMs',
      'preparedGuideMs',
      'preparedGuideCacheHit',
      'siteBuildCacheHit',
      'templateMaterializeMs',
      'publisherRuntimeMs',
      'publisherModelMs',
      'renderSemanticsCacheHit',
      'renderModelMs',
      'catalogMs',
    ]) {
      expect(CONTRACT).toContain(`${field}:`);
      expect(CLIENT).toContain(`result.metrics.rust.${field}`);
    }
    expect(PROTOCOL).toContain("prepare: { args: [project: ProjectRevision, spec: GeneratorSpec]; result: PrepareResult }");
    expect(PROTOCOL).not.toContain('prepareMetrics:');
  });

  test('separates compiler, Rust preparation, and post-Rust host work', () => {
    expect(WORKER).toContain('compileProjectMs: compiled.buildMs');
    expect(WORKER).toContain('const rustBoundaryStarted = performance.now()');
    expect(WORKER).toContain('Math.max(0, rustBoundaryMs - compiled.buildMs)');
    expect(WORKER).toContain('const hostPrepareStarted = performance.now()');
    expect(WORKER).toContain('rust: prepared.metrics');
    expect(CONTRACT).toContain('compileProjectMs: number');
    expect(CONTRACT).toContain('rustPrepareMs: number');
    expect(CONTRACT).toContain('hostPrepareMs: number');
  });

  test('preserves a typed successful compile across later preparation failure', () => {
    expect(WORKER).toContain("status: 'siteFailed'");
    expect(WORKER).toContain("result.status === 'siteFailed'");
    expect(WORKER).toContain("new PrepareOperationError(result.error, 'site', compiled)");
    expect(WORKER).toContain("throw new PrepareOperationError(String(error), 'compile')");
    expect(WORKER).toContain("throw new PrepareOperationError(String(error), 'site', compiled)");
    expect(WORKER).not.toContain("message.includes('compile')");
    expect(WORKER).not.toContain('compileProject(filesJson:');
    expect(PROTOCOL).toContain("{ operation: 'prepare'; stage: 'site'; compiled: CompileResult }");
  });

  test('keeps the deferred R5 bundle off the site-preparation path', () => {
    const snapshot = CLIENT.slice(
      CLIENT.indexOf('async snapshot(url: string)'),
      CLIENT.indexOf('async expandValueSet'),
    );
    const prepare = CLIENT.slice(
      CLIENT.indexOf('async prepare(project: ProjectRevision'),
      CLIENT.indexOf('async outputs(handle:'),
    );
    expect(snapshot).toContain('await this.ensureSnapshotBundles()');
    expect(prepare).not.toContain('ensureSnapshotBundles');
    expect(INSPECTOR).toContain("useState<Tab>('differential')");
    expect(INSPECTOR).toContain("effectiveTab === 'snapshot'");
    expect(INSPECTOR).toContain('<SnapshotTree');
    expect(INSPECTOR).toContain('Generate snapshot');
  });

  test('uses the media type returned by Rust without re-reading the catalog', () => {
    const render = WORKER.slice(
      WORKER.indexOf('async render(handle, path)'),
      WORKER.indexOf('async finalize(handle)'),
    );
    expect(render).toContain('unwrap<RenderedOutput>(s.render(handle, path))');
    expect(render).toContain('return rendered');
    expect(render).not.toContain('s.outputs(handle)');
  });
});
