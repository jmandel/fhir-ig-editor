import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import type { ContentRef } from '../src/site/contract';
import {
  PREVIEW_SW_PROTOCOL,
  isCompatiblePreviewWorkerPong,
  isSafePreviewPath,
  previewContentChanged,
  previewWorkerProtocol,
  previewWorkerScriptPath,
  registeredPreviewPaths,
  validatePreviewSource,
  waitForCompatiblePreviewWorker,
} from '../src/preview/previewWindow';
import { installPreviewControls, preparePreviewHtml } from '../public/preview-controls.js';

const ref = (digit: string, byteLength = 12): ContentRef => ({
  sha256: digit.repeat(64),
  byteLength,
  mediaType: 'text/html; charset=utf-8',
});

const source = (content: ContentRef | null = ref('a')) => ({
  igId: 'uscore',
  handle: 'build-handle-1',
  buildId: 'sb1-sha256:one',
  catalog: {
    buildId: 'sb1-sha256:one',
    outputs: [{
      path: 'en/index.html',
      kind: 'page' as const,
      mediaType: 'text/html; charset=utf-8',
      ...(content ? { content } : {}),
    }],
  },
});

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

test('catalog publication accepts one immutable safe output set', () => {
  const validated = validatePreviewSource(source());
  expect(validated).toEqual(source());
  expect(Object.isFrozen(validated)).toBeTrue();
  expect(Object.isFrozen(validated.catalog.outputs)).toBeTrue();
  expect(Object.isFrozen(validated.catalog.outputs[0].content)).toBeTrue();
  expect(validatePreviewSource(source(null)).catalog.outputs[0].content).toBeUndefined();
  for (const path of ['../secret', '/absolute', 'en/../secret', 'en\\index.html', 'en/a?b']) {
    expect(isSafePreviewPath(path)).toBeFalse();
  }
  expect(isSafePreviewPath('en/StructureDefinition-us-core-patient.html')).toBeTrue();
  expect(() => validatePreviewSource({
    ...source(),
    catalog: { ...source().catalog, buildId: 'another-build' },
  })).toThrow('does not belong');
  expect(() => validatePreviewSource({
    ...source(),
    catalog: { ...source().catalog, outputs: [source().catalog.outputs[0], source().catalog.outputs[0]] },
  })).toThrow('duplicate');
  expect(() => validatePreviewSource({ ...source(), igId: 'bad\\id' })).toThrow('IG id');
});

test('hot reload compares canonical ContentRefs, not generation text', () => {
  expect(previewContentChanged(ref('a'), ref('a'))).toBeFalse();
  expect(previewContentChanged(ref('a'), ref('b'))).toBeTrue();
  expect(previewContentChanged(ref('a', 12), ref('a', 13))).toBeTrue();
  expect(previewContentChanged(null, ref('a'))).toBeTrue();
});

test('response-time controls preserve base, anchors, and explicit scroll restoration', () => {
  const path = 'en/StructureDefinition-us-core-careplan.html';
  const first = preparePreviewHtml(
    '<html><head></head><body><a href="#tabs-key">Key</a></body></html>',
    '/preview/',
    'uscore',
    path,
    100,
    ref('a').sha256,
  );
  const second = preparePreviewHtml(first, '/preview/', 'uscore', path, 101, ref('b').sha256);
  expect(second.match(/<script data-igpreview="hot-reload"/g)).toHaveLength(1);
  expect(second.match(/<base data-igpreview="base"/g)).toHaveLength(1);
  expect(second).toContain('sessionStorage.setItem(scrollKey');
  expect(second).toContain('scrollTo(position.x, position.y)');
  expect(second).toContain('ResizeObserver');
  expect(second).toContain('fromContentSha256');
  expect(second).toContain(`"generation":101`);
  expect(second).not.toContain(`"generation":100`);
  expect(second).toContain(`"contentSha256":"${ref('b').sha256}"`);
  const baseHref = second.match(/<base data-igpreview="base" href="([^"]+)">/)?.[1];
  const documentUrl = new URL(baseHref!, 'https://example.test');
  expect(new URL('#tabs-key', documentUrl).href).toBe(`${documentUrl.href}#tabs-key`);
  expect(new URL('assets/site.css', documentUrl).pathname).toBe('/preview/uscore/en/assets/site.css');
  expect(second.indexOf('data-igpreview="hot-reload"')).toBeLessThan(second.indexOf('<a href='));
  const script = second.match(/<script data-igpreview="hot-reload">([\s\S]*?)<\/script>/)?.[1];
  expect(() => new Function(script!)).not.toThrow();
});

test('scroll restoration survives incomplete layout and late page-script scrolling', () => {
  const runtimeListeners = new Map<string, Set<(event: { isTrusted?: boolean }) => void>>();
  const documentListeners = new Map<string, Set<() => void>>();
  const add = <T extends (...args: never[]) => unknown>(map: Map<string, Set<T>>, type: string, listener: T) => {
    const listeners = map.get(type) ?? new Set<T>();
    listeners.add(listener);
    map.set(type, listeners);
  };
  const remove = <T extends (...args: never[]) => unknown>(map: Map<string, Set<T>>, type: string, listener: T) => {
    map.get(type)?.delete(listener);
  };
  const storage = new Map<string, string>();
  const key = 'igpreview:scroll:cycle\nen/index.html';
  storage.set(key, JSON.stringify({
    x: 0,
    y: 640,
    savedAt: Date.now(),
    targetGeneration: 101,
    fromContentSha256: ref('a').sha256,
  }));
  let layoutReady = false;
  const document = {
    readyState: 'loading',
    documentElement: {},
    addEventListener(type: string, listener: () => void) {
      add(documentListeners, type, listener);
    },
    removeEventListener(type: string, listener: () => void) {
      remove(documentListeners, type, listener);
    },
  };
  const runtime = {
    location: { pathname: '/preview/cycle/en/index.html', reload() {} },
    document,
    history: { scrollRestoration: 'auto' },
    scrollX: 0,
    scrollY: 0,
    scrollTo(x: number, y: number) {
      runtime.scrollX = x;
      runtime.scrollY = layoutReady ? y : 0;
    },
    sessionStorage: {
      getItem(name: string) { return storage.get(name) ?? null; },
      setItem(name: string, value: string) { storage.set(name, value); },
      removeItem(name: string) { storage.delete(name); },
    },
    BroadcastChannel: class {
      onmessage = null;
      postMessage() {}
    },
    crypto: { randomUUID: () => 'client-id' },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout: () => 1,
    clearTimeout() {},
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    addEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void) {
      add(runtimeListeners, type, listener);
    },
    removeEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void) {
      remove(runtimeListeners, type, listener);
    },
  };
  const emit = (type: string, event: { isTrusted?: boolean } = {}) => {
    for (const listener of [...(runtimeListeners.get(type) ?? [])]) listener(event);
  };

  installPreviewControls({
    generator: 'cycle',
    path: 'en/index.html',
    generation: 101,
    contentSha256: ref('b').sha256,
  }, 'igpreview', runtime as never);

  // Parsing-time scrollTo is clamped because the final document is not laid
  // out, and the target remains durable rather than being removed prematurely.
  expect(runtime.scrollY).toBe(0);
  expect(storage.has(key)).toBeTrue();

  layoutReady = true;
  document.readyState = 'complete';
  emit('load');
  expect(runtime.scrollY).toBe(640);

  // A template's late initialization scroll is corrected without a timer.
  runtime.scrollY = 0;
  emit('scroll');
  expect(runtime.scrollY).toBe(640);

  // A trusted user gesture cancels the bounded controller immediately.
  emit('wheel', { isTrusted: true });
  runtime.scrollY = 0;
  emit('scroll');
  expect(runtime.scrollY).toBe(0);
  expect(storage.has(key)).toBeFalse();
  expect(runtime.history.scrollRestoration).toBe('auto');
});

test('one preview client replaces history and stale clients expire', () => {
  const now = 1_000_000;
  const registry = new Map([
    ['current', { igId: 'ig-a', path: 'en/current.html', lastSeen: now }],
    ['same-path', { igId: 'ig-a', path: 'en/current.html', lastSeen: now }],
    ['other-ig', { igId: 'ig-b', path: 'en/current.html', lastSeen: now }],
    ['expired', { igId: 'ig-a', path: 'en/old.html', lastSeen: now - 5 * 60_000 - 1 }],
  ]);
  expect(registeredPreviewPaths(registry, 'ig-a', now)).toEqual(['en/current.html']);
});

test('Service Worker persists a per-IG pointer and has no byte-provisioning side channel', async () => {
  const sw = await readFile(new URL('../public/preview-sw.js', import.meta.url), 'utf8');
  expect(sw).toContain('igpreview-state:v');
  expect(sw).toContain('await writePublication(publication)');
  expect(sw).toContain('await readPublication(parsed.igId)');
  expect(sw).toContain('publication.generation <= existing.generation');
  expect(sw).toContain("getDirectoryHandle(OPFS_DIR, { create: false })");
  expect(sw).toContain('await sha256Hex(bytes) !== ref.sha256) return null');
  expect(sw).toContain("output.kind !== 'page'");
  expect(sw).toContain('reply.body instanceof ArrayBuffer');
  expect(sw).toContain("requestFromEditor(publication, output, 'igpreview:content')");
  expect(sw).toContain("requestFromEditor(publication, output, 'igpreview:render')");
  for (const removed of ['provisionAssets', 'assetManifest', 'pagePrefix', 'isBase64', 'base64To']) {
    expect(sw).not.toContain(removed);
  }
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
      globalThis.setTimeout(() => { active = current; }, 5);
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
