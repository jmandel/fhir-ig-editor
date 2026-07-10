import { expect, test } from 'bun:test';

import {
  PREVIEW_SW_PROTOCOL,
  commitPreviewGenerationWithFallback,
  isCompatiblePreviewWorkerPong,
  previewCacheCandidates,
  previewContentChanged,
  previewWorkerProtocol,
  previewWorkerScriptPath,
  preparePreviewHtml,
  registeredPreviewPaths,
  waitForCompatiblePreviewWorker,
} from '../src/preview/previewWindow';

function fakePreviewWorker(scriptURL: string, protocol?: number): ServiceWorker {
  return {
    state: 'activated',
    scriptURL,
    postMessage(message: unknown, transfer: Transferable[]) {
      if ((message as { type?: string })?.type !== 'igpreview:ping') return;
      const port = transfer[0] as MessagePort;
      queueMicrotask(() => port.postMessage({
        type: 'igpreview:pong',
        ...(protocol == null ? {} : { protocol }),
      }));
    },
  } as unknown as ServiceWorker;
}

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

test('preview worker URL and pong bind the rolling-deployment protocol', async () => {
  expect(previewWorkerScriptPath('/fhir-ig-editor/')).toBe(
    `/fhir-ig-editor/preview-sw.js?protocol=${PREVIEW_SW_PROTOCOL}`,
  );
  expect(isCompatiblePreviewWorkerPong({ type: 'igpreview:pong' })).toBeFalse();
  expect(isCompatiblePreviewWorkerPong({
    type: 'igpreview:pong',
    protocol: PREVIEW_SW_PROTOCOL,
  })).toBeTrue();

  const legacy = fakePreviewWorker('https://example.test/fhir-ig-editor/preview-sw.js');
  expect(await previewWorkerProtocol(legacy, 20)).toBeNull();
});

test('an old active worker cannot win while its compatible replacement installs', async () => {
  const desired = `https://example.test/fhir-ig-editor/preview-sw.js?protocol=${PREVIEW_SW_PROTOCOL}`;
  const legacy = fakePreviewWorker('https://example.test/fhir-ig-editor/preview-sw.js');
  const current = fakePreviewWorker(desired, PREVIEW_SW_PROTOCOL);
  let active = legacy;
  let updates = 0;
  const registration = {
    get active() {
      return active;
    },
    async update() {
      updates += 1;
      globalThis.setTimeout(() => {
        active = current;
      }, 5);
      return registration;
    },
  } as unknown as ServiceWorkerRegistration;

  const selected = await waitForCompatiblePreviewWorker(registration, desired, {
    timeoutMs: 250,
    pollMs: 2,
    pingTimeoutMs: 20,
  });
  expect(selected).toBe(current);
  expect(updates).toBe(1);
});

test('a slow full asset commit degrades to a small usable generation commit', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const result = await commitPreviewGenerationWithFallback(
    { generation: 7, igId: 'demo' },
    'en/',
    [{ key: 'assets/site.css', mime: 'text/css', bytes: new ArrayBuffer(8) }],
    true,
    () => true,
    async (message) => {
      calls.push(message);
      if (calls.length === 1) throw new Error('simulated mobile transfer timeout');
      return true;
    },
  );

  expect(result.committed).toBeTrue();
  expect(result.fullAssetsCommitted).toBeFalse();
  expect(calls).toHaveLength(2);
  expect(calls[0].hasAssetManifest).toBeTrue();
  expect((calls[0].assets as unknown[])).toHaveLength(1);
  expect(calls[1]).toMatchObject({
    type: 'igpreview:commitGeneration',
    generation: 7,
    igId: 'demo',
    hasAssetManifest: false,
    assets: [],
  });
});
