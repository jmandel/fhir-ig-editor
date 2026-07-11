/* Test fixture: the last unversioned preview-worker control protocol.
 * It understands ping but does not report a protocol and deliberately ignores
 * commitGeneration, reproducing the returning-browser failure from production. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('message', (event) => {
  const message = event.data;
  if (message?.type === 'igpreview:ping') {
    event.ports[0]?.postMessage({ type: 'igpreview:pong', generation: 0 });
  }
  // The legacy worker has no igpreview:commit handler or ACK.
});
