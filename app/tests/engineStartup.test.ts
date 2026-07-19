import { describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BuildEvent, InitResult } from '../src/worker/protocol';

const fakeClients: FakeEngineClient[] = [];

class FakeEngineClient {
  initCalls = 0;
  disposeCalls = 0;
  private report: ((event: BuildEvent) => void) | null = null;
  private readonly fatalListeners = new Set<(error: Error) => void>();
  readonly result: InitResult = {
    mounted: 0,
    version: { engine: 'test', version: 'test', commit: 'test' },
    events: [],
  };

  constructor(private readonly initFailure: Error | null = null) {
    fakeClients.push(this);
  }

  init(report: (event: BuildEvent) => void): Promise<InitResult> {
    this.initCalls += 1;
    this.report = report;
    return this.initFailure ? Promise.reject(this.initFailure) : Promise.resolve(this.result);
  }

  emit(event: BuildEvent): void {
    this.report?.(event);
  }

  onFatal(listener: (error: Error) => void): () => void {
    this.fatalListeners.add(listener);
    return () => this.fatalListeners.delete(listener);
  }

  fail(error: Error): void {
    for (const listener of this.fatalListeners) listener(error);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

class FakeEngineInitializationFailure extends Error {
  constructor(readonly stage: 'manifest' | 'wasm', message: string) {
    super(message);
  }
}

mock.module('../src/worker/client', () => ({
  EngineClient: FakeEngineClient,
  EngineInitializationFailure: FakeEngineInitializationFailure,
}));

const { EngineStartup, engineStartup } = await import('../src/worker/engineStartup');

describe('page-process engine startup owner', () => {
  test('starts once, replays observations across remounts, and disposes once', async () => {
    const client = fakeClients[0];
    expect(client).toBeDefined();
    expect(client.initCalls).toBe(1);
    await expect(engineStartup.ready).resolves.toBe(client.result);

    const first: BuildEvent = { stage: 'wasm', message: 'first' };
    const second: BuildEvent = { stage: 'ready', message: 'second' };
    client.emit(first);

    const mountOne: BuildEvent[] = [];
    const unmountOne = engineStartup.subscribe((event) => mountOne.push(event));
    expect(mountOne).toEqual([first]);

    // StrictMode's second mount gets the buffered event without another client
    // or init call, then both live listeners see the same next observation.
    const mountTwo: BuildEvent[] = [];
    const unmountTwo = engineStartup.subscribe((event) => mountTwo.push(event));
    const errorLog = spyOn(console, 'error').mockImplementation(() => {});
    const throwing = engineStartup.subscribe(() => {
      throw new Error('broken progress projection');
    });
    expect(() => client.emit(second)).not.toThrow();
    throwing();
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
    expect(client.initCalls).toBe(1);
    expect(mountOne).toEqual([first, second]);
    expect(mountTwo).toEqual([first, second]);

    const failure = new Error('Worker crashed after ready');
    const failures: Error[] = [];
    const unsubscribeFailure = engineStartup.subscribeFailure(({ error }) => failures.push(error));
    client.fail(failure);
    expect(failures).toEqual([failure]);
    const replayed: Error[] = [];
    const unsubscribeReplay = engineStartup.subscribeFailure(({ error }) => replayed.push(error));
    expect(replayed).toEqual([failure]);

    unmountOne();
    unmountTwo();
    unsubscribeFailure();
    unsubscribeReplay();
    engineStartup.dispose();
    engineStartup.dispose();
    expect(client.disposeCalls).toBe(1);
    const afterDispose: Error[] = [];
    engineStartup.subscribeFailure(({ error }) => afterDispose.push(error));
    expect(afterDispose).toEqual([failure]);
  });

  test('keeps ownership, overlap, and cleanup explicit in source', () => {
    const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
    const reactBootstrap = readFileSync(new URL('../src/reactBootstrap.tsx', import.meta.url), 'utf8');
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');

    expect(main).toContain("import { engineStartup } from './worker/engineStartup'");
    expect(main.indexOf("import { engineStartup } from './worker/engineStartup'"))
      .toBeLessThan(main.indexOf("import './styles.css'"));
    expect(main).toContain("import('./reactBootstrap')");
    expect(main).not.toContain("from 'react'");
    expect(main).not.toContain("from 'react-dom/client'");
    expect(main).not.toMatch(/from ['"]\.\/App['"]/);
    expect(reactBootstrap).toContain("import React from 'react'");
    expect(reactBootstrap).toContain("import { App } from './App'");
    expect(app).toContain('export function App({ startup }');
    expect(app).toContain('Promise.all([guardedWorkspaceResult, startup.ready])');
    expect(app).toContain('startup.subscribeFailure(failBoot)');
    expect(app).toContain("pointEvent('app.boot-failed'");
    expect(app).toContain('setBootError(message)');
    expect(app).toContain('Reload editor');
    expect(app).not.toContain('new EngineClient()');

    expect(client).toContain('private initPromise: Promise<InitResult> | null = null');
    expect(client).toContain('if (this.initPromise) return this.initPromise');
    expect(client).toContain('const workerInitPromise = this.call(\'init\')');
    expect(client).toContain('await Promise.all([');
    expect(client).toContain('worker.onerror = (event) =>');
    expect(client).toContain('worker.onmessageerror = () =>');
    expect(client).toContain('this.rejectPending(reason)');
    expect(client).toContain("spanEvent('engine.recycle.yield'");
    expect(client).toContain('setTimeout(resolve, 0)');
    expect(client).not.toContain('configuredWaitMs');
    expect(main).toContain('engineStartup.dispose(new Error(`editor application module failed:');
    expect(client).toContain('for (const event of [moduleEvent, ...workerEvents, rpcEvent]) emitProgress(report, event)');
    expect(client).toContain('onFatal(listener: EngineFatalCb)');
    expect(client).toContain('this.worker.terminate()');
  });

  test('classifies and replays an initialization failure', async () => {
    const failure = new FakeEngineInitializationFailure('manifest', 'manifest unavailable');
    const client = new FakeEngineClient(failure);
    const startup = new EngineStartup(client as unknown as import('../src/worker/client').EngineClient);
    const observed: Array<{ error: Error; stage: string }> = [];
    startup.subscribeFailure((value) => observed.push(value));

    await expect(startup.ready).rejects.toBe(failure);
    await Promise.resolve();
    expect(observed).toEqual([{ error: failure, stage: 'manifest' }]);
    const replayed: string[] = [];
    startup.subscribeFailure(({ stage }) => replayed.push(stage));
    expect(replayed).toEqual(['manifest']);
    startup.dispose();
    expect(client.disposeCalls).toBe(1);
  });
});
