/**
 * Stable identity for the exact inputs accepted by Session.compileProject.
 *
 * This is a host-side sequencing key, not the authoritative SiteBuild id. The
 * Rust handoff still hashes the source manifest and verifies its own build id;
 * this digest prevents an adapter from asking that session to render a newer
 * ProjectStore snapshot than the one currently compiled into it.
 */
export interface ProjectCompileInputs {
  config: string;
  files: Record<string, string>;
  predefined: Record<string, unknown>;
  siteFiles: Record<string, string>;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

export async function projectCompileRevision(inputs: ProjectCompileInputs): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(inputs));
  if (!globalThis.crypto?.subtle) {
    // Local non-secure test hosts may lack Web Crypto. The canonical value is
    // still an exact equality key; production secure contexts retain only its
    // compact digest.
    return `project-json:${new TextDecoder().decode(bytes)}`;
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `project-sha256:${hex}`;
}
