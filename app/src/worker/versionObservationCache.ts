/** One successful mutable-version observation. `cacheable` is false when any
 * registry transport was unreachable, aborted, or malformed during the
 * attempt; reachable empty observations remain cacheable. */
export interface VersionObservation {
  readonly versions: readonly string[];
  readonly unreachable: boolean;
  readonly cacheable: boolean;
}

export interface ObservedVersion<T> {
  readonly value: T;
  readonly fromCache: boolean;
}

/** Worker-session cache with attempt-scoped promotion. There is deliberately no
 * TTL: exact source/local epochs and Worker lifetime are the invalidators. */
export class VersionObservationCache<T> {
  private scope: string | null = null;
  private committed = new Map<string, T>();
  private inFlight = new Map<string, Promise<T>>();

  constructor(private readonly isCacheable: (value: T) => boolean) {}

  syncScope(scope: string): boolean {
    if (this.scope === scope) return false;
    this.scope = scope;
    this.committed.clear();
    this.inFlight.clear();
    return true;
  }

  clear(): void {
    this.scope = null;
    this.committed.clear();
    this.inFlight.clear();
  }

  begin(scope: string): VersionObservationAttempt<T> {
    this.syncScope(scope);
    return new VersionObservationAttempt(this, scope);
  }

  lookup(scope: string, id: string): T | undefined {
    return this.scope === scope ? this.committed.get(id) : undefined;
  }

  sharedFlight(scope: string, id: string): Promise<T> | undefined {
    return this.scope === scope ? this.inFlight.get(id) : undefined;
  }

  startFlight(scope: string, id: string, load: () => Promise<T>): Promise<T> {
    const pending = load();
    if (this.scope !== scope) return pending;
    this.inFlight.set(id, pending);
    void pending.finally(() => {
      if (this.scope === scope && this.inFlight.get(id) === pending) {
        this.inFlight.delete(id);
      }
    }).catch(() => {});
    return pending;
  }

  cacheable(value: T): boolean {
    return this.isCacheable(value);
  }

  promote(scope: string, observations: ReadonlyMap<string, T>): void {
    if (this.scope !== scope) return;
    for (const [id, value] of observations) this.committed.set(id, value);
  }
}

export class VersionObservationAttempt<T> {
  private readonly observed = new Map<string, Promise<T>>();
  private readonly successful = new Map<string, T>();
  private closed = false;

  constructor(
    private readonly owner: VersionObservationCache<T>,
    private readonly scope: string,
  ) {}

  async observe(id: string, load: () => Promise<T>): Promise<ObservedVersion<T>> {
    if (this.closed) throw new Error('version-observation attempt is closed');
    const committed = this.owner.lookup(this.scope, id);
    if (committed !== undefined) return { value: committed, fromCache: true };

    let fromCache = true;
    let pending = this.observed.get(id) ?? this.owner.sharedFlight(this.scope, id);
    if (!pending) {
      fromCache = false;
      pending = this.owner.startFlight(this.scope, id, load);
    }
    this.observed.set(id, pending);
    try {
      const value = await pending;
      if (this.owner.cacheable(value)) this.successful.set(id, value);
      else this.observed.delete(id);
      return { value, fromCache };
    } catch (error) {
      this.observed.delete(id);
      throw error;
    }
  }

  commit(): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.promote(this.scope, this.successful);
    this.observed.clear();
    this.successful.clear();
  }

  discard(): void {
    this.closed = true;
    this.observed.clear();
    this.successful.clear();
  }
}
