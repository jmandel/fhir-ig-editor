// A session-scoped store of user-supplied package tarballs (task #32 source d:
// local .tgz drag-drop, for air-gapped or registry-blocked environments).
//
// The user drops one or more `.tgz` files; each is inflated once to a mountable
// `{name: base64}` map and indexed by its `id#version` (read from the tarball's
// `package/package.json`). The resolver's fetch loop consults this store FIRST
// (before any network), so a locally-provided package always wins and no request
// leaves the browser for it.
//
// In-memory only (per session). Dropped packages don't persist across reloads by
// design — they're an escape hatch, not a project store.

import type { BundleSpec } from './protocol';

/** label (`id#version`) -> inflated bundle spec. */
const store = new Map<string, BundleSpec>();

/** True iff a package with this exact `id#version` label was locally provided. */
export function hasLocalPackage(label: string): boolean {
  return store.has(label);
}

/** Get a locally-provided package's mountable spec, or null. */
export function getLocalPackage(label: string): BundleSpec | null {
  return store.get(label) ?? null;
}

/** All locally-provided labels (for a host version index over user tarballs). */
export function localLabels(): string[] {
  return [...store.keys()];
}

/** Register an inflated tarball under its `id#version` label. Returns the label. */
export function addLocalPackage(label: string, files: Record<string, string>): string {
  store.set(label, { label, files });
  return label;
}

/** Inflate a dropped `.tgz` ArrayBuffer, read its `id#version` from
 *  `package/package.json`, and register it. Returns the label. Throws if the
 *  tarball has no readable `package.json` (not a FHIR package). */
export async function ingestTgz(tgz: ArrayBuffer): Promise<string> {
  const { inflateBundle } = await import('./inflate');
  const files = await inflateBundle(tgz);
  // package.json is base64 in the inflated map; decode + parse for id#version.
  const pkgB64 = files['package.json'];
  if (!pkgB64) throw new Error('dropped .tgz has no package/package.json (not a FHIR package)');
  const pkg = JSON.parse(new TextDecoder().decode(base64ToBytes(pkgB64)));
  const id = pkg.name;
  const version = pkg.version;
  if (!id || !version) throw new Error('package.json missing name/version');
  const label = `${id}#${version}`;
  addLocalPackage(label, files);
  return label;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
