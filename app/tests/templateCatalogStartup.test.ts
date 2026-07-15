import { afterAll, describe, expect, test } from 'bun:test';
import { CURATED_TEMPLATES, getCuratedCatalogs } from '../src/adapters/templateCatalog';

const originalFetch = globalThis.fetch;

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe('curated template catalog startup', () => {
  test('single-flights StrictMode callers and retains one page-process result', async () => {
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        versions: { '1.0.0': {} },
        'dist-tags': { latest: '1.0.0' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    const first = getCuratedCatalogs();
    const replay = getCuratedCatalogs();
    expect(replay).toBe(first);
    const [one, two] = await Promise.all([first, replay]);
    expect(two).toBe(one);
    expect(fetches).toBe(CURATED_TEMPLATES.length);

    const retained = getCuratedCatalogs();
    expect(retained).toBe(first);
    expect(await retained).toBe(one);
    expect(fetches).toBe(CURATED_TEMPLATES.length);
  });
});
