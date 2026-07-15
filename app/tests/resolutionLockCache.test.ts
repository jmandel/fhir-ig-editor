import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { BuildEvent, ResolutionStep } from '../src/worker/protocol';
import {
  lockFromResolution,
  lockedLabels,
  resolutionLockCacheKey,
  resolutionMatchesLock,
} from '../src/worker/resolutionLockCache';
import {
  acquireForProject,
  fetchRegistryVersions,
  obtainLockedPackages,
  refreshMutableVersionIndex,
} from '../src/worker/packageResolver';
import { packageSourceSnapshot } from '../src/vfs/packageSettings';
import { VersionObservationCache } from '../src/worker/versionObservationCache';
import type { VersionObservation } from '../src/worker/versionObservationCache';

const RESOLVER_SOURCE = readFileSync(
  new URL('../src/worker/packageResolver.ts', import.meta.url),
  'utf8',
);

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

  test('baked-only mutable candidates require a reachable empty registry proof', async () => {
    const originalFetch = globalThis.fetch;
    let queried = false;
    globalThis.fetch = (async () => {
      queried = true;
      return new Response('missing', { status: 404 });
    }) as typeof fetch;
    try {
      const index = await refreshMutableVersionIndex(step.mutable_requests, {
        versions: { 'example.pkg': ['1.0.0', '2.0.0'] },
      }, () => {});
      expect(queried).toBeTrue();
      expect(index?.versions['example.pkg']).toEqual(['1.0.0', '2.0.0']);
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test('shares one successful observation between lock validation and normal resolution', async () => {
    const source = packageSourceSnapshot(['https://registry.example'], '');
    const observations = new VersionObservationCache<VersionObservation>(
      (value) => value.cacheable && !value.unreachable,
    );
    const attempt = observations.begin(`${source.sourceKey}/local-0`);
    let loads = 0;
    const observe = async (id: string) => (await attempt.observe(id, async () => {
      loads += 1;
      return { versions: ['2.0.0'], unreachable: false, cacheable: true };
    })).value;

    const validated = await refreshMutableVersionIndex(
      step.mutable_requests,
      { versions: {} },
      () => {},
      source,
      observe,
    );
    const outcome = await acquireForProject({
      resolveStep: async () => step,
      openMount: async () => { throw new Error('satisfied resolution must not mount'); },
      bakedBundle: () => undefined,
      fetchBaked: async () => { throw new Error('satisfied resolution must not fetch'); },
    }, 'fhirVersion: 4.0.1\n', () => {}, validated ?? undefined, source, observe);

    expect(outcome.step.satisfied).toBe(true);
    expect(loads).toBe(1);
    attempt.commit();
  });

  test('marks malformed and unreachable metadata uncacheable but reachable empty cacheable', async () => {
    const originalFetch = globalThis.fetch;
    const source = packageSourceSnapshot(['https://registry.example'], '');
    try {
      globalThis.fetch = (async () => new Response('{not-json', { status: 200 })) as typeof fetch;
      expect(await fetchRegistryVersions('malformed.pkg', () => {}, source)).toEqual({
        versions: [],
        unreachable: false,
        cacheable: false,
      });

      globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
      expect(await fetchRegistryVersions('offline.pkg', () => {}, source)).toEqual({
        versions: [],
        unreachable: true,
        cacheable: false,
      });

      globalThis.fetch = (async () => new Response('missing', { status: 404 })) as typeof fetch;
      expect(await fetchRegistryVersions('missing.pkg', () => {}, source)).toEqual({
        versions: [],
        unreachable: false,
        cacheable: true,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('registry metadata uses the shared progressing-stream inactivity guard', () => {
    const versions = RESOLVER_SOURCE.slice(
      RESOLVER_SOURCE.indexOf('export async function fetchRegistryVersions('),
      RESOLVER_SOURCE.indexOf('/** Build a VersionIndex seed'),
    );
    expect(versions).toContain('await openPackageTransport(');
    expect(versions).toContain("{ redirect: 'follow', cache: 'no-cache' }");
    expect(versions).toContain('readResponseBytes(resp, undefined, undefined, transport.guard)');
    expect(versions).toContain('transport.guard.close()');
    expect(versions).not.toContain('resp.json()');
  });

  test('obtains an exact closure concurrently and reports aggregate progress', async () => {
    let mounted = false;
    let inFlight = 0;
    let peak = 0;
    const progress: BuildEvent[] = [];
    const labels = ['a#1.0.0', 'b#1.0.0', 'c#1.0.0'];
    const result = await obtainLockedPackages({
      resolveStep: async () => { throw new Error('unused'); },
      openMount: async (expected) => ({
        stage: async () => {},
        commit: async () => {
          mounted = true;
          return { mounted: expected.length, newlyMounted: [...expected], events: [] };
        },
        abort: async () => {},
      }),
      bakedBundle: (label) => ({
        label,
        tgz: `${label}.tgz`,
        sha256: '1'.repeat(64),
        loadPhase: 'compile',
      }),
      fetchBaked: async (bundle, report) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        report({
          stage: 'bundle-fetch',
          label: bundle.label,
          bytes: 1,
          totalBytes: 10,
          message: `Downloading ${bundle.label}`,
        });
        await Promise.resolve();
        inFlight -= 1;
        return {
          kind: 'raw',
          spec: { label: bundle.label, files: {} },
          transportIdentity: `tgz-${bundle.sha256}`,
        };
      },
    }, labels, (event) => progress.push(event));
    expect(result.blocked).toEqual([]);
    expect(result.packages).toHaveLength(3);
    expect(peak).toBeGreaterThan(1);
    expect(mounted).toBeTrue();
    expect(progress.at(-1)?.message).toBe('Located 3 dependencies; ready to prepare.');
    expect(progress.at(-1)?.stage).toBe('resolve');
    expect(progress.at(-1)?.bytes).toBe(3);
    expect(progress.every((event) => !/[abc]#1\.0\.0/.test(event.message))).toBeTrue();
    expect(progress.every((event) => event.totalBytes == null)).toBeTrue();
  });

  test('prepares carriers in arrival order and commits resolver order once', async () => {
    const labels = ['a#1.0.0', 'b#1.0.0', 'c#1.0.0'];
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const staged: number[] = [];
    let opened: readonly string[] | null = null;
    let commits = 0;
    let aborts = 0;
    const pending = obtainLockedPackages({
      resolveStep: async () => { throw new Error('unused'); },
      openMount: async (expected) => {
        opened = [...expected];
        return {
          stage: async (index, input) => {
            expect(input.kind === 'raw' ? input.spec.label : '').toBe(labels[index]);
            staged.push(index);
          },
          commit: async () => {
            commits += 1;
            return { mounted: 3, newlyMounted: [...labels], events: [] };
          },
          abort: async () => { aborts += 1; },
        };
      },
      bakedBundle: (label) => ({
        label,
        tgz: `${label}.tgz`,
        sha256: '2'.repeat(64),
        loadPhase: 'compile',
      }),
      fetchBaked: async (bundle) => {
        started.push(bundle.label);
        await new Promise<void>((resolve) => { releases.set(bundle.label, resolve); });
        return {
          kind: 'raw',
          spec: { label: bundle.label, files: {} },
          transportIdentity: `tgz-${bundle.sha256}`,
        };
      },
    }, labels, () => {});

    for (let spin = 0; started.length < labels.length && spin < 20; spin += 1) {
      await Promise.resolve();
    }
    expect(started).toHaveLength(3);
    for (const label of [labels[1], labels[2], labels[0]]) {
      const expectedStages = staged.length + 1;
      releases.get(label)!();
      for (let spin = 0; staged.length < expectedStages && spin < 20; spin += 1) {
        await Promise.resolve();
      }
      expect(staged).toHaveLength(expectedStages);
    }
    const result = await pending;
    expect(opened).toEqual(labels);
    expect(staged).toEqual([1, 2, 0]);
    expect(commits).toBe(1);
    expect(aborts).toBe(0);
    expect(result.mounted).toEqual(labels);
  });
});
