import type { OutputDescriptor, OutputResourceSubject } from '../site/contract';
import type { ResourceView } from './resourceView';

/**
 * Stable UI identity for one compiled artifact. Output filenames are a
 * presentation detail and are neither unique nor stable across generators.
 * The authored definition location disambiguates two declarations of the same
 * FHIR subject; source-less generated resources deliberately share the subject
 * identity and are therefore de-duplicated rather than selected arbitrarily.
 */
export function resourceIdentity(resource: ResourceView): string {
  const subject = subjectOf(resource);
  const source = resource.definition
    ? [
        resource.definition.kind,
        resource.definition.path,
        resource.definition.line,
        resource.definition.column,
      ]
    : null;
  return JSON.stringify([
    subject ? [subject.resourceType, subject.id] : null,
    source,
    // Malformed/untyped compiler output still gets an exact stable identity,
    // without promoting its filename into a domain key.
    subject || source ? null : [resource.url ?? null, resource.text],
  ]);
}

/** Primary entries win when the same exact artifact is present in both sets. */
export function mergeResourcesByIdentity(
  primary: ResourceView[],
  additional: ResourceView[],
): ResourceView[] {
  const merged: ResourceView[] = [];
  const seen = new Set<string>();
  for (const resource of [...primary, ...additional]) {
    const identity = resourceIdentity(resource);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(resource);
  }
  return merged;
}

export function subjectOf(resource: ResourceView): OutputResourceSubject | null {
  return resource.resourceType && resource.id
    ? { resourceType: resource.resourceType, id: resource.id }
    : null;
}

export function sameSubject(
  left: OutputResourceSubject | null | undefined,
  right: OutputResourceSubject | null | undefined,
): boolean {
  return Boolean(left && right && left.resourceType === right.resourceType && left.id === right.id);
}

export function resourceForSubject(
  resources: ResourceView[],
  subject: OutputResourceSubject | null | undefined,
): ResourceView | null {
  const matches = resources.filter((resource) => sameSubject(subjectOf(resource), subject));
  return matches.length === 1 ? matches[0] : null;
}

export function resourceForPage(
  resources: ResourceView[],
  page: OutputDescriptor | null | undefined,
): ResourceView | null {
  return resourceForSubject(resources, page?.subject);
}

export function resourceForDefinition(
  resources: ResourceView[],
  definition: ResourceView['definition'] | null | undefined,
): ResourceView | null {
  if (!definition) return null;
  const matches = resources.filter((resource) => resource.definition
    && resource.definition.kind === definition.kind
    && resource.definition.path === definition.path
    && resource.definition.line === definition.line
    && resource.definition.column === definition.column);
  return matches.length === 1 ? matches[0] : null;
}

export function primaryPageForResource(
  pages: OutputDescriptor[] | null,
  resource: ResourceView | null,
): OutputDescriptor | null {
  const subject = resource ? subjectOf(resource) : null;
  if (!subject || !pages) return null;
  const matches = pages.filter((page) => page.subjectPage === 'primary' && sameSubject(page.subject, subject));
  return matches.length === 1 ? matches[0] : null;
}

export function soleResourceDeclaredIn(
  resources: ResourceView[],
  sourcePath: string,
): ResourceView | null {
  const matches = resources.filter((resource) => resource.definition?.path === sourcePath);
  return matches.length === 1 ? matches[0] : null;
}
