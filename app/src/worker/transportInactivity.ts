/**
 * A package transfer has no total wall-clock deadline: a large package may take
 * as long as the network requires while bytes keep arriving. We only abandon a
 * transport after one full minute without response headers or another body
 * chunk. That bounds how long an open package-mount ticket can be held by a
 * dead connection without penalizing a slow, progressing stream.
 */
export const PACKAGE_TRANSPORT_INACTIVITY_MS = 60_000;

export type PackageTransportPhase = 'response headers' | 'response body';

/** Injectable only so the inactivity boundary can be tested without sleeping. */
export interface PackageTransportScheduler {
  schedule(callback: () => void, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const browserScheduler: PackageTransportScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class PackageTransportInactivityError extends Error {
  constructor(
    readonly label: string,
    readonly phase: PackageTransportPhase,
    readonly inactivityMs: number,
  ) {
    super(
      `package transport for ${label} made no progress while waiting for ${phase} `
      + `for ${Math.ceil(inactivityMs / 1_000)}s`,
    );
    this.name = 'PackageTransportInactivityError';
  }
}

export interface PackageTransportGuard {
  readonly signal: AbortSignal;
  wait<T>(operation: PromiseLike<T>, phase: PackageTransportPhase): Promise<T>;
  close(): void;
}

/** Create one sequential headers/body inactivity boundary for one transport. */
export function createPackageTransportGuard(
  label: string,
  inactivityMs = PACKAGE_TRANSPORT_INACTIVITY_MS,
  scheduler: PackageTransportScheduler = browserScheduler,
): PackageTransportGuard {
  if (!Number.isFinite(inactivityMs) || inactivityMs <= 0) {
    throw new Error('package transport inactivity interval must be positive');
  }

  const controller = new AbortController();
  let closed = false;
  let active: { handle: unknown; reject: (error: Error) => void } | null = null;

  return {
    signal: controller.signal,

    wait<T>(operation: PromiseLike<T>, phase: PackageTransportPhase): Promise<T> {
      if (closed) return Promise.reject(new Error(`package transport for ${label} is closed`));
      if (active) return Promise.reject(new Error(`package transport for ${label} has concurrent reads`));

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          if (active) scheduler.cancel(active.handle);
          active = null;
          complete();
        };
        const rejectActive = (error: Error) => finish(() => reject(error));
        const handle = scheduler.schedule(() => {
          const error = new PackageTransportInactivityError(label, phase, inactivityMs);
          finish(() => {
            closed = true;
            controller.abort(error);
            reject(error);
          });
        }, inactivityMs);
        active = { handle, reject: rejectActive };
        Promise.resolve(operation).then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      });
    },

    close(): void {
      if (closed) return;
      closed = true;
      // A caller may reject a response after its headers arrive but before a
      // body read begins (for example, a non-OK registry response). Abort the
      // underlying fetch in that gap as well as during an active wait.
      controller.abort();
      if (!active) return;
      active.reject(new Error(`package transport for ${label} was closed`));
    },
  };
}

export interface OpenPackageTransportOptions {
  inactivityMs?: number;
  scheduler?: PackageTransportScheduler;
  fetcher?: typeof fetch;
}

/** Open a fetch and return the same guard for its subsequent body reads. */
export async function openPackageTransport(
  label: string,
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: OpenPackageTransportOptions = {},
): Promise<{ response: Response; guard: PackageTransportGuard }> {
  const guard = createPackageTransportGuard(
    label,
    options.inactivityMs,
    options.scheduler,
  );
  try {
    const fetcher = options.fetcher ?? fetch;
    const response = await guard.wait(
      fetcher(input, { ...init, signal: guard.signal }),
      'response headers',
    );
    return { response, guard };
  } catch (error) {
    guard.close();
    throw error;
  }
}
