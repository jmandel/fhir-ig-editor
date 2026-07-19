// Package-acquisition settings (task #32): the FHIR package registry base(s) the
// runtime resolver fetches missing packages from, plus an optional pass-through
// proxy for CORS-blocked or air-gapped environments.
//
// `packages2.fhir.org` emits two Access-Control-Allow-Origin headers on its
// `/packages/*` metadata and redirect responses, which browsers reject. Its
// final `/web/<id>-<version>.tgz` objects are CORS-readable, however, so exact
// package fetches use that endpoint directly. Mutable-version metadata from
// packages2 still requires the existing pass-through proxy.
//
// Persisted in localStorage (small strings), so the settings survive reloads
// without touching any project Workspace.

const REGISTRY_KEY = 'fhir-ig-editor.pkg-registries';
const PROXY_KEY = 'fhir-ig-editor.pkg-proxy';

/** Immutable acquisition authority captured once at the start of an operation.
 * The key has no clock/TTL component: it changes only when the normalized,
 * resolver-ordered registry/proxy configuration changes. */
export interface PackageSourceSnapshot {
  readonly registries: readonly string[];
  readonly proxy: string;
  readonly sourceKey: string;
}

/** Default FHIR package registries, in resolver order. */
export const DEFAULT_REGISTRIES = [
  'https://packages.fhir.org',
  'https://packages2.fhir.org/packages',
];

/** The configured registries (newline/comma separated), or the defaults. */
export function getRegistries(): string[] {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY)?.trim();
    if (!raw) return [...DEFAULT_REGISTRIES];
    const list = raw
      .split(/[\n,]+/)
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean);
    return list.length ? list : [...DEFAULT_REGISTRIES];
  } catch {
    return [...DEFAULT_REGISTRIES];
  }
}

export function setRegistries(list: string[]): void {
  try {
    const v = list.map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean).join('\n');
    if (v) localStorage.setItem(REGISTRY_KEY, v);
    else localStorage.removeItem(REGISTRY_KEY);
  } catch {
    /* private-mode: session-only */
  }
}

/** An optional pass-through proxy base. When set, a package tarball URL `U` is
 *  fetched as `<proxy>?url=<encodeURIComponent(U)>` (a common CORS-proxy shape).
 *  Empty by default; exact package bytes from both defaults are CORS-readable. */
export function getPackageProxy(): string {
  try {
    return localStorage.getItem(PROXY_KEY)?.trim().replace(/\/+$/, '') ?? '';
  } catch {
    return '';
  }
}

function normalizeRegistry(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function normalizeProxy(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/** Construct the exact ordered source authority used by both mutable metadata
 * observation and exact TGZ transport. Exported inputs make deterministic
 * source-change tests independent of localStorage. */
export function packageSourceSnapshot(
  registries: readonly string[] = getRegistries(),
  proxy: string = getPackageProxy(),
): PackageSourceSnapshot {
  const normalizedRegistries = Object.freeze(
    registries.map(normalizeRegistry).filter(Boolean),
  );
  const normalizedProxy = normalizeProxy(proxy);
  return Object.freeze({
    registries: normalizedRegistries,
    proxy: normalizedProxy,
    sourceKey: JSON.stringify([normalizedRegistries, normalizedProxy]),
  });
}

/** Apply the already-captured proxy without consulting mutable settings. */
export function viaPackageSource(source: PackageSourceSnapshot, url: string): string {
  return source.proxy ? `${source.proxy}?url=${encodeURIComponent(url)}` : url;
}

export function setPackageProxy(url: string): void {
  const v = url.trim().replace(/\/+$/, '');
  try {
    if (v) localStorage.setItem(PROXY_KEY, v);
    else localStorage.removeItem(PROXY_KEY);
  } catch {
    /* private-mode: session-only */
  }
}

function isPackages2Registry(registry: string): boolean {
  try {
    const url = new URL(registry);
    return url.hostname === 'packages2.fhir.org'
      && url.pathname.replace(/\/+$/, '') === '/packages';
  } catch {
    return false;
  }
}

/** Build the browser-readable tarball URL for one exact coordinate. Most FHIR
 *  registries serve `<registry>/<id>/<version>`. packages2's redirect response
 *  is not CORS-readable, but its deterministic final blob is. */
export function tarballUrl(registry: string, id: string, version: string): string {
  if (isPackages2Registry(registry)) {
    return `https://packages2.fhir.org/web/${encodeURIComponent(id)}-${encodeURIComponent(version)}.tgz`;
  }
  return `${registry.replace(/\/+$/, '')}/${id}/${version}`;
}

/** The registry metadata (npm-style) URL for a package id — lists available
 *  versions, used to build the resolver's version index for `latest`/`x`. */
export function metadataUrl(registry: string, id: string): string {
  return `${registry.replace(/\/+$/, '')}/${id}`;
}

/** Whether metadata at this direct registry URL can be read by a browser. A
 * configured proxy can expose any registry, so callers use this only in direct
 * mode. */
export function directMetadataReadable(registry: string): boolean {
  return !isPackages2Registry(registry);
}

/** Wrap a URL through the configured proxy (if any). */
export function viaProxy(url: string): string {
  const proxy = getPackageProxy();
  return proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url;
}
