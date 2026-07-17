import type { ProjectRevision } from '../site/contract.generated';
import type { ResourceView } from '../views/resourceView';

export interface ProjectFile {
  path: string;
  text: string;
}

export interface BinaryProjectFile {
  path: string;
  base64: string;
}

export interface WorkspaceSource {
  projectId: string;
  name: string;
  sourceIdentity: string;
  files: ProjectFile[];
  binaryFiles?: BinaryProjectFile[];
}

export interface WorkspaceInstallResult {
  workspace: Workspace;
  installed: boolean;
  durationMs: number;
  textFiles: number;
  binaryFiles: number;
  storedBytes: number;
}

export interface WorkspaceCapture {
  projectId: string;
  buildEpochSecs: number;
  revision: ProjectRevision;
  predefinedDisplay: ResourceView[];
}

interface WorkspaceTextProjection {
  /** Exact source value that owns every derived field below. */
  sourceText: string;
  fsh: boolean;
  predefined?: Record<string, unknown>;
  predefinedDisplay?: ResourceView;
  siteFile: boolean;
  siteBase64?: string;
}

const OPFS_ROOT = 'fhir-ig-editor-workspaces';
const POINTER_FILE = 'current.json';
const STATE_FILE = 'workspace.json';
const BINARY_PREFIX = 'binary-';
const KEY_SEP = '␟';

interface WorkspacePointer {
  schema: 1;
  generation: string;
}

interface WorkspaceState {
  schema: 1;
  projectId: string;
  name: string;
  sourceIdentity: string;
  dirty: boolean;
  textPaths: string[];
  binaryPaths: string[];
}

interface LoadedWorkspace {
  generation: string;
  state: WorkspaceState;
  text: Map<string, string>;
  binary: Map<string, string>;
}

interface WorkspacePersistence {
  readonly persistent: boolean;
  read(projectId: string): Promise<LoadedWorkspace | null>;
  stage(source: WorkspaceSource): Promise<StagedWorkspace>;
  discard(staged: StagedWorkspace): Promise<void>;
  publish(staged: StagedWorkspace): Promise<void>;
  rollback(staged: StagedWorkspace): Promise<void>;
  complete(staged: StagedWorkspace): Promise<void>;
  writeText(projectId: string, generation: string, path: string, text: string): Promise<void>;
  deleteText(projectId: string, generation: string, path: string): Promise<void>;
  writeState(projectId: string, generation: string, state: WorkspaceState): Promise<void>;
}

interface StagedWorkspace {
  projectId: string;
  loaded: LoadedWorkspace;
  previousGeneration: string | null;
  /** Memory fallback only; OPFS rollback needs just the generation pointer. */
  previousMemory?: LoadedWorkspace | null;
}

export interface WorkspaceInstallCondition {
  /** The exact clean workspace observed before source acquisition began. Null
   * means the caller observed that no workspace existed. */
  replace: Workspace | null;
}

function encodeKey(path: string): string {
  return path.replaceAll('/', KEY_SEP);
}

function projectKey(projectId: string): string {
  return encodeURIComponent(projectId);
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function sourceState(source: WorkspaceSource): WorkspaceState {
  return {
    schema: 1,
    projectId: source.projectId,
    name: source.name,
    sourceIdentity: source.sourceIdentity,
    dirty: false,
    textPaths: source.files.map((file) => file.path).sort(),
    binaryPaths: (source.binaryFiles ?? []).map((file) => file.path).sort(),
  };
}

function safeProjectPath(path: string): boolean {
  return path.length > 0
    && !path.startsWith('/')
    && !path.includes('\\')
    && !path.includes('\0')
    && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function validateSource(source: WorkspaceSource): void {
  if (!source.projectId || !source.sourceIdentity) throw new Error('workspace source identity is required');
  const paths = new Set<string>();
  for (const file of [...source.files, ...(source.binaryFiles ?? [])]) {
    if (!safeProjectPath(file.path)) throw new Error(`invalid workspace path ${file.path}`);
    if (paths.has(file.path)) throw new Error(`duplicate workspace path ${file.path}`);
    paths.add(file.path);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function projectWorkspaceText(path: string, text: string): WorkspaceTextProjection {
  const predefinedPath = (
    (path.startsWith('input/resources/') || path.startsWith('input/examples/'))
    && path.endsWith('.json')
  );
  const siteFile = path.startsWith('input/pagecontent/')
    || path.startsWith('input/pages/')
    || path.startsWith('input/includes/')
    || path.startsWith('input/intro-notes/')
    || path.startsWith('input/resource-docs/')
    || path.startsWith('input/images-source/')
    || path.startsWith('input/data/')
    || predefinedPath;
  const predefined = predefinedPath
    ? deepFreeze(JSON.parse(text) as Record<string, unknown>)
    : undefined;
  const predefinedDisplay = predefined
    ? deepFreeze<ResourceView>({
      filename: path.slice(path.lastIndexOf('/') + 1),
      text,
      resourceType: typeof predefined.resourceType === 'string' ? predefined.resourceType : undefined,
      id: typeof predefined.id === 'string' ? predefined.id : undefined,
      url: typeof predefined.url === 'string' ? predefined.url : undefined,
      definition: { kind: 'predefined-resource', path, line: 1, column: 0 },
    })
    : undefined;
  return Object.freeze({
    sourceText: text,
    fsh: path.endsWith('.fsh'),
    predefined,
    predefinedDisplay,
    siteFile,
    siteBase64: siteFile ? utf8ToBase64(text) : undefined,
  });
}

function validateState(value: unknown, projectId: string): WorkspaceState | null {
  const state = value as Partial<WorkspaceState> | null;
  if (
    !state
    || state.schema !== 1
    || state.projectId !== projectId
    || typeof state.name !== 'string'
    || typeof state.sourceIdentity !== 'string'
    || typeof state.dirty !== 'boolean'
    || !Array.isArray(state.textPaths)
    || !state.textPaths.every((path) => typeof path === 'string')
    || new Set(state.textPaths).size !== state.textPaths.length
    || !Array.isArray(state.binaryPaths)
    || !state.binaryPaths.every((path) => typeof path === 'string')
    || new Set(state.binaryPaths).size !== state.binaryPaths.length
  ) return null;
  return state as WorkspaceState;
}

async function readText(directory: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try {
    return await (await directory.getFileHandle(name)).getFile().then((file) => file.text());
  } catch {
    return null;
  }
}

async function writeText(directory: FileSystemDirectoryHandle, name: string, text: string): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function runPool(tasks: Array<() => Promise<void>>, limit = 16): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= tasks.length) return;
      await tasks[index]();
    }
  }));
}

class OpfsWorkspacePersistence implements WorkspacePersistence {
  readonly persistent = true;

  private constructor(private root: FileSystemDirectoryHandle) {}

  static async create(): Promise<OpfsWorkspacePersistence | null> {
    try {
      const storage = await navigator.storage.getDirectory();
      return new OpfsWorkspacePersistence(
        await storage.getDirectoryHandle(OPFS_ROOT, { create: true }),
      );
    } catch {
      return null;
    }
  }

  private async projectDirectory(projectId: string, create = false): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await this.root.getDirectoryHandle(projectKey(projectId), { create });
    } catch {
      return null;
    }
  }

  private async generationDirectory(
    projectId: string,
    generation: string,
    create = false,
  ): Promise<FileSystemDirectoryHandle | null> {
    const project = await this.projectDirectory(projectId, create);
    if (!project) return null;
    try {
      return await project.getDirectoryHandle(generation, { create });
    } catch {
      return null;
    }
  }

  async read(projectId: string): Promise<LoadedWorkspace | null> {
    const project = await this.projectDirectory(projectId);
    if (!project) return null;
    let pointer: WorkspacePointer;
    try {
      pointer = JSON.parse((await readText(project, POINTER_FILE)) ?? '') as WorkspacePointer;
    } catch {
      return null;
    }
    if (pointer.schema !== 1 || typeof pointer.generation !== 'string' || !pointer.generation) return null;
    const generation = await this.generationDirectory(projectId, pointer.generation);
    if (!generation) return null;
    let parsedState: unknown;
    try {
      parsedState = JSON.parse((await readText(generation, STATE_FILE)) ?? '');
    } catch {
      return null;
    }
    const state = validateState(parsedState, projectId);
    if (!state) return null;
    const text = new Map<string, string>();
    const binary = new Map<string, string>();
    await runPool([
      ...state.textPaths.map((path) => async () => {
        const body = await readText(generation, encodeKey(path));
        if (body == null) throw new Error(`workspace ${projectId} is missing ${path}`);
        text.set(path, body);
      }),
      ...state.binaryPaths.map((path) => async () => {
        const body = await readText(generation, `${BINARY_PREFIX}${encodeKey(path)}`);
        if (body == null) throw new Error(`workspace ${projectId} is missing ${path}`);
        binary.set(path, body);
      }),
    ]).catch(() => {});
    if (text.size !== state.textPaths.length || binary.size !== state.binaryPaths.length) return null;
    return { generation: pointer.generation, state, text, binary };
  }

  async stage(source: WorkspaceSource): Promise<StagedWorkspace> {
    const project = await this.projectDirectory(source.projectId, true);
    if (!project) throw new Error(`cannot create workspace ${source.projectId}`);
    let previousGeneration: string | null = null;
    try {
      const value = JSON.parse((await readText(project, POINTER_FILE)) ?? '') as WorkspacePointer;
      if (value.schema === 1 && typeof value.generation === 'string') {
        previousGeneration = value.generation;
      }
    } catch {
      // No committed predecessor.
    }
    const generationName = `generation-${Date.now()}-${crypto.randomUUID()}`;
    const generation = await project.getDirectoryHandle(generationName, { create: true });
    const state = sourceState(source);
    try {
      await runPool([
        ...source.files.map((file) => () => writeText(generation, encodeKey(file.path), file.text)),
        ...(source.binaryFiles ?? []).map((file) => () => (
          writeText(generation, `${BINARY_PREFIX}${encodeKey(file.path)}`, file.base64)
        )),
      ]);
      await writeText(generation, STATE_FILE, JSON.stringify(state));
    } catch (error) {
      await project.removeEntry(generationName, { recursive: true }).catch(() => {});
      throw error;
    }
    return {
      projectId: source.projectId,
      previousGeneration,
      loaded: {
        generation: generationName,
        state,
        text: new Map(source.files.map((file) => [file.path, file.text])),
        binary: new Map((source.binaryFiles ?? []).map((file) => [file.path, file.base64])),
      },
    };
  }

  async publish(staged: StagedWorkspace): Promise<void> {
    const project = await this.projectDirectory(staged.projectId, true);
    if (!project) throw new Error(`cannot publish workspace ${staged.projectId}`);
    // The pointer is the commit record. The predecessor remains present until
    // the repository confirms that no edit raced source acquisition/publication.
    await writeText(project, POINTER_FILE, JSON.stringify({
      schema: 1,
      generation: staged.loaded.generation,
    }));
  }

  async discard(staged: StagedWorkspace): Promise<void> {
    const project = await this.projectDirectory(staged.projectId);
    await project?.removeEntry(staged.loaded.generation, { recursive: true }).catch(() => {});
  }

  async rollback(staged: StagedWorkspace): Promise<void> {
    const project = await this.projectDirectory(staged.projectId);
    if (!project) return;
    if (staged.previousGeneration) {
      await writeText(project, POINTER_FILE, JSON.stringify({
        schema: 1,
        generation: staged.previousGeneration,
      }));
    } else {
      await project.removeEntry(POINTER_FILE).catch(() => {});
    }
    await project.removeEntry(staged.loaded.generation, { recursive: true }).catch(() => {});
  }

  async complete(staged: StagedWorkspace): Promise<void> {
    // Keep the predecessor as a recovery generation. Source replacement is
    // rare, and deleting the Workspace still displayed by React would turn a
    // last-moment edit into an unavailable write. A later explicit compactor can
    // remove unreferenced generations without participating in publication.
    void staged;
  }

  async writeText(projectId: string, generation: string, path: string, text: string): Promise<void> {
    const directory = await this.generationDirectory(projectId, generation);
    if (!directory) throw new Error(`workspace ${projectId} is unavailable`);
    await writeText(directory, encodeKey(path), text);
  }

  async deleteText(projectId: string, generation: string, path: string): Promise<void> {
    const directory = await this.generationDirectory(projectId, generation);
    if (!directory) throw new Error(`workspace ${projectId} is unavailable`);
    await directory.removeEntry(encodeKey(path)).catch(() => {});
  }

  async writeState(projectId: string, generation: string, state: WorkspaceState): Promise<void> {
    const directory = await this.generationDirectory(projectId, generation);
    if (!directory) throw new Error(`workspace ${projectId} is unavailable`);
    await writeText(directory, STATE_FILE, JSON.stringify(state));
  }
}

class MemoryWorkspacePersistence implements WorkspacePersistence {
  readonly persistent = false;
  private projects = new Map<string, LoadedWorkspace>();

  async read(projectId: string): Promise<LoadedWorkspace | null> {
    const loaded = this.projects.get(projectId);
    return loaded ? this.clone(loaded) : null;
  }

  async stage(source: WorkspaceSource): Promise<StagedWorkspace> {
    const loaded: LoadedWorkspace = {
      generation: `memory-${Date.now()}-${crypto.randomUUID()}`,
      state: sourceState(source),
      text: new Map(source.files.map((file) => [file.path, file.text])),
      binary: new Map((source.binaryFiles ?? []).map((file) => [file.path, file.base64])),
    };
    return {
      projectId: source.projectId,
      loaded: this.clone(loaded),
      previousGeneration: this.projects.get(source.projectId)?.generation ?? null,
      previousMemory: await this.read(source.projectId),
    };
  }

  async publish(staged: StagedWorkspace): Promise<void> {
    this.projects.set(staged.projectId, this.clone(staged.loaded));
  }

  async discard(_staged: StagedWorkspace): Promise<void> {
    // A staged in-memory workspace has not entered the project map yet.
  }

  async rollback(staged: StagedWorkspace): Promise<void> {
    if (staged.previousMemory) this.projects.set(staged.projectId, this.clone(staged.previousMemory));
    else this.projects.delete(staged.projectId);
  }

  async complete(_staged: StagedWorkspace): Promise<void> {
    // Publishing replaces the single in-memory entry atomically.
  }

  async writeText(projectId: string, generation: string, path: string, text: string): Promise<void> {
    const loaded = this.require(projectId, generation);
    loaded.text.set(path, text);
  }

  async deleteText(projectId: string, generation: string, path: string): Promise<void> {
    this.require(projectId, generation).text.delete(path);
  }

  async writeState(projectId: string, generation: string, state: WorkspaceState): Promise<void> {
    this.require(projectId, generation).state = { ...state };
  }

  private require(projectId: string, generation: string): LoadedWorkspace {
    const loaded = this.projects.get(projectId);
    if (!loaded || loaded.generation !== generation) throw new Error(`workspace ${projectId} is unavailable`);
    return loaded;
  }

  private clone(loaded: LoadedWorkspace): LoadedWorkspace {
    return {
      generation: loaded.generation,
      state: { ...loaded.state, textPaths: [...loaded.state.textPaths], binaryPaths: [...loaded.state.binaryPaths] },
      text: new Map(loaded.text),
      binary: new Map(loaded.binary),
    };
  }
}

export class WorkspaceRepository {
  private workspaces = new Map<string, Workspace>();
  private installTails = new Map<string, Promise<void>>();

  private constructor(private persistence: WorkspacePersistence) {}

  static async create(): Promise<WorkspaceRepository> {
    const persistence = await OpfsWorkspacePersistence.create() ?? new MemoryWorkspacePersistence();
    return new WorkspaceRepository(persistence);
  }

  get persistent(): boolean {
    return this.persistence.persistent;
  }

  async open(projectId: string): Promise<Workspace | null> {
    const current = this.workspaces.get(projectId);
    if (current) return current;
    const loaded = await this.persistence.read(projectId);
    if (!loaded) return null;
    // Another caller may have completed the same read while persistence yielded.
    // One project generation must have exactly one mutable Workspace owner.
    const raced = this.workspaces.get(projectId);
    if (raced) return raced;
    const workspace = new Workspace(this.persistence, loaded);
    this.workspaces.set(projectId, workspace);
    return workspace;
  }

  async installSource(
    source: WorkspaceSource,
    condition?: WorkspaceInstallCondition,
  ): Promise<WorkspaceInstallResult> {
    // Pointer publication and rollback form one per-project transaction. Without
    // serialization, two first installs can both observe no predecessor and a
    // losing rollback can erase the winner's committed pointer.
    const previous = this.installTails.get(source.projectId) ?? Promise.resolve();
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => turn);
    this.installTails.set(source.projectId, tail);
    await previous;
    try {
      return await this.installSourceNow(source, condition);
    } finally {
      release();
      if (this.installTails.get(source.projectId) === tail) this.installTails.delete(source.projectId);
    }
  }

  private async installSourceNow(
    source: WorkspaceSource,
    condition?: WorkspaceInstallCondition,
  ): Promise<WorkspaceInstallResult> {
    const started = performance.now();
    validateSource(source);
    const staged = await this.persistence.stage(source);
    const canReplace = () => condition === undefined || (
      (this.workspaces.get(source.projectId) ?? null) === condition.replace
      && !condition.replace?.dirty
    );
    if (!canReplace()) {
      await this.persistence.discard(staged);
      return this.retainedResult(source, condition?.replace, started);
    }
    await this.persistence.publish(staged);
    // An edit can run while the OPFS pointer write yields. Restore the exact
    // predecessor instead of allowing the newly downloaded source to win.
    if (!canReplace()) {
      await this.persistence.rollback(staged);
      return this.retainedResult(source, condition?.replace, started);
    }
    // A source replacement creates a new owner. Keeping and mutating the old
    // Workspace object would let a stale downloader's identity condition remain
    // true after a newer generation had already replaced it.
    const workspace = new Workspace(this.persistence, staged.loaded);
    this.workspaces.set(source.projectId, workspace);
    await this.persistence.complete(staged);
    const encoder = new TextEncoder();
    const storedBytes = source.files.reduce(
      (sum, file) => sum + encoder.encode(file.text).byteLength,
      0,
    ) + (source.binaryFiles ?? []).reduce((sum, file) => sum + file.base64.length, 0);
    return {
      workspace,
      installed: true,
      durationMs: performance.now() - started,
      textFiles: source.files.length,
      binaryFiles: source.binaryFiles?.length ?? 0,
      storedBytes,
    };
  }

  private retainedResult(
    source: WorkspaceSource,
    observed: Workspace | null | undefined,
    started: number,
  ): WorkspaceInstallResult {
    const workspace = this.workspaces.get(source.projectId) ?? observed;
    if (!workspace) throw new Error(`workspace ${source.projectId} changed during source installation`);
    return {
      workspace,
      installed: false,
      durationMs: performance.now() - started,
      textFiles: workspace.list().length,
      binaryFiles: workspace.binaryFileCount,
      storedBytes: 0,
    };
  }
}

export class Workspace {
  readonly listeners = new Set<() => void>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private state: WorkspaceState;
  private text: Map<string, string>;
  private binary: Map<string, string>;
  /**
   * The current source node's deterministic per-file projection. This is not a
   * generation cache: there is at most one entry per live text path, and an
   * edit replaces that path's derivation. Captures only assemble immutable
   * records from these exact path/text-owned values.
   */
  private projectedText = new Map<string, WorkspaceTextProjection>();

  constructor(
    private persistence: WorkspacePersistence,
    private loaded: LoadedWorkspace,
  ) {
    this.state = { ...loaded.state, textPaths: [...loaded.state.textPaths], binaryPaths: [...loaded.state.binaryPaths] };
    this.text = new Map(loaded.text);
    this.binary = new Map(loaded.binary);
  }

  get projectId(): string {
    return this.state.projectId;
  }

  get name(): string {
    return this.state.name;
  }

  get sourceIdentity(): string {
    return this.state.sourceIdentity;
  }

  get dirty(): boolean {
    return this.state.dirty;
  }

  get binaryFileCount(): number {
    return this.binary.size;
  }

  list(): string[] {
    return [...this.text.keys()].sort();
  }

  has(path: string): boolean {
    return this.text.has(path);
  }

  read(path: string): string | null {
    return this.text.get(path) ?? null;
  }

  async write(path: string, text: string): Promise<void> {
    const existed = this.text.has(path);
    if (this.text.get(path) !== text) this.projectedText.delete(path);
    this.text.set(path, text);
    this.state.dirty = true;
    this.state.textPaths = [...this.text.keys()].sort();
    const state = this.stateSnapshot();
    const pending = this.persist(async () => {
      if (existed) {
        // Mark an existing workspace dirty before replacing an existing body.
        // A crash can retain the old body, but can never reopen edited bytes as
        // an apparently clean source generation.
        await this.persistence.writeState(this.projectId, this.loaded.generation, state);
        await this.persistence.writeText(this.projectId, this.loaded.generation, path, text);
      } else {
        // A new body's orphan is harmless; publish its state reference last.
        await this.persistence.writeText(this.projectId, this.loaded.generation, path, text);
        await this.persistence.writeState(this.projectId, this.loaded.generation, state);
      }
    });
    this.notify();
    await pending;
  }

  async delete(path: string): Promise<void> {
    if (!this.text.delete(path)) return;
    this.projectedText.delete(path);
    this.state.dirty = true;
    this.state.textPaths = [...this.text.keys()].sort();
    const state = this.stateSnapshot();
    const pending = this.persist(async () => {
      await this.persistence.writeState(this.projectId, this.loaded.generation, state);
      await this.persistence.deleteText(this.projectId, this.loaded.generation, path);
    });
    this.notify();
    await pending;
  }

  async rename(from: string, to: string): Promise<void> {
    const text = this.text.get(from);
    if (text == null || from === to) return;
    this.text.delete(from);
    this.text.set(to, text);
    this.projectedText.delete(from);
    this.projectedText.delete(to);
    this.state.dirty = true;
    this.state.textPaths = [...this.text.keys()].sort();
    const state = this.stateSnapshot();
    const pending = this.persist(async () => {
      await this.persistence.writeText(this.projectId, this.loaded.generation, to, text);
      await this.persistence.writeState(this.projectId, this.loaded.generation, state);
      await this.persistence.deleteText(this.projectId, this.loaded.generation, from);
    });
    this.notify();
    await pending;
  }

  capture(buildEpochSecs: number): WorkspaceCapture {
    const files: Record<string, string> = {};
    const predefined: Record<string, unknown> = {};
    const siteFiles: Record<string, string> = {};
    const predefinedDisplay: ResourceView[] = [];
    for (const [path, text] of this.text) {
      let projected = this.projectedText.get(path);
      if (!projected || projected.sourceText !== text) {
        projected = projectWorkspaceText(path, text);
        this.projectedText.set(path, projected);
      }
      if (projected.fsh) files[path] = text;
      if (projected.predefined) predefined[path] = projected.predefined;
      if (projected.predefinedDisplay) predefinedDisplay.push(projected.predefinedDisplay);
      if (projected.siteFile) siteFiles[path] = projected.siteBase64 ?? '';
    }
    for (const [path, base64] of this.binary) siteFiles[path] = base64;
    predefinedDisplay.sort((left, right) => left.filename.localeCompare(right.filename));
    const revision: ProjectRevision = Object.freeze({
      config: this.text.get('sushi-config.yaml') ?? '',
      fsh: Object.freeze(files),
      predefined: Object.freeze(predefined),
      siteFiles: Object.freeze(siteFiles),
    });
    return { projectId: this.projectId, buildEpochSecs, revision, predefinedDisplay };
  }

  private stateSnapshot(): WorkspaceState {
    return {
      ...this.state,
      textPaths: [...this.state.textPaths],
      binaryPaths: [...this.state.binaryPaths],
    };
  }

  private persist(operation: () => Promise<void>): Promise<void> {
    const pending = this.persistenceTail.then(operation, operation);
    this.persistenceTail = pending.catch(() => {});
    return pending;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
