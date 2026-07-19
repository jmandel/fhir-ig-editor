import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_REGISTRIES,
  directMetadataReadable,
  metadataUrl,
  packageSourceSnapshot,
  tarballUrl,
  viaPackageSource,
} from '../src/vfs/packageSettings';

describe('package source snapshots', () => {
  test('default exact-package URLs avoid packages2 malformed CORS redirect', () => {
    expect(DEFAULT_REGISTRIES).toEqual([
      'https://packages.fhir.org',
      'https://packages2.fhir.org/packages',
    ]);
    expect(tarballUrl(DEFAULT_REGISTRIES[0], 'us.nlm.vsac', '0.24.0'))
      .toBe('https://packages.fhir.org/us.nlm.vsac/0.24.0');
    expect(tarballUrl(DEFAULT_REGISTRIES[1], 'us.nlm.vsac', '0.24.0'))
      .toBe('https://packages2.fhir.org/web/us.nlm.vsac-0.24.0.tgz');
    expect(metadataUrl(DEFAULT_REGISTRIES[1], 'us.nlm.vsac'))
      .toBe('https://packages2.fhir.org/packages/us.nlm.vsac');
    expect(directMetadataReadable(DEFAULT_REGISTRIES[0])).toBeTrue();
    expect(directMetadataReadable(DEFAULT_REGISTRIES[1])).toBeFalse();
    expect(directMetadataReadable('https://mirror.example/packages')).toBeTrue();
  });

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
