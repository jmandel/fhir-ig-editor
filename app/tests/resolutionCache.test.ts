import { describe, expect, test } from 'bun:test';
import { ResolutionCache } from '../src/worker/resolutionCache';

describe('package resolution lifecycle', () => {
  test('an edit after a deferred mount cannot reuse the old config fixpoint', () => {
    const cache = new ResolutionCache<{ satisfied: boolean }>();
    const config = 'id: fixture\nfhirVersion: 4.0.1\n';
    const first = { satisfied: true };
    cache.record(config, first);
    expect(cache.get(config)).toBe(first);

    expect(cache.noteMount(['hl7.fhir.r5.core#5.0.0'])).toBeTrue();
    expect(cache.get(config)).toBeNull();

    const resolvedAgain = { satisfied: true };
    cache.record(config, resolvedAgain);
    expect(cache.get(config)).toBe(resolvedAgain);
  });

  test('an idempotent mount preserves the exact config-bound outcome', () => {
    const cache = new ResolutionCache<number>();
    cache.record('config-a', 1);
    expect(cache.noteMount([])).toBeFalse();
    expect(cache.get('config-a')).toBe(1);
    expect(cache.get('config-b')).toBeNull();
  });
});
