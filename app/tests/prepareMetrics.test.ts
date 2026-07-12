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
      'publisherRecipeAssetsCacheHit',
      'templateMaterializeMs',
      'publisherRuntimeMs',
      'publisherModelMs',
      'renderSemanticsCacheHit',
      'renderModelMs',
      'outputCatalogMs',
      'publisherArtifactsMs',
      'siteBuildCloseMs',
      'closureVerifyMs',
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
    expect(INSPECTOR).toContain('Full definition');
    expect(INSPECTOR).toContain('FHIR snapshot: the complete definition');
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

  test('publishes only changed Rust ContentRefs during one worker lifetime', () => {
    expect(WORKER).toContain('const publishedRustContent = new Set<string>()');
    expect(WORKER).toContain("`${content.sha256}\\u0000${content.byteLength}\\u0000${content.mediaType ?? ''}`");
    const publish = WORKER.slice(
      WORKER.indexOf('async function publishRustContent('),
      WORKER.indexOf('function publicCycleDescriptor'),
    );
    expect(publish).toContain('if (publishedRustContent.has(key)) return');
    expect(publish).toContain('if (await contentStore.get(content))');
    expect(publish).toContain('publishedRustContent.add(key)');
    expect(publish.indexOf('await storeExactContent')).toBeLessThan(
      publish.lastIndexOf('publishedRustContent.add(key)'),
    );
  });

  test('keeps a package-heavy guide only across a lightweight external Cycle successor', () => {
    expect(CLIENT).toContain("project.projectId !== 'cycle' || spec.generator !== 'cycle'");
    expect(CLIENT).toContain('MAX_RETAINED_CYCLE_SUCCESSOR_FILES = 128');
    expect(CLIENT).toContain('MAX_RETAINED_CYCLE_SUCCESSOR_CODE_UNITS = 16 * 1024 * 1024');
    expect(CLIENT).toContain('this.lastCompiledResourceCount === 0 && !smallCycleSuccessor');
    expect(CLIENT).toContain('this.preparedConfigs.length >= 2');
  });

  test('rejects a warm pointer whose selected artifact decodes to another label', () => {
    const stage = WORKER.slice(
      WORKER.indexOf('for (const item of inputs)'),
      WORKER.indexOf('commitResult = unwrap<PreparedCommitResult>(s.commitPreparedMount())'),
    );
    expect(stage).toContain('const staged = unwrap<{ label: string }>(');
    expect(stage).toContain('if (staged.label !== pointer.label)');
    expect(WORKER.indexOf('if (staged.label !== pointer.label)')).toBeLessThan(
      WORKER.indexOf('commitResult = unwrap<PreparedCommitResult>(s.commitPreparedMount())'),
    );
  });

  test('stages warm and cold package carriers in one atomic ordered transaction', () => {
    const mount = WORKER.slice(
      WORKER.indexOf('async mountPackages(packages: PackageMountInput[])'),
      WORKER.indexOf('async resolveProject(config, versionIndex)'),
    );
    expect(mount).not.toContain('requires an all-raw or all-prepared transaction');
    expect(mount).toContain('unwrap(s.beginPreparedMount(inputs.length))');
    expect(mount).toContain('for (const item of inputs)');
    expect(mount).toContain("if (item.kind === 'prepared')");
    expect(mount).toContain('const { spec, transportIdentity } = item');
    expect(mount).toContain('s.commitPreparedMount()');
    expect(CLIENT).not.toContain('if (hasRaw && hasPrepared)');
  });
});
