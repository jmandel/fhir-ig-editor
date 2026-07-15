import { describe, expect, test } from 'bun:test';
import { epochMs, pointEvent, spanEvent } from '../src/performance/timeline';

describe('performance timeline', () => {
  test('aligns performance time to its epoch', () => {
    const before = performance.timeOrigin + performance.now();
    const observed = epochMs();
    const after = performance.timeOrigin + performance.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  test('creates a nonnegative machine-readable span', () => {
    expect(spanEvent('engine.session.init', 'worker', 120, {
      stage: 'wasm',
      message: 'Initialized.',
    }, 155)).toEqual({
      phase: 'engine.session.init',
      source: 'worker',
      startMs: 120,
      durationMs: 35,
      stage: 'wasm',
      message: 'Initialized.',
    });
    expect(spanEvent('clock.skew', 'window', 10, {
      stage: 'ready',
      message: 'Observed.',
    }, 5).durationMs).toBe(0);
  });

  test('creates aligned point observations without inventing a duration', () => {
    expect(pointEvent('engine.worker.ready', 'worker', {
      stage: 'wasm',
      message: 'Worker ready.',
    }, 99)).toEqual({
      phase: 'engine.worker.ready',
      source: 'worker',
      startMs: 99,
      stage: 'wasm',
      message: 'Worker ready.',
    });
  });
});
