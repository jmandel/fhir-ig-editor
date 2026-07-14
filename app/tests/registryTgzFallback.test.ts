import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  obtainRawPackageByLabel,
  retryRegistryTgzCarrier,
} from '../src/worker/packageResolver';
import type { PackageMountInput } from '../src/worker/protocol';

const originalFetch = globalThis.fetch;
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

function useRegistries(...registries: string[]): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return key === 'fhir-ig-editor.pkg-registries' ? registries.join('\n') : null;
      },
    },
  });
}

describe('registry TGZ fallback', () => {
  test('retries only the canonical typed Worker integrity failure and retains retry bytes', () => {
    const worker = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');
    expect(worker).toContain("phase: 'package-transport'");
    expect(worker).toContain("code: 'integrity'");
    expect(worker).toContain('retryable: true');
    expect(worker).toContain('throw tgzPreparationFailure(item.label, error)');
    expect(client).toContain("error.detail.phase !== 'package-transport'");
    expect(client).toContain("error.detail.code !== 'integrity'");
    expect(client).toContain("item.transportIdentity !== 'unpinned'");
    expect(client).toContain('retryRegistryTgzCarrier(');
  });

  test('continues at the next registry after Worker preparation rejects a carrier', async () => {
    useRegistries('https://first.example', 'https://second.example');
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      const body = url.startsWith('https://first.example') ? 'invalid-tgz' : 'valid-tgz';
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(body.length) },
      });
    }) as typeof fetch;

    const first = await obtainRawPackageByLabel('example.pkg#1.0.0');
    expect(first?.kind).toBe('tgz');
    if (!first || first.kind !== 'tgz') throw new Error('expected first registry carrier');
    expect(new TextDecoder().decode(first.bytes)).toBe('invalid-tgz');

    const second = await retryRegistryTgzCarrier(first, () => {});
    expect(second?.kind).toBe('tgz');
    if (!second || second.kind !== 'tgz') throw new Error('expected second registry carrier');
    expect(new TextDecoder().decode(second.bytes)).toBe('valid-tgz');
    expect(await retryRegistryTgzCarrier(second, () => {})).toBeNull();
    expect(requested).toEqual([
      'https://first.example/example.pkg/1.0.0',
      'https://second.example/example.pkg/1.0.0',
    ]);
  });

  test('does not give baked or otherwise untracked TGZ carriers registry authority', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('must not fetch');
    }) as typeof fetch;
    const baked: PackageMountInput = {
      kind: 'tgz',
      label: 'example.pkg#1.0.0',
      bytes: new TextEncoder().encode('baked').buffer,
      transportIdentity: `tgz-${'a'.repeat(64)}`,
    };
    expect(await retryRegistryTgzCarrier(baked, () => {})).toBeNull();
    expect(fetched).toBeFalse();
  });
});
