import type { SiteTreeFile } from '../worker/protocol';

const STATIC_ASSET_RE = /\.(?:css|js|png|svg|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot)$/i;
const RUNTIME_PACK_PATH = 'data/publisher-runtime/1.0.0.json';

export interface PublisherRuntimeSource {
  package: string;
  license: string;
  url: string;
  role: string;
}

export interface PublisherRuntimeAsset {
  mime: string;
  b64: string;
  sha256: string;
  source: string;
  sourcePath: string;
}

export interface PublisherRuntimePack {
  schemaVersion: 1;
  id: string;
  generatedBy: string;
  sources: Record<string, PublisherRuntimeSource>;
  assets: Record<string, PublisherRuntimeAsset>;
}

export interface StockAssetProvenance {
  producer: string;
  package: string;
  license: string;
  sourcePath: string;
  sha256?: string;
}

interface StockAssetEntry {
  mime: string;
  b64: string;
  priority: number;
  provenance: StockAssetProvenance;
  sha256Promise?: Promise<string | null>;
}

export const JQUERY_PREVIEW_COMPAT = {
  id: 'jquery-3.7.0-ui-tabs-1.11.1',
  producer: 'editor-jquery-compat',
  jquery: {
    path: 'assets/js/jquery.js',
    sha256: 'd8f9afbf492e4c139e9d2bcb9ba6ef7c14921eb509fb703bc7a3f911b774eff8',
  },
  jqueryUi: {
    path: 'assets/js/jquery-ui.min.js',
    sha256: '4dd865e0f9932d4c8e31ad8c04f1271116dad7462455e4fb3fea8c46ebdd7075',
  },
  shim: {
    path: '_fhir-ig-editor/compat/jquery-3.7.0-ui-tabs-1.11.1.js',
    sha256: '5ff89b5b73dd144e3bed959ab75251275127e501a290c4db7f1070c82d7b8f53',
  },
} as const;

function mimeFor(name: string): string {
  const clean = name.replace(/[?#].*$/, '');
  const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      css: 'text/css',
      js: 'text/javascript',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      eot: 'application/vnd.ms-fontobject',
    }[ext] ?? 'application/octet-stream'
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function siteTreeFileToBase64(file: SiteTreeFile): string {
  return typeof file === 'string' ? bytesToBase64(new TextEncoder().encode(file)) : file.b64;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Base64(b64: string): Promise<string | null> {
  if (!globalThis.crypto?.subtle) return null;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', base64ToBytes(b64)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A deterministic public-path catalog with explicit producer precedence.
 *
 * Publisher runtime < template < authored IG files. Conflicts are resolved by
 * priority, never by an accidental basename match. The provenance ledger is
 * retained even though the Service Worker wire format only needs mime + bytes.
 */
export class StockAssetCatalog {
  private readonly entries = new Map<string, Map<string, StockAssetEntry>>();

  add(
    publicPath: string,
    file: SiteTreeFile | { mime: string; b64: string },
    provenance: StockAssetProvenance,
    priority: number,
  ): void {
    const key = normalizePublicPath(publicPath);
    if (!key) throw new Error(`asset producer ${provenance.producer} emitted an empty path`);
    const packed = typeof file === 'object' && 'mime' in file;
    const layers = this.entries.get(key) ?? new Map<string, StockAssetEntry>();
    let mime: string;
    let b64: string;
    if (packed) {
      mime = file.mime;
      b64 = file.b64;
    } else {
      mime = mimeFor(key);
      b64 = siteTreeFileToBase64(file);
    }
    layers.set(provenance.producer, {
      mime,
      b64,
      priority,
      provenance,
    });
    this.entries.set(key, layers);
  }

  addRuntimePack(pack: PublisherRuntimePack): void {
    assertRuntimePack(pack);
    for (const [publicPath, asset] of Object.entries(pack.assets)) {
      const source = pack.sources[asset.source];
      this.add(
        publicPath,
        { mime: asset.mime, b64: asset.b64 },
        {
          producer: `publisher-runtime:${pack.id}`,
          package: source.package,
          license: source.license,
          sourcePath: asset.sourcePath,
          sha256: asset.sha256,
        },
        10,
      );
    }
  }

  addTemplateTree(coord: string, tree: Record<string, SiteTreeFile>): number {
    let added = 0;
    for (const [treePath, file] of Object.entries(tree)) {
      const publicPath = templatePublicPath(treePath);
      if (!publicPath) continue;
      this.add(
        publicPath,
        file,
        {
          producer: `template:${coord}`,
          package: coord,
          license: 'package-declared',
          sourcePath: treePath,
        },
        20,
      );
      added += 1;
    }
    return added;
  }

  addIgAsset(projectId: string, publicPath: string, b64: string, sourcePath: string): void {
    this.add(
      publicPath,
      { b64 },
      {
        producer: `ig:${projectId}`,
        package: projectId,
        license: 'project-declared',
        sourcePath,
      },
      30,
    );
  }

  removeProducer(producer: string): void {
    for (const [path, layers] of this.entries) {
      layers.delete(producer);
      if (layers.size === 0) this.entries.delete(path);
    }
  }

  resolve(name: string, pagePrefix: string): { name: string; mime: string; base64: string } | null {
    let key = normalizePublicPath(name);
    const prefix = normalizePublicPath(pagePrefix);
    if (prefix && key.startsWith(`${prefix}/`)) key = key.slice(prefix.length + 1);
    const entry = this.selected(key);
    if (!entry) return null;
    return { name, mime: entry.mime, base64: entry.b64 };
  }

  has(publicPath: string): boolean {
    return this.selected(normalizePublicPath(publicPath)) != null;
  }

  manifest(): Record<string, { mime: string; b64: string }> {
    const assets: Record<string, { mime: string; b64: string }> = {};
    for (const key of [...this.entries.keys()].sort()) {
      const entry = this.selected(key)!;
      assets[key] = { mime: entry.mime, b64: entry.b64 };
    }
    return assets;
  }

  provenance(): Record<string, StockAssetProvenance> {
    const out: Record<string, StockAssetProvenance> = {};
    for (const key of [...this.entries.keys()].sort()) out[key] = this.selected(key)!.provenance;
    return out;
  }

  /** Hash the actually selected bytes (not a manifest claim), once per layer.
   * Compatibility transforms fail closed when Web Crypto is unavailable. */
  async selectedSha256(publicPath: string): Promise<string | null> {
    const entry = this.selected(normalizePublicPath(publicPath));
    if (!entry) return null;
    entry.sha256Promise ??= sha256Base64(entry.b64);
    return entry.sha256Promise;
  }

  private selected(path: string): StockAssetEntry | null {
    const layers = this.entries.get(path);
    if (!layers) return null;
    let winner: StockAssetEntry | null = null;
    for (const entry of layers.values()) {
      if (!winner || entry.priority >= winner.priority) winner = entry;
    }
    return winner;
  }
}

const TABLE_LINE_COLORS = ['#000000', '#0ed145', '#d4a815'] as const;

/** Browser-equivalent of HierarchicalTableGenerator.genImage for a background
 * name that was discovered only while rendering. Fixed core-package PNGs stay
 * byte-exact; a name absent from that finite package set becomes an inline 800x2
 * SVG with the same one-pixel, every-other-row tree lines. Because it is inline,
 * the SW's already-sealed static manifest remains complete for arbitrary table
 * depths and indent combinations. */
export function tableBackgroundDataUri(name: string): string | null {
  const match = /^tbl_bck([0-5]+)\.png$/.exec(name);
  if (!match) return null;
  const digits = [...match[1]].map(Number);
  const current = digits.pop()!;
  const rects: string[] = [];
  digits.forEach((indent, index) => {
    if (indent % 2 === 1) {
      rects.push(`<rect x="${12 + index * 16}" y="0" width="1" height="1" fill="${TABLE_LINE_COLORS[Math.floor(indent / 2)]}"/>`);
    }
  });
  if (current % 2 === 1) {
    rects.push(`<rect x="${12 + digits.length * 16}" y="0" width="1" height="1" fill="${TABLE_LINE_COLORS[Math.floor(current / 2)]}"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="2" viewBox="0 0 800 2" shape-rendering="crispEdges">${rects.join('')}</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export function materializeMissingTableBackgrounds(html: string, catalog: StockAssetCatalog): string {
  return html.replace(
    /url\(\s*(['"]?)(?:[^)'"\s]*\/)?(tbl_bck[0-5]+\.png)\1\s*\)/g,
    (whole, _quote: string, name: string) => {
      if (catalog.has(name)) return whole;
      const dataUri = tableBackgroundDataUri(name);
      return dataUri ? `url("${dataUri}")` : whole;
    },
  );
}

interface ScriptTag {
  start: number;
  end: number;
  src: string;
}

function externalScriptTags(html: string): ScriptTag[] {
  const tags: ScriptTag[] = [];
  const script = /<script\b[^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*>\s*<\/script\s*>/gi;
  for (const match of html.matchAll(script)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[0]);
    if (!src || match.index == null) continue;
    tags.push({ start: match.index, end: match.index + match[0].length, src: src[1] ?? src[2] ?? src[3] });
  }
  return tags;
}

function scriptLoadsPath(src: string, expected: string): boolean {
  let path = src.trim().replace(/[?#].*$/, '').replace(/\\/g, '/');
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return false;
  path = path.replace(/^\/+/, '');
  while (path.startsWith('../')) path = path.slice(3);
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/');
  return path === expected || path.endsWith(`/${expected}`);
}

/** Preview-only compatibility handoff for one byte-exact package pairing.
 *
 * Both vendored assets remain untouched. When (and only when) the catalog's
 * selected bytes match the pinned hashes and the HTML loads them in the right
 * order, insert the separately provisioned shim immediately after jquery.js.
 * A unique data marker makes the transform idempotent and auditable. */
export async function injectJqueryPreviewCompatibility(
  html: string,
  catalog: StockAssetCatalog,
): Promise<string> {
  const compat = JQUERY_PREVIEW_COMPAT;
  if (html.includes(`data-fhir-ig-editor-preview-compat="${compat.id}"`)) return html;

  const [jqueryHash, jqueryUiHash, shimHash] = await Promise.all([
    catalog.selectedSha256(compat.jquery.path),
    catalog.selectedSha256(compat.jqueryUi.path),
    catalog.selectedSha256(compat.shim.path),
  ]);
  if (
    jqueryHash !== compat.jquery.sha256 ||
    jqueryUiHash !== compat.jqueryUi.sha256 ||
    shimHash !== compat.shim.sha256
  ) {
    return html;
  }

  const tags = externalScriptTags(html);
  const jquery = tags.find((tag) => scriptLoadsPath(tag.src, compat.jquery.path));
  if (!jquery) return html;
  const jqueryUi = tags.find(
    (tag) => tag.start >= jquery.end && scriptLoadsPath(tag.src, compat.jqueryUi.path),
  );
  if (!jqueryUi) return html;

  const shim =
    `\n<script src="${compat.shim.path}" ` +
    `data-fhir-ig-editor-preview-compat="${compat.id}" ` +
    `data-producer="${compat.producer}"></script>`;
  return html.slice(0, jquery.end) + shim + html.slice(jquery.end);
}

export function normalizePublicPath(name: string): string {
  let value = name.replace(/[?#].*$/, '').replace(/\\/g, '/').replace(/^\/+/, '');
  while (value.startsWith('../')) value = value.slice(3);
  value = value.replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
  return value;
}

/** Accept both mountSite-mapped warm trees and raw template artifact trees. */
export function templatePublicPath(treePath: string): string | null {
  const path = normalizePublicPath(treePath);
  let rel: string | null = null;
  if (path.startsWith('template/content/')) rel = path.slice('template/content/'.length);
  else if (path.startsWith('content/')) rel = path.slice('content/'.length);
  else if (path.startsWith('template/assets/')) rel = `assets/${path.slice('template/assets/'.length)}`;
  else if (path.startsWith('assets/')) rel = path;
  else if (path.startsWith('_includes/')) rel = path.slice('_includes/'.length);
  else if (path.startsWith('includes/')) rel = path.slice('includes/'.length);
  return rel && STATIC_ASSET_RE.test(rel) ? rel : null;
}

export function assertRuntimePack(pack: PublisherRuntimePack): void {
  if (pack.schemaVersion !== 1 || !pack.id || !pack.assets || !pack.sources) {
    throw new Error('invalid Publisher runtime asset pack (expected schemaVersion 1)');
  }
  for (const [path, asset] of Object.entries(pack.assets)) {
    if (normalizePublicPath(path) !== path) throw new Error(`runtime asset path is not canonical: ${path}`);
    if (!pack.sources[asset.source]) throw new Error(`${path}: unknown provenance source ${asset.source}`);
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error(`${path}: invalid sha256`);
    if (!asset.mime || !asset.b64 || !asset.sourcePath) throw new Error(`${path}: incomplete runtime asset`);
  }
}

let runtimePackPromise: Promise<PublisherRuntimePack> | null = null;

export async function loadPublisherRuntimePack(): Promise<PublisherRuntimePack> {
  if (!runtimePackPromise) {
    const base = import.meta.env.BASE_URL || '/';
    runtimePackPromise = fetch(`${base}${RUNTIME_PACK_PATH}`).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Publisher runtime pack unavailable (${response.status} ${response.statusText})`);
      }
      const pack = (await response.json()) as PublisherRuntimePack;
      assertRuntimePack(pack);
      return pack;
    });
  }
  return runtimePackPromise;
}

/** Fetch the committed materialized template solely as an asset export. This
 * keeps the forced-live engine path visually identical when a warm artifact is
 * available, without changing which template tree the renderer itself uses. */
export async function fetchTemplateAssetArtifact(coord: string): Promise<Record<string, SiteTreeFile> | null> {
  const split = coord.lastIndexOf('#');
  const id = split >= 0 ? coord.slice(0, split) : coord;
  const version = split >= 0 ? coord.slice(split + 1) : '1.0.0';
  const base = import.meta.env.BASE_URL || '/';
  const url = `${base}data/templates/${encodeURIComponent(id)}/${encodeURIComponent(version)}.json`;
  try {
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const document = (await response.json()) as { files?: Record<string, SiteTreeFile> };
    if (!document.files) throw new Error('artifact has no files map');
    return document.files;
  } catch (error) {
    console.warn(`template asset export unavailable for ${coord}: ${error}`);
    return null;
  }
}
