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

export interface SupersededTaskOutcome {
  requestId: number;
  latest: false;
  superseded: true;
}

export type LatestTaskOutcome<T> = (TaskOutcome<T> & { superseded: false }) | SupersededTaskOutcome;

interface PendingLatest {
  requestId: number;
  task: (lease: TaskLease) => Promise<unknown>;
  resolve: (outcome: LatestTaskOutcome<unknown>) => void;
  reject: (reason: unknown) => void;
}

export class LatestTaskQueue {
  private latestRequestId = 0;
  private tail: Promise<void> = Promise.resolve();
  private pendingLatest: PendingLatest | null = null;
  private latestPump: Promise<void> | null = null;

  enqueue<T>(task: (lease: TaskLease) => Promise<T>): Promise<TaskOutcome<T>> {
    const requestId = ++this.latestRequestId;
    this.dropPendingLatest();
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

  /**
   * Run immediately after already-active engine work, with at most one
   * replaceable pending task. Calls made before the pump starts coalesce; calls
   * made while wasm is running replace the one successor instead of building a
   * backlog. The running task's lease is revoked as soon as a successor exists.
   */
  enqueueLatest<T>(task: (lease: TaskLease) => Promise<T>): Promise<LatestTaskOutcome<T>> {
    const requestId = ++this.latestRequestId;
    this.dropPendingLatest();
    const outcome = new Promise<LatestTaskOutcome<T>>((resolve, reject) => {
      this.pendingLatest = {
        requestId,
        task,
        resolve: resolve as (value: LatestTaskOutcome<unknown>) => void,
        reject,
      };
    });
    this.ensureLatestPump();
    return outcome;
  }

  /** Supersede running work and discard a not-yet-started latest task. */
  invalidate(): number {
    const requestId = ++this.latestRequestId;
    this.dropPendingLatest();
    return requestId;
  }

  get latestId(): number {
    return this.latestRequestId;
  }

  private dropPendingLatest(): void {
    const pending = this.pendingLatest;
    if (!pending) return;
    this.pendingLatest = null;
    pending.resolve({ requestId: pending.requestId, latest: false, superseded: true });
  }

  private ensureLatestPump(): void {
    if (this.latestPump) return;
    const pump = this.tail.then(async () => {
      for (;;) {
        const pending = this.pendingLatest;
        if (!pending) return;
        this.pendingLatest = null;
        const lease: TaskLease = {
          requestId: pending.requestId,
          isLatest: () => pending.requestId === this.latestRequestId,
        };
        try {
          const value = await pending.task(lease);
          pending.resolve({
            requestId: pending.requestId,
            latest: lease.isLatest(),
            superseded: false,
            value,
          });
        } catch (error) {
          pending.reject(error);
        }
      }
    });
    const settled = pump.then(
      () => undefined,
      () => undefined,
    );
    this.latestPump = settled;
    this.tail = settled;
    void settled.then(() => {
      if (this.latestPump !== settled) return;
      this.latestPump = null;
      if (this.pendingLatest) this.ensureLatestPump();
    });
  }
}
