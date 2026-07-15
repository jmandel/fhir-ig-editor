import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ResolutionStep, VersionIndex } from '../src/worker/protocol';
import {
  reactivateCachedResolution,
  ResolutionCache,
} from '../src/worker/resolutionCache';

const CLIENT = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');

describe('package resolution lifecycle', () => {
  test('an edit after a deferred mount cannot reuse the old config fixpoint', () => {
    const cache = new ResolutionCache<{ satisfied: boolean }>();
    const config = 'id: fixture\nfhirVersion: 4.0.1\n';
    const source = 'sources-a/local-0';
    const first = { satisfied: true };
    cache.record(config, source, first);
    expect(cache.get(config, source)).toBe(first);

    expect(cache.noteMount(['hl7.fhir.r5.core#5.0.0'])).toBeTrue();
    expect(cache.get(config, source)).toBeNull();

    const resolvedAgain = { satisfied: true };
    cache.record(config, source, resolvedAgain);
    expect(cache.get(config, source)).toBe(resolvedAgain);
  });

  test('an idempotent mount preserves the exact config-bound outcome', () => {
    const cache = new ResolutionCache<number>();
    cache.record('config-a', 'sources-a/local-0', 1);
    expect(cache.noteMount([])).toBeFalse();
    expect(cache.get('config-a', 'sources-a/local-0')).toBe(1);
    expect(cache.get('config-b', 'sources-a/local-0')).toBeNull();
  });

  test('retains a strict two-entry LRU for A to Cycle to A without a mount', () => {
    const cache = new ResolutionCache<number>();
    const source = 'sources-a/local-0';
    cache.record('config-a', source, 1);
    cache.record('config-cycle', source, 2);
    expect(cache.get('config-a', source)).toBe(1); // refresh A recency
    cache.record('config-third', source, 3);
    expect(cache.get('config-a', source)).toBe(1);
    expect(cache.get('config-cycle', source)).toBeNull();
    expect(cache.get('config-third', source)).toBe(3);
  });

  test('A to Cycle to A re-establishes and verifies Rust resolver authority', async () => {
    const step: ResolutionStep = {
      resolver_schema: 3,
      compile_set: [{ package_id: 'example.a', version: '1.0.0' }],
      context_closure: [{ package_id: 'example.a', version: '1.0.0' }],
      resolution_support: [],
      missing: [],
      satisfied: true,
      mutable_requests: [],
    };
    const versionIndex: VersionIndex = { versions: { 'example.a': ['1.0.0'] } };
    const cached = { step, versionIndex, blocked: [], mounted: [] };
    let activeConfig = 'cycle';
    const restored = await reactivateCachedResolution(cached, async (observedIndex) => {
      expect(activeConfig).toBe('cycle');
      expect(observedIndex).toBe(versionIndex);
      activeConfig = 'a';
      return structuredClone(step);
    });

    expect(activeConfig).toBe('a');
    expect(restored).not.toBeNull();
    expect(restored?.step).not.toBe(step);
    expect(restored?.step).toEqual(step);
  });

  test('a cached hint fails closed when Rust does not reproduce its exact step', async () => {
    const cachedStep: ResolutionStep = {
      resolver_schema: 3,
      compile_set: [{ package_id: 'example.a', version: '1.0.0' }],
      context_closure: [{ package_id: 'example.a', version: '1.0.0' }],
      resolution_support: [],
      missing: [],
      satisfied: true,
      mutable_requests: [],
    };
    const changedStep: ResolutionStep = {
      ...cachedStep,
      context_closure: [{ package_id: 'example.a', version: '2.0.0' }],
    };
    const restored = await reactivateCachedResolution(
      { step: cachedStep, versionIndex: { versions: {} } },
      async () => changedStep,
    );
    expect(restored).toBeNull();
  });

  test('requires the exact source and local-authority epoch before lookup', () => {
    const cache = new ResolutionCache<number>();
    cache.record('config-a', 'sources-a/local-1', 1);
    expect(cache.get('config-a', 'sources-b/local-1')).toBeNull();
    expect(cache.get('config-a', 'sources-a/local-2')).toBeNull();
    expect(cache.get('config-a', 'sources-a/local-1')).toBe(1);
  });

  test('keeps Worker/source invalidation separate from package-mount invalidation', () => {
    const createWorker = CLIENT.slice(
      CLIENT.indexOf('private createWorker()'),
      CLIENT.indexOf('private invalidatePackageAuthority()'),
    );
    expect(createWorker).toContain('this.versionObservations.clear()');
    expect(createWorker).toContain('this.resolutionCache.clear()');

    const acquire = CLIENT.slice(
      CLIENT.indexOf('async acquireForProject('),
      CLIENT.indexOf('async snapshot('),
    );
    expect(acquire.indexOf('source: PackageSourceSnapshot = packageSourceSnapshot()'))
      .toBeLessThan(acquire.indexOf('this.resolutionCache.get(config, sourceEpoch)'));
    expect(acquire).toContain('reactivateCachedResolution(');
    expect(acquire).toContain('(versionIndex) => this.resolveStep(config, versionIndex)');
    expect(acquire).toContain('settleObservations(outcome.step.satisfied)');
    expect(acquire).toContain('fromCache: true');

    const mount = CLIENT.slice(
      CLIENT.indexOf('private async openPackageMount('),
      CLIENT.indexOf('private async rawFallbackForPrepared('),
    );
    expect(mount).toContain('this.resolutionCache.noteMount(result.newlyMounted)');
    expect(mount).not.toContain('versionObservations');
  });
});
