import { describe, expect, test } from 'bun:test';

import type { ResolutionStep } from '../src/worker/protocol';
import {
  lockFromResolution,
  lockedLabels,
  resolutionLockCacheKey,
  resolutionMatchesLock,
} from '../src/worker/resolutionLockCache';
import { obtainLockedPackages, refreshMutableVersionIndex } from '../src/worker/packageResolver';

const step: ResolutionStep = {
  resolver_schema: 3,
  compile_set: [
    { package_id: 'hl7.fhir.r4.core', version: '4.0.1' },
    { package_id: 'example.pkg', version: '2.0.0' },
  ],
  context_closure: [
    { package_id: 'hl7.fhir.r4.core', version: '4.0.1' },
    { package_id: 'example.pkg', version: '2.0.0' },
    { package_id: 'transitive.pkg', version: '1.0.0' },
  ],
  resolution_support: [
    { package_id: 'example.pkg', version: '2.0.0' },
    { package_id: 'filtered-r5.pkg', version: '1.0.0' },
  ],
  missing: [],
  satisfied: true,
  mutable_requests: [{
    package_id: 'example.pkg',
    requested: 'latest',
    resolved_version: '2.0.0',
    set: 'compile',
  }],
};

describe('persistent package-resolution lock', () => {
  test('keys exact config, engine, baked universe, and registry authority', async () => {
    const authority = {
      engineRecipe: 'a'.repeat(64),
      bakedPackages: [{ label: 'example.pkg#2.0.0', sha256: '1'.repeat(64) }],
      registries: ['https://packages.fhir.org'],
      proxy: '',
    };
    const a = await resolutionLockCacheKey('fhirVersion: 4.0.1\n', authority);
    const reordered = await resolutionLockCacheKey('fhirVersion: 4.0.1\n', {
      ...authority,
      bakedPackages: [...authority.bakedPackages].reverse(),
    });
    const changed = await resolutionLockCacheKey('fhirVersion: 4.0.1\n', {
      ...authority,
      engineRecipe: 'b'.repeat(64),
    });
    expect(reordered).toEqual(a);
    expect(changed.cacheKey).not.toBe(a.cacheKey);
  });

  test('requires Rust to reproduce the exact ordered closure', () => {
    const lock = lockFromResolution('a'.repeat(64), 'b'.repeat(64), step, {
      versions: { 'example.pkg': ['2.0.0'] },
    });
    expect(lockedLabels(lock)).toEqual([
      'hl7.fhir.r4.core#4.0.1',
      'example.pkg#2.0.0',
      'transitive.pkg#1.0.0',
      'filtered-r5.pkg#1.0.0',
    ]);
    expect(resolutionMatchesLock(step, lock)).toBeTrue();
    expect(resolutionMatchesLock({
      ...step,
      compile_set: [...step.compile_set].reverse(),
    }, lock)).toBeFalse();
    expect(resolutionMatchesLock({ ...step, resolver_schema: 2 }, lock)).toBeFalse();
  });

  test('baked mutable candidates can be freshness-validated without registry lookup', async () => {
    const index = await refreshMutableVersionIndex(step.mutable_requests, {
      versions: { 'example.pkg': ['1.0.0', '2.0.0'] },
    }, () => {});
    expect(index?.versions['example.pkg']).toEqual(['1.0.0', '2.0.0']);
  });

  test('registry-backed mutable candidates force HTTP revalidation', async () => {
    const originalFetch = globalThis.fetch;
    let cacheMode: RequestCache | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      cacheMode = init?.cache;
      return new Response(JSON.stringify({ versions: { '1.0.0': {}, '2.0.0': {} } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const index = await refreshMutableVersionIndex([{
        package_id: 'registry.pkg',
        requested: 'latest',
        resolved_version: '1.0.0',
        set: 'compile',
      }], { versions: {} }, () => {});
      expect(cacheMode).toBe('no-cache');
      expect(index?.versions['registry.pkg']).toEqual(['1.0.0', '2.0.0']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('obtains an exact closure concurrently but never mounts it', async () => {
    let mounted = false;
    let inFlight = 0;
    let peak = 0;
    const labels = ['a#1.0.0', 'b#1.0.0', 'c#1.0.0'];
    const result = await obtainLockedPackages({
      resolveStep: async () => { throw new Error('unused'); },
      mount: async () => { mounted = true; },
      bakedBundle: (label) => ({
        label,
        tgz: `${label}.tgz`,
        sha256: '1'.repeat(64),
        loadPhase: 'compile',
      }),
      fetchBaked: async (bundle) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return {
          kind: 'raw',
          spec: { label: bundle.label, files: {} },
          transportIdentity: `tgz-${bundle.sha256}`,
        };
      },
    }, labels, () => {});
    expect(result.blocked).toEqual([]);
    expect(result.packages).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
    expect(mounted).toBeFalse();
  });
});
