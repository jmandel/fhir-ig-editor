import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(new URL('../src/worker/client.ts', import.meta.url), 'utf8');
const RESOLVER_SOURCE = readFileSync(new URL('../src/worker/packageResolver.ts', import.meta.url), 'utf8');

describe('template PreparedPackage transport', () => {
  test('selects the authenticated warm pointer and retains a raw cold fallback', () => {
    expect(SOURCE).not.toContain("!entry.label.includes('.template#')");
    expect(SOURCE).toContain('if (!forceRaw)');
    expect(SOURCE).toContain('findPreparedPackage(entry.label, transportIdentity)');
    expect(SOURCE).toContain("return { kind: 'prepared', pointer }");
    expect(SOURCE).toContain('this.loadBundle(entry, stageLabel, true, report)');

    const warmLookup = SOURCE.indexOf('findPreparedPackage(entry.label, transportIdentity)');
    const networkFetch = SOURCE.indexOf('resp = await fetch(url)');
    expect(warmLookup).toBeGreaterThan(-1);
    expect(networkFetch).toBeGreaterThan(warmLookup);
    expect(SOURCE).not.toContain('readCachedBundle');
    expect(SOURCE).not.toContain("import('./inflate')");
    expect(SOURCE).toContain("return { kind: 'tgz', label: entry.label, bytes: compressed, transportIdentity }");
  });

  test('uses complete prepared packages for live template acquisition', () => {
    expect(RESOLVER_SOURCE).not.toContain("!label.includes('.template#')");
    expect(RESOLVER_SOURCE).not.toContain('unexpectedly selected prepared-only transport');
    expect(RESOLVER_SOURCE).toContain('await host.mount([packageInput])');
    expect(RESOLVER_SOURCE).toContain('Promise<boolean>');
  });

  test('recovers a bad prepared artifact only from original transports', () => {
    expect(SOURCE).toContain('this.loadBundle(entry, stageLabel, true, report)');
    expect(RESOLVER_SOURCE).toContain('if (hasLocalPackage(label))');
    expect(RESOLVER_SOURCE).toContain('await fetchFromRegistry(label, missing');
    expect(SOURCE).not.toContain('bundleCache');
    expect(RESOLVER_SOURCE).not.toContain('bundleCache');
  });
});
