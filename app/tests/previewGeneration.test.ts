import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

import type { ContentRef } from '../src/site/contract';
import {
  PREVIEW_SW_PROTOCOL,
  isSafePreviewPath,
  postPreviewCommit,
  previewContentChanged,
  previewWorkerPublication,
  previewWorkerScriptPath,
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

function fakePreviewWorker(
  scriptURL: string,
  state: ServiceWorkerState = 'activated',
): ServiceWorker {
  return Object.assign(new EventTarget(), {
    state,
    scriptURL,
    postMessage(message: unknown, transfer: Transferable[] = []) {
      if ((message as { type?: unknown })?.type === 'igpreview:ping') {
        (transfer[0] as MessagePort | undefined)?.postMessage({
          type: 'igpreview:pong',
          protocol: PREVIEW_SW_PROTOCOL,
        });
      }
    },
  }) as unknown as ServiceWorker;
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
  expect(second).toContain('scrollTo(target.x, target.y)');
  expect(second).toContain('ResizeObserver');
  expect(second).toContain('requestAnimationFrame');
  expect(second).not.toContain('8_000');
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
    targetGeneration: 101,
    fromContentSha256: ref('a').sha256,
  }));
  let layoutReady = false;
  const animationFrames: Array<() => void> = [];
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
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    requestAnimationFrame(callback: () => void) {
      animationFrames.push(callback);
      return animationFrames.length;
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
  const nextFrame = () => {
    const callback = animationFrames.shift();
    expect(callback).toBeDefined();
    callback?.();
  };

  installPreviewControls({
    generator: 'cycle',
    path: 'en/index.html',
    generation: 101,
    contentSha256: ref('b').sha256,
  }, 'igpreview', runtime as never);

  // Parsing-time scrollTo is clamped because the final document is not laid
  // out. The saved record remains durable until restoration really succeeds.
  expect(runtime.scrollY).toBe(0);
  expect(storage.has(key)).toBeTrue();

  layoutReady = true;
  document.readyState = 'complete';
  emit('load');
  expect(runtime.scrollY).toBe(640);
  expect(storage.has(key)).toBeTrue();
  expect(runtime.history.scrollRestoration).toBe('manual');

  // A template's late initialization scroll invalidates the pending stable
  // boundary and is corrected without a wall-clock timeout.
  runtime.scrollY = 0;
  emit('scroll');
  expect(runtime.scrollY).toBe(640);

  // The stale candidate frame restarts the check. Two consecutive paint
  // boundaries at the target then prove readiness and relinquish ownership.
  nextFrame();
  nextFrame();
  nextFrame();
  expect(storage.has(key)).toBeFalse();
  expect(runtime.history.scrollRestoration).toBe('auto');

  // Browser find, fragment, accessibility, and programmatic scrolling are no
  // longer corrected once the stable target handoff is complete.
  runtime.scrollY = 0;
  emit('scroll');
  expect(runtime.scrollY).toBe(0);
});

test('trusted scroll ownership cancels restoration immediately', () => {
  const listeners = new Map<string, Set<(event: { isTrusted?: boolean }) => void>>();
  const storage = new Map<string, string>();
  const key = 'igpreview:scroll:cycle\nen/index.html';
  storage.set(key, JSON.stringify({
    x: 0,
    y: 640,
    targetGeneration: 101,
    fromContentSha256: ref('a').sha256,
  }));
  const runtime = {
    location: { pathname: '/preview/cycle/en/index.html', reload() {} },
    document: {
      readyState: 'loading',
      documentElement: {},
      addEventListener() {},
      removeEventListener() {},
    },
    history: { scrollRestoration: 'auto' },
    scrollX: 0,
    scrollY: 0,
    scrollTo() {},
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
    addEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type: string, listener: (event: { isTrusted?: boolean }) => void) {
      listeners.get(type)?.delete(listener);
    },
  };

  installPreviewControls({
    generator: 'cycle',
    path: 'en/index.html',
    generation: 101,
    contentSha256: ref('b').sha256,
  }, 'igpreview', runtime as never);

  expect(storage.has(key)).toBeTrue();
  for (const listener of [...(listeners.get('wheel') ?? [])]) listener({ isTrusted: true });
  expect(storage.has(key)).toBeFalse();
  expect(runtime.history.scrollRestoration).toBe('auto');
});

test('controlled WindowClients are the complete open-preview authority', async () => {
  Object.assign(self, {
    location: new URL('https://example.test/fhir-ig-editor/preview-sw-v8.js'),
    registration: { scope: 'https://example.test/fhir-ig-editor/preview/' },
  });
  const { previewPathsForClients } = await import('../public/preview-sw-v8.js?controlled-open-paths');
  const editor = { url: 'https://example.test/fhir-ig-editor/' };
  const tabA = { url: 'https://example.test/fhir-ig-editor/preview/ig-a/en/a.html' };
  const duplicateA = { url: 'https://example.test/fhir-ig-editor/preview/ig-a/en/a.html#second-tab' };
  const tabB = { url: 'https://example.test/fhir-ig-editor/preview/ig-a/en/b.html' };
  const otherGuide = { url: 'https://example.test/fhir-ig-editor/preview/ig-b/en/a.html' };

  expect(previewPathsForClients(
    [editor, tabB, duplicateA, otherGuide, tabA],
    'ig-a',
    'https://example.test',
  )).toEqual(['en/a.html', 'en/b.html']);
  // No close message is needed or trusted: once tab B is absent from the next
  // controlled-client snapshot, its path is absent too. Duplicate tabs remain
  // one render/reload path by construction.
  expect(previewPathsForClients(
    [editor, duplicateA, otherGuide, tabA],
    'ig-a',
    'https://example.test',
  )).toEqual(['en/a.html']);

  const controls = await readFile(new URL('../public/preview-controls.js', import.meta.url), 'utf8');
  expect(controls).not.toContain('igpreview:client-id');
  expect(controls).not.toContain("type: 'hello'");
  expect(controls).not.toContain("type: 'bye'");
  expect(controls).not.toContain("message.type === 'who'");
});

test('Service Worker persists a per-IG pointer and has no byte-provisioning side channel', async () => {
  const sw = await readFile(new URL('../public/preview-sw-v8.js', import.meta.url), 'utf8');
  expect(sw).toContain('igpreview-state:v');
  expect(sw).toContain('const PREVIEW_STORAGE_SCHEMA = 6');
  expect(sw).toContain('await writePublication(publication)');
  expect(sw).toContain('await readPublication(parsed.igId)');
  expect(sw).toContain("message.type === 'igpreview:read'");
  expect(sw).toContain('source: publication.source');
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
  expect(sw).toContain('This response is not cached.');
  expect(sw).toContain('onclick="location.reload()">Retry preview</button>');
  expect(sw).toContain('Why rendering failed');
  expect(sw).toContain("error.trim().slice(0, 4_000)");
  expect(sw).toContain("reply?.type === 'igpreview:accepted'");
  expect(sw).toContain("reply?.type === 'igpreview:complete'");
  expect(sw).toContain("message.type === 'igpreview:ping'");
  expect(sw).toContain('commitRequests');
  expect(sw).toContain("type: 'igpreview:pending'");
  expect(sw).toContain("import { preparePreviewHtml } from './preview-controls-v8.js'");
  expect(sw).toContain("const LEGACY_STATE_CACHES = ['igpreview-state:v5', 'igpreview-state:v4']");
  expect(sw).toContain("const LEGACY_OUTPUT_CACHE_PREFIXES = ['igpreview-output:v5:', 'igpreview-output:v4:']");
  expect(sw).toContain('ownerClientId');
  expect(sw).toContain('self.clients.get(publication.ownerClientId)');
  expect(sw).toContain("self.clients.matchAll({ type: 'window', includeUncontrolled: false })");
  expect(sw).toContain('openPaths');
  expect(sw).not.toContain('1_500');
  expect(sw).not.toContain('8_000');
});

test('an accepted publication is not failed by a total-work deadline', async () => {
  let complete: (() => void) | null = null;
  const worker = Object.assign(new EventTarget(), {
    state: 'activated' as ServiceWorkerState,
    postMessage(message: unknown, transfer: Transferable[]) {
      const commitId = (message as { commitId: string }).commitId;
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: 'igpreview:accepted', protocol: PREVIEW_SW_PROTOCOL, commitId });
      complete = () => port.postMessage({
        type: 'igpreview:complete',
        ok: true,
        protocol: PREVIEW_SW_PROTOCOL,
        commitId,
        generation: 43,
      });
    },
  }) as unknown as ServiceWorker;
  const pending = postPreviewCommit(worker, source(), 43);
  expect(complete).not.toBeNull();
  complete?.();
  expect(await pending).toMatchObject({ ok: true, generation: 43 });
});

test('an accepted publication recovers by idempotent status after Worker execution loss', async () => {
  const commitIds: string[] = [];
  let attempt = 0;
  let retry: (() => void) | null = null;
  const worker = Object.assign(new EventTarget(), {
    state: 'activated' as ServiceWorkerState,
    postMessage(message: unknown, transfer: Transferable[]) {
      attempt += 1;
      const commitId = (message as { commitId: string }).commitId;
      commitIds.push(commitId);
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: 'igpreview:accepted', protocol: PREVIEW_SW_PROTOCOL, commitId });
      if (attempt > 1) {
        port.postMessage({
          type: 'igpreview:complete',
          ok: true,
          protocol: PREVIEW_SW_PROTOCOL,
          commitId,
          generation: 44,
        });
      }
    },
  }) as unknown as ServiceWorker;
  const pending = postPreviewCommit(worker, source(), 44, () => true, (scheduled) => {
    retry = scheduled;
    return () => {};
  });
  await Promise.resolve();
  expect(retry).not.toBeNull();
  retry?.();
  expect(await pending).toMatchObject({ ok: true, generation: 44 });
  expect(commitIds).toHaveLength(2);
  expect(commitIds[0]).toBe(commitIds[1]);
});

test('an accepted publication follows a compatible replacement with the same commit id', async () => {
  const commitIds: string[] = [];
  let retry: (() => void) | null = null;
  const first = Object.assign(new EventTarget(), {
    state: 'activated' as ServiceWorkerState,
    postMessage(message: unknown, transfer: Transferable[]) {
      const commitId = (message as { commitId: string }).commitId;
      commitIds.push(commitId);
      (first as unknown as { state: ServiceWorkerState }).state = 'redundant';
      first.dispatchEvent(new Event('statechange'));
      throw new Error('worker replaced between state check and postMessage');
    },
  }) as unknown as ServiceWorker;
  const replacement = Object.assign(new EventTarget(), {
    state: 'activated' as ServiceWorkerState,
    postMessage(message: unknown, transfer: Transferable[]) {
      const commitId = (message as { commitId: string }).commitId;
      commitIds.push(commitId);
      const port = transfer[0] as MessagePort;
      port.postMessage({ type: 'igpreview:accepted', protocol: PREVIEW_SW_PROTOCOL, commitId });
      port.postMessage({
        type: 'igpreview:complete', ok: true, protocol: PREVIEW_SW_PROTOCOL,
        commitId, generation: 45,
      });
    },
  }) as unknown as ServiceWorker;
  const pending = postPreviewCommit(first, source(), 45, () => true, (scheduled) => {
    retry = scheduled;
    return () => {};
  }, async () => replacement);
  expect(retry).not.toBeNull();
  retry?.();
  expect(await pending).toMatchObject({ ok: true, generation: 45 });
  expect(commitIds).toHaveLength(2);
  expect(commitIds[0]).toBe(commitIds[1]);
});

test('an accepted page render remains pending until its exact owner completes it', async () => {
  const body = new TextEncoder().encode('<html>deferred but valid</html>').buffer;
  const bodyLength = body.byteLength;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', body)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const editor = {
    id: 'owning-editor',
    url: 'https://example.test/fhir-ig-editor/',
    postMessage(message: unknown, transfer: Transferable[]) {
      const requestId = (message as { requestId: string }).requestId;
      const port = transfer[0] as MessagePort;
      port.onmessage = (event) => {
        if (event.data?.type === 'igpreview:lease-check') {
          port.postMessage({ type: 'igpreview:alive', protocol: PREVIEW_SW_PROTOCOL, requestId });
        }
      };
      port.postMessage({ type: 'igpreview:accepted', protocol: PREVIEW_SW_PROTOCOL, requestId });
      complete = () => port.postMessage({
        type: 'igpreview:complete',
        protocol: PREVIEW_SW_PROTOCOL,
        requestId,
        ok: true,
        path: 'en/index.html',
        mediaType: 'text/html',
        content: { sha256: digest, byteLength: bodyLength, mediaType: 'text/html' },
        body,
      }, [body]);
    },
  };
  let complete: (() => void) | null = null;
  Object.assign(self, {
    location: new URL('https://example.test/fhir-ig-editor/preview-sw-v8.js'),
    registration: { scope: 'https://example.test/fhir-ig-editor/preview/' },
    clients: {
      get: async (id: string) => id === editor.id ? editor : undefined,
    },
  });
  const {
    requestFromEditor,
    validatePublication,
  } = await import('../public/preview-sw-v8.js?owned-render-lifecycle');
  expect(validatePublication(source(), 43, editor.id, 'commit-test-43').ownerClientId).toBe(editor.id);
  expect(() => validatePublication(source(), 43, null, 'commit-test-43')).toThrow('WindowClient owner');
  const pending = requestFromEditor({
    ownerClientId: editor.id,
    responderProtocol: PREVIEW_SW_PROTOCOL,
    source: { igId: 'tiny', buildId: 'slow-build' },
  }, {
    path: 'en/index.html',
    mediaType: 'text/html',
  }, 'igpreview:render');
  let settled = false;
  void pending.then(() => { settled = true; });
  await Promise.resolve();
  expect(complete).not.toBeNull();
  expect(settled).toBeFalse();
  complete?.();
  const result = await pending;
  expect(result?.ref.sha256).toBe(digest);
  expect(result?.bytes.byteLength).toBe(bodyLength);

  const absent = await requestFromEditor({
    ownerClientId: 'another-editor',
    source: { igId: 'tiny', buildId: 'slow-build' },
  }, {
    path: 'en/index.html',
    mediaType: 'text/html',
  }, 'igpreview:render');
  expect(absent).toEqual({ error: 'the editor owning this preview is no longer open' });

  const closingEditor = { id: 'closing-editor', postMessage() {} };
  let ownerObservations = 0;
  Object.assign(self, { clients: { get: async (id: string) => {
    if (id !== closingEditor.id) return undefined;
    ownerObservations += 1;
    return ownerObservations < 3 ? closingEditor : undefined;
  } } });
  const closed = await requestFromEditor({
    ownerClientId: closingEditor.id,
    responderProtocol: PREVIEW_SW_PROTOCOL,
    source: { igId: 'tiny', buildId: 'slow-build' },
  }, {
    path: 'en/index.html',
    mediaType: 'text/html',
  }, 'igpreview:render', { pollMs: 1 });
  expect(closed).toEqual({
    error: 'the editor owning this preview closed during rendering',
  });
});

test('protocol 8 can finish a response owned by an already-open protocol 6 editor', async () => {
  const body = new TextEncoder().encode('<html>legacy responder</html>').buffer;
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', body)),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
  const editor = {
    id: 'legacy-editor',
    postMessage(_message: unknown, transfer: Transferable[]) {
      (transfer[0] as MessagePort).postMessage({
        ok: true,
        path: 'en/index.html',
        mediaType: 'text/html',
        content: { sha256: digest, byteLength: body.byteLength, mediaType: 'text/html' },
        body,
      }, [body]);
    },
  };
  Object.assign(self, { clients: { get: async (id: string) => id === editor.id ? editor : undefined } });
  const { requestFromEditor } = await import('../public/preview-sw-v8.js?legacy-responder');
  const result = await requestFromEditor({
    ownerClientId: editor.id,
    responderProtocol: 6,
    source: { igId: 'tiny', buildId: 'legacy-build' },
  }, {
    path: 'en/index.html',
    mediaType: 'text/html',
  }, 'igpreview:render');
  expect(result?.ref.sha256).toBe(digest);
});

test('preview worker URL binds the rolling-deployment protocol', () => {
  expect(previewWorkerScriptPath('/fhir-ig-editor/')).toBe(
    '/fhir-ig-editor/preview-sw.js?protocol=6',
  );
});

test('a persisted preview pointer is validated before provisional restore', async () => {
  const publicationWorker = Object.assign(fakePreviewWorker(
    'https://example.test/preview-sw.js?protocol=6',
  ), {
    postMessage(message: unknown, transfer: Transferable[]) {
      expect(message).toEqual({ type: 'igpreview:read', protocol: PREVIEW_SW_PROTOCOL, igId: 'uscore' });
      const port = transfer[0] as MessagePort;
      queueMicrotask(() => port.postMessage({
        ok: true,
        protocol: PREVIEW_SW_PROTOCOL,
        generation: 42,
        source: source(),
      }));
    },
  });
  expect(await previewWorkerPublication(publicationWorker, 'uscore')).toEqual({
    generation: 42,
    source: source(),
  });

  const wrongIgWorker = Object.assign(fakePreviewWorker(
    'https://example.test/preview-sw.js?protocol=6',
  ), {
    postMessage(_message: unknown, transfer: Transferable[]) {
      const port = transfer[0] as MessagePort;
      queueMicrotask(() => port.postMessage({
        ok: true,
        protocol: PREVIEW_SW_PROTOCOL,
        generation: 42,
        source: { ...source(), igId: 'mcode' },
      }));
    },
  });
  expect(await previewWorkerPublication(wrongIgWorker, 'uscore')).toBeNull();

  const replacedWorker = fakePreviewWorker(
    'https://example.test/preview-sw.js?protocol=6',
    'redundant',
  );
  expect(await previewWorkerPublication(replacedWorker, 'uscore')).toBeNull();
});

test('an old active worker cannot win while its compatible replacement installs', async () => {
  const desired = 'https://example.test/fhir-ig-editor/preview-sw.js?protocol=6';
  const legacy = Object.assign(fakePreviewWorker(desired), {
    postMessage(_message: unknown, transfer: Transferable[]) {
      (transfer[0] as MessagePort).postMessage({ type: 'igpreview:pong', protocol: 6 });
    },
  });
  const current = fakePreviewWorker(desired, 'installing');
  let active = legacy;
  let installing: ServiceWorker | null = current;
  const registration = new EventTarget() as ServiceWorkerRegistration;
  Object.defineProperties(registration, {
    active: { get: () => active },
    installing: { get: () => installing },
    waiting: { get: () => null },
  });
  let updateCalls = 0;
  registration.update = async () => {
    updateCalls += 1;
    throw new Error('an exact installing worker must not trigger an update');
  };
  const pending = waitForCompatiblePreviewWorker(registration, desired);
  (current as unknown as { state: ServiceWorkerState }).state = 'activated';
  active = current;
  installing = null;
  current.dispatchEvent(new Event('statechange'));
  const selected = await pending;
  expect(selected).toBe(current);
  expect(updateCalls).toBe(0);
});

test('matching script URL cannot substitute for semantic protocol compatibility', async () => {
  const desired = 'https://example.test/fhir-ig-editor/preview-sw.js?protocol=6';
  const wrongProtocol = Object.assign(fakePreviewWorker(desired), {
    postMessage(_message: unknown, transfer: Transferable[]) {
      (transfer[0] as MessagePort).postMessage({ type: 'igpreview:pong', protocol: 7 });
    },
  });
  await expect(waitForCompatiblePreviewWorker({
    active: wrongProtocol,
    installing: null,
    waiting: null,
  }, desired)).rejects.toThrow('does not implement protocol');
});
