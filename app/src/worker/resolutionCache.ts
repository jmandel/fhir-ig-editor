/** Host-side mirror of the engine's config-bound package-resolution state.
 * Any fresh mount invalidates both the Rust fixpoint and this cached outcome. */
export class ResolutionCache<T> {
  private generation = 0;
  private entry: { config: string; generation: number; value: T } | null = null;

  get(config: string): T | null {
    return this.entry?.config === config && this.entry.generation === this.generation
      ? this.entry.value
      : null;
  }

  record(config: string, value: T): void {
    this.entry = { config, generation: this.generation, value };
  }

  /** Mirror a successful mount transaction. Empty/idempotent mounts preserve
   * the outcome; any newly mounted label starts a new package generation. */
  noteMount(newlyMounted: readonly string[]): boolean {
    if (newlyMounted.length === 0) return false;
    this.generation += 1;
    this.entry = null;
    return true;
  }

  clear(): void {
    this.entry = null;
  }
}
