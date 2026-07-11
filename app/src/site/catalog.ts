import type { OutputCatalog } from './contract';

/** Publication requires a content-addressed closed non-page namespace. */
export function assertClosedNonPageCatalog(catalog: OutputCatalog): void {
  for (const output of catalog.outputs) {
    if (output.kind !== 'page' && !output.content) {
      throw new Error(`Output catalog ${catalog.buildId} has unresolved ${output.kind} '${output.path}'`);
    }
  }
}
