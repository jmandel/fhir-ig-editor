import type { BuildEvent, BuildEventSource } from '../site/contract.generated';

/** Epoch-aligned high-resolution time. Window and dedicated Worker clocks have
 * different zeroes, but `timeOrigin + now()` is comparable across both. */
export function epochMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Construct one completed span on the canonical BuildEvent observation plane. */
export function spanEvent(
  phase: string,
  source: BuildEventSource,
  startedMs: number,
  event: Omit<BuildEvent, 'phase' | 'source' | 'startMs' | 'durationMs'>,
  endedMs = epochMs(),
): BuildEvent {
  return {
    ...event,
    phase,
    source,
    startMs: startedMs,
    durationMs: Math.max(0, endedMs - startedMs),
  };
}

/** Construct an aligned point observation where no duration is meaningful. */
export function pointEvent(
  phase: string,
  source: BuildEventSource,
  event: Omit<BuildEvent, 'phase' | 'source' | 'startMs' | 'durationMs'>,
  atMs = epochMs(),
): BuildEvent {
  return { ...event, phase, source, startMs: atMs };
}
