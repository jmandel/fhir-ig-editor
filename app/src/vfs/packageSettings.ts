// Package-acquisition settings (task #32): the FHIR package registry base(s) the
// runtime resolver fetches missing packages from, plus an optional pass-through
// proxy for CORS-blocked or air-gapped environments.
//
// Defaults mirror the engine's own registry order (package_acquisition
// resolution-config.json): packages.fhir.org first, then packages2.fhir.org.
// Both were verified to send `Access-Control-Allow-Origin: *` on metadata AND
// tarball responses (see the task #32 CORS findings), so a browser fetch works
// directly with NO proxy for the common case. The proxy is only for locked-down
// networks where even those are blocked.
//
// Persisted in localStorage (small strings), so the settings survive reloads
// without touching the OPFS project store.

const REGISTRY_KEY = 'fhir-ig-editor.pkg-registries';
const PROXY_KEY = 'fhir-ig-editor.pkg-proxy';

/** The default FHIR package registries, in try order. `packages.fhir.org` first:
 *  its CORS is a clean single `Access-Control-Allow-Origin: *`; packages2 emits a
 *  duplicate ACAO header alongside `*`, which some browsers reject — so it is the
 *  fallback, not the primary. */
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
 *  Empty by default (direct registry fetch — both defaults are CORS-open). */
export function getPackageProxy(): string {
  try {
    return localStorage.getItem(PROXY_KEY)?.trim().replace(/\/+$/, '') ?? '';
  } catch {
    return '';
  }
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

/** Build the tarball URL for `id#version` against one registry base. The FHIR
 *  registry serves the tarball at `<registry>/<id>/<version>` (a 200
 *  `application/tar+gzip`, or a CORS-open 302 to the actual blob on packages2).
 *  Mirrors package_acquisition `fallback_tarball_url` default shape. */
export function tarballUrl(registry: string, id: string, version: string): string {
  return `${registry.replace(/\/+$/, '')}/${id}/${version}`;
}

/** The registry metadata (npm-style) URL for a package id — lists available
 *  versions, used to build the resolver's version index for `latest`/`x`. */
export function metadataUrl(registry: string, id: string): string {
  return `${registry.replace(/\/+$/, '')}/${id}`;
}

/** Wrap a URL through the configured proxy (if any). */
export function viaProxy(url: string): string {
  const proxy = getPackageProxy();
  return proxy ? `${proxy}?url=${encodeURIComponent(url)}` : url;
}
