// The runtime package-acquisition loop (task #32): make ARBITRARY IGs load in the
// browser with Rust-DRIVEN, host-TRANSPORTED package acquisition.
//
// The engine (`resolve_project`, all resolution logic in Rust) tells us, for the
// current mounted set, exactly which packages are still MISSING. The host's only
// job is TRANSPORT: fetch each missing package's bytes, mount them, and ask the
// engine again — a `resolve → fetch → mount → resolve` loop to a fixpoint. No
// dependency math lives here; we never decide a version or walk a package.json.
//
// Fetch sources, in priority order (spec §4b / task step 4):
//   (a) same-origin prebuilt bundles  — the baked manifest (fast, offline-capable)
//   (b) local .tgz drag-drop           — user-provided packages (air-gapped)  [*]
//   (c) direct FHIR registry           — packages.fhir.org / packages2 (CORS-open)
//   (d) user-configured proxy          — for locked-down networks (wraps (c))
//   [*] local packages are checked BEFORE the network so a provided tarball wins.
//
// A package that no source can supply becomes a precise BLOCKED state (id#version
// + why + the three remedies), surfaced to the UI — never a silent failure.

import type {
  BundleSpec,
  MissingPackage,
  ResolutionStep,
  VersionIndex,
} from './protocol';
import { readCachedBundle, writeCachedBundle } from './bundleCache';
import { getLocalPackage, hasLocalPackage, localLabels } from './localPackages';
import {
  getRegistries,
  metadataUrl,
  tarballUrl,
  viaProxy,
} from '../vfs/packageSettings';

/** A package the loop could not obtain from ANY source, with the reason + the
 *  remedies the UI offers. */
export interface BlockedPackage {
  packageId: string;
  version: string;
  /** Human, single-line why. */
  why: string;
  /** The three standing remedies (spec §4b step 4). */
  remedies: string[];
}

export interface ResolveOutcome {
  step: ResolutionStep;
  blocked: BlockedPackage[];
  /** Labels newly fetched + mounted across the whole loop. */
  mounted: string[];
}

/** How the loop reports progress (reuses the worker ProgressEvent stages). */
export type ResolveProgress = (ev: {
  stage: 'resolve' | 'registry-fetch' | 'bundle-cache-hit' | 'package-blocked';
  label?: string;
  message: string;
}) => void;

/** The seams the loop needs from its host (EngineClient supplies these). */
export interface ResolverHost {
  /** Ask the engine to resolve against the currently mounted set. */
  resolveStep(config: string, versionIndex?: VersionIndex): Promise<ResolutionStep>;
  /** Mount a set of fetched bundles into the engine. */
  mount(bundles: BundleSpec[]): Promise<void>;
  /** The baked same-origin manifest's `label -> tgz filename` map (source a). */
  bakedBundle(label: string): { tgz: string; bytes?: number } | undefined;
  /** Fetch + inflate a same-origin baked bundle by its tgz filename (source a). */
  fetchBaked(label: string, tgz: string): Promise<BundleSpec>;
}

const MAX_ROUNDS = 24; // fixpoint guard: a closure this deep is pathological.

/**
 * Drive the resolve → fetch → mount → resolve loop until the engine reports
 * `satisfied` (nothing missing) or no source can supply the remaining packages.
 *
 * `versionIndex` seeds the engine's `latest`/`x` resolution; we AUGMENT it each
 * round with versions discovered from the registry metadata (so a `latest` request
 * the baked set can't satisfy still resolves), keeping the DECISION in Rust.
 */
export async function acquireForProject(
  host: ResolverHost,
  config: string,
  onProgress: ResolveProgress,
  seedIndex?: VersionIndex,
): Promise<ResolveOutcome> {
  const index: VersionIndex = seedIndex
    ? { versions: { ...seedIndex.versions } }
    : { versions: {} };
  // Seed the index with locally-provided package versions so `latest`/`x` requests
  // can resolve to a dropped tarball without any network.
  mergeLabelsIntoIndex(index, localLabels());

  const mountedAll: string[] = [];
  const blocked: BlockedPackage[] = [];

  let step: ResolutionStep | null = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    onProgress({ stage: 'resolve', message: 'Resolving package closure…' });
    step = await host.resolveStep(config, index);
    if (step.satisfied) break;

    // The engine lists what is missing. Split unresolved-version (need registry
    // metadata to pick a version) from not-mounted (need the bytes).
    const toFetch: MissingPackage[] = [];
    let learnedNewVersion = false;

    for (const m of step.missing) {
      if (m.reason.kind === 'unresolved_version') {
        // Try to LEARN the available versions from the registry metadata so the
        // NEXT resolve round can pick one (decision stays in Rust). If we already
        // have versions indexed for it, the engine simply couldn't match — skip.
        if (!index.versions[m.package_id]) {
          const versions = await fetchRegistryVersions(m.package_id, onProgress);
          if (versions.length) {
            index.versions[m.package_id] = versions;
            learnedNewVersion = true;
          }
        }
      } else {
        toFetch.push(m);
      }
    }

    // If we learned new versions this round, re-resolve before fetching bytes
    // (the concrete version may change what's needed).
    if (learnedNewVersion && toFetch.length === 0) continue;

    if (toFetch.length === 0 && !learnedNewVersion) {
      // Nothing fetchable AND nothing new learned: the remaining missing are all
      // unresolved versions we couldn't learn. Block them.
      for (const m of step.missing) {
        blocked.push(blockedFrom(m, 'no versions found in any configured registry'));
      }
      break;
    }

    // Fetch + mount each not-mounted package.
    const specs: BundleSpec[] = [];
    for (const m of toFetch) {
      const label = `${m.package_id}#${m.version}`;
      const spec = await obtainPackage(host, label, m, onProgress, blocked);
      if (spec) specs.push(spec);
    }
    if (specs.length) {
      await host.mount(specs);
      for (const s of specs) {
        mountedAll.push(s.label);
        mergeLabelsIntoIndex(index, [s.label]);
      }
    } else if (!learnedNewVersion) {
      // A full round with nothing obtained and nothing learned: give up (the
      // remaining missing became `blocked` inside obtainPackage).
      break;
    }
  }

  // Final resolve to get the authoritative step (satisfied or with residual
  // missing that are all accounted for as blocked).
  if (!step || !step.satisfied) {
    step = await host.resolveStep(config, index);
  }
  // Any residual missing not already blocked → block with a transport reason.
  if (!step.satisfied) {
    for (const m of step.missing) {
      const label = `${m.package_id}#${m.version}`;
      if (!blocked.some((b) => `${b.packageId}#${b.version}` === label)) {
        blocked.push(
          blockedFrom(
            m,
            m.reason.kind === 'unresolved_version'
              ? `could not resolve version "${m.reason.requested}"`
              : 'could not be fetched from any source',
          ),
        );
      }
    }
  }

  return { step, blocked, mounted: mountedAll };
}

/** Obtain ONE package's bytes from the priority-ordered sources, mounting-ready.
 *  On total failure, pushes a precise BlockedPackage and returns null. */
async function obtainPackage(
  host: ResolverHost,
  label: string,
  missing: MissingPackage,
  onProgress: ResolveProgress,
  blocked: BlockedPackage[],
): Promise<BundleSpec | null> {
  // (a') OPFS warm cache — a package fetched on a previous session/round.
  const cached = await readCachedBundle(label);
  if (cached) {
    onProgress({ stage: 'bundle-cache-hit', label, message: `${label} (cached)` });
    return cached;
  }

  // (b) local .tgz drag-drop — before any network.
  if (hasLocalPackage(label)) {
    const spec = getLocalPackage(label)!;
    void writeCachedBundle(spec);
    return spec;
  }

  // (a) same-origin prebuilt bundle from the baked manifest.
  const baked = host.bakedBundle(label);
  if (baked) {
    try {
      const spec = await host.fetchBaked(label, baked.tgz);
      void writeCachedBundle(spec);
      return spec;
    } catch {
      /* fall through to the registry */
    }
  }

  // (c)/(d) direct FHIR registry (optionally via the configured proxy).
  const spec = await fetchFromRegistry(label, missing, onProgress);
  if (spec) {
    void writeCachedBundle(spec);
    return spec;
  }

  // Blocked: no source could supply it. Precise UI state.
  blocked.push(
    blockedFrom(missing, 'not in the prebuilt bundles, local drops, or any registry'),
  );
  onProgress({ stage: 'package-blocked', label, message: `Cannot obtain ${label}` });
  return null;
}

/** Fetch a package tarball from the configured registries (packages.fhir.org →
 *  packages2 → …), each optionally wrapped through the proxy. Returns a mountable
 *  spec, or null if every registry failed. */
async function fetchFromRegistry(
  label: string,
  missing: MissingPackage,
  onProgress: ResolveProgress,
): Promise<BundleSpec | null> {
  const { package_id: id, version } = missing;
  for (const registry of getRegistries()) {
    const direct = tarballUrl(registry, id, version);
    const url = viaProxy(direct);
    onProgress({ stage: 'registry-fetch', label, message: `Fetching ${label} from ${registry}…` });
    try {
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) continue;
      // A raw registry npm tarball roots files under `package/`; our inflate
      // strips that prefix, and the engine derives the `.derived-index.json`
      // sidecar in-memory (verified byte-parity vs repacked bundles), so a plain
      // registry tarball mounts identically to a baked bundle.
      const { inflateBundleResponse } = await import('./inflate');
      const files = await inflateBundleResponse(resp);
      return { label, files };
    } catch {
      /* try the next registry */
    }
  }
  return null;
}

/** Query a registry's npm-style metadata for a package's available versions
 *  (used to build the engine's version index for `latest`/`x`). Returns [] if no
 *  registry answers. */
async function fetchRegistryVersions(
  id: string,
  onProgress: ResolveProgress,
): Promise<string[]> {
  for (const registry of getRegistries()) {
    const url = viaProxy(metadataUrl(registry, id));
    onProgress({ stage: 'registry-fetch', label: id, message: `Looking up ${id} versions…` });
    try {
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp.ok) continue;
      const meta = await resp.json();
      const versions = meta?.versions ? Object.keys(meta.versions) : [];
      if (versions.length) return versions;
    } catch {
      /* try the next registry */
    }
  }
  return [];
}

function mergeLabelsIntoIndex(index: VersionIndex, labels: string[]): void {
  for (const label of labels) {
    const hash = label.lastIndexOf('#');
    if (hash <= 0) continue;
    const id = label.slice(0, hash);
    const ver = label.slice(hash + 1);
    const list = (index.versions[id] ??= []);
    if (!list.includes(ver)) list.push(ver);
  }
}

function blockedFrom(m: MissingPackage, why: string): BlockedPackage {
  return {
    packageId: m.package_id,
    version: m.version,
    why,
    remedies: [
      'Drop the package .tgz into the editor (works offline / air-gapped)',
      'Configure a package proxy URL in Settings (for CORS-blocked networks)',
      'Check the package id#version exists on packages.fhir.org',
    ],
  };
}
