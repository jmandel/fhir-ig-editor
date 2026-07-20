/** Private two-generation registry for immutable worker build runtimes. */
export class BuildRuntimeRegistry<T> {
  private readonly values = new Map<string, T>();
  private recent: string[] = [];

  get(handle: string): T | undefined {
    return this.values.get(handle);
  }

  /** Reuse an exact retained runtime and make its successful preparation the
   * current generation. Ordinary reads deliberately remain recency-neutral. */
  touch(handle: string): T | undefined {
    const value = this.values.get(handle);
    if (value === undefined) return undefined;
    this.recent = [handle, ...this.recent.filter((candidate) => candidate !== handle)];
    return value;
  }

  /** Install only after preparation has fully succeeded. Current and immediate
   * predecessor remain callable for preview hash comparison; older values go. */
  install(handle: string, value: T): void {
    this.values.set(handle, value);
    this.recent = [handle, ...this.recent.filter((candidate) => candidate !== handle)].slice(0, 2);
    const retained = new Set(this.recent);
    for (const candidate of this.values.keys()) {
      if (!retained.has(candidate)) this.values.delete(candidate);
    }
  }

  /** Drop an unpublished candidate while preserving every other retained
   * runtime and its recency. Repeated release is deliberately harmless. */
  release(handle: string): boolean {
    const released = this.values.delete(handle);
    this.recent = this.recent.filter((candidate) => candidate !== handle);
    return released;
  }

  handles(): string[] {
    return [...this.recent];
  }
}
