import type { DerivedRecipeValue } from '../storage/derivedArtifactCache';

const DIGEST_REVISION = /^project-sha256:[0-9a-f]{64}$/;

export function isProjectCompileRevision(value: string): boolean {
  if (DIGEST_REVISION.test(value)) return true;
  if (!value.startsWith('project-json:')) return false;
  try {
    JSON.parse(value.slice('project-json:'.length));
    return true;
  } catch {
    return false;
  }
}

export function cycleBuildRecipe(
  projectRevision: string,
  buildEpochSecs: number,
  engineCommit: string,
  engineRecipe: string,
  snapshotSourcesIdentity: string,
): DerivedRecipeValue {
  if (!isProjectCompileRevision(projectRevision)) {
    throw new Error(`invalid project revision for Cycle build cache: ${projectRevision}`);
  }
  if (!Number.isSafeInteger(buildEpochSecs)) throw new Error('invalid Cycle build epoch');
  return {
    schema: 1,
    kind: 'closed-cycle-site-build',
    projectRevision,
    buildEpochSecs,
    engineCommit,
    engineRecipe,
    snapshotSourcesIdentity,
    target: 'cycle-site/v2',
  };
}

export function cycleOutputRecipe(
  buildId: string,
  kind: 'page' | 'asset',
  file: string,
  rendererRecipe: string,
): DerivedRecipeValue {
  return {
    schema: 1,
    kind: 'cycle-site-output',
    buildId,
    outputKind: kind,
    file,
    renderer: 'cycle-site/v2',
    rendererRecipe,
  };
}
