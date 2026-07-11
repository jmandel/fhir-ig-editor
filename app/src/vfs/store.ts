// Project store (spec §5). The working IG lives as a flat path→text map. Backed
// by OPFS when available (persists across reloads), with an in-memory fallback
// for browsers without OPFS (Safari private mode, etc. — spec §11: degrade
// gracefully, no persistence). The editor only mounts this; the fancier
// PackageSource browser impl lives engine-side.
//
// Paths are project-relative POSIX (e.g. `input/fsh/Profiles.fsh`,
// `sushi-config.yaml`). OPFS has no nested-dir create-on-write, so we store every
// file at a single flattened key (path with '/' → encoded) in one OPFS directory;
// the logical tree is reconstructed from the path strings.

export interface ProjectFile {
  path: string;
  text: string;
}

/** A binary project file (e.g. an image), content base64. Kept separate from the
 *  text cache so exact authored bytes survive compile and SiteBuild projection. */
export interface BinaryProjectFile {
  path: string;
  base64: string;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

const OPFS_DIR = 'fhir-ig-editor-project';
const KEY_SEP = '␟'; // '␟' unit separator — not valid in paths
const STATE_PATH = '.fhir-ig-editor-state.json';
const BINARY_PREFIX = '.fhir-ig-editor-binary/';

interface PersistedProjectState {
  schema: 2;
  /** Immutable identity of the catalog/source artifact that populated the
   * store. Null means the user has edited the working copy. */
  sourceIdentity: string | null;
  textPaths: string[];
  binaryPaths: string[];
}

export interface ProjectLoadResult {
  reused: boolean;
  durationMs: number;
  textFiles: number;
  binaryFiles: number;
  /** UTF-8 bytes written for text plus persisted base64 binary bodies. */
  storedBytes: number;
}

function encodeKey(path: string): string {
  return path.replaceAll('/', KEY_SEP);
}
function decodeKey(key: string): string {
  return key.replaceAll(KEY_SEP, '/');
}

interface Backend {
  readonly kind: 'opfs' | 'memory';
  list(): Promise<string[]>;
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  delete(path: string): Promise<void>;
  clear(): Promise<void>;
}

class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private files = new Map<string, string>();
  async list() {
    return [...this.files.keys()];
  }
  async read(path: string) {
    return this.files.get(path) ?? null;
  }
  async write(path: string, text: string) {
    this.files.set(path, text);
  }
  async delete(path: string) {
    this.files.delete(path);
  }
  async clear() {
    this.files.clear();
  }
}

class OpfsBackend implements Backend {
  readonly kind = 'opfs' as const;
  constructor(private dir: FileSystemDirectoryHandle) {}

  static async create(): Promise<OpfsBackend | null> {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
      return new OpfsBackend(dir);
    } catch {
      return null;
    }
  }

  async list() {
    const out: string[] = [];
    // @ts-expect-error - entries() is present on OPFS dir handles at runtime
    for await (const [name, handle] of this.dir.entries()) {
      if (handle.kind === 'file') out.push(decodeKey(name));
    }
    return out;
  }
  async read(path: string) {
    try {
      const fh = await this.dir.getFileHandle(encodeKey(path));
      return await (await fh.getFile()).text();
    } catch {
      return null;
    }
  }
  async write(path: string, text: string) {
    const fh = await this.dir.getFileHandle(encodeKey(path), { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  async delete(path: string) {
    try {
      await this.dir.removeEntry(encodeKey(path));
    } catch {
      /* already gone */
    }
  }
  async clear() {
    const names = [];
    // @ts-expect-error - entries() present at runtime
    for await (const [name] of this.dir.entries()) names.push(name);
    for (const n of names) await this.dir.removeEntry(n).catch(() => {});
  }
}

/**
 * The project VFS. `create()` picks OPFS if available, else in-memory. A change
 * listener lets the UI react to writes (mark dirty / re-list the tree).
 */
export class ProjectStore {
  private constructor(
    private backend: Backend,
    private cache: Map<string, string>,
    private binary: Map<string, string>,
    private sourceIdentity: string | null,
  ) {}

  readonly listeners = new Set<() => void>();

  static async create(): Promise<ProjectStore> {
    const backend = (await OpfsBackend.create()) ?? new MemoryBackend();
    const paths = await backend.list();
    let state: PersistedProjectState = {
      schema: 2,
      sourceIdentity: null,
      textPaths: [],
      binaryPaths: [],
    };
    if (paths.includes(STATE_PATH)) {
      try {
        const parsed = JSON.parse((await backend.read(STATE_PATH)) ?? '') as Partial<PersistedProjectState>;
        if (
          parsed.schema === 2
          && (typeof parsed.sourceIdentity === 'string' || parsed.sourceIdentity === null)
          && Array.isArray(parsed.textPaths)
          && parsed.textPaths.every((path) => typeof path === 'string')
          && Array.isArray(parsed.binaryPaths)
          && parsed.binaryPaths.every((path) => typeof path === 'string')
        ) {
          state = parsed as PersistedProjectState;
        }
      } catch {
        // A torn/old state marker cannot authorize source reuse. Ordinary text
        // files remain recoverable as an editable working copy.
      }
    }
    const cache = new Map<string, string>();
    const textPaths = paths.filter((path) => path !== STATE_PATH && !path.startsWith(BINARY_PREFIX));
    await Promise.all(textPaths.map(async (path) => cache.set(path, (await backend.read(path)) ?? '')));
    const binary = new Map<string, string>();
    await Promise.all(state.binaryPaths.map(async (path) => {
      const body = await backend.read(`${BINARY_PREFIX}${path}`);
      if (body != null) binary.set(path, body);
    }));
    // The state marker is a commit record. Missing binary members invalidate
    // source reuse but do not discard the recoverable working copy.
    const complete = binary.size === state.binaryPaths.length
      && cache.size === state.textPaths.length
      && state.textPaths.every((path) => cache.has(path));
    return new ProjectStore(backend, cache, binary, complete ? state.sourceIdentity : null);
  }

  get persistent() {
    return this.backend.kind === 'opfs';
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  list(): string[] {
    return [...this.cache.keys()].sort();
  }

  has(path: string): boolean {
    return this.cache.has(path);
  }

  read(path: string): string | null {
    return this.cache.get(path) ?? null;
  }

  async write(path: string, text: string): Promise<void> {
    this.cache.set(path, text);
    await this.backend.write(path, text);
    await this.invalidateSourceIdentity();
    this.notify();
  }

  async delete(path: string): Promise<void> {
    this.cache.delete(path);
    await this.backend.delete(path);
    await this.invalidateSourceIdentity();
    this.notify();
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.cache.get(from);
    if (text == null) return;
    await this.write(to, text);
    await this.delete(from);
  }

  private async writeState(): Promise<void> {
    const state: PersistedProjectState = {
      schema: 2,
      sourceIdentity: this.sourceIdentity,
      textPaths: [...this.cache.keys()].sort(),
      binaryPaths: [...this.binary.keys()].sort(),
    };
    await this.backend.write(STATE_PATH, JSON.stringify(state));
  }

  private async invalidateSourceIdentity(): Promise<void> {
    if (this.sourceIdentity === null) return;
    this.sourceIdentity = null;
    await this.writeState();
  }

  hasSource(identity: string): boolean {
    return this.sourceIdentity === identity;
  }

  /** Replace the whole project. When `identity` matches the last completely
   * committed immutable source, this is a true no-op: no archive unpack result
   * is rewritten and persisted binary assets remain available. */
  async loadAll(
    files: ProjectFile[],
    binary: BinaryProjectFile[] = [],
    identity?: string,
  ): Promise<ProjectLoadResult> {
    const started = performance.now();
    if (identity && this.sourceIdentity === identity) {
      return {
        reused: true,
        durationMs: performance.now() - started,
        textFiles: this.cache.size,
        binaryFiles: this.binary.size,
        storedBytes: 0,
      };
    }
    await this.backend.clear();
    // Clearing the committed backend revokes the old source proof immediately.
    // If any subsequent member write fails, this in-memory instance must not
    // continue claiming that the now-deleted prior project is reusable.
    this.sourceIdentity = null;
    this.cache.clear();
    this.binary.clear();
    for (const file of files) this.cache.set(file.path, file.text);
    for (const file of binary) this.binary.set(file.path, file.base64);
    const encoder = new TextEncoder();
    const storedBytes = files.reduce((sum, file) => sum + encoder.encode(file.text).byteLength, 0)
      + binary.reduce((sum, file) => sum + file.base64.length, 0);
    // OPFS file creation has non-trivial latency. A bounded pool retains
    // deterministic all-or-nothing state publication without serializing
    // hundreds of independent writes.
    const writes: Array<() => Promise<void>> = [
      ...files.map((file) => () => this.backend.write(file.path, file.text)),
      ...binary.map((file) => () => this.backend.write(`${BINARY_PREFIX}${file.path}`, file.base64)),
    ];
    let next = 0;
    const runners = Array.from({ length: Math.min(16, writes.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= writes.length) return;
        await writes[index]();
      }
    });
    await Promise.all(runners);
    // Publish the source identity last. A failure above therefore leaves no
    // marker that could make a future load accept partial content.
    this.sourceIdentity = identity ?? null;
    await this.writeState();
    this.notify();
    return {
      reused: false,
      durationMs: performance.now() - started,
      textFiles: files.length,
      binaryFiles: binary.length,
      storedBytes,
    };
  }

  /** Exact authored Publisher input for compileProject/PreparedGuide: pages,
   * resource narratives, includes, data, generator sources, resources, and
   * images as `path -> base64`. */
  siteFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, t] of this.cache) {
      if (
        p.startsWith('input/pagecontent/') ||
        p.startsWith('input/pages/') ||
        p.startsWith('input/includes/') ||
        p.startsWith('input/intro-notes/') ||
        p.startsWith('input/resource-docs/') ||
        p.startsWith('input/images-source/') ||
        // input/data/* are the IG-authored site.data files the publisher copies
        // into temp/pages/_data/*; Publisher preparation stages them alongside
        // the producer-emitted _data model.
        p.startsWith('input/data/') ||
        ((p.startsWith('input/resources/') || p.startsWith('input/examples/')) && p.endsWith('.json'))
      ) {
        out[p] = utf8ToBase64(t);
      }
    }
    for (const [p, b64] of this.binary) out[p] = b64;
    return out;
  }

  /** All FSH file contents keyed by path — the compile input. */
  fshFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, t] of this.cache) if (p.endsWith('.fsh')) out[p] = t;
    return out;
  }

  /** Authored local FHIR resources under input/{resources,examples}/**.json.
   * Both roots cross the compiler boundary through this one map; the exact
   * source path retains SUSHI's folder-specific publication semantics. */
  predefinedResources(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [p, t] of this.cache) {
      if ((p.startsWith('input/resources/') || p.startsWith('input/examples/')) && p.endsWith('.json')) {
        // Fail before compilation rather than silently dropping an authored
        // resource. Rust independently validates the raw site-file copy too.
        out[p] = JSON.parse(t);
      }
    }
    return out;
  }

  /** Authored local resources (input/{resources,examples}/**.json) shaped like the
   *  compiler's CompiledResource, for the Definitions workspace. A
   *  predefined-resource IG (0 FSH; e.g. US Core, IPS) authors its profiles as
   *  input/resources JSON, so SUSHI emits nothing — without these the panel is
   *  empty even though the IG is full of conformance resources. These are
   *  display/browse entries (the compile output list stays byte-exact SUSHI). */
  predefinedDisplayResources(): Array<{
    filename: string;
    text: string;
    resourceType?: string;
    id?: string;
    url?: string;
    definition: { kind: 'predefined-resource'; path: string; line: number; column: number };
  }> {
    const out: Array<{
      filename: string;
      text: string;
      resourceType?: string;
      id?: string;
      url?: string;
      definition: { kind: 'predefined-resource'; path: string; line: number; column: number };
    }> = [];
    for (const [p, t] of this.cache) {
      if (!((p.startsWith('input/resources/') || p.startsWith('input/examples/')) && p.endsWith('.json'))) continue;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(t) as Record<string, unknown>;
      } catch {
        continue; // malformed — surfaced by the compiler diagnostics
      }
      out.push({
        filename: p.slice(p.lastIndexOf('/') + 1),
        text: t,
        resourceType: typeof body.resourceType === 'string' ? body.resourceType : undefined,
        id: typeof body.id === 'string' ? body.id : undefined,
        url: typeof body.url === 'string' ? body.url : undefined,
        definition: { kind: 'predefined-resource', path: p, line: 1, column: 0 },
      });
    }
    out.sort((a, b) => a.filename.localeCompare(b.filename));
    return out;
  }

  config(): string {
    return this.cache.get('sushi-config.yaml') ?? '';
  }
}
