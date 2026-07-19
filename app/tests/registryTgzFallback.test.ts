import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  fetchRegistryVersions,
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
  test('uses packages2 final blob directly after the primary registry misses', async () => {
    useRegistries('https://packages.fhir.org', 'https://packages2.fhir.org/packages');
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requested.push(url);
      if (url.startsWith('https://packages.fhir.org/')) {
        return new Response(null, { status: 404 });
      }
      return new Response('valid-tgz', {
        status: 200,
        headers: { 'content-length': '9' },
      });
    }) as typeof fetch;

    const carrier = await obtainRawPackageByLabel('us.nlm.vsac#0.24.0');
    expect(carrier?.kind).toBe('tgz');
    expect(requested).toEqual([
      'https://packages.fhir.org/us.nlm.vsac/0.24.0',
      'https://packages2.fhir.org/web/us.nlm.vsac-0.24.0.tgz',
    ]);
  });

  test('does not issue packages2 metadata request that Chromium must reject', async () => {
    useRegistries('https://packages.fhir.org', 'https://packages2.fhir.org/packages');
    const requested: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const observation = await fetchRegistryVersions('example.mutable', () => {});
    expect(requested).toEqual(['https://packages.fhir.org/example.mutable']);
    expect(observation).toEqual({ versions: [], unreachable: false, cacheable: true });
  });

  test('retries only integrity failures and makes resource-policy exhaustion final', () => {
    const worker = readFileSync(new URL('../src/worker/engine.worker.ts', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');
    const contract = readFileSync(new URL('../src/site/contract.generated.ts', import.meta.url), 'utf8');
    expect(worker).toContain("phase: 'package-transport'");
    expect(worker).toContain("code: 'integrity'");
    expect(worker).toContain('retryable: true');
    expect(worker).toContain("error.kind === 'resource-limit'");
    expect(worker).toContain("code: 'resource-limit'");
    expect(worker).toContain('retryable: false');
    expect(worker).toContain('Trying another registry will not help.');
    expect(worker).toContain('throw tgzPreparationFailure(item.label, error)');
    expect(client).toContain("error.detail.phase !== 'package-transport'");
    expect(client).toContain("error.detail.code !== 'integrity'");
    expect(client).toContain('isFailedRegistryTgzCarrier(error, input)');
    expect(client).toContain("input.kind === 'tgz' ? [input.bytes] : []");
    expect(client).toContain('retryRegistryTgzCarrier(');
    expect(contract).toContain('"resource-limit"');
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

    structuredClone({ input: first }, { transfer: [first.bytes] });
    expect(first.bytes.byteLength).toBe(0);

    // Retry stays on the acquisition's immutable source snapshot even if the
    // user changes settings while Rust is rejecting the first carrier.
    useRegistries('https://changed.example');
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
