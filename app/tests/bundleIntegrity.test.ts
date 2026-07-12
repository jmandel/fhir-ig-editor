import { describe, expect, test } from 'bun:test';

import {
  BakedBundleIntegrityError,
  parseBakedBundleManifest,
  readResponseBytes,
  readVerifiedBundleBytes,
} from '../src/worker/bundleIntegrity';
import { obtainAndMountPackage } from '../src/worker/packageResolver';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('baked package transport integrity', () => {
  test('manifest requires unique entries with lowercase SHA-256 digests', () => {
    const parsed = parseBakedBundleManifest({
      bundles: [{
        label: 'example.pkg#1.0.0',
        tgz: 'example.pkg#1.0.0.tgz',
        sha256: ABC_SHA256,
        bytes: 3,
        loadPhase: 'snapshot',
      }],
    });
    expect(parsed.bundles[0].sha256).toBe(ABC_SHA256);
    expect(parsed.bundles[0].loadPhase).toBe('snapshot');

    expect(() => parseBakedBundleManifest({
      bundles: [{ label: 'example.pkg#1.0.0', tgz: 'x.tgz' }],
    })).toThrow('valid lowercase SHA-256');
    expect(() => parseBakedBundleManifest({
      bundles: [{ label: 'example.pkg#1.0.0', tgz: 'x.tgz', sha256: ABC_SHA256, loadPhase: 'later' }],
    })).toThrow('invalid loadPhase');
    expect(() => parseBakedBundleManifest({
      bundles: [
        { label: 'example.pkg#1.0.0', tgz: 'a.tgz', sha256: ABC_SHA256, loadPhase: 'compile' },
        { label: 'example.pkg#1.0.0', tgz: 'b.tgz', sha256: ABC_SHA256, loadPhase: 'compile' },
      ],
    })).toThrow('duplicate label');
  });

  test('compressed bytes are authenticated before being returned', async () => {
    const entry = { label: 'example.pkg#1.0.0', sha256: ABC_SHA256, bytes: 3 };
    const verified = await readVerifiedBundleBytes(new Response('abc'), entry);
    expect(new TextDecoder().decode(verified)).toBe('abc');

    await expect(readVerifiedBundleBytes(
      new Response('abd'),
      entry,
    )).rejects.toBeInstanceOf(BakedBundleIntegrityError);
    await expect(readVerifiedBundleBytes(
      new Response('abc'),
      { ...entry, bytes: 4 },
    )).rejects.toThrow('byte length mismatch');
  });

  test('stream progress starts at zero and counts consumed response bytes', async () => {
    const updates: Array<[number, number | undefined]> = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('ab'));
        controller.enqueue(new TextEncoder().encode('c'));
        controller.close();
      },
    });
    const bytes = await readResponseBytes(
      new Response(body),
      (read, total) => updates.push([read, total]),
      3,
    );
    expect(new TextDecoder().decode(bytes)).toBe('abc');
    expect(updates).toEqual([[0, 3], [3, 3]]);
  });

  test('announces verification only after the complete transport is consumed', async () => {
    const events: string[] = [];
    await expect(readVerifiedBundleBytes(
      new Response('abd'),
      { label: 'example.pkg#1.0.0', sha256: ABC_SHA256, bytes: 3 },
      (read) => events.push(`read:${read}`),
      () => events.push('verify'),
    )).rejects.toBeInstanceOf(BakedBundleIntegrityError);
    expect(events).toEqual(['read:0', 'read:3', 'verify']);
  });

  test('a baked digest failure cannot downgrade to an unpinned registry source', async () => {
    let mounted = false;
    const baked = {
      label: 'example.pkg#1.0.0',
      tgz: 'example.pkg#1.0.0.tgz',
      sha256: ABC_SHA256,
      loadPhase: 'compile' as const,
    };
    await expect(obtainAndMountPackage({
      resolveStep: async () => { throw new Error('unused'); },
      mount: async () => { mounted = true; },
      bakedBundle: () => baked,
      fetchBaked: async () => {
        throw new BakedBundleIntegrityError('digest mismatch');
      },
    }, baked.label, () => {})).rejects.toThrow('digest mismatch');
    expect(mounted).toBe(false);
  });
});
