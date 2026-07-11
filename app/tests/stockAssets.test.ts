import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertRuntimePack,
  injectJqueryPreviewCompatibility,
  JQUERY_PREVIEW_COMPAT,
  materializeMissingTableBackgrounds,
  StockAssetCatalog,
  tableBackgroundDataUri,
  templatePublicPath,
  type PublisherRuntimePack,
} from '../src/adapters/stockAssets';
import { mountTemplateChain } from '../src/worker/templateChain';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACK_PATH = path.resolve(HERE, '../public/data/publisher-runtime/1.0.0.json');
const TEMPLATE_PATH = path.resolve(HERE, '../public/data/templates/hl7.fhir.template/1.0.0.json');

async function readPack(): Promise<PublisherRuntimePack> {
  return Bun.file(PACK_PATH).json() as Promise<PublisherRuntimePack>;
}

function sha256(b64: string): string {
  return createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
}

describe('Publisher runtime pack', () => {
  test('is self-describing and every payload matches its pinned hash', async () => {
    const pack = await readPack();
    expect(() => assertRuntimePack(pack)).not.toThrow();
    expect(pack.id).toBe('hl7-fhir-publisher-runtime#1.0.0');
    expect(Object.keys(pack.assets).length).toBeGreaterThanOrEqual(210);
    for (const [name, asset] of Object.entries(pack.assets)) {
      expect(sha256(asset.b64), name).toBe(asset.sha256);
      expect(pack.sources[asset.source], `${name} provenance`).toBeDefined();
    }
  });

  test('closes the representative stock page and stylesheet references', async () => {
    const pack = await readPack();
    const catalog = new StockAssetCatalog();
    catalog.addRuntimePack(pack);

    const required = [
      'assets/images/usa.svg',
      'tree-filter.png',
      'tbl_spacer.png',
      'tbl_vjoin.png',
      'tbl_vjoin-open.png',
      'tbl_vjoin_end.png',
      'tbl_vjoin_end-open.png',
      'tbl_vjoin_end_slicer.png',
      'tbl_vline.png',
      'tbl_blank.png',
      'icon_resource.png',
      'icon_primitive.png',
      'icon_slice.png',
      'icon_slice_item.png',
      'icon_modifier_extension_simple.png',
      'icon_datatype.gif',
      'icon_choice.gif',
      'icon_element.gif',
      'icon_extension_simple.png',
      'icon_reference.png',
      'external.png',
      'cc0.png',
      'fhir-table-scripts.js',
      'fhir.css',
      'strip.png',
      'watermark.png',
      'OpenSans-CondBold-webfont.eot',
      'OpenSans-CondBold-webfont.svg',
      'OpenSans-CondBold-webfont.ttf',
      'OpenSans-CondBold-webfont.woff',
      'OpenSans-CondLight-webfont.eot',
      'OpenSans-CondLight-webfont.svg',
      'OpenSans-CondLight-webfont.ttf',
      'OpenSans-CondLight-webfont.woff',
      'tbl_bck1.png',
      'tbl_bck10.png',
      'tbl_bck13.png',
      'tbl_bck134.png',
      'tbl_bck124.png',
      'tbl_bck11.png',
      'tbl_bck110.png',
      'tbl_bck100.png',
      'tbl_bck01.png',
      'tbl_bck010.png',
      'tbl_bck000.png',
      'tbl_bck112.png',
      'assets/font/fontawesome-webfont.eot',
      'assets/font/fontawesome-webfont.woff',
      'assets/font/fontawesome-webfont.ttf',
      'assets/images/theme/up.png',
      'assets/css/images/ui-bg_glass_100_f6f6f6_1x400.png',
      'assets/css/images/ui-bg_glass_100_fdf5ce_1x400.png',
      'assets/css/images/ui-bg_glass_65_ffffff_1x400.png',
      'assets/css/images/ui-bg_highlight-soft_75_ffe45c_1x100.png',
      'assets/css/images/ui-bg_diagonals-thick_18_b81900_40x40.png',
      'assets/css/images/ui-icons_222222_256x240.png',
      'assets/css/images/ui-icons_ffffff_256x240.png',
      'assets/css/images/ui-icons_ef8c08_256x240.png',
      'assets/css/images/ui-icons_228ef1_256x240.png',
      'assets/css/images/ui-icons_ffd27a_256x240.png',
      'assets/css/images/ui-bg_diagonals-thick_20_666666_40x40.png',
      'assets/css/images/ui-bg_flat_10_000000_40x100.png',
    ];

    for (const name of required) {
      const resolved = catalog.resolve(`en/${name}?cache=test`, 'en/');
      if (!resolved && /^tbl_bck[0-5]+\.png$/.test(name)) {
        const html = materializeMissingTableBackgrounds(`<td style="background-image:url(${name})">`, catalog);
        expect(html, name).toContain('data:image/svg+xml;base64,');
        expect(html, name).not.toContain(`url(${name})`);
        continue;
      }
      expect(resolved, name).not.toBeNull();
      expect(resolved?.mime, name).not.toBe('application/octet-stream');
      expect(resolved?.base64.length, name).toBeGreaterThan(0);
    }
  });

  test('closes every local URL in the materialized template and FHIR stylesheets', async () => {
    const [pack, template] = await Promise.all([
      readPack(),
      Bun.file(TEMPLATE_PATH).json() as Promise<{ files: Record<string, string | { b64: string }> }>,
    ]);
    const catalog = new StockAssetCatalog();
    catalog.addRuntimePack(pack);
    catalog.addTemplateTree('hl7.fhir.template#1.0.0', template.files);
    const manifest = catalog.manifest();
    const cssFiles = Object.entries(manifest).filter(([name]) => name.endsWith('.css'));
    expect(cssFiles.length).toBeGreaterThanOrEqual(10);

    for (const [cssPath, asset] of cssFiles) {
      const css = Buffer.from(asset.b64, 'base64').toString('utf8');
      for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
        const raw = match[2].trim();
        if (/^(?:data:|https?:|\/\/|#)/i.test(raw)) continue;
        const withoutQuery = raw.replace(/[?#].*$/, '');
        const publicPath = path.posix.normalize(path.posix.join(path.posix.dirname(cssPath), withoutQuery));
        expect(catalog.resolve(`en/${publicPath}`, 'en/'), `${cssPath} -> ${raw}`).not.toBeNull();
      }
    }
  });

  test('table backgrounds are the exact core-package bytes', async () => {
    const pack = await readPack();
    expect(pack.assets['tbl_bck1.png'].sha256).toBe('cb771577e0fcc32410e69b00c781f42ea543bb95c46c6afac3d4744299b441c4');
    expect(pack.assets['tbl_bck1.png'].source).toBe('fhir-r4-core');
    const tableScript = pack.assets['fhir-table-scripts.js'];
    expect(tableScript.sha256).toBe('03c51f09901ea7496c927b48980943a6dbdde08f646a8150011f88ddcea48898');
    expect(tableScript.source).toBe('editor-table-runtime');
    const tableSource = Buffer.from(tableScript.b64, 'base64').toString('utf8');
    expect(tableSource).toContain('childElement.classList.contains(prop)');
    expect(tableSource).not.toContain('classes.includes(prop)');
  });

  test('records the preview jQuery compatibility shim as its own hashed producer', async () => {
    const pack = await readPack();
    const compat = JQUERY_PREVIEW_COMPAT;
    const shim = pack.assets[compat.shim.path];
    expect(shim).toBeDefined();
    expect(shim.source).toBe(compat.producer);
    expect(shim.sourcePath).toBe('generated:preview-jquery-3.7.0-ui-tabs-1.11.1-v1');
    expect(shim.sha256).toBe(compat.shim.sha256);
    expect(pack.sources[shim.source].license).toBe('CC0-1.0');
  });

  test('materializes novel table indent combinations with Publisher line semantics', () => {
    const uri = tableBackgroundDataUri('tbl_bck134.png');
    expect(uri).not.toBeNull();
    const svg = Buffer.from(uri!.split(',')[1], 'base64').toString('utf8');
    // Prior indents 1 and 3 continue regular (black) and slicer (green)
    // lines; final 4 has no child line.
    expect(svg).toContain('x="12" y="0" width="1" height="1" fill="#000000"');
    expect(svg).toContain('x="28" y="0" width="1" height="1" fill="#0ed145"');
    expect(svg).not.toContain('x="44"');
  });
});

describe('stock asset catalog', () => {
  test('maps raw and mounted template trees to the same public paths', () => {
    expect(templatePublicPath('content/assets/css/project.css')).toBe('assets/css/project.css');
    expect(templatePublicPath('template/content/assets/css/project.css')).toBe('assets/css/project.css');
    expect(templatePublicPath('_includes/custom.js')).toBe('custom.js');
    expect(templatePublicPath('template/layouts/layout.html')).toBeNull();
  });

  test('uses explicit producer precedence and removes deleted authored assets', async () => {
    const pack = await readPack();
    const catalog = new StockAssetCatalog();
    catalog.addRuntimePack(pack);
    catalog.addTemplateTree('example#1.0.0', { 'content/external.png': { b64: 'dGVtcGxhdGU=' } });
    catalog.addIgAsset('demo', 'external.png', 'aWc=', 'input/images/external.png');
    expect(catalog.resolve('en/external.png', 'en/')?.base64).toBe('aWc=');
    expect(catalog.provenance()['external.png'].producer).toBe('ig:demo');
    catalog.removeProducer('ig:demo');
    expect(catalog.resolve('external.png', '')?.base64).toBe('dGVtcGxhdGU=');
    expect(catalog.provenance()['external.png'].producer).toBe('template:example#1.0.0');
  });
});

describe('preview jQuery compatibility', () => {
  test('is exact-pair gated, ordered, idempotent, and leaves package bytes untouched', async () => {
    const [pack, template] = await Promise.all([
      readPack(),
      Bun.file(TEMPLATE_PATH).json() as Promise<{ files: Record<string, string | { b64: string }> }>,
    ]);
    const compat = JQUERY_PREVIEW_COMPAT;
    const catalog = new StockAssetCatalog();
    catalog.addRuntimePack(pack);
    catalog.addTemplateTree('hl7.fhir.template#1.0.0', template.files);

    expect(await catalog.selectedSha256(compat.jquery.path)).toBe(compat.jquery.sha256);
    expect(await catalog.selectedSha256(compat.jqueryUi.path)).toBe(compat.jqueryUi.sha256);
    const jqueryBefore = catalog.resolve(compat.jquery.path, '')!.base64;
    const jqueryUiBefore = catalog.resolve(compat.jqueryUi.path, '')!.base64;
    const html =
      '<head><script defer src="./assets/js/jquery.js?v=3.7.0"></script>' +
      '<script src="assets/js/other.js"></script>' +
      '<script src="assets/js/jquery-ui.min.js"></script></head>';
    const injected = await injectJqueryPreviewCompatibility(html, catalog);
    const jqueryEnd = injected.indexOf('</script>') + '</script>'.length;
    const shimAt = injected.indexOf(`data-fhir-ig-editor-preview-compat="${compat.id}"`);
    const uiAt = injected.indexOf('assets/js/jquery-ui.min.js');
    expect(shimAt).toBeGreaterThanOrEqual(jqueryEnd);
    expect(shimAt).toBeLessThan(uiAt);
    expect(injected).toContain(`src="${compat.shim.path}"`);
    expect(await injectJqueryPreviewCompatibility(injected, catalog)).toBe(injected);
    expect(catalog.resolve(compat.jquery.path, '')!.base64).toBe(jqueryBefore);
    expect(catalog.resolve(compat.jqueryUi.path, '')!.base64).toBe(jqueryUiBefore);

    const changed = new StockAssetCatalog();
    changed.addRuntimePack(pack);
    changed.addTemplateTree('hl7.fhir.template#1.0.0', template.files);
    const jquery = template.files['content/assets/js/jquery.js'];
    expect(typeof jquery).toBe('string');
    changed.addTemplateTree('changed.template#1', {
      'content/assets/js/jquery.js': `${jquery as string}\n`,
    });
    expect(await injectJqueryPreviewCompatibility(html, changed)).toBe(html);
    const reversed =
      '<script src="assets/js/jquery-ui.min.js"></script>' +
      '<script src="assets/js/jquery.js"></script>';
    expect(await injectJqueryPreviewCompatibility(reversed, catalog)).toBe(reversed);
  });

  test('restores legacy jqXHR callback methods with their original arguments and context', async () => {
    const pack = await readPack();
    const source = Buffer.from(pack.assets[JQUERY_PREVIEW_COMPAT.shim.path].b64, 'base64').toString('utf8');

    type Callback = (...args: unknown[]) => void;
    function pendingRequest() {
      const done: Callback[] = [];
      const fail: Callback[] = [];
      const always: Callback[] = [];
      const add = (target: Callback[], values: unknown[]) => {
        const visit = (value: unknown): void => {
          if (Array.isArray(value)) value.forEach(visit);
          else if (typeof value === 'function') target.push(value as Callback);
        };
        values.forEach(visit);
      };
      const xhr: Record<string, unknown> = {
        done(...callbacks: unknown[]) { add(done, callbacks); return this; },
        fail(...callbacks: unknown[]) { add(fail, callbacks); return this; },
        always(...callbacks: unknown[]) { add(always, callbacks); return this; },
      };
      return {
        xhr,
        resolve(context: object, data: unknown, status: string) {
          done.forEach((callback) => callback.call(context, data, status, xhr));
          always.forEach((callback) => callback.call(context, data, status, xhr));
        },
        reject(context: object, status: string, error: unknown) {
          fail.forEach((callback) => callback.call(context, xhr, status, error));
          always.forEach((callback) => callback.call(context, xhr, status, error));
        },
      };
    }

    const pending: ReturnType<typeof pendingRequest>[] = [];
    const originalAjax = () => {
      const request = pendingRequest();
      pending.push(request);
      return request.xhr;
    };
    const jquery = { fn: { jquery: '3.7.0' }, ajax: originalAjax } as Record<string, unknown> & {
      ajax: (...args: unknown[]) => Record<string, unknown>;
    };
    new Function('window', source)({ jQuery: jquery });
    expect(jquery.ajax).not.toBe(originalAjax);

    const successContext = { kind: 'success-context' };
    const successCalls: unknown[][] = [];
    const successXhr = jquery.ajax();
    const successReturn = (successXhr.success as (...callbacks: unknown[]) => unknown).call(
      successXhr,
      function (this: unknown, ...args: unknown[]) { successCalls.push(['success', this, ...args]); },
    );
    expect(successReturn).toBe(successXhr);
    (successXhr.complete as (...callbacks: unknown[]) => unknown).call(successXhr, [
      function (this: unknown, ...args: unknown[]) { successCalls.push(['complete', this, ...args]); },
    ]);
    pending[0].resolve(successContext, 'body', 'success');
    expect(successCalls).toEqual([
      ['success', successContext, 'body', 'success', successXhr],
      ['complete', successContext, successXhr, 'success'],
    ]);

    const errorContext = { kind: 'error-context' };
    const errorValue = new Error('network');
    const errorCalls: unknown[][] = [];
    const errorXhr = jquery.ajax();
    (errorXhr.error as (...callbacks: unknown[]) => unknown).call(
      errorXhr,
      function (this: unknown, ...args: unknown[]) { errorCalls.push(['error', this, ...args]); },
    );
    (errorXhr.complete as (...callbacks: unknown[]) => unknown).call(
      errorXhr,
      function (this: unknown, ...args: unknown[]) { errorCalls.push(['complete', this, ...args]); },
    );
    pending[1].reject(errorContext, 'error', errorValue);
    expect(errorCalls).toEqual([
      ['error', errorContext, errorXhr, 'error', errorValue],
      ['complete', errorContext, errorXhr, 'error'],
    ]);

    const otherAjax = () => pendingRequest().xhr;
    const other = { fn: { jquery: '3.7.1' }, ajax: otherAjax };
    new Function('window', source)({ jQuery: other });
    expect(other.ajax).toBe(otherAjax);
  });
});

describe('live template asset export', () => {
  test('uses the fetched chain and applies base-to-leaf precedence', async () => {
    const b64 = (text: string) => Buffer.from(text).toString('base64');
    const packages: Record<string, Record<string, string>> = {
      'leaf.template#1.0.0': {
        'package.json': b64(JSON.stringify({ name: 'leaf.template', base: 'base.template', dependencies: { 'base.template': '1.0.0' } })),
        'content/assets/css/shared.css': b64('leaf'),
        'content/assets/js/leaf.js': b64('leaf-js'),
        'scripts/not-public.js': b64('ignored'),
      },
      'base.template#1.0.0': {
        'package.json': b64(JSON.stringify({ name: 'base.template' })),
        'content/assets/css/shared.css': b64('base'),
        'content/assets/images/base.png': b64('base-png'),
      },
    };
    const mounted: string[] = [];
    const fetched: string[] = [];
    const host = {
      resolveStep: async () => ({}) as never,
      bakedBundle: (label: string) => packages[label]
        ? { label, tgz: label, sha256: '0'.repeat(64), loadPhase: 'on-demand' as const }
        : undefined,
      fetchBaked: async (bundle: { label: string }) => {
        fetched.push(bundle.label);
        return {
          kind: 'raw' as const,
          spec: { label: bundle.label, files: packages[bundle.label] },
          transportIdentity: 'test',
        };
      },
      mount: async (bundles: Array<{ spec: { label: string } }>) => {
        mounted.push(...bundles.map((bundle) => bundle.spec.label));
      },
    };
    const result = await mountTemplateChain(host as never, 'leaf.template#1.0.0', () => {});
    expect(result.chain).toEqual(['leaf.template#1.0.0', 'base.template#1.0.0']);
    expect(fetched).toEqual(result.chain);
    expect(mounted).toEqual(result.chain);
    expect(result.assets['content/assets/css/shared.css'].b64).toBe(b64('leaf'));
    expect(result.assets['content/assets/images/base.png'].b64).toBe(b64('base-png'));
    expect(result.assets['scripts/not-public.js']).toBeUndefined();
  });
});
