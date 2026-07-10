import { expect, test } from 'bun:test';

import { assertCompatibleEngineCommit } from '../src/worker/engineVersion';

test('engine/app commit compatibility fails closed outside explicit dev mode', () => {
  expect(() => assertCompatibleEngineCommit('abc123', 'abc123')).not.toThrow();
  expect(() => assertCompatibleEngineCommit('dev', 'dirty')).not.toThrow();
  expect(() => assertCompatibleEngineCommit(undefined, 'dirty')).not.toThrow();
  expect(() => assertCompatibleEngineCommit('abc123', 'def456')).toThrow(
    'Engine version mismatch: app expects abc123, loaded def456',
  );
});
