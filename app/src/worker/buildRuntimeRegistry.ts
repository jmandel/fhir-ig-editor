/** Private two-generation registry for immutable worker build runtimes. */
export class BuildRuntimeRegistry<T> {
  private readonly values = new Map<string, T>();
  private recent: string[] = [];

  get(handle: string): T | undefined {
    return this.values.get(handle);
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

  handles(): string[] {
    return [...this.recent];
  }
}
