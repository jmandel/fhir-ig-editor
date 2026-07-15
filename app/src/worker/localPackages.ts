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

export interface LocalPackageInstallation {
  readonly label: string;
  readonly changed: boolean;
  commit(): void;
  rollback(): void;
}

/** label (`id#version`) -> inflated bundle spec. */
const store = new Map<string, BundleSpec>();
let authorityEpoch = 0;

/** Monotonic session epoch for effective local-package authority. It advances
 * only when lookup-visible bytes change or are rolled back. */
export function localPackageEpoch(): number {
  return authorityEpoch;
}

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

function sameFiles(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftNames = Object.keys(left);
  const rightNames = Object.keys(right);
  return leftNames.length === rightNames.length
    && leftNames.every((name) => left[name] === right[name]);
}

/** Install one candidate while retaining an exact rollback to the prior local
 * authority. File-map equality is order-independent, so dropping the same
 * effective package twice does not perturb the engine lifecycle. */
export function stageLocalPackage(
  label: string,
  files: Record<string, string>,
): LocalPackageInstallation {
  const previous = store.get(label);
  const changed = !previous || !sameFiles(previous.files, files);
  if (!changed) {
    return { label, changed: false, commit() {}, rollback() {} };
  }

  store.set(label, { label, files });
  authorityEpoch += 1;
  let active = true;
  return {
    label,
    changed: true,
    commit() {
      active = false;
    },
    rollback() {
      if (!active) return;
      if (previous) store.set(label, previous);
      else store.delete(label);
      authorityEpoch += 1;
      active = false;
    },
  };
}

/** Register a package immediately. Production ingestion uses the staged form
 * above; this direct helper remains useful for explicit resolver fixtures. */
export function addLocalPackage(label: string, files: Record<string, string>): string {
  stageLocalPackage(label, files).commit();
  return label;
}

/** Own the small lifecycle transaction that connects the session-local store
 * to one mutable Worker. Store rollback is exact; a failed attempted override
 * requires a clean Worker before recovery because the candidate may already
 * have committed to Rust before a later compilation/site failure. */
export class LocalPackageAuthority {
  private pending: LocalPackageInstallation[] = [];
  private recyclePending = false;

  accept(installation: LocalPackageInstallation, mounted: boolean): void {
    if (!installation.changed) return;
    this.pending.push(installation);
    if (mounted) this.recyclePending = true;
  }

  get requiresRecycle(): boolean {
    return this.recyclePending;
  }

  async reconcile(recycle: () => Promise<void>): Promise<boolean> {
    if (!this.recyclePending) return false;
    await recycle();
    this.recyclePending = false;
    return true;
  }

  commit(): void {
    for (const installation of this.pending) installation.commit();
    this.pending = [];
  }

  rollback(): boolean {
    if (this.pending.length === 0) return false;
    for (const installation of [...this.pending].reverse()) installation.rollback();
    this.pending = [];
    this.recyclePending = true;
    return true;
  }
}

/** Inflate a dropped `.tgz` ArrayBuffer, read its `id#version` from
 *  `package/package.json`, and register it. Returns the label. Throws if the
 *  tarball has no readable `package.json` (not a FHIR package). The returned
 *  installation remains rollback-capable until its first build succeeds. */
export async function ingestTgz(tgz: ArrayBuffer): Promise<LocalPackageInstallation> {
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
  return stageLocalPackage(label, files);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
