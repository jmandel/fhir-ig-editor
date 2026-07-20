import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  LatestTaskQueue,
} from '../src/build/latestTaskQueue';
import { BuildRuntimeRegistry } from '../src/worker/buildRuntimeRegistry';

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

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

  test('an edit enters the replaceable latest-only queue without a fixed timer', () => {
    const schedule = APP.slice(
      APP.indexOf('const scheduleCompile = useCallback'),
      APP.indexOf('// ---- open a baked project'),
    );
    expect(schedule).toContain('buildQueueRef.current.enqueueLatest');
    expect(schedule).not.toContain('setTimeout');
  });

  test('coalesces a same-turn burst before any expensive task starts', async () => {
    const queue = new LatestTaskQueue();
    const events: string[] = [];
    const first = queue.enqueueLatest(async () => events.push('first'));
    const second = queue.enqueueLatest(async () => events.push('second'));
    const third = queue.enqueueLatest(async () => events.push('third'));

    expect(await first).toMatchObject({ latest: false, superseded: true });
    expect(await second).toMatchObject({ latest: false, superseded: true });
    expect(await third).toMatchObject({ latest: true, superseded: false });
    expect(events).toEqual(['third']);
  });

  test('a typing burst permits one running task and only its newest successor', async () => {
    const queue = new LatestTaskQueue();
    const firstGate = deferred();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (name: string, gate?: Promise<void>) => queue.enqueueLatest(async (lease) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push(`${name}:start`);
      if (gate) await gate;
      if (lease.isLatest()) events.push(`${name}:publish`);
      active -= 1;
      events.push(`${name}:end`);
      return name;
    });

    const first = run('first', firstGate.promise);
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    const second = run('second');
    const third = run('third');
    const fourth = run('fourth');
    expect(await second).toMatchObject({ superseded: true });
    expect(await third).toMatchObject({ superseded: true });
    firstGate.resolve();
    expect(await first).toMatchObject({ latest: false, superseded: false });
    expect(await fourth).toMatchObject({ latest: true, superseded: false, value: 'fourth' });
    expect(maxActive).toBe(1);
    expect(events).toEqual(['first:start', 'first:end', 'fourth:start', 'fourth:publish', 'fourth:end']);
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

  test('awaits superseded runtime release before starting its successor', async () => {
    const queue = new LatestTaskQueue();
    const runtimes = new BuildRuntimeRegistry<string>();
    const bPrepared = deferred();
    const letBObserveRevocation = deferred();
    const releaseFinished = deferred();
    const events: string[] = [];
    runtimes.install('published-a', 'A');

    const b = queue.enqueueLatest(async (lease) => {
      runtimes.install('superseded-b', 'B');
      events.push('b:prepared');
      bPrepared.resolve();
      await letBObserveRevocation.promise;
      if (!lease.isLatest()) {
        events.push('b:release-start');
        await releaseFinished.promise;
        runtimes.release('superseded-b');
        events.push('b:release-complete');
      }
    });
    await bPrepared.promise;
    const c = queue.enqueueLatest(async () => {
      events.push('c:start');
      runtimes.install('latest-c', 'C');
    });
    letBObserveRevocation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['b:prepared', 'b:release-start']);
    releaseFinished.resolve();

    expect(await b).toMatchObject({ latest: false, superseded: false });
    expect(await c).toMatchObject({ latest: true, superseded: false });
    expect(events).toEqual([
      'b:prepared',
      'b:release-start',
      'b:release-complete',
      'c:start',
    ]);
    expect(runtimes.handles()).toEqual(['latest-c', 'published-a']);
  });
});
