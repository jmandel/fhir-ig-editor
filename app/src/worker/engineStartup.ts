// Page-process owner for the one compiler Worker. Importing this module starts
// Worker/WASM initialization immediately; React consumes the same buffered
// startup regardless of StrictMode mount/re-mount behavior.

import {
  EngineClient,
  EngineInitializationFailure,
  type EngineInitializationStage,
} from './client';
import type { InitResult, BuildEvent } from './protocol';

export type StartupListener = (event: BuildEvent) => void;
export interface EngineStartupFailure {
  error: Error;
  stage: EngineInitializationStage;
}
export type StartupFailureListener = (failure: EngineStartupFailure) => void;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function notify<T>(listener: (value: T) => void, value: T, kind: string): void {
  try {
    listener(value);
  } catch (error) {
    console.error(`engine startup ${kind} observer failed`, error);
  }
}

export function classifyEngineStartupFailure(error: unknown): EngineStartupFailure {
  return {
    error: asError(error),
    stage: error instanceof EngineInitializationFailure ? error.stage : 'wasm',
  };
}

export class EngineStartup {
  readonly ready: Promise<InitResult>;
  private readonly events: BuildEvent[] = [];
  private readonly listeners = new Set<StartupListener>();
  private readonly failureListeners = new Set<StartupFailureListener>();
  private failure: EngineStartupFailure | null = null;
  private readonly unsubscribeFatal: () => void;
  private disposed = false;

  constructor(readonly engine: EngineClient) {
    this.unsubscribeFatal = engine.onFatal((error) => {
      this.publishFailure({ error, stage: 'wasm' });
    });
    this.ready = engine.init((event) => {
      if (this.disposed) return;
      this.events.push(event);
      for (const listener of [...this.listeners]) notify(listener, event, 'event');
    });
    // Retain the original promise (including its rejection) for every consumer,
    // while also marking an early module-evaluation failure as observed until
    // React attaches its own error handling.
    void this.ready.catch((error: unknown) => {
      this.publishFailure(classifyEngineStartupFailure(error));
    });
  }

  private publishFailure(failure: EngineStartupFailure): void {
    if (this.disposed || this.failure) return;
    this.failure = failure;
    for (const listener of [...this.failureListeners]) notify(listener, failure, 'failure');
  }

  /** Subscribe to future observations and synchronously replay everything that
   * happened before React mounted. Each subscriber owns only its UI projection;
   * process-wide metric recording subscribes once in main.tsx. */
  subscribe(listener: StartupListener): () => void {
    if (this.disposed) return () => {};
    for (const event of this.events) notify(listener, event, 'event');
    if (!this.disposed) this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Observe startup rejection or a terminal failure of the live Worker. Replay
   * makes failure stable across StrictMode and React refresh remounts. */
  subscribeFailure(listener: StartupFailureListener): () => void {
    // A terminal App failure deliberately disposes the Worker while preserving
    // this immutable failure value for a later React remount's reload surface.
    if (this.disposed) {
      if (this.failure) notify(listener, this.failure, 'failure');
      return () => {};
    }
    if (this.failure) notify(listener, this.failure, 'failure');
    if (!this.disposed) this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  dispose(reason: Error = new Error('engine startup owner disposed')): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeFatal();
    this.listeners.clear();
    this.failureListeners.clear();
    this.engine.dispose(reason);
  }
}

export const engineStartup = new EngineStartup(new EngineClient());

// React refresh leaves this dependency module cached. If this owner/client
// module itself is replaced, retire its Worker before Vite evaluates a new one.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    engineStartup.dispose(new Error('engine Worker replaced by hot update'));
  });
}
