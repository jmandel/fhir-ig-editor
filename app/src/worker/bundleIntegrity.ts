/** Integrity boundary for same-origin package bundles baked into the app. */

import type { PackageTransportGuard } from './transportInactivity';

export interface BakedBundleEntry {
  label: string;
  tgz: string;
  sha256: string;
  bytes?: number;
  /** Intended acquisition phase. Compile packages are still resolver-selected;
   * this is purpose metadata, not an instruction to mount them globally. */
  loadPhase: 'compile' | 'on-demand';
}

export interface BakedBundleManifest {
  bundles: BakedBundleEntry[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A fetched baked blob disagreed with its deployment manifest. Callers must
 * not downgrade this failure to an unpinned registry transport. */
export class BakedBundleIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BakedBundleIntegrityError';
  }
}

/** The authenticated same-origin artifact could not be transported. This is
 * the only baked-package failure for which retrying or using another transport
 * can be correct; integrity and decode failures must remain fatal. */
export class BakedBundleTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BakedBundleTransportError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the baked manifest as untrusted deployment data. Digests are required,
 * labels must be unique, and optional metadata must have its declared type. */
export function parseBakedBundleManifest(value: unknown): BakedBundleManifest {
  if (!isRecord(value) || !Array.isArray(value.bundles)) {
    throw new Error('package bundle manifest must contain a bundles array');
  }

  const seen = new Set<string>();
  const bundles = value.bundles.map((candidate, index): BakedBundleEntry => {
    if (!isRecord(candidate)) throw new Error(`package bundle manifest entry ${index} must be an object`);
    const { label, tgz, sha256, bytes, loadPhase } = candidate;
    if (typeof label !== 'string' || !label) {
      throw new Error(`package bundle manifest entry ${index} has no label`);
    }
    if (seen.has(label)) throw new Error(`package bundle manifest has duplicate label ${label}`);
    seen.add(label);
    if (typeof tgz !== 'string' || !tgz) {
      throw new Error(`package bundle manifest entry ${label} has no tgz filename`);
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new Error(`package bundle manifest entry ${label} has no valid lowercase SHA-256`);
    }
    if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 0)) {
      throw new Error(`package bundle manifest entry ${label} has an invalid byte length`);
    }
    if (loadPhase !== 'compile' && loadPhase !== 'on-demand') {
      throw new Error(`package bundle manifest entry ${label} has an invalid loadPhase`);
    }
    return {
      label,
      tgz,
      sha256,
      ...(bytes === undefined ? {} : { bytes: bytes as number }),
      loadPhase,
    };
  });
  return { bundles };
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Read a response body while reporting the bytes actually consumed. This is
 * deliberately transport-only: authentication and decompression remain at
 * their existing boundaries. */
export async function readResponseBytes(
  response: Response,
  onProgress?: (bytes: number, totalBytes?: number) => void,
  expectedBytes?: number,
  transportGuard?: PackageTransportGuard,
): Promise<ArrayBuffer> {
  const contentLength = response.headers.get('content-length');
  const headerBytes = contentLength == null ? Number.NaN : Number(contentLength);
  const totalBytes = expectedBytes ?? (
    Number.isSafeInteger(headerBytes) && headerBytes >= 0 ? headerBytes : undefined
  );
  onProgress?.(0, totalBytes);
  if (!response.body) {
    const operation = response.arrayBuffer();
    const bytes = transportGuard
      ? await transportGuard.wait(operation, 'response body')
      : await operation;
    onProgress?.(bytes.byteLength, totalBytes);
    return bytes;
  }
  const reader = response.body.getReader();
  let length = 0;
  let reportedLength = 0;
  let reportedAt = performance.now();
  const measuredBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Empty chunks do not satisfy a pending pull. Keep reading until this
        // pull either publishes bytes or closes the stream; each underlying
        // read still gets its own renewable no-progress boundary.
        while (true) {
          const operation = reader.read();
          const { done, value } = transportGuard
            ? await transportGuard.wait(operation, 'response body')
            : await operation;
          if (done) {
            if (reportedLength !== length) onProgress?.(length, totalBytes);
            controller.close();
            return;
          }
          if (!value?.byteLength) continue;
          length += value.byteLength;
          const now = performance.now();
          if (length === totalBytes || now - reportedAt >= 100) {
            onProgress?.(length, totalBytes);
            reportedLength = length;
            reportedAt = now;
          }
          controller.enqueue(value);
          return;
        }
      } catch (error) {
        // The fetch's AbortSignal normally terminates the reader. Cancellation
        // also releases synthetic/test streams not connected to that signal.
        void reader.cancel(error).catch(() => {});
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  try {
    // Let the Fetch implementation assemble one ArrayBuffer directly. The old
    // path retained every response chunk and then allocated a second joined
    // buffer, needlessly doubling large-package JS memory before wasm-bindgen's
    // unavoidable copy into WASM.
    const bytes = await new Response(measuredBody).arrayBuffer();
    if (bytes.byteLength !== length) {
      throw new Error(`response body accounting mismatch: consumed ${length}, assembled ${bytes.byteLength}`);
    }
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  }
}

/** Read and authenticate a compressed baked bundle before any inflater or engine
 * can observe its contents. The optional byte count is checked as an additional
 * truncation/configuration diagnostic; SHA-256 remains authoritative. */
export async function readVerifiedBundleBytes(
  response: Response,
  entry: Pick<BakedBundleEntry, 'label' | 'sha256' | 'bytes'>,
  onProgress?: (bytes: number, totalBytes?: number) => void,
  onVerify?: () => void,
  transportGuard?: PackageTransportGuard,
): Promise<ArrayBuffer> {
  if (!response.ok) {
    throw new BakedBundleTransportError(
      `fetch baked package ${entry.label} -> ${response.status}`,
    );
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await readResponseBytes(response, onProgress, entry.bytes, transportGuard);
  } catch (error) {
    throw new BakedBundleTransportError(
      `read baked package ${entry.label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (entry.bytes !== undefined && bytes.byteLength !== entry.bytes) {
    throw new BakedBundleIntegrityError(
      `baked package ${entry.label} byte length mismatch: expected ${entry.bytes}, got ${bytes.byteLength}`,
    );
  }
  onVerify?.();
  const actual = await sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new BakedBundleIntegrityError(
      `baked package ${entry.label} SHA-256 mismatch: expected ${entry.sha256}, got ${actual}`,
    );
  }
  return bytes;
}

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
