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
  MissingPackage,
  MountResult,
  MutableVersionRequest,
  PackageMountInput,
  BuildEvent,
  ResolutionStep,
  VersionIndex,
} from './protocol';
import { BakedBundleTransportError, readResponseBytes } from './bundleIntegrity';
import type { BakedBundleEntry } from './bundleIntegrity';
import { openPackageTransport } from './transportInactivity';
import { getLocalPackage, hasLocalPackage, localLabels } from './localPackages';
import {
  metadataUrl,
  packageSourceSnapshot,
  tarballUrl,
  viaPackageSource,
} from '../vfs/packageSettings';
import type { PackageSourceSnapshot } from '../vfs/packageSettings';
import type { VersionObservation } from './versionObservationCache';
import { epochMs, pointEvent, spanEvent } from '../performance/timeline';

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
export type ResolveProgress = (ev: BuildEvent) => void;

/** Attempt-scoped observation seam supplied by EngineClient. It owns
 * single-flight/session reuse; transport and registry order remain here. */
export type ObserveRegistryVersions = (
  id: string,
  onProgress: ResolveProgress,
) => Promise<VersionObservation>;

/** Resolver-facing handle to one private ordered Worker/Rust transaction. */
export interface ResolverMountTransaction {
  stage(index: number, input: PackageMountInput): Promise<void>;
  commit(): Promise<MountResult>;
  abort(): Promise<void>;
}

/** Registry retry position belongs to host transport, not to the package
 * carrier crossing the Worker boundary. Key it by the exact ArrayBuffer so a
 * typed Rust TGZ preparation failure can continue with the next configured
 * registry without adding registry policy to PackageMountInput. */
interface RegistryCarrierOrigin {
  label: string;
  missing: MissingPackage;
  nextRegistryIndex: number;
  source: PackageSourceSnapshot;
}

const registryCarrierOrigins = new WeakMap<ArrayBuffer, RegistryCarrierOrigin>();

/** The seams the loop needs from its host (EngineClient supplies these). */
export interface ResolverHost {
  /** Ask the engine to resolve against the currently mounted set. */
  resolveStep(config: string, versionIndex?: VersionIndex): Promise<ResolutionStep>;
  /** Open the one ordered transaction. `null` means the selected package
   * generation became stale while waiting for the mount mutex; resolve again. */
  openMount(labels: readonly string[]): Promise<ResolverMountTransaction | null>;
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
      stage: done ? 'resolve' : 'bundle-fetch',
      message: done
        ? `Located ${unique.length} dependencies; ready to prepare.`
        : `Loading ${completed.size} of ${unique.length} dependencies…`,
      ...(bytesByLabel.size > 0 ? { bytes } : {}),
    });
  };
  return {
    report(event: BuildEvent) {
      if (event.stage === 'package-blocked' || !event.label || !members.has(event.label)) {
        emit(event);
        return;
      }
      if (event.bytes != null) {
        bytesByLabel.set(event.label, Math.max(bytesByLabel.get(event.label) ?? 0, event.bytes));
      }
      // Preserve completed machine spans for the benchmark while immediately
      // restoring the aggregate presentation event below. React batches these
      // same-turn updates, so individual parallel filenames never flicker.
      if (event.phase && event.durationMs != null) emit(event);
      reportAggregate();
    },
    complete(label: string) {
      completed.add(label);
      reportAggregate();
    },
  };
}

interface PackageBatchRequest {
  label: string;
  missing: MissingPackage | null;
  invalid?: BlockedPackage;
}

interface PackageBatchResult {
  packages: Array<PackageMountInput | undefined>;
  blocked: BlockedPackage[];
  /** Non-null only when a production ticket committed the complete batch. */
  mounted: string[] | null;
  stale: boolean;
}

/** The one bounded acquisition pipeline for authoritative resolver rounds and
 * persistent-lock prefetches. Transport finishes in arbitrary order; a
 * production ticket prepares each arrival immediately and commits only when
 * every resolver-indexed slot is present. */
async function acquirePackageBatch(
  host: ResolverHost,
  requests: readonly PackageBatchRequest[],
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot,
): Promise<PackageBatchResult> {
  const blocked = requests.flatMap((request) => request.invalid ? [request.invalid] : []);
  const packages: Array<PackageMountInput | undefined> = new Array(requests.length);
  const labels = requests.map(({ label }) => label);
  const progress = packageBatchProgress(labels, onProgress);
  const transaction = requests.length > 0 ? await host.openMount(labels) : null;
  if (requests.length > 0 && !transaction) {
    return { packages, blocked, mounted: null, stale: true };
  }
  let preparationError: unknown;
  let preparationFailed = false;
  let next = 0;
  const readers = Array.from({ length: Math.min(4, requests.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= requests.length) return;
      const request = requests[index];
      if (!request.missing) continue;
      try {
        const obtained = await obtainPackage(
          host,
          request.label,
          request.missing,
          progress.report,
          blocked,
          source,
        );
        if (obtained) {
          packages[index] = obtained;
          await transaction?.stage(index, obtained);
          progress.complete(request.label);
        }
      } catch (error) {
        if (!preparationFailed) preparationError = error;
        preparationFailed = true;
      }
    }
  });
  await Promise.all(readers);
  if (preparationFailed) {
    await transaction?.abort().catch(() => {});
    throw preparationError;
  }

  const complete = blocked.length === 0
    && packages.filter((item) => item !== undefined).length === requests.length;
  let mounted: string[] | null = null;
  if (transaction) {
    if (complete) mounted = (await transaction.commit()).newlyMounted;
    else await transaction.abort();
  }
  return { packages, blocked, mounted, stale: false };
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
  source: PackageSourceSnapshot = packageSourceSnapshot(),
  observeVersions: ObserveRegistryVersions = (id, report) => fetchRegistryVersions(id, report, source),
): Promise<ResolveOutcome> {
  const index: VersionIndex = seedIndex
    ? { versions: { ...seedIndex.versions } }
    : { versions: {} };
  // Seed the index with locally-provided package versions so `latest`/`x` requests
  // can resolve to a dropped tarball without any network.
  mergeLabelsIntoIndex(index, localLabels());

  const mountedAll: string[] = [];
  const blocked: BlockedPackage[] = [];
  const refreshedMutableIds = new Map<string, { unreachable: boolean }>();

  let step: ResolutionStep | null = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    onProgress({ stage: 'resolve', message: 'Resolving package closure…' });
    step = await host.resolveStep(config, index);

    // Baked/local versions are offline candidates, not authority for mutable
    // `latest`/`x` requests. Query each mutable id once and merge any registry
    // candidates before Rust selects the concrete coordinate. A reachable empty
    // result deliberately preserves baked-only aliases; an unreachable result
    // permits the normal offline candidate set but cannot validate a lock.
    const unrefreshed = [...new Set(step.mutable_requests.map((request) => request.package_id))]
      .filter((id) => !refreshedMutableIds.has(id));
    const refreshes = await Promise.all(unrefreshed.map(async (id) => ({
      id,
      result: await observeVersions(id, onProgress),
    })));
    let learnedRegistryCandidate = false;
    for (const { id, result } of refreshes) {
      refreshedMutableIds.set(id, { unreachable: result.unreachable });
      if (result.versions.length === 0) continue;
      const merged = [...new Set([...(index.versions[id] ?? []), ...result.versions])];
      if (merged.length !== (index.versions[id]?.length ?? 0)) learnedRegistryCandidate = true;
      index.versions[id] = merged;
    }
    if (learnedRegistryCandidate) continue;
    if (step.satisfied) break;

    // The engine lists what is missing. Split unresolved-version (need registry
    // metadata to pick a version) from not-mounted (need the bytes).
    const toFetch: MissingPackage[] = [];
    // Packages whose version lookup failed because the registry was UNREACHABLE
    // (network/CORS/offline) rather than genuinely absent — drives a truthful
    // block message ("registry unreachable" vs "no versions found").
    const unreachableIds = new Set<string>();

    for (const m of step.missing) {
      if (m.reason.kind === 'unresolved_version') {
        if (refreshedMutableIds.get(m.package_id)?.unreachable) {
          unreachableIds.add(m.package_id);
        }
      } else {
        toFetch.push(m);
      }
    }

    if (toFetch.length === 0) {
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
    const labels = toFetch.map((m) => `${m.package_id}#${m.version}`);
    const acquired = await acquirePackageBatch(
      host,
      toFetch.map((missing, slot) => ({ label: labels[slot], missing })),
      onProgress,
      source,
    );
    if (acquired.stale) continue;
    blocked.push(...acquired.blocked);
    const obtained = acquired.packages.filter(
      (spec): spec is PackageMountInput => spec !== undefined,
    );
    if (obtained.length) {
      if (obtained.length !== labels.length) {
        // Successful TGZ slots were transferred into the invisible Worker
        // transaction and cannot be replayed after abort without reacquisition.
        // Keep mounted state unchanged and report why otherwise-available
        // siblings were withheld instead of copying every large carrier.
        for (const [slot, spec] of acquired.packages.entries()) {
          if (!spec) continue;
          const missing = toFetch[slot];
          blocked.push(blockedFrom(
            missing,
            'not mounted because another package in the same atomic resolution round was unavailable',
          ));
        }
        break;
      }
      if (!acquired.mounted) {
        throw new Error('complete package ticket closed without a mounted result');
      }
      const mountedLabels = acquired.mounted;
      for (const label of mountedLabels) {
        mountedAll.push(label);
        mergeLabelsIntoIndex(index, [label]);
      }
    } else {
      // A full round with nothing obtained: the remaining missing became
      // `blocked` inside obtainPackage.
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
 * every mutable request needs a successful observation for this exact
 * Worker/source/local epoch. A failed observation rejects the fast path rather
 * than pinning the stale concrete version recorded by the lock. */
export async function refreshMutableVersionIndex(
  requests: readonly MutableVersionRequest[],
  seed: VersionIndex,
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot = packageSourceSnapshot(),
  observeVersions: ObserveRegistryVersions = (id, report) => fetchRegistryVersions(id, report, source),
): Promise<VersionIndex | null> {
  const index: VersionIndex = { versions: {} };
  for (const [id, versions] of Object.entries(seed.versions)) {
    index.versions[id] = [...versions];
  }
  mergeLabelsIntoIndex(index, localLabels());
  const ids = [...new Set(requests.map((request) => request.package_id))];
  const refreshed = await Promise.all(ids.map(async (id) => ({
    id,
    result: await observeVersions(id, onProgress),
  })));
  for (const { id, result } of refreshed) {
    // Persistent locks require a complete reachable observation. Ordinary
    // resolution may continue offline after a partial failure, but a lock may
    // not treat malformed/aborted metadata as proof of an unchanged universe.
    if (result.unreachable || !result.cacheable) return null;
    index.versions[id] = [
      ...new Set([...(index.versions[id] ?? []), ...result.versions]),
    ];
  }
  return index;
}

/** Acquire an exact cached closure as one transport batch. Production hosts
 * prepare arrivals into an invisible ticket and commit only when the complete
 * lock was obtained; every host supplies the same explicit ticket boundary. */
export async function obtainLockedPackages(
  host: ResolverHost,
  labels: readonly string[],
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot = packageSourceSnapshot(),
): Promise<{
  packages: PackageMountInput[];
  blocked: BlockedPackage[];
  mounted: string[] | null;
  stale: boolean;
}> {
  const acquired = await acquirePackageBatch(
    host,
    labels.map((label): PackageBatchRequest => {
      const hash = label.lastIndexOf('#');
      if (hash <= 0) return {
        label,
        missing: null,
        invalid: {
          packageId: label,
          version: '',
          why: 'persistent resolution lock contains an invalid coordinate',
          remedies: [],
        },
      };
      return {
        label,
        missing: {
          package_id: label.slice(0, hash),
          version: label.slice(hash + 1),
          reason: { kind: 'not_mounted' },
          set: 'context',
        },
      };
    }),
    onProgress,
    source,
  );
  return {
    packages: acquired.packages.filter(
      (item): item is PackageMountInput => item !== undefined,
    ),
    blocked: acquired.blocked,
    mounted: acquired.mounted,
    stale: acquired.stale,
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
  source: PackageSourceSnapshot,
): Promise<PackageMountInput | null> {
  // An explicit session-local drop is the user's development authority for
  // this coordinate. It must beat baked and persisted artifacts of the same
  // label; Rust still validates its package metadata and content atomically.
  if (hasLocalPackage(label)) {
    const spec = getLocalPackage(label)!;
    return { kind: 'raw', spec, transportIdentity: 'unpinned' };
  }
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
  const cacheReadStartedMs = epochMs();
  const { findPreparedPackage, UNPINNED_TRANSPORT_IDENTITY } = await import('./preparedPackageCache');
  const pointer = await findPreparedPackage(label, UNPINNED_TRANSPORT_IDENTITY);
  if (pointer) {
    onProgress(spanEvent('package.cache-read', 'window', cacheReadStartedMs, {
      stage: 'bundle-cache-hit',
      label,
      message: `${label} (prepared binary)`,
      fromCache: true,
      inputBytes: pointer.bytes,
    }));
    return { kind: 'prepared', pointer };
  }
  onProgress(spanEvent('package.cache-read', 'window', cacheReadStartedMs, {
    stage: 'resolve',
    label,
    message: `${label} is not in the prepared-package cache.`,
    fromCache: false,
  }));
  // (c)/(d) direct FHIR registry (optionally via the configured proxy).
  const carrier = await fetchFromRegistry(label, missing, onProgress, source);
  if (carrier) return carrier;

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
export async function obtainRawPackageByLabel(
  label: string,
  source: PackageSourceSnapshot = packageSourceSnapshot(),
): Promise<PackageMountInput | null> {
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
  return fetchFromRegistry(label, missing, () => {}, source);
}

/** Continue an exact registry acquisition after Rust rejected the downloaded
 * TGZ during decode/normalization. Baked and local carriers deliberately have
 * no entry in this side table and therefore cannot silently downgrade. */
export async function retryRegistryTgzCarrier(
  carrier: PackageMountInput,
  onProgress: ResolveProgress,
): Promise<PackageMountInput | null> {
  if (carrier.kind !== 'tgz') return null;
  const origin = registryCarrierOrigins.get(carrier.bytes);
  if (!origin || origin.label !== carrier.label) return null;
  return fetchFromRegistry(
    origin.label,
    origin.missing,
    onProgress,
    origin.source,
    origin.nextRegistryIndex,
  );
}

/** Obtain and mount one exact coordinate requested by Rust's private template
 * resolution handshake. Templates use the ordinary OPFS/local/baked/registry
 * transport ladder, including complete PreparedPackage v3 artifacts. Returns
 * only success; no package files cross back to the host. */
export async function obtainAndMountPackage(
  host: ResolverHost,
  label: string,
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot = packageSourceSnapshot(),
): Promise<boolean> {
  const hash = label.lastIndexOf('#');
  const missing: MissingPackage = {
    package_id: hash > 0 ? label.slice(0, hash) : label,
    version: hash > 0 ? label.slice(hash + 1) : '',
    reason: { kind: 'not_mounted' },
    set: 'context',
  };
  const acquired = await acquirePackageBatch(
    host,
    [{ label, missing }],
    onProgress,
    source,
  );
  if (acquired.stale) return true;
  return acquired.blocked.length === 0 && acquired.mounted?.includes(label) === true;
}

/** Fetch a package tarball from the configured registries (packages.fhir.org →
 *  packages2 → …), each optionally wrapped through the proxy. Returns the
 *  compressed carrier, or null if every registry failed. */
async function fetchFromRegistry(
  label: string,
  missing: MissingPackage,
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot,
  startRegistryIndex = 0,
): Promise<PackageMountInput | null> {
  const { package_id: id, version } = missing;
  const registries = source.registries;
  for (
    let registryIndex = startRegistryIndex;
    registryIndex < registries.length;
    registryIndex += 1
  ) {
    const registry = registries[registryIndex];
    const direct = tarballUrl(registry, id, version);
    const url = viaPackageSource(source, direct);
    const fetchStartedMs = epochMs();
    onProgress(pointEvent('package.fetch-start', 'window', {
      stage: 'registry-fetch',
      label,
      message: `Fetching ${label} from ${registry}…`,
    }, fetchStartedMs));
    try {
      const transport = await openPackageTransport(
        `${label} from ${registry}`,
        url,
        { redirect: 'follow' },
      );
      try {
        const resp = transport.response;
        if (!resp.ok) {
          onProgress(spanEvent('package.fetch', 'window', fetchStartedMs, {
            stage: 'registry-fetch',
            label,
            message: `${registry} returned HTTP ${resp.status} for ${label}; trying the next registry.`,
            metrics: { fetchSucceeded: 0, httpStatus: resp.status },
          }));
          continue;
        }
        const contentLength = resp.headers.get('content-length');
        const total = contentLength == null ? Number.NaN : Number(contentLength);
        const totalBytes = Number.isSafeInteger(total) && total > 0 ? total : undefined;
        onProgress({
          phase: 'package.fetch.progress',
          source: 'window',
          startMs: epochMs(),
          stage: 'registry-fetch',
          label,
          bytes: 0,
          totalBytes,
          message: `Downloading ${label} from ${registry}…`,
        });
        const bytes = await readResponseBytes(
          resp,
          (read) => {
            onProgress({
              phase: 'package.fetch.progress',
              source: 'window',
              startMs: epochMs(),
              stage: 'registry-fetch',
              label,
              bytes: read,
              totalBytes,
              message: `Downloading ${label} from ${registry}…`,
            });
          },
          totalBytes,
          transport.guard,
        );
        onProgress(spanEvent('package.fetch', 'window', fetchStartedMs, {
          stage: 'resolve',
          label,
          message: `Downloaded ${label}; ready to prepare.`,
          inputBytes: bytes.byteLength,
        }));
        const carrier: PackageMountInput = {
          kind: 'tgz',
          label,
          bytes,
          transportIdentity: 'unpinned',
        };
        registryCarrierOrigins.set(bytes, {
          label,
          missing,
          nextRegistryIndex: registryIndex + 1,
          source,
        });
        return carrier;
      } finally {
        transport.guard.close();
      }
    } catch {
      onProgress(spanEvent('package.fetch', 'window', fetchStartedMs, {
        stage: 'registry-fetch',
        label,
        message: `Could not fetch ${label} from ${registry}; trying the next registry.`,
        metrics: { fetchSucceeded: 0 },
      }));
      /* try the next registry */
    }
  }
  return null;
}

/** Query a registry's npm-style metadata for a package's available versions
 *  (used to build the engine's version index for `latest`/`x`). Returns the found
 *  versions plus `unreachable: true` when EVERY registry threw (network/CORS/
 *  offline) rather than answering — so a subsequent block can say "registry
 *  unreachable" instead of falsely implying the package doesn't exist.
 *  `cacheable` additionally requires that no registry observation was malformed
 *  or aborted before the chosen/empty result. */
export async function fetchRegistryVersions(
  id: string,
  onProgress: ResolveProgress,
  source: PackageSourceSnapshot = packageSourceSnapshot(),
): Promise<VersionObservation> {
  let anyReplied = false; // at least one registry answered (any HTTP status)
  let complete = true;
  for (const registry of source.registries) {
    const url = viaPackageSource(source, metadataUrl(registry, id));
    const fetchStartedMs = epochMs();
    onProgress(pointEvent('package.version-fetch-start', 'window', {
      stage: 'registry-fetch',
      label: id,
      message: `Looking up ${id} versions…`,
    }, fetchStartedMs));
    try {
      // Mutable coordinates require an origin revalidation. `no-cache` may use
      // a 304 response but may not silently accept a fresh-looking disk-cache
      // entry whose registry candidate universe has changed.
      const transport = await openPackageTransport(
        `${id} metadata from ${registry}`,
        url,
        { redirect: 'follow', cache: 'no-cache' },
      );
      try {
        const resp = transport.response;
        anyReplied = true;
        if (!resp.ok) {
          if (resp.status !== 404) complete = false;
          onProgress(spanEvent('package.version-fetch', 'window', fetchStartedMs, {
            stage: 'registry-fetch',
            label: id,
            message: `${registry} returned HTTP ${resp.status} for ${id}; trying the next registry.`,
            fromCache: false,
            metrics: { fetchSucceeded: 0, httpStatus: resp.status },
          }));
          continue;
        }
        const bytes = await readResponseBytes(resp, undefined, undefined, transport.guard);
        const meta: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
          throw new Error(`malformed registry metadata for ${id}`);
        }
        const versionMap = (meta as { versions?: unknown }).versions;
        if (versionMap !== undefined
          && (!versionMap || typeof versionMap !== 'object' || Array.isArray(versionMap))) {
          throw new Error(`malformed registry versions for ${id}`);
        }
        const versions = versionMap ? Object.keys(versionMap) : [];
        onProgress(spanEvent('package.version-fetch', 'window', fetchStartedMs, {
          stage: 'registry-fetch',
          label: id,
          message: `Loaded ${versions.length} available versions for ${id}.`,
          fromCache: false,
          fileCount: versions.length,
        }));
        if (versions.length) return { versions, unreachable: false, cacheable: complete };
      } finally {
        transport.guard.close();
      }
    } catch {
      complete = false;
      onProgress(spanEvent('package.version-fetch', 'window', fetchStartedMs, {
        stage: 'registry-fetch',
        label: id,
        message: `Could not load versions for ${id} from ${registry}.`,
        fromCache: false,
        metrics: { fetchSucceeded: 0 },
      }));
      /* incomplete/invalid observation for this registry — try the next */
    }
  }
  // Unreachable = no registry ever produced an HTTP reply (all threw).
  const unreachable = !anyReplied;
  onProgress({
    phase: 'package.version-fetch',
    source: 'window',
    startMs: epochMs(),
    stage: 'registry-fetch',
    label: id,
    message: unreachable
      ? `No configured registry was reachable for ${id}.`
      : `No configured registry reported versions for ${id}.`,
    fromCache: false,
    durationMs: 0,
    fileCount: 0,
  });
  return { versions: [], unreachable, cacheable: !unreachable && complete };
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
