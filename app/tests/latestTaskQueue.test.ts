import { describe, expect, test } from 'bun:test';

import {
  LatestTaskQueue,
  SEMANTIC_EDIT_DEBOUNCE_MS,
  SITE_EDIT_DEBOUNCE_MS,
  editDebounceMs,
} from '../src/build/latestTaskQueue';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('LatestTaskQueue', () => {
  test('gives prose edits a shorter pause without weakening semantic coalescing', () => {
    expect(editDebounceMs('input/fsh/Profile.fsh')).toBe(SEMANTIC_EDIT_DEBOUNCE_MS);
    expect(editDebounceMs('sushi-config.yaml')).toBe(SEMANTIC_EDIT_DEBOUNCE_MS);
    expect(editDebounceMs('input/resources/Patient-p.json')).toBe(SEMANTIC_EDIT_DEBOUNCE_MS);
    expect(editDebounceMs('input/examples/Patient-p.json')).toBe(SEMANTIC_EDIT_DEBOUNCE_MS);
    expect(editDebounceMs('input/pagecontent/index.md')).toBe(SITE_EDIT_DEBOUNCE_MS);
    expect(editDebounceMs('input/images/diagram.svg')).toBe(SITE_EDIT_DEBOUNCE_MS);
    expect(SITE_EDIT_DEBOUNCE_MS).toBeLessThan(SEMANTIC_EDIT_DEBOUNCE_MS);
  });

  test('serializes mutable engine operations and only the newest lease may publish', async () => {
    const queue = new LatestTaskQueue();
    const firstGate = deferred();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const first = queue.enqueue(async (lease) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('first:start');
      await firstGate.promise;
      if (lease.isLatest()) events.push('first:publish');
      active -= 1;
      events.push('first:end');
      return 'first';
    });
    const second = queue.enqueue(async (lease) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('second:start');
      if (lease.isLatest()) events.push('second:publish');
      active -= 1;
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    firstGate.resolve();
    expect((await first).latest).toBe(false);
    expect((await second).latest).toBe(true);
    expect(maxActive).toBe(1);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:publish']);
  });

  test('an invalidation revokes a running lease without starting new work', async () => {
    const queue = new LatestTaskQueue();
    const gate = deferred();
    let couldPublish = true;
    const running = queue.enqueue(async (lease) => {
      await gate.promise;
      couldPublish = lease.isLatest();
    });
    queue.invalidate();
    gate.resolve();
    const outcome = await running;
    expect(outcome.latest).toBe(false);
    expect(couldPublish).toBe(false);
  });

  test('a rejection does not poison later queued work', async () => {
    const queue = new LatestTaskQueue();
    const failed = queue.enqueue(async () => {
      throw new Error('expected');
    });
    const recovered = queue.enqueue(async () => 42);
    await expect(failed).rejects.toThrow('expected');
    expect((await recovered).value).toBe(42);
  });
});
