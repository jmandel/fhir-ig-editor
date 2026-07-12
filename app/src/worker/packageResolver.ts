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
  MutableVersionRequest,
  PackageMountInput,
  ProgressEvent,
  ResolutionStep,
  VersionIndex,
} from './protocol';
import { BakedBundleTransportError } from './bundleIntegrity';
import type { BakedBundleEntry } from './bundleIntegrity';
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
  /** Exact candidate universe used for the final authoritative Rust step. */
  versionIndex: VersionIndex;
}

/** How the loop reports progress (the resolver emits a subset of the shared
 * progress vocabulary; baked transport adds timing/cache metadata). */
export type ResolveProgress = (ev: ProgressEvent) => void;

/** The seams the loop needs from its host (EngineClient supplies these). */
export interface ResolverHost {
  /** Ask the engine to resolve against the currently mounted set. */
  resolveStep(config: string, versionIndex?: VersionIndex): Promise<ResolutionStep>;
  /** Mount a set of fetched bundles into the engine. */
  mount(packages: PackageMountInput[]): Promise<void>;
  /** The baked same-origin manifest's exact transport entry (source a). */
  bakedBundle(label: string): BakedBundleEntry | undefined;
  /** Fetch, verify, and inflate one exact same-origin baked bundle (source a). */
  fetchBaked(bundle: BakedBundleEntry, onProgress: ResolveProgress): Promise<PackageMountInput>;
}

const MAX_ROUNDS = 24; // fixpoint guard: a closure this deep is pathological.

/** Keep bounded parallel package I/O while presenting it as one stable batch.
 * Individual streams still contribute their actual consumed bytes, but they
 * cannot race to replace the banner with four alternating package names or
 * incompatible per-file denominators. A one-package batch preserves the more
 * specific message and determinate byte total. */
export function packageBatchProgress(labels: readonly string[], emit: ResolveProgress) {
  const unique = [...new Set(labels)];
  if (unique.length <= 1) {
    return { report: emit, complete: (_label: string) => {} };
  }
  const members = new Set(unique);
  const completed = new Set<string>();
  const bytesByLabel = new Map<string, number>();
  const reportAggregate = () => {
    const bytes = [...bytesByLabel.values()].reduce((sum, value) => sum + value, 0);
    const done = completed.size === unique.length;
    emit({
      stage: 'bundle-fetch',
      message: `${done ? 'Loaded' : 'Loading'} ${completed.size} of ${unique.length} dependencies${done ? '.' : '…'}`,
      ...(bytesByLabel.size > 0 ? { bytes } : {}),
    });
  };
  return {
    report(event: ProgressEvent) {
      if (event.stage === 'package-blocked' || !event.label || !members.has(event.label)) {
        emit(event);
        return;
      }
      if (event.bytes != null) {
        bytesByLabel.set(event.label, Math.max(bytesByLabel.get(event.label) ?? 0, event.bytes));
      }
      reportAggregate();
    },
    complete(label: string) {
      completed.add(label);
      reportAggregate();
    },
  };
}

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
    // Packages whose version lookup failed because the registry was UNREACHABLE
    // (network/CORS/offline) rather than genuinely absent — drives a truthful
    // block message ("registry unreachable" vs "no versions found").
    const unreachableIds = new Set<string>();

    for (const m of step.missing) {
      if (m.reason.kind === 'unresolved_version') {
        // Try to LEARN the available versions from the registry metadata so the
        // NEXT resolve round can pick one (decision stays in Rust). If we already
        // have versions indexed for it (e.g. seeded from the baked manifest), the
        // engine simply couldn't match — skip the network.
        if (!index.versions[m.package_id]) {
          const { versions, unreachable } = await fetchRegistryVersions(m.package_id, onProgress);
          if (versions.length) {
            index.versions[m.package_id] = versions;
            learnedNewVersion = true;
          } else if (unreachable) {
            unreachableIds.add(m.package_id);
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
      // unresolved versions we couldn't learn. Block them — naming registry
      // unreachability where that (not absence) is the cause.
      for (const m of step.missing) {
        const why = unreachableIds.has(m.package_id)
          ? 'registry unreachable — check your connection (or configure a package proxy in Settings)'
          : 'no versions found in any configured registry';
        blocked.push(blockedFrom(m, why));
      }
      break;
    }

    // Fetch + mount each not-mounted package.
    // Packages in one authoritative ResolutionStep are independent transport
    // requests and form one atomic engine mount batch. Read/fetch them with
    // bounded concurrency instead of serializing large OPFS operations.
    const specs: Array<PackageMountInput | undefined> = [];
    const labels = toFetch.map((m) => `${m.package_id}#${m.version}`);
    const batch = packageBatchProgress(labels, onProgress);
    let nextFetch = 0;
    const fetchers = Array.from({ length: Math.min(4, toFetch.length) }, async () => {
      for (;;) {
        const index = nextFetch++;
        if (index >= toFetch.length) return;
        const m = toFetch[index];
        const label = `${m.package_id}#${m.version}`;
        const spec = await obtainPackage(host, label, m, batch.report, blocked);
        if (spec) {
          specs[index] = spec;
          batch.complete(label);
        }
      }
    });
    await Promise.all(fetchers);
    const obtained = specs.filter((spec): spec is PackageMountInput => spec !== undefined);
    if (obtained.length) {
      await host.mount(obtained);
      for (const packageInput of obtained) {
        const label = packageInput.kind === 'raw' ? packageInput.spec.label : packageInput.pointer.label;
        mountedAll.push(label);
        mergeLabelsIntoIndex(index, [label]);
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

  return { step, blocked, mounted: mountedAll, versionIndex: index };
}

/** Refresh the candidate universe needed to validate a persistent exact lock.
 * Baked/local candidates are deployment/session authority and arrive in `seed`;
 * every other mutable request is queried from the configured registry now. A
 * registry miss/unreachable result rejects the fast path rather than pinning the
 * stale concrete version recorded by the lock. */
export async function refreshMutableVersionIndex(
  requests: readonly MutableVersionRequest[],
  seed: VersionIndex,
  onProgress: ResolveProgress,
): Promise<VersionIndex | null> {
  const index: VersionIndex = { versions: {} };
  for (const [id, versions] of Object.entries(seed.versions)) {
    index.versions[id] = [...versions];
  }
  mergeLabelsIntoIndex(index, localLabels());
  const ids = [...new Set(requests.map((request) => request.package_id))]
    .filter((id) => !index.versions[id]?.length);
  const refreshed = await Promise.all(ids.map(async (id) => ({
    id,
    result: await fetchRegistryVersions(id, onProgress),
  })));
  for (const { id, result } of refreshed) {
    if (result.unreachable || result.versions.length === 0) return null;
    index.versions[id] = result.versions;
  }
  return index;
}

/** Acquire an exact cached closure as one transport batch. This function makes
 * no resolution decision and performs no mount; callers atomically mount only
 * when every package was obtained, then ask Rust to verify the closure. */
export async function obtainLockedPackages(
  host: ResolverHost,
  labels: readonly string[],
  onProgress: ResolveProgress,
): Promise<{ packages: PackageMountInput[]; blocked: BlockedPackage[] }> {
  const blocked: BlockedPackage[] = [];
  const packages: Array<PackageMountInput | undefined> = new Array(labels.length);
  const batch = packageBatchProgress(labels, onProgress);
  let next = 0;
  const readers = Array.from({ length: Math.min(4, labels.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= labels.length) return;
      const label = labels[index];
      const hash = label.lastIndexOf('#');
      if (hash <= 0) {
        blocked.push({
          packageId: label,
          version: '',
          why: 'persistent resolution lock contains an invalid coordinate',
          remedies: [],
        });
        continue;
      }
      const missing: MissingPackage = {
        package_id: label.slice(0, hash),
        version: label.slice(hash + 1),
        reason: { kind: 'not_mounted' },
        set: 'context',
      };
      const obtained = await obtainPackage(host, label, missing, batch.report, blocked);
      if (obtained) {
        packages[index] = obtained;
        batch.complete(label);
      }
    }
  });
  await Promise.all(readers);
  return {
    packages: packages.filter((item): item is PackageMountInput => item !== undefined),
    blocked,
  };
}

/** Obtain ONE package's bytes from the priority-ordered sources, mounting-ready.
 *  On total failure, pushes a precise BlockedPackage and returns null. */
async function obtainPackage(
  host: ResolverHost,
  label: string,
  missing: MissingPackage,
  onProgress: ResolveProgress,
  blocked: BlockedPackage[],
): Promise<PackageMountInput | null> {
  const baked = host.bakedBundle(label);
  // A baked package's exact transport digest also keys the prepared cache. Let
  // the host select the authenticated prepared artifact or original transport.
  if (baked) {
    try {
      return await host.fetchBaked(baked, onProgress);
    } catch (error) {
      // A mobile connection can drop a large same-origin response midway. Give
      // the exact immutable artifact one immediate retry before considering a
      // local or registry transport. Any integrity, inflate, or programming
      // failure is deterministic and must not be hidden behind a slow download.
      if (!(error instanceof BakedBundleTransportError)) throw error;
      onProgress({
        stage: 'bundle-fetch',
        label,
        message: `Retrying ${label} from this app after a transport interruption…`,
      });
      try {
        return await host.fetchBaked(baked, onProgress);
      } catch (retryError) {
        if (!(retryError instanceof BakedBundleTransportError)) throw retryError;
        onProgress({
          stage: 'bundle-fetch',
          label,
          message: `This app's copy of ${label} is unreachable; trying another source…`,
        });
        /* fall through to local/registry transport */
      }
    }
  }
  const { findPreparedPackage, UNPINNED_TRANSPORT_IDENTITY } = await import('./preparedPackageCache');
  const pointer = await findPreparedPackage(label, UNPINNED_TRANSPORT_IDENTITY);
  if (pointer) {
    onProgress({ stage: 'bundle-cache-hit', label, message: `${label} (prepared binary)` });
    return { kind: 'prepared', pointer };
  }
  // Local .tgz drag-drop — before any network.
  if (hasLocalPackage(label)) {
    const spec = getLocalPackage(label)!;
    return { kind: 'raw', spec, transportIdentity: 'unpinned' };
  }

  // (c)/(d) direct FHIR registry (optionally via the configured proxy).
  const spec = await fetchFromRegistry(label, missing, onProgress);
  if (spec) {
    return { kind: 'raw', spec, transportIdentity: 'unpinned' };
  }

  // Blocked: no source could supply it. Precise UI state.
  blocked.push(
    blockedFrom(missing, 'not in the prebuilt bundles, local drops, or any registry'),
  );
  onProgress({ stage: 'package-blocked', label, message: `Cannot obtain ${label}` });
  return null;
}

/** Recovery ladder used when an unpinned PreparedPackage fails validation.
 * Reuse an explicit local package or refetch the exact coordinate; stale
 * inflated/base64 persistence is never recovery authority. */
export async function obtainRawPackageByLabel(label: string): Promise<PackageMountInput | null> {
  if (hasLocalPackage(label)) {
    return { kind: 'raw', spec: getLocalPackage(label)!, transportIdentity: 'unpinned' };
  }
  const hash = label.lastIndexOf('#');
  if (hash <= 0) return null;
  const missing: MissingPackage = {
    package_id: label.slice(0, hash),
    version: label.slice(hash + 1),
    reason: { kind: 'not_mounted' },
    set: 'context',
  };
  const spec = await fetchFromRegistry(label, missing, () => {});
  if (!spec) return null;
  return { kind: 'raw', spec, transportIdentity: 'unpinned' };
}

/** Obtain and mount one exact coordinate requested by Rust's private template
 * resolution handshake. Templates use the ordinary OPFS/local/baked/registry
 * transport ladder, including complete PreparedPackage v3 artifacts. Returns
 * only success; no package files cross back to the host. */
export async function obtainAndMountPackage(
  host: ResolverHost,
  label: string,
  onProgress: ResolveProgress,
): Promise<boolean> {
  const hash = label.lastIndexOf('#');
  const missing: MissingPackage = {
    package_id: hash > 0 ? label.slice(0, hash) : label,
    version: hash > 0 ? label.slice(hash + 1) : '',
    reason: { kind: 'not_mounted' },
    set: 'context',
  };
  const blocked: BlockedPackage[] = [];
  const packageInput = await obtainPackage(host, label, missing, onProgress, blocked);
  if (!packageInput) return false;
  await host.mount([packageInput]);
  return true;
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
      const contentLength = resp.headers.get('content-length');
      const total = contentLength == null ? Number.NaN : Number(contentLength);
      const totalBytes = Number.isSafeInteger(total) && total > 0 ? total : undefined;
      onProgress({
        stage: 'registry-fetch',
        label,
        bytes: 0,
        totalBytes,
        message: `Downloading ${label} from ${registry}…`,
      });
      const { inflateBundleResponse } = await import('./inflate');
      const files = await inflateBundleResponse(
        resp,
        (bytes) => {
          onProgress({
            stage: 'registry-fetch',
            label,
            bytes,
            totalBytes,
            message: `Downloading ${label} from ${registry}…`,
          });
        },
        () => onProgress({
          stage: 'bundle-unpack',
          label,
          message: `Unpacking ${label}…`,
        }),
      );
      onProgress({ stage: 'bundle-unpack', label, message: `Unpacked ${label}.` });
      return { label, files };
    } catch {
      /* try the next registry */
    }
  }
  return null;
}

/** Query a registry's npm-style metadata for a package's available versions
 *  (used to build the engine's version index for `latest`/`x`). Returns the found
 *  versions plus `unreachable: true` when EVERY registry threw (network/CORS/
 *  offline) rather than answering — so a subsequent block can say "registry
 *  unreachable" instead of falsely implying the package doesn't exist. */
export async function fetchRegistryVersions(
  id: string,
  onProgress: ResolveProgress,
): Promise<{ versions: string[]; unreachable: boolean }> {
  let anyReplied = false; // at least one registry answered (any HTTP status)
  for (const registry of getRegistries()) {
    const url = viaProxy(metadataUrl(registry, id));
    onProgress({ stage: 'registry-fetch', label: id, message: `Looking up ${id} versions…` });
    try {
      // Mutable coordinates require an origin revalidation. `no-cache` may use
      // a 304 response but may not silently accept a fresh-looking disk-cache
      // entry whose registry candidate universe has changed.
      const resp = await fetch(url, { redirect: 'follow', cache: 'no-cache' });
      anyReplied = true;
      if (!resp.ok) continue;
      const meta = await resp.json();
      const versions = meta?.versions ? Object.keys(meta.versions) : [];
      if (versions.length) return { versions, unreachable: false };
    } catch {
      /* network-level failure for this registry — try the next */
    }
  }
  // Unreachable = no registry ever produced an HTTP reply (all threw).
  return { versions: [], unreachable: !anyReplied };
}

/** Build a VersionIndex seed from `name#version` labels (e.g. the baked-manifest
 *  labels). Seeding baked pins lets Rust resolve `latest`/`x` requests for
 *  publisher-internal alias packages that DON'T exist on any registry (the `.r4`
 *  alias set: hl7.fhir.uv.tools.r4 / hl7.terminology.r4 / hl7.fhir.uv.extensions.r4)
 *  with zero network — otherwise a `latest` request hard-blocks with "no versions
 *  found in any configured registry" even though the bytes are already mounted. */
export function indexFromLabels(labels: Iterable<string>): VersionIndex {
  const index: VersionIndex = { versions: {} };
  mergeLabelsIntoIndex(index, [...labels]);
  return index;
}

export function mergeLabelsIntoIndex(index: VersionIndex, labels: string[]): void {
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
