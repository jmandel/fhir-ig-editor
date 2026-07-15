/** Host-side mirror of the engine's config-bound package-resolution state.
 * Any fresh mount invalidates both the Rust fixpoint and this cached outcome. */
import type { ResolutionStep, VersionIndex } from './protocol';

interface CachedResolution {
  readonly step: ResolutionStep;
  readonly versionIndex: VersionIndex;
}

/** Rust intentionally owns one active resolver fixpoint. A host cache can keep
 * candidate evidence for A -> B -> A, but it cannot make A active merely by
 * returning an old object. Re-run Rust with the exact candidate universe and
 * accept the hint only when it reproduces the complete ordered step. */
export async function reactivateCachedResolution<T extends CachedResolution>(
  cached: T,
  resolve: (versionIndex: VersionIndex) => Promise<ResolutionStep>,
): Promise<T | null> {
  const step = await resolve(cached.versionIndex);
  if (!step.satisfied || JSON.stringify(step) !== JSON.stringify(cached.step)) return null;
  return { ...cached, step };
}

export class ResolutionCache<T> {
  private generation = 0;
  private entries: Array<{
    config: string;
    generation: number;
    sourceEpoch: string;
    value: T;
  }> = [];

  get(config: string, sourceEpoch: string): T | null {
    const index = this.entries.findIndex((entry) => entry.config === config
      && entry.generation === this.generation
      && entry.sourceEpoch === sourceEpoch);
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    this.entries.push(entry);
    return entry.value;
  }

  record(config: string, sourceEpoch: string, value: T): void {
    this.entries = this.entries.filter((entry) => !(entry.config === config
      && entry.generation === this.generation
      && entry.sourceEpoch === sourceEpoch));
    this.entries.push({ config, generation: this.generation, sourceEpoch, value });
    if (this.entries.length > 2) this.entries.shift();
  }

  /** Mirror a successful mount transaction. Empty/idempotent mounts preserve
   * the outcome; any newly mounted label starts a new package generation. */
  noteMount(newlyMounted: readonly string[]): boolean {
    if (newlyMounted.length === 0) return false;
    this.generation += 1;
    this.entries = [];
    return true;
  }

  clear(): void {
    this.entries = [];
  }
}
