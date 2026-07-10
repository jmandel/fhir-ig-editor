/**
 * Serializes operations over the wasm engine's mutable build surface while
 * giving callers a latest-wins commit lease.
 *
 * Work already executing is allowed to finish (the wasm calls are not
 * cancellable), but as soon as a newer request is queued `lease.isLatest()` is
 * false. Obsolete work must therefore avoid publishing React/SW state. The next
 * task never starts until the prior one settles, so template/site-tree mutations
 * cannot interleave.
 */
export interface TaskLease {
  readonly requestId: number;
  isLatest(): boolean;
}

export interface TaskOutcome<T> {
  requestId: number;
  latest: boolean;
  value: T;
}

export class LatestTaskQueue {
  private latestRequestId = 0;
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: (lease: TaskLease) => Promise<T>): Promise<TaskOutcome<T>> {
    const requestId = ++this.latestRequestId;
    const lease: TaskLease = {
      requestId,
      isLatest: () => requestId === this.latestRequestId,
    };

    const run = this.tail.then(() => task(lease));
    // A rejected task must not poison the serial queue.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run.then((value) => ({ requestId, latest: lease.isLatest(), value }));
  }

  /** Supersede any running task without enqueueing another operation. */
  invalidate(): number {
    return ++this.latestRequestId;
  }

  get latestId(): number {
    return this.latestRequestId;
  }
}
