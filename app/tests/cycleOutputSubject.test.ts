import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CONTRACT = readFileSync(new URL('../src/site/contract.generated.ts', import.meta.url), 'utf8');
const CYCLE_RUNTIME = readFileSync(new URL('../src/worker/cycleRuntime.ts', import.meta.url), 'utf8');

describe('Cycle resource-page subjects', () => {
  test('the public catalog carries the renderer-declared exact subject', () => {
    expect(CONTRACT).toContain('subject?: OutputResourceSubject');
    expect(CONTRACT).toContain('subjectPage?: OutputSubjectPage');

    const projection = CYCLE_RUNTIME.slice(
      CYCLE_RUNTIME.indexOf('function publicCycleDescriptor'),
      CYCLE_RUNTIME.indexOf('export async function openCycleBuildRuntime'),
    );
    expect(projection).toContain('subject: { ...output.subject }');
    expect(projection).toContain('subjectPage: output.subjectPage');
  });
});
