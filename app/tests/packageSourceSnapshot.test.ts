import { describe, expect, test } from 'bun:test';

import {
  packageSourceSnapshot,
  viaPackageSource,
} from '../src/vfs/packageSettings';

describe('package source snapshots', () => {
  test('binds normalized resolver order and proxy without a time component', () => {
    const first = packageSourceSnapshot(
      [' https://first.example/// ', 'https://second.example/path/'],
      ' https://proxy.example/ ',
    );
    const same = packageSourceSnapshot(
      ['https://first.example', 'https://second.example/path'],
      'https://proxy.example',
    );
    const reordered = packageSourceSnapshot(
      ['https://second.example/path', 'https://first.example'],
      'https://proxy.example',
    );

    expect(first.registries).toEqual([
      'https://first.example',
      'https://second.example/path',
    ]);
    expect(first.proxy).toBe('https://proxy.example');
    expect(first.sourceKey).toBe(same.sourceKey);
    expect(first.sourceKey).not.toBe(reordered.sourceKey);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.registries)).toBe(true);
    expect(viaPackageSource(first, 'https://first.example/example.pkg'))
      .toBe('https://proxy.example?url=https%3A%2F%2Ffirst.example%2Fexample.pkg');
  });
});
