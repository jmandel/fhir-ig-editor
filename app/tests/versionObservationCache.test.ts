import { describe, expect, test } from 'bun:test';

import {
  VersionObservationCache,
} from '../src/worker/versionObservationCache';
import type { VersionObservation } from '../src/worker/versionObservationCache';

function observation(
  versions: string[],
  overrides: Partial<VersionObservation> = {},
): VersionObservation {
  return { versions, unreachable: false, cacheable: true, ...overrides };
}

function cache() {
  return new VersionObservationCache<VersionObservation>(
    (value) => value.cacheable && !value.unreachable,
  );
}

describe('mutable registry version observations', () => {
  test('single-flights an attempt and reuses only its committed successful hit', async () => {
    const observations = cache();
    const attempt = observations.begin('sources-a/local-0');
    let loads = 0;
    let release!: (value: VersionObservation) => void;
    const load = () => {
      loads += 1;
      return new Promise<VersionObservation>((resolve) => { release = resolve; });
    };
    const first = attempt.observe('example.pkg', load);
    const joined = attempt.observe('example.pkg', load);
    expect(loads).toBe(1);
    release(observation(['1.0.0']));
    expect((await first).fromCache).toBe(false);
    expect((await joined).fromCache).toBe(true);
    attempt.commit();

    const next = observations.begin('sources-a/local-0');
    const hit = await next.observe('example.pkg', async () => {
      throw new Error('committed observation should be reused');
    });
    expect(hit.fromCache).toBe(true);
    expect(hit.value.versions).toEqual(['1.0.0']);
  });

  test('does not retain unreachable, malformed, or aborted observations', async () => {
    for (const failed of [
      observation([], { unreachable: true, cacheable: false }),
      observation([], { cacheable: false }),
    ]) {
      const observations = cache();
      const first = observations.begin('sources-a/local-0');
      await first.observe('example.pkg', async () => failed);
      first.commit();
      let retried = 0;
      const retry = observations.begin('sources-a/local-0');
      await retry.observe('example.pkg', async () => {
        retried += 1;
        return observation(['2.0.0']);
      });
      expect(retried).toBe(1);
    }

    const observations = cache();
    const aborted = observations.begin('sources-a/local-0');
    await expect(aborted.observe('example.pkg', async () => {
      throw new DOMException('aborted', 'AbortError');
    })).rejects.toThrow('aborted');
    aborted.discard();
    let retried = 0;
    await observations.begin('sources-a/local-0').observe('example.pkg', async () => {
      retried += 1;
      return observation(['3.0.0']);
    });
    expect(retried).toBe(1);
  });

  test('retains reachable empty only after the overall attempt succeeds', async () => {
    const observations = cache();
    const failedAttempt = observations.begin('sources-a/local-0');
    await failedAttempt.observe('alias.pkg', async () => observation([]));
    failedAttempt.discard(); // model an unsatisfied resolver outcome

    let retries = 0;
    const successfulAttempt = observations.begin('sources-a/local-0');
    const retried = await successfulAttempt.observe('alias.pkg', async () => {
      retries += 1;
      return observation([]);
    });
    expect(retried.fromCache).toBe(false);
    expect(retries).toBe(1);
    successfulAttempt.commit();

    const hit = await observations.begin('sources-a/local-0').observe(
      'alias.pkg',
      async () => { throw new Error('reachable empty should be reusable'); },
    );
    expect(hit.fromCache).toBe(true);
    expect(hit.value.versions).toEqual([]);
  });

  test('source or local-authority changes clear observations, mounts do not', async () => {
    const observations = cache();
    const first = observations.begin('sources-a/local-0');
    await first.observe('example.pkg', async () => observation(['1.0.0']));
    first.commit();

    // Package-generation changes are intentionally absent from this scope: a
    // mount invalidates closure outcomes, not registry observations.
    const sameScope = await observations.begin('sources-a/local-0').observe(
      'example.pkg',
      async () => { throw new Error('mount-only reuse should hit'); },
    );
    expect(sameScope.fromCache).toBe(true);

    for (const scope of ['sources-b/local-0', 'sources-b/local-1']) {
      let loads = 0;
      const changed = observations.begin(scope);
      const value = await changed.observe('example.pkg', async () => {
        loads += 1;
        return observation(['2.0.0']);
      });
      expect(value.fromCache).toBe(false);
      expect(loads).toBe(1);
      changed.commit();
    }
  });

  test('a fresh Worker clear forces the same scope to observe again', async () => {
    const observations = cache();
    const first = observations.begin('sources-a/local-0');
    await first.observe('example.pkg', async () => observation(['1.0.0']));
    first.commit();

    observations.clear();
    let loads = 0;
    const afterRestart = await observations.begin('sources-a/local-0').observe(
      'example.pkg',
      async () => {
        loads += 1;
        return observation(['2.0.0']);
      },
    );
    expect(loads).toBe(1);
    expect(afterRestart.fromCache).toBe(false);
    expect(afterRestart.value.versions).toEqual(['2.0.0']);
  });
});
