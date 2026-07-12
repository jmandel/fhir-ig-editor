import { describe, expect, test } from 'bun:test';
import {
  PREPARED_PACKAGE_MEDIA_TYPE,
  validPreparedPackagePointer,
} from '../src/worker/preparedPackageCache';

const digest = 'a'.repeat(64);

function pointer(overrides: Record<string, unknown> = {}) {
  return {
    schema: 3,
    label: 'example.pkg#1.2.3',
    transportIdentity: 'sha256:transport',
    cacheKey: `pp3-sha256-${digest}-n1-d1-a1`,
    artifactSha256: 'c'.repeat(64),
    bytes: 123,
    ...overrides,
  };
}

describe('PreparedPackage v3 pointer boundary', () => {
  test('accepts only the current schema, key tuple, label, and transport identity', () => {
    expect(validPreparedPackagePointer(
      pointer(),
      'example.pkg#1.2.3',
      'sha256:transport',
    )).toBe(true);
    expect(validPreparedPackagePointer(pointer({ schema: 2 }))).toBe(false);
    expect(validPreparedPackagePointer(pointer({
      cacheKey: `pp2-sha256-${digest}-n1-d1-a1`,
    }))).toBe(false);
    expect(validPreparedPackagePointer(pointer(), 'other.pkg#1.2.3')).toBe(false);
    expect(validPreparedPackagePointer(pointer(), undefined, 'other')).toBe(false);
  });

  test('matches Rust canonical numeric parsing before reading ContentStore bytes', () => {
    expect(validPreparedPackagePointer(pointer({
      cacheKey: `pp3-sha256-${digest}-n2-d1-a1`,
    }))).toBe(false);
    expect(validPreparedPackagePointer(pointer({
      cacheKey: `pp3-sha256-${digest.toUpperCase()}-n1-d1-a1`,
    }))).toBe(false);
    expect(validPreparedPackagePointer(pointer({
      cacheKey: `pp3-sha256-${digest}-n1-d2-a1`,
    }))).toBe(false);
  });

  test('uses a distinct v3 ContentStore media type', () => {
    expect(PREPARED_PACKAGE_MEDIA_TYPE).toBe('application/vnd.fhir.package.prepared.v3');
  });
});
