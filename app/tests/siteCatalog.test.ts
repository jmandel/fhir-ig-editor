import { expect, test } from 'bun:test';
import { assertClosedNonPageCatalog } from '../src/site/catalog';
import type { OutputCatalog } from '../src/site/contract';

const ref = { sha256: 'a'.repeat(64), byteLength: 1, mediaType: 'text/plain' };

test.each(['cycle', 'publisher'])('%s publication closes every asset and auxiliary output', (buildId) => {
  const catalog: OutputCatalog = {
    buildId,
    outputs: [
      { path: 'index.html', kind: 'page', mediaType: 'text/html' },
      { path: 'assets/app.js', kind: 'asset', mediaType: 'text/javascript', content: ref },
      { path: 'extra.json', kind: 'auxiliary', mediaType: 'application/json', content: ref },
    ],
  };
  expect(() => assertClosedNonPageCatalog(catalog)).not.toThrow();
  expect(() => assertClosedNonPageCatalog({
    ...catalog,
    outputs: catalog.outputs.map((output) => output.kind === 'asset' ? { ...output, content: undefined } : output),
  })).toThrow('unresolved asset');
});
