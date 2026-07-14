import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CONTRACT = readFileSync(new URL('../src/site/contract.ts', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');
const PROTOCOL = readFileSync(new URL('../src/worker/protocol.ts', import.meta.url), 'utf8');
const INSPECTOR = readFileSync(new URL('../src/views/ResourceInspector.tsx', import.meta.url), 'utf8');
const E2E = readFileSync(new URL('../../scripts/verify-e2e.mjs', import.meta.url), 'utf8');

describe('canonical build observations and failures', () => {
  test('keeps worker and renderer transport out of the public Build contract', () => {
    expect(CONTRACT).toContain('export interface Build');
    expect(CONTRACT).toContain('outputs(): Promise<OutputCatalog>');
    expect(CONTRACT).toContain('render(path: string): Promise<ContentRef>');
    expect(CONTRACT).toContain('finalize(): Promise<SiteOutput>');
    for (const privateTransport of [
      'PrepareResult',
      'PreparedProjectResult',
      'RendererImplementation',
      'SiteOutputFile',
      'PreparedExport',
      'PackageMountResult',
      'ResolutionStep',
      'ApiEnvelope',
    ]) {
      expect(CONTRACT).not.toContain(privateTransport);
    }
    expect(PROTOCOL).toContain("from '../site/contract.generated'");
    expect(WORKER).toContain("from '../site/contract.generated'");
  });

  test('carries preparation observations only through BuildEvent', () => {
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
      expect(CLIENT).not.toContain(`result.metrics.rust.${field}`);
    }
    expect(PROTOCOL).toContain("prepare: { args: [project: ProjectRevision, spec: GeneratorSpec]; result: PrepareTransportResult }");
    expect(PROTOCOL).toContain('events: BuildEvent[]');
    expect(CLIENT).toContain('for (const event of result.events)');
    expect(PROTOCOL).not.toContain('RustPrepareMetrics');
    expect(PROTOCOL).not.toContain('prepareMetrics:');
    expect(PROTOCOL).not.toContain('rustPrepareMs: number');
    expect(CONTRACT).not.toContain('RustPrepareMetrics');
  });

  test('reads warm-reuse proof from the Rust prepare event, not a later host timing event', () => {
    expect(E2E).toContain("event?.operation === 'prepare'");
    expect(E2E).toContain("Object.hasOwn(event.metrics, 'snapshotCompletedLocalCacheHit')");
  });

  test('reports compiler, Rust boundary, and host opening through events', () => {
    expect(WORKER).toContain('const rustBoundaryStarted = performance.now()');
    expect(WORKER).toContain('const hostPrepareStarted = performance.now()');
    expect(WORKER).toContain('...result.events');
    expect(WORKER).toContain('rustBoundaryMs');
    expect(WORKER).toContain('hostPrepareMs');
    expect(WORKER).not.toContain('rust: prepared.metrics');
  });

  test('preserves a typed successful compile across later preparation failure', () => {
    expect(WORKER).toContain('class EngineBuildFailure extends Error');
    expect(WORKER).toContain('(error) => new EngineBuildFailure(error)');
    expect(WORKER).toContain('unwrapApiEnvelope<T, BuildError<CompileResult>>');
    expect(WORKER).toContain('successfulCompilation: compiled');
    expect(WORKER).not.toContain('error.detail.successfulCompilation =');
    expect(WORKER).not.toContain("status: 'siteFailed'");
    expect(WORKER).not.toContain('PrepareOperationError');
    expect(WORKER).not.toContain("message.includes('compile')");
    expect(WORKER).not.toContain('compileProject(filesJson:');
    expect(PROTOCOL).toContain('error: BuildError<CompileResult>');
    expect(CLIENT).toContain('class BuildFailure extends Error');
    expect(CLIENT).toContain('readonly detail: BuildError<CompileResult>');
  });

  test('keeps the deferred R5 bundle off the site-preparation path', () => {
    const snapshot = CLIENT.slice(
      CLIENT.indexOf('async snapshot('),
      CLIENT.indexOf('async expandValueSet'),
    );
    const prepare = CLIENT.slice(
      CLIENT.indexOf('async prepare('),
      CLIENT.indexOf('open(buildId:'),
    );
    expect(snapshot).toContain('await this.ensureSnapshotBundles(report)');
    expect(prepare).not.toContain('ensureSnapshotBundles');
    expect(INSPECTOR).toContain("useState<Tab>('differential')");
    expect(INSPECTOR).toContain("effectiveTab === 'snapshot'");
    expect(INSPECTOR).toContain('<SnapshotTree');
    expect(INSPECTOR).toContain('Full definition');
    expect(INSPECTOR).toContain('FHIR snapshot: the complete definition');
  });

  test('returns the rendered ContentRef without re-reading the catalog', () => {
    const render = WORKER.slice(
      WORKER.indexOf('async render(handle, path)'),
      WORKER.indexOf('async finalize(handle)'),
    );
    expect(render).toContain('unwrapBuild<ContentRef>(s.render(handle, path))');
    expect(render).toContain('return content');
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
    expect(CLIENT).toContain("spec.generator !== 'cycle'");
    expect(CLIENT).not.toContain('project.projectId');
    expect(CLIENT).toContain('MAX_RETAINED_CYCLE_SUCCESSOR_FILES = 128');
    expect(CLIENT).toContain('MAX_RETAINED_CYCLE_SUCCESSOR_CODE_UNITS = 16 * 1024 * 1024');
    expect(CLIENT).toContain('this.lastCompiledResourceCount === 0 && !smallCycleSuccessor');
    expect(CLIENT).toContain('this.preparedConfigs.length >= 2');
  });

  test('rejects a warm pointer whose selected artifact decodes to another label', () => {
    const stage = WORKER.slice(
      WORKER.indexOf('for (const item of inputs)'),
      WORKER.indexOf('commitResult = unwrap<PackageMountResult>(s.commitPreparedMount())'),
    );
    expect(stage).toContain('const staged = unwrap<PreparedStageResult>(');
    expect(stage).toContain('if (staged.label !== pointer.label)');
    expect(WORKER.indexOf('if (staged.label !== pointer.label)')).toBeLessThan(
      WORKER.indexOf('commitResult = unwrap<PackageMountResult>(s.commitPreparedMount())'),
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
    expect(mount).toContain("if (item.kind === 'tgz')");
    expect(mount).toContain('s.prepareTgzArtifact(item.label, new Uint8Array(item.bytes))');
    expect(mount).toContain('s.prepareArtifacts(input)');
    expect(mount).toContain('s.commitPreparedMount()');
    expect(CLIENT).not.toContain('if (hasRaw && hasPrepared)');
    expect(CLIENT).toContain('coldCarriers.length === transaction.length');
    expect(CLIENT).toContain("this.request('mountPackages', [transaction], transfer)");
  });
});
