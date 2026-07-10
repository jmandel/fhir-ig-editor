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
  ) {}

  readonly listeners = new Set<() => void>();

  /** Binary project files (images), path -> base64. Not persisted (read-only demo
   *  assets); rehydrated by `loadAll` each session. */
  private binary = new Map<string, string>();

  static async create(): Promise<ProjectStore> {
    const backend = (await OpfsBackend.create()) ?? new MemoryBackend();
    const cache = new Map<string, string>();
    for (const p of await backend.list()) {
      cache.set(p, (await backend.read(p)) ?? '');
    }
    return new ProjectStore(backend, cache);
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
    this.notify();
  }

  async delete(path: string): Promise<void> {
    this.cache.delete(path);
    await this.backend.delete(path);
    this.notify();
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.cache.get(from);
    if (text == null) return;
    await this.write(to, text);
    await this.delete(from);
  }

  /** Replace the whole project (used by "Open demo IG"). */
  async loadAll(files: ProjectFile[], binary: BinaryProjectFile[] = []): Promise<void> {
    await this.backend.clear();
    this.cache.clear();
    this.binary.clear();
    for (const f of files) {
      this.cache.set(f.path, f.text);
      await this.backend.write(f.path, f.text);
    }
    for (const b of binary) this.binary.set(b.path, b.base64);
    this.notify();
  }

  /** Exact site-source input for compileProject/SiteBuild: pagecontent,
   * includes, data, resources, and images as `path -> base64`. */
  siteFiles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [p, t] of this.cache) {
      if (
        p.startsWith('input/pagecontent/') ||
        p.startsWith('input/includes/') ||
        // input/data/* are the IG-authored site.data files the publisher copies
        // into temp/pages/_data/* — the source-driven stock adapter (task #45)
        // stages them alongside the producer-emitted _data model.
        p.startsWith('input/data/') ||
        (p.startsWith('input/resources/') && p.endsWith('.json'))
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

  /** Predefined JSON resources under input/resources/** — the compile input. */
  predefinedResources(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [p, t] of this.cache) {
      if (p.startsWith('input/resources/') && p.endsWith('.json')) {
        // Fail before compilation rather than silently dropping an authored
        // resource. Rust independently validates the raw site-file copy too.
        out[p] = JSON.parse(t);
      }
    }
    return out;
  }

  /** Predefined conformance resources (input/resources/**.json) shaped like the
   *  compiler's CompiledResource, for the "Compiled resources" panel. A
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
  }> {
    const out: Array<{ filename: string; text: string; resourceType?: string; id?: string; url?: string }> = [];
    for (const [p, t] of this.cache) {
      if (!(p.startsWith('input/resources/') && p.endsWith('.json'))) continue;
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
      });
    }
    out.sort((a, b) => a.filename.localeCompare(b.filename));
    return out;
  }

  config(): string {
    return this.cache.get('sushi-config.yaml') ?? '';
  }
}
