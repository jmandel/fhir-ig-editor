/** Fail closed when independently cached app and WASM artifacts do not name the
 * same engine commit. `dev`/undefined are explicit unpinned development modes. */
export function assertCompatibleEngineCommit(
  expected: string | undefined,
  actual: string,
): void {
  if (!expected || expected === 'dev' || actual === expected) return;
  throw new Error(
    `Engine version mismatch: app expects ${expected}, loaded ${actual}. `
      + 'Hard-reload the page (a redeploy left a stale cached engine).',
  );
}
