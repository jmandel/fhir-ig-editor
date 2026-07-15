/**
 * Lazily loaded Cycle renderer capability.
 *
 * Publisher builds never import this module. Keeping every executable
 * `@cycle/*` dependency behind this boundary lets the compiler Worker start,
 * load WASM, and prepare Publisher guides without parsing the external-builder
 * renderer graph. The public site API remains the same four operations; this
 * is only the Worker's private runtime implementation for `generator=cycle`.
 */
declare const __CYCLE_RENDER_RECIPE__: string;

import { ClosedBuildHandle } from '@cycle/core/closed-build';
import { openCycleGenerator } from '@cycle/core/open-site-build';
import type { CycleGenerator, CycleGeneratorOutput } from '@cycle/core/open-site-build';
import {
  CycleRendererPackage,
  type CycleRendererPackageManifest,
} from '@cycle/core/renderer-package';
import {
  CYCLE_OUTPUT_SCHEMA,
  CYCLE_RENDERER_IDENTITY,
  rendererOutputDeclaration,
} from '@cycle/core/output-receipt';
import type {
  ClosedSiteBuild,
  ContentRef,
  OutputCatalog,
  OutputDescriptor,
} from '../site/contract.generated';
import { assertClosedNonPageCatalog } from '../site/catalog';
import { contentStore } from '../storage/contentStore';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

/** Narrow host capability used by the external renderer. */
export interface CycleRuntimeSession {
  readContent(handle: string, sha256: string): Uint8Array;
  openRenderer(
    handle: string,
    rendererJson: string,
    outputSchema: string,
    optionsJson: string,
    pathsJson: string,
  ): void;
  admitOutput(handle: string, fileJson: string, bytes: Uint8Array): void;
  finalize(handle: string): string;
}

/** Opaque runtime retained by the worker's ordinary two-generation registry. */
export interface CycleBuildRuntime {
  readonly kind: 'cycle';
  readonly buildId: string;
  outputs(): OutputCatalog;
  render(path: string): Promise<ContentRef>;
  finalizeEnvelope(): Promise<string>;
}

interface LoadedCycleRendererPackage {
  package: CycleRendererPackage;
  manifest: CycleRendererPackageManifest;
  contentByPath: ReadonlyMap<string, ContentRef>;
}

let cycleRendererPackagePromise: Promise<LoadedCycleRendererPackage> | null = null;

function sameContentRef(left: ContentRef, right: ContentRef): boolean {
  return left.sha256 === right.sha256
    && left.byteLength === right.byteLength
    && left.mediaType === right.mediaType;
}

async function storeExactContent(bytes: Uint8Array, expected: ContentRef): Promise<void> {
  const stored = await contentStore.put(bytes, expected.mediaType);
  if (!stored || !sameContentRef(stored, expected)) {
    throw new Error(`ContentStore rejected ${expected.sha256}`);
  }
}

async function loadCycleRendererPackage(): Promise<LoadedCycleRendererPackage> {
  if (cycleRendererPackagePromise) return cycleRendererPackagePromise;
  const pending = (async () => {
    const root = `${BASE}data/cycle/renderer-package/`;
    const response = await fetch(`${root}manifest.json`);
    if (!response.ok) throw new Error(`Cycle renderer package manifest -> ${response.status}`);
    const manifest = await response.json() as CycleRendererPackageManifest;
    const memory = new Map<string, Uint8Array>();
    const unique = new Map(manifest.files.map((file) => [file.content.sha256, file.content]));
    await Promise.all([...unique.values()].map(async (content) => {
      const cached = await contentStore.get(content);
      if (cached) return;
      const bodyResponse = await fetch(`${root}objects/${content.sha256}`);
      if (!bodyResponse.ok) {
        throw new Error(`Cycle renderer package object ${content.sha256} -> ${bodyResponse.status}`);
      }
      const bytes = new Uint8Array(await bodyResponse.arrayBuffer());
      memory.set(content.sha256, bytes);
      await storeExactContent(bytes, content);
    }));
    const packageValue = await CycleRendererPackage.open(manifest, {
      get: async (content) => {
        const stored = await contentStore.get(content);
        return stored ? new Uint8Array(stored) : memory.get(content.sha256) ?? null;
      },
    });
    return {
      package: packageValue,
      manifest,
      contentByPath: new Map(manifest.files.map((file) => [file.path, file.content])),
    };
  })();
  cycleRendererPackagePromise = pending;
  try {
    return await pending;
  } catch (error) {
    if (cycleRendererPackagePromise === pending) cycleRendererPackagePromise = null;
    throw error;
  }
}

function publicCycleDescriptor(
  output: CycleGeneratorOutput,
  packaged?: ContentRef,
): OutputDescriptor {
  return {
    path: output.file,
    kind: output.kind,
    mediaType: output.mime,
    ...(packaged ? { content: packaged } : {}),
    ...(output.title ? { title: output.title } : {}),
    ...(output.pageKind ? { pageKind: output.pageKind } : {}),
    ...(output.subject ? {
      subject: { ...output.subject },
      subjectPage: output.subjectPage,
    } : {}),
  };
}

export async function openCycleBuildRuntime(
  session: CycleRuntimeSession,
  buildId: string,
  siteBuild: ClosedSiteBuild,
): Promise<CycleBuildRuntime> {
  const rendererPackage = await loadCycleRendererPackage();
  const closed = await ClosedBuildHandle.open(siteBuild, {
    get: async (content) => {
      const bytes = session.readContent(buildId, content.sha256);
      await storeExactContent(bytes, content);
      return bytes;
    },
  });
  const generator: CycleGenerator = await openCycleGenerator(closed, rendererPackage.package, {
    get: async (content) => {
      const bytes = await contentStore.get(content);
      return bytes ? new Uint8Array(bytes) : null;
    },
    put: async (bytes, mediaType) => {
      const content = await contentStore.put(bytes, mediaType);
      if (!content) throw new Error('Cycle output ContentStore is unavailable');
      if (!content.mediaType) throw new Error('Cycle output ContentStore omitted media type');
      return { ...content, mediaType: content.mediaType };
    },
  });
  const catalog = generator.outputs();
  const publicCatalog: OutputCatalog = {
    buildId,
    outputs: catalog.map((output) => publicCycleDescriptor(
      output,
      rendererPackage.contentByPath.get(output.file),
    )),
  };
  const rendered = new Map<string, ContentRef>();

  session.openRenderer(
    buildId,
    JSON.stringify({ ...CYCLE_RENDERER_IDENTITY, recipeSha256: __CYCLE_RENDER_RECIPE__ }),
    CYCLE_OUTPUT_SCHEMA,
    JSON.stringify({ rendererPackageId: rendererPackage.manifest.packageId }),
    JSON.stringify(catalog.map((output) => output.file)),
  );

  const render = async (path: string): Promise<ContentRef> => {
    const prior = rendered.get(path);
    if (prior) return prior;
    const descriptor = publicCatalog.outputs.find((output) => output.path === path);
    const rendererDescriptor = catalog.find((output) => output.file === path);
    if (!descriptor) throw new Error(`render: path ${path} is not declared by outputs`);
    if (!rendererDescriptor) throw new Error(`render: Cycle renderer omitted ${path}`);
    if (descriptor.content) {
      const stored = await contentStore.get(descriptor.content);
      if (!stored) throw new Error(`ContentStore is missing Cycle output ${path}`);
      const { mediaType: _mediaType, ...file } = rendererOutputDeclaration(rendererDescriptor);
      session.admitOutput(
        buildId,
        JSON.stringify({ ...file, content: descriptor.content }),
        new Uint8Array(stored),
      );
      rendered.set(path, descriptor.content);
      return descriptor.content;
    }
    const content = await generator.render(path);
    const stored = await contentStore.get(content);
    if (!stored) throw new Error(`ContentStore is missing Cycle output ${path}`);
    const { mediaType: _mediaType, ...file } = rendererOutputDeclaration(rendererDescriptor);
    session.admitOutput(
      buildId,
      JSON.stringify({ ...file, content }),
      new Uint8Array(stored),
    );
    rendered.set(path, content);
    descriptor.content = content;
    return content;
  };

  const runtime: CycleBuildRuntime = {
    kind: 'cycle',
    buildId,
    outputs: () => publicCatalog,
    render,
    finalizeEnvelope: async () => {
      for (const descriptor of catalog) {
        const content = await render(descriptor.file);
        if (!content.mediaType) {
          throw new Error(`Cycle renderer emitted ${descriptor.file} without a media type`);
        }
      }
      return session.finalize(buildId);
    },
  };

  // Preview assets are a closed catalog, never a live mutable-adapter query.
  // Materialize every non-page before publication; pages alone stay lazy.
  for (const output of catalog) {
    if (output.kind !== 'page') await runtime.render(output.file);
  }
  assertClosedNonPageCatalog(publicCatalog);
  return runtime;
}
