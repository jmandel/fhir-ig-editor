import type { ProgressEvent } from './worker/protocol';

const DOWNLOAD_STAGES = new Set<ProgressEvent['stage']>([
  'manifest',
  'bundle-fetch',
  'registry-fetch',
  'lazy-fetch',
]);

export interface ProgressPresentation {
  downloading: boolean;
  byteLabel: string | null;
  fraction: number | null;
}

function mb(bytes: number): string {
  const value = bytes / 1024 / 1024;
  return value < 1 ? value.toFixed(2) : value.toFixed(1);
}

/** Derive one honest presentation from a progress event. Work phases are text
 * only. A bar is shown solely for a byte transport with a known total, and its
 * label always comes from bytes already read rather than the declared size. */
export function presentProgress(progress: ProgressEvent): ProgressPresentation {
  const downloading = DOWNLOAD_STAGES.has(progress.stage);
  if (!downloading) return { downloading: false, byteLabel: null, fraction: null };
  // Reserve the download row before the first response chunk arrives. This
  // prevents the project-open banner from gaining a line between "Fetching"
  // and the first byte-progress event.
  if (progress.bytes == null) return { downloading: true, byteLabel: null, fraction: null };

  const bytes = Math.max(0, progress.bytes ?? 0);
  const total = progress.totalBytes != null && progress.totalBytes > 0
    ? progress.totalBytes
    : null;
  if (total == null) {
    return {
      downloading: true,
      byteLabel: `${mb(bytes)} MB downloaded`,
      fraction: null,
    };
  }
  return {
    downloading: true,
    byteLabel: `${mb(bytes)} / ${mb(total)} MB`,
    fraction: Math.min(1, bytes / total),
  };
}
