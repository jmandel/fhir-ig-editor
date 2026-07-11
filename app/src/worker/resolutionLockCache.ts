/** Persistent, fail-closed cache for exact Rust package-resolution closures.
 *
 * A lock is only a prefetch plan. It never authorizes compilation: callers must
 * refresh every mutable version universe, mount the named immutable packages,
 * and ask Rust to produce an equivalent satisfied ResolutionStep. Content bytes
 * live in the shared ContentStore; this directory contains only tiny pointers.
 */

import { contentStore, type ContentRef } from '../storage/contentStore';
import { sha256Hex } from './bundleIntegrity';
import type { MutableVersionRequest, ResolutionStep, VersionIndex } from './protocol';

const CACHE_DIR = 'fhir-ig-editor-resolution-locks-v1';
export const RESOLUTION_LOCK_SCHEMA = 1;
export const EXPECTED_RESOLVER_SCHEMA = 2;
const MEDIA_TYPE = 'application/vnd.fhir.package-resolution-lock.v1+json';
const SHA256 = /^[0-9a-f]{64}$/;

export interface ResolutionAuthority {
  /** SHA-256 of the exact emitted WASM + JS glue, not a source commit label. */
  engineRecipe: string;
  bakedPackages: Array<{ label: string; sha256: string }>;
  registries: string[];
  proxy: string;
}

export interface PersistentResolutionLock {
  schema: typeof RESOLUTION_LOCK_SCHEMA;
  resolverSchema: number;
  cacheKey: string;
  configSha256: string;
  compileSet: Array<{ package_id: string; version: string }>;
  contextClosure: Array<{ package_id: string; version: string }>;
  resolutionSupport: Array<{ package_id: string; version: string }>;
  mutableRequests: MutableVersionRequest[];
  versionIndex: VersionIndex;
}

interface LockPointer {
  schema: typeof RESOLUTION_LOCK_SCHEMA;
  cacheKey: string;
  object: ContentRef;
}

function canonicalAuthority(authority: ResolutionAuthority): string {
  return JSON.stringify({
    engineRecipe: authority.engineRecipe,
    bakedPackages: [...authority.bakedPackages]
      .sort((a, b) => a.label.localeCompare(b.label) || a.sha256.localeCompare(b.sha256)),
    registries: authority.registries,
    proxy: authority.proxy,
  });
}

export async function resolutionLockCacheKey(
  config: string,
  authority: ResolutionAuthority,
): Promise<{ cacheKey: string; configSha256: string }> {
  const encoder = new TextEncoder();
  const configSha256 = await sha256Hex(encoder.encode(config));
  const cacheKey = await sha256Hex(encoder.encode(JSON.stringify({
    schema: RESOLUTION_LOCK_SCHEMA,
    resolverSchema: EXPECTED_RESOLVER_SCHEMA,
    configSha256,
    authority: canonicalAuthority(authority),
  })));
  return { cacheKey, configSha256 };
}

function validCoord(value: unknown): value is { package_id: string; version: string } {
  const coord = value as { package_id?: unknown; version?: unknown } | null;
  return !!coord && typeof coord.package_id === 'string' && !!coord.package_id
    && typeof coord.version === 'string' && !!coord.version;
}

function validMutable(value: unknown): value is MutableVersionRequest {
  const request = value as Partial<MutableVersionRequest> | null;
  return !!request
    && typeof request.package_id === 'string' && !!request.package_id
    && typeof request.requested === 'string' && !!request.requested
    && (request.resolved_version === null || typeof request.resolved_version === 'string')
    && (request.set === 'compile' || request.set === 'context');
}

function validVersionIndex(value: unknown): value is VersionIndex {
  const index = value as Partial<VersionIndex> | null;
  if (!index || typeof index.versions !== 'object' || index.versions === null || Array.isArray(index.versions)) {
    return false;
  }
  return Object.entries(index.versions).every(([id, versions]) =>
    !!id && Array.isArray(versions) && versions.every((version) => typeof version === 'string' && !!version));
}

function validLock(value: unknown, cacheKey: string, configSha256: string): value is PersistentResolutionLock {
  const lock = value as Partial<PersistentResolutionLock> | null;
  return !!lock
    && lock.schema === RESOLUTION_LOCK_SCHEMA
    && lock.resolverSchema === EXPECTED_RESOLVER_SCHEMA
    && lock.cacheKey === cacheKey
    && lock.configSha256 === configSha256
    && Array.isArray(lock.compileSet) && lock.compileSet.length > 0 && lock.compileSet.every(validCoord)
    && Array.isArray(lock.contextClosure) && lock.contextClosure.every(validCoord)
    && Array.isArray(lock.resolutionSupport) && lock.resolutionSupport.every(validCoord)
    && Array.isArray(lock.mutableRequests)
    && lock.mutableRequests.every((request) => validMutable(request) && request.resolved_version !== null)
    && validVersionIndex(lock.versionIndex);
}

function normalizeIndex(index: VersionIndex): VersionIndex {
  const versions: Record<string, string[]> = {};
  for (const id of Object.keys(index.versions).sort()) {
    versions[id] = [...new Set(index.versions[id])].sort();
  }
  return { versions };
}

export function lockFromResolution(
  cacheKey: string,
  configSha256: string,
  step: ResolutionStep,
  versionIndex: VersionIndex,
): PersistentResolutionLock {
  if (!step.satisfied || step.resolver_schema !== EXPECTED_RESOLVER_SCHEMA) {
    throw new Error('cannot persist an unsatisfied or unknown-schema package resolution');
  }
  return {
    schema: RESOLUTION_LOCK_SCHEMA,
    resolverSchema: step.resolver_schema,
    cacheKey,
    configSha256,
    compileSet: step.compile_set,
    contextClosure: step.context_closure,
    resolutionSupport: step.resolution_support,
    mutableRequests: step.mutable_requests,
    versionIndex: normalizeIndex(versionIndex),
  };
}

export function lockedLabels(lock: PersistentResolutionLock): string[] {
  return [...new Set([...lock.compileSet, ...lock.contextClosure, ...lock.resolutionSupport]
    .map(({ package_id, version }) => `${package_id}#${version}`))];
}

/** Exact ordered equality is intentional: load order is part of resolver output. */
export function resolutionMatchesLock(step: ResolutionStep, lock: PersistentResolutionLock): boolean {
  return step.satisfied
    && step.resolver_schema === lock.resolverSchema
    && JSON.stringify(step.compile_set) === JSON.stringify(lock.compileSet)
    && JSON.stringify(step.context_closure) === JSON.stringify(lock.contextClosure)
    && JSON.stringify(step.resolution_support) === JSON.stringify(lock.resolutionSupport);
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null;
  }
}

function validPointer(value: unknown, cacheKey: string): value is LockPointer {
  const pointer = value as Partial<LockPointer> | null;
  const object = pointer?.object as Partial<ContentRef> | undefined;
  return !!pointer
    && pointer.schema === RESOLUTION_LOCK_SCHEMA
    && pointer.cacheKey === cacheKey
    && !!object && typeof object.sha256 === 'string' && SHA256.test(object.sha256)
    && Number.isSafeInteger(object.byteLength) && (object.byteLength ?? -1) >= 0;
}

export async function readResolutionLock(
  config: string,
  authority: ResolutionAuthority,
): Promise<PersistentResolutionLock | null> {
  const { cacheKey, configSha256 } = await resolutionLockCacheKey(config, authority);
  const dir = await directory();
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(`${cacheKey}.json`);
    const candidate = JSON.parse(await (await handle.getFile()).text()) as unknown;
    if (!validPointer(candidate, cacheKey)) return null;
    const bytes = await contentStore.get(candidate.object);
    if (!bytes) return null;
    const lock = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return validLock(lock, cacheKey, configSha256) ? lock : null;
  } catch {
    return null;
  }
}

/** Content first, pointer last: a torn publication is only a cache miss. */
export async function writeResolutionLock(
  config: string,
  authority: ResolutionAuthority,
  step: ResolutionStep,
  versionIndex: VersionIndex,
): Promise<void> {
  const { cacheKey, configSha256 } = await resolutionLockCacheKey(config, authority);
  const lock = lockFromResolution(cacheKey, configSha256, step, versionIndex);
  const bytes = new TextEncoder().encode(JSON.stringify(lock));
  const object = await contentStore.put(bytes, MEDIA_TYPE);
  if (!object) return;
  const dir = await directory();
  if (!dir) return;
  const handle = await dir.getFileHandle(`${cacheKey}.json`, { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({ schema: RESOLUTION_LOCK_SCHEMA, cacheKey, object } satisfies LockPointer));
  await writable.close();
}
