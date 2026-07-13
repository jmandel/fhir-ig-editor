import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const CONTRACT = readFileSync(new URL('../src/site/contract.generated.ts', import.meta.url), 'utf8');
const WORKER = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');

describe('Cycle resource-page subjects', () => {
  test('the public catalog carries the renderer-declared exact subject', () => {
    expect(CONTRACT).toContain('subject?: OutputResourceSubject');
    expect(CONTRACT).toContain('subjectPage?: OutputSubjectPage');

    const projection = WORKER.slice(
      WORKER.indexOf('function publicCycleDescriptor'),
      WORKER.indexOf('async function renderCycleOutput'),
    );
    expect(projection).toContain('subject: { ...output.subject }');
    expect(projection).toContain('subjectPage: output.subjectPage');
  });
});
