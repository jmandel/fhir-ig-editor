/** Host-side mirror of the package labels in one replaceable Rust Session. */
export class MountedLabels {
  private labels = new Set<string>();

  /** Commit a successful Session.init(), whose semantics replace all packages. */
  replace(labels: Iterable<string>): void {
    this.labels = new Set(labels);
  }

  /** Select one transactional mount batch without changing committed state. */
  fresh<T extends { label: string }>(bundles: readonly T[]): T[] {
    const transaction = new Set<string>();
    const fresh: T[] = [];
    for (const bundle of bundles) {
      if (this.labels.has(bundle.label)) continue;
      if (transaction.has(bundle.label)) {
        throw new Error(`mountPackages: duplicate new package label in one transaction: ${bundle.label}`);
      }
      transaction.add(bundle.label);
      fresh.push(bundle);
    }
    return fresh;
  }

  /** Commit labels only after Session.mount() succeeds. */
  add(bundles: readonly { label: string }[]): void {
    for (const bundle of bundles) this.labels.add(bundle.label);
  }

  get size(): number {
    return this.labels.size;
  }
}
