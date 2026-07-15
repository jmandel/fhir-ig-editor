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

  test('keeps snapshots within the already-resolved project release closure', () => {
    const snapshot = CLIENT.slice(
      CLIENT.indexOf('async snapshot('),
      CLIENT.indexOf('async expandValueSet'),
    );
    expect(snapshot).not.toContain('ensureSnapshotBundles');
    expect(CLIENT).not.toContain('snapshotBundles');
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
      WORKER.indexOf('// ---- op handlers'),
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

  test('reconciles changed local package authority before the next prepare', () => {
    const ingest = CLIENT.slice(
      CLIENT.indexOf('async ingestLocalTgz('),
      CLIENT.indexOf('  /** Ask the engine to resolve'),
    );
    expect(ingest).toContain('await this.prepareBarrier');
    expect(ingest.indexOf('await this.prepareBarrier'))
      .toBeLessThan(ingest.indexOf('await ingestTgz(tgz)'));
    const prepare = CLIENT.slice(
      CLIENT.indexOf('async prepare(\n'),
      CLIENT.indexOf('  open(buildId: string)'),
    );
    expect(prepare).toContain('this.localPackageAuthority.reconcile');
    expect(prepare).toContain('() => this.recycleWorker(report)');
    expect(prepare.indexOf('this.localPackageAuthority.reconcile'))
      .toBeLessThan(prepare.indexOf('const packageSource = packageSourceSnapshot()'));
    expect(prepare).toContain('const packageLocalEpoch = localPackageEpoch()');
    expect(prepare.match(/packageSourceSnapshot\(\)/gu)).toHaveLength(1);
    expect(prepare).toContain(
      'this.acquireForProject(project.config, report, packageSource, packageLocalEpoch)',
    );
    expect(prepare).toContain('packageSource,\n          packageLocalEpoch,');
    expect(prepare).toContain('this.localPackageAuthority.commit()');
    expect(prepare).toContain('this.localPackageAuthority.rollback()');
    const dispose = CLIENT.slice(
      CLIENT.indexOf('dispose(reason:'),
      CLIENT.indexOf('  // ---- runtime package resolution'),
    );
    expect(dispose).toContain('this.localPackageAuthority.rollback()');
  });

  test('passes the expected label into Rust before a warm slot is occupied', () => {
    expect(WORKER).toContain(
      's.stagePreparedMount(index, new Uint8Array(artifact), pointer.cacheKey, pointer.label)',
    );
    expect(WORKER).not.toContain('if (staged.label !== pointer.label)');
  });

  test('streams warm and cold carriers through one ordered ticket implementation', () => {
    const mount = WORKER.slice(
      WORKER.indexOf('async openPackageMount(labels: string[])'),
      WORKER.indexOf('async resolveProject(config, versionIndex)'),
    );
    expect(mount).toContain('unwrap(s.beginPreparedMount(labels.length))');
    expect(mount).toContain('async stagePackageMount(');
    expect(mount).toContain("if (item.kind === 'prepared')");
    expect(mount).toContain("if (item.kind === 'tgz')");
    expect(mount).toContain('s.prepareTgzArtifact(item.label, new Uint8Array(item.bytes))');
    expect(mount).toContain('s.prepareArtifacts(input)');
    expect(mount).toContain('s.stagePreparedMount(index, bytes, artifact.cacheKey, artifact.label)');
    expect(mount).toContain('async commitPackageMount(ticket: number)');
    expect(mount).toContain('s.commitPreparedMount()');
    expect(mount).toContain('async abortPackageMount(ticket: number)');
    expect(mount).toContain('s.abortPreparedMount()');
    expect(CLIENT).toContain('private async acquirePackageMountLock()');
    expect(CLIENT).toContain("'stagePackageMount'");
    expect(CLIENT).toContain("input.kind === 'tgz' ? [input.bytes] : []");
    const clientMount = CLIENT.slice(
      CLIENT.indexOf('private async openPackageMount('),
      CLIENT.indexOf('private async rawFallbackForPrepared('),
    );
    expect(clientMount).toContain("await this.call('abortPackageMount', ticket)");
    expect(clientMount).toContain('finally {\n        finished = true;\n        release();');
    expect(CLIENT).not.toContain("this.request('mountPackages'");
  });
});
