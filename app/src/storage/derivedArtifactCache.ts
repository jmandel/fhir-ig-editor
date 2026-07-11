/** Exact derived-artifact cache over ContentStore.
 *
 * Recipes are canonical JSON and pointers are published only after immutable
 * content. A pointer is never authority: every read revalidates its recipe,
 * digest, byte length, and content SHA-256 through ContentStore. */

import { sha256Hex } from '../worker/bundleIntegrity';
import { contentStore, type ContentRef } from './contentStore';

const POINTER_DIR = 'fhir-ig-editor-derived-v1';
const SHA256 = /^[0-9a-f]{64}$/;

export type DerivedRecipeValue =
  | null
  | boolean
  | number
  | string
  | DerivedRecipeValue[]
  | { [key: string]: DerivedRecipeValue };

interface DerivedPointer {
  schema: 1;
  namespace: string;
  recipeDigest: string;
  content: ContentRef;
}

function canonicalize(value: DerivedRecipeValue): DerivedRecipeValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error('derived-artifact recipes require finite numbers');
  }
  return value;
}

export function canonicalDerivedRecipe(recipe: DerivedRecipeValue): string {
  return JSON.stringify(canonicalize(recipe));
}

export async function derivedRecipeDigest(recipe: DerivedRecipeValue): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalDerivedRecipe(recipe)));
}

async function pointerDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(POINTER_DIR, { create: true });
  } catch {
    return null;
  }
}

function safeNamespace(namespace: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(namespace)) {
    throw new Error(`invalid derived-artifact namespace ${namespace}`);
  }
  return namespace;
}

function pointerName(namespace: string, digest: string): string {
  return `${safeNamespace(namespace)}__${digest}.json`;
}

function validPointer(
  value: unknown,
  namespace: string,
  recipeDigest: string,
): value is DerivedPointer {
  const pointer = value as Partial<DerivedPointer> | null;
  const content = pointer?.content as Partial<ContentRef> | undefined;
  return !!pointer
    && pointer.schema === 1
    && pointer.namespace === namespace
    && pointer.recipeDigest === recipeDigest
    && !!content
    && typeof content.sha256 === 'string'
    && SHA256.test(content.sha256)
    && Number.isSafeInteger(content.byteLength)
    && (content.byteLength ?? -1) >= 0
    && (content.mediaType === undefined || typeof content.mediaType === 'string');
}

export interface DerivedArtifact {
  bytes: ArrayBuffer;
  content: ContentRef;
  recipeDigest: string;
}

export async function readDerivedArtifact(
  namespace: string,
  recipe: DerivedRecipeValue,
  expectedMediaType?: string,
): Promise<DerivedArtifact | null> {
  const recipeDigest = await derivedRecipeDigest(recipe);
  const directory = await pointerDirectory();
  if (!directory) return null;
  try {
    const handle = await directory.getFileHandle(pointerName(namespace, recipeDigest));
    const candidate = JSON.parse(await (await handle.getFile()).text());
    if (!validPointer(candidate, namespace, recipeDigest)) return null;
    if (expectedMediaType && candidate.content.mediaType !== expectedMediaType) return null;
    const bytes = await contentStore.get(candidate.content);
    return bytes ? { bytes, content: candidate.content, recipeDigest } : null;
  } catch {
    return null;
  }
}

export async function writeDerivedArtifact(
  namespace: string,
  recipe: DerivedRecipeValue,
  bytes: BufferSource,
  mediaType: string,
): Promise<DerivedArtifact | null> {
  const recipeDigest = await derivedRecipeDigest(recipe);
  const content = await contentStore.put(bytes, mediaType);
  if (!content) return null;
  const directory = await pointerDirectory();
  if (!directory) return null;
  const pointer: DerivedPointer = { schema: 1, namespace, recipeDigest, content };
  // Pointer-last publication: a crash before this write leaves only harmless,
  // unreachable content. ContentStore verifies bytes before this point.
  const handle = await directory.getFileHandle(pointerName(namespace, recipeDigest), { create: true });
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(pointer));
  await writable.close();
  return { bytes: bytes instanceof ArrayBuffer ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), content, recipeDigest };
}
