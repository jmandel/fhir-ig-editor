import { describe, expect, test } from 'bun:test';
import { presentProgress } from '../src/progressPresentation';

describe('progress presentation', () => {
  test('reports bytes actually downloaded against a known total', () => {
    expect(presentProgress({
      stage: 'bundle-fetch',
      message: 'Downloading core',
      bytes: 3 * 1024 * 1024,
      totalBytes: 12 * 1024 * 1024,
    })).toEqual({
      downloading: true,
      byteLabel: '3.0 / 12.0 MB',
      fraction: 0.25,
    });
  });

  test('reports downloaded megabytes when a server omits the total', () => {
    expect(presentProgress({
      stage: 'registry-fetch',
      message: 'Downloading package',
      bytes: 512 * 1024,
    })).toEqual({
      downloading: true,
      byteLabel: '0.50 MB downloaded',
      fraction: null,
    });
  });

  test('does not turn build work into a fake download or progress bar', () => {
    expect(presentProgress({
      stage: 'site-build',
      message: 'Building site',
      fraction: 0.5,
      inputBytes: 12 * 1024 * 1024,
    })).toEqual({ downloading: false, byteLabel: null, fraction: null });
  });

  test('never lets a mismatched response overfill the bar', () => {
    expect(presentProgress({
      stage: 'manifest',
      message: 'Downloading project',
      bytes: 20,
      totalBytes: 10,
    }).fraction).toBe(1);
  });
});
