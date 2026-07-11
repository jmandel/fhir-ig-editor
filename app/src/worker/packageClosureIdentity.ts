import type { ResolutionStep } from './protocol';

const labels = (items: Array<{ package_id: string; version: string }>) =>
  items.map(({ package_id, version }) => `${package_id}#${version}`).sort();

/** Exact persistent compiler identity. Coordinates preserve resolver roles;
 * PreparedPackage keys bind every coordinate to normalized/indexed bytes. */
export function exactPackageClosureIdentity(
  step: ResolutionStep,
  mountedIdentities: ReadonlyMap<string, string>,
): string {
  const compile = labels(step.compile_set);
  const context = labels(step.context_closure);
  const resolutionSupport = labels(step.resolution_support ?? []);
  const identityLabels = [...new Set([...compile, ...context, ...resolutionSupport])].sort();
  const packages = identityLabels.map((label) => {
    const cacheKey = mountedIdentities.get(label);
    if (!cacheKey) {
      throw new Error(`cannot establish exact package identity for resolved closure member ${label}`);
    }
    return { label, cacheKey };
  });
  const missing = step.missing.map((item) => ({
    label: `${item.package_id}#${item.version}`,
    set: item.set,
    reason: item.reason,
  })).sort((left, right) => left.label.localeCompare(right.label) || left.set.localeCompare(right.set));
  return JSON.stringify({
    satisfied: step.satisfied,
    compile,
    context,
    resolutionSupport,
    packages,
    missing,
  });
}
