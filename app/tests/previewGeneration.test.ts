import { expect, test } from 'bun:test';

import {
  previewCacheCandidates,
  previewContentChanged,
  preparePreviewHtml,
  registeredPreviewPaths,
} from '../src/preview/previewWindow';

test('hot-reload baseline never reads a cache from the newly published generation', () => {
  expect(
    previewCacheCandidates(
      ['unrelated', 'igpreview::100', 'igpreview::102', 'igpreview::101', 'igpreview::99'],
      101,
    ),
  ).toEqual(['igpreview::101', 'igpreview::100', 'igpreview::99']);
});

test('a generation-only snippet change does not reload an unchanged page', () => {
  const before = '<main>same profile</main><script>var me={"generation":100}</script>';
  const after = '<main>same profile</main><script>var me={"generation":101}</script>';
  expect(previewContentChanged(before, after)).toBe(false);
  expect(previewContentChanged(before, after.replace('same profile', 'changed profile'))).toBe(true);
  expect(previewContentChanged(null, after)).toBe(true);
});

test('open preview paths are scoped to the IG URL key', () => {
  const now = 1_000_000;
  const registry = new Map([
    ['tab-a', { igId: 'ig-a', path: 'en/index.html', lastSeen: now }],
    ['tab-b', { igId: 'ig-a', path: 'en/profile.html', lastSeen: now }],
    ['tab-c', { igId: 'ig-b', path: 'en/index.html', lastSeen: now }],
    ['tab-d', { igId: 'ig-b', path: 'other.html', lastSeen: now }],
  ]);
  expect(registeredPreviewPaths(registry, 'ig-a', now)).toEqual(['en/index.html', 'en/profile.html']);
  expect(registeredPreviewPaths(registry, 'ig-b', now)).toEqual(['en/index.html', 'other.html']);
  expect(registeredPreviewPaths(registry, 'missing', now)).toEqual([]);
});

test('one preview client replaces its prior path and stale clients expire', () => {
  const now = 1_000_000;
  const registry = new Map([
    ['navigated-tab', { igId: 'ig-a', path: 'en/current.html', lastSeen: now }],
    ['other-tab', { igId: 'ig-a', path: 'en/current.html', lastSeen: now }],
    ['closed-tab', { igId: 'ig-a', path: 'en/old.html', lastSeen: now - 5 * 60_000 - 1 }],
  ]);
  expect(registeredPreviewPaths(registry, 'ig-a', now)).toEqual(['en/current.html']);
});

test('preview preparation replaces an old control block instead of stacking listeners', () => {
  const index = preparePreviewHtml('<html><head></head><body>page</body></html>', 'ig-a', 'en/index.html', 100);
  const profile = preparePreviewHtml(index, 'ig-a', 'en/profile.html', 101);
  expect(profile.match(/<script data-igpreview="hot-reload"/g)?.length).toBe(1);
  expect(profile.match(/<base data-igpreview="base"/g)?.length).toBe(1);
  expect(profile).not.toContain('"path":"en/index.html"');
  expect(profile).toContain('"path":"en/profile.html"');
  const script = profile.match(/<script data-igpreview="hot-reload">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Function(script!)).not.toThrow();
});
