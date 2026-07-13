import type { CompilationDefinition, CompilationResource } from '../site/contract';

/** Presentation-only source location for an authored JSON resource. It is not
 * part of CompilationOutcome because predefined resources are inputs, not
 * compiler outputs. */
export interface PredefinedResourceDefinition {
  kind: 'predefined-resource';
  path: string;
  line: number;
  column: number;
}

export type ResourceDefinition = CompilationDefinition | PredefinedResourceDefinition;

/** Explore merges canonical compiler outputs with authored JSON inputs. */
export type ResourceView = Omit<CompilationResource, 'definition'> & {
  definition?: ResourceDefinition;
};
