import { describe, expect, test } from 'bun:test';

import { exactPackageClosureIdentity } from '../src/worker/packageClosureIdentity';
import type { ResolutionStep } from '../src/worker/protocol';

const step: ResolutionStep = {
  resolver_schema: 1,
  compile_set: [{ package_id: 'example.pkg', version: '1.0.0' }],
  context_closure: [{ package_id: 'example.pkg', version: '1.0.0' }],
  resolution_support: [],
  missing: [],
  satisfied: true,
  mutable_requests: [],
};

describe('exact package closure identity', () => {
  test('changes when the same coordinate is republished with different bytes', () => {
    const first = exactPackageClosureIdentity(step, new Map([
      ['example.pkg#1.0.0', `pp1-sha256-${'a'.repeat(64)}-n1-d1-a1`],
    ]));
    const republished = exactPackageClosureIdentity(step, new Map([
      ['example.pkg#1.0.0', `pp1-sha256-${'b'.repeat(64)}-n1-d1-a1`],
    ]));
    expect(republished).not.toBe(first);
  });

  test('fails closed when any resolved member lacks a content identity', () => {
    expect(() => exactPackageClosureIdentity(step, new Map()))
      .toThrow('cannot establish exact package identity');
  });
});
