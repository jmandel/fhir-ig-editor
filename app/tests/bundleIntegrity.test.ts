import { describe, expect, test } from 'bun:test';

import {
  BakedBundleIntegrityError,
  BakedBundleTransportError,
  parseBakedBundleManifest,
  readResponseBytes,
  readVerifiedBundleBytes,
} from '../src/worker/bundleIntegrity';
import { obtainAndMountPackage } from '../src/worker/packageResolver';
import { addLocalPackage } from '../src/worker/localPackages';
import type { PackageMountInput } from '../src/worker/protocol';
import {
  createPackageTransportGuard,
  openPackageTransport,
  PackageTransportInactivityError,
} from '../src/worker/transportInactivity';
import type { PackageTransportScheduler } from '../src/worker/transportInactivity';

const ABC_SHA256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

class ManualScheduler implements PackageTransportScheduler {
  private nowMs = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { atMs: number; callback: () => void }>();

  schedule(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { atMs: this.nowMs + delayMs, callback });
    return id;
  }

  cancel(handle: unknown): void {
    this.tasks.delete(handle as number);
  }

  advance(delayMs: number): void {
    const targetMs = this.nowMs + delayMs;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.atMs <= targetMs)
        .sort((left, right) => left[1].atMs - right[1].atMs)[0];
      if (!due) break;
      const [id, task] = due;
      this.tasks.delete(id);
      this.nowMs = task.atMs;
      task.callback();
    }
    this.nowMs = targetMs;
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function ticketHost(
  commitInputs: (inputs: PackageMountInput[]) => void,
): (labels: readonly string[]) => Promise<{
  stage(index: number, input: PackageMountInput): Promise<void>;
  commit(): Promise<{ mounted: number; newlyMounted: string[]; events: [] }>;
  abort(): Promise<void>;
}> {
  return async (labels) => {
    const inputs: Array<PackageMountInput | undefined> = new Array(labels.length);
    return {
      stage: async (index, input) => { inputs[index] = input; },
      commit: async () => {
        const complete = inputs.filter((input) => input !== undefined) as PackageMountInput[];
        commitInputs(complete);
        return { mounted: complete.length, newlyMounted: [...labels], events: [] };
      },
      abort: async () => {},
    };
  };
}

describe('baked package transport integrity', () => {
  test('a header fetch with no activity aborts at the inactivity boundary', async () => {
    const scheduler = new ManualScheduler();
    let fetchSignal: AbortSignal | null = null;
    const opening = openPackageTransport(
      'example.pkg#1.0.0',
      'https://packages.example/example.tgz',
      {},
      {
        inactivityMs: 1_000,
        scheduler,
        fetcher: (_input, init) => {
          fetchSignal = init?.signal ?? null;
          return new Promise<Response>(() => {});
        },
      },
    );
    const outcome = opening.then(
      () => null,
      (error: unknown) => error,
    );

    scheduler.advance(999);
    await flushMicrotasks();
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(false);
    scheduler.advance(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(PackageTransportInactivityError);
    expect((error as PackageTransportInactivityError).phase).toBe('response headers');
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  test('closing after headers still aborts the underlying fetch', async () => {
    let fetchSignal: AbortSignal | null = null;
    const { guard } = await openPackageTransport(
      'example.pkg#1.0.0',
      'https://packages.example/example.tgz',
      {},
      {
        fetcher: async (_input, init) => {
          fetchSignal = init?.signal ?? null;
          return new Response('unused');
        },
      },
    );

    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(false);
    guard.close();
    expect((fetchSignal as AbortSignal | null)?.aborted).toBe(true);
  });

  test('body activity permits a slow stream whose total time exceeds the interval', async () => {
    const scheduler = new ManualScheduler();
    const guard = createPackageTransportGuard('example.pkg#1.0.0', 1_000, scheduler);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    }));
    const reading = readResponseBytes(response, undefined, 2, guard);

    scheduler.advance(900);
    controller.enqueue(new Uint8Array([97]));
    await flushMicrotasks();
    scheduler.advance(900);
    controller.enqueue(new Uint8Array([98]));
    await flushMicrotasks();
    scheduler.advance(900);
    controller.close();

    expect(new TextDecoder().decode(await reading)).toBe('ab');
    expect(guard.signal.aborted).toBe(false);
    guard.close();
  });

  test('a body that stops producing chunks aborts at the inactivity boundary', async () => {
    const scheduler = new ManualScheduler();
    const guard = createPackageTransportGuard('example.pkg#1.0.0', 1_000, scheduler);
    const response = new Response(new ReadableStream<Uint8Array>({ start() {} }));
    const reading = readResponseBytes(response, undefined, undefined, guard);
    const outcome = reading.then(
      () => null,
      (error: unknown) => error,
    );

    // Response.arrayBuffer starts consumption on the stream's pull microtask;
    // advance the injected clock only after that first guarded read is active.
    await flushMicrotasks();
    scheduler.advance(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(PackageTransportInactivityError);
    expect((error as PackageTransportInactivityError).phase).toBe('response body');
    expect(guard.signal.aborted).toBe(true);
  });

  test('manifest requires unique entries with lowercase SHA-256 digests', () => {
    const parsed = parseBakedBundleManifest({
      bundles: [{
        label: 'example.pkg#1.0.0',
        tgz: 'example.pkg#1.0.0.tgz',
        sha256: ABC_SHA256,
        bytes: 3,
        loadPhase: 'on-demand',
      }],
    });
    expect(parsed.bundles[0].sha256).toBe(ABC_SHA256);
    expect(parsed.bundles[0].loadPhase).toBe('on-demand');

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

  test('HTTP and interrupted-body failures are classified as transport failures', async () => {
    const entry = { label: 'example.pkg#1.0.0', sha256: ABC_SHA256, bytes: 3 };
    await expect(readVerifiedBundleBytes(
      new Response('missing', { status: 503 }),
      entry,
    )).rejects.toBeInstanceOf(BakedBundleTransportError);

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a'));
        controller.error(new Error('connection reset'));
      },
    });
    await expect(readVerifiedBundleBytes(
      new Response(body),
      entry,
    )).rejects.toBeInstanceOf(BakedBundleTransportError);
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
      openMount: ticketHost(() => { mounted = true; }),
      bakedBundle: () => baked,
      fetchBaked: async () => {
        throw new BakedBundleIntegrityError('digest mismatch');
      },
    }, baked.label, () => {})).rejects.toThrow('digest mismatch');
    expect(mounted).toBe(false);
  });

  test('a transient baked transport interruption retries the exact artifact', async () => {
    let attempts = 0;
    let mounted = false;
    const progress: string[] = [];
    const baked = {
      label: 'example.pkg#1.0.0',
      tgz: 'example.pkg#1.0.0.tgz',
      sha256: ABC_SHA256,
      loadPhase: 'compile' as const,
    };
    const result = await obtainAndMountPackage({
      resolveStep: async () => { throw new Error('unused'); },
      openMount: ticketHost(([input]) => {
        mounted = input.kind === 'raw' && input.spec.label === baked.label;
      }),
      bakedBundle: () => baked,
      fetchBaked: async () => {
        attempts += 1;
        if (attempts === 1) throw new BakedBundleTransportError('connection reset');
        return {
          kind: 'raw',
          spec: { label: baked.label, files: {} },
          transportIdentity: `tgz-${baked.sha256}`,
        };
      },
    }, baked.label, (event) => progress.push(event.message));
    expect(result).toBe(true);
    expect(attempts).toBe(2);
    expect(mounted).toBe(true);
    expect(progress).toContain(
      `Retrying ${baked.label} from this app after a transport interruption…`,
    );
  });

  test('an unavailable transport aborts its open mount ticket without committing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('registry offline');
    }) as typeof fetch;
    const label = 'stalled-transport.pkg#1.0.0';
    let attempts = 0;
    let commits = 0;
    let aborts = 0;
    try {
      const mounted = await obtainAndMountPackage({
        resolveStep: async () => { throw new Error('unused'); },
        openMount: async () => ({
          stage: async () => { throw new Error('must not stage'); },
          commit: async () => {
            commits += 1;
            return { mounted: 0, newlyMounted: [], events: [] };
          },
          abort: async () => { aborts += 1; },
        }),
        bakedBundle: () => ({
          label,
          tgz: `${label}.tgz`,
          sha256: ABC_SHA256,
          loadPhase: 'compile',
        }),
        fetchBaked: async () => {
          attempts += 1;
          throw new BakedBundleTransportError('inactive package transport', {
            cause: new PackageTransportInactivityError(label, 'response body', 1_000),
          });
        },
      }, label, () => {});

      expect(mounted).toBe(false);
      expect(attempts).toBe(2);
      expect(aborts).toBe(1);
      expect(commits).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a baked decode failure is fatal and is not retried or downgraded', async () => {
    let attempts = 0;
    const baked = {
      label: 'example.pkg#1.0.0',
      tgz: 'example.pkg#1.0.0.tgz',
      sha256: ABC_SHA256,
      loadPhase: 'compile' as const,
    };
    await expect(obtainAndMountPackage({
      resolveStep: async () => { throw new Error('unused'); },
      openMount: ticketHost(() => { throw new Error('must not mount'); }),
      bakedBundle: () => baked,
      fetchBaked: async () => {
        attempts += 1;
        throw new Error('invalid gzip stream');
      },
    }, baked.label, () => {})).rejects.toThrow('invalid gzip stream');
    expect(attempts).toBe(1);
  });

  test('an explicit local package overrides baked transport for the same coordinate', async () => {
    const label = 'transport-fallback.pkg#1.0.0';
    addLocalPackage(label, { 'package.json': 'e30=' });
    let attempts = 0;
    let mountedFromLocal = false;
    const progress: string[] = [];
    const baked = {
      label,
      tgz: `${label}.tgz`,
      sha256: ABC_SHA256,
      loadPhase: 'compile' as const,
    };
    const result = await obtainAndMountPackage({
      resolveStep: async () => { throw new Error('unused'); },
      openMount: ticketHost(([input]) => {
        mountedFromLocal = input.kind === 'raw'
          && input.transportIdentity === 'unpinned'
          && input.spec.label === label;
      }),
      bakedBundle: () => baked,
      fetchBaked: async () => {
        attempts += 1;
        throw new BakedBundleTransportError('offline');
      },
    }, label, (event) => progress.push(event.message));
    expect(result).toBe(true);
    expect(attempts).toBe(0);
    expect(mountedFromLocal).toBe(true);
    expect(progress).toEqual([]);
  });
});
