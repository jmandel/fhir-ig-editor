// Shared browser-side closure check for a rendered preview page.
//
// The collector is deliberately dependency-free and serializable: CDP harnesses
// can inject `runtimeClosureExpression()` into the editor page after selecting a
// preview iframe.  `assessRuntimeClosure()` then applies the same pass/fail law in
// Node/Bun.  Keeping the law here avoids one-off asset probes that merely print a
// list without gating the build.

export async function collectPreviewRuntimeClosure(expectedPage) {
  const frame = document.querySelector('.preview-frame');
  const win = frame?.contentWindow;
  const doc = frame?.contentDocument || win?.document;
  if (!frame || !win || !doc?.body) {
    return { error: 'preview iframe document is unavailable' };
  }

  const assets = new Map();
  const add = (raw, kind, baseUrl = doc.baseURI) => {
    if (!raw || /^(?:data|blob|javascript):|^#/.test(raw)) return;
    let url;
    try {
      url = new URL(raw, baseUrl).href;
    } catch {
      return;
    }
    if (new URL(url).origin !== location.origin) return;
    if (!assets.has(url)) assets.set(url, new Set());
    assets.get(url).add(kind);
  };
  const addSrcset = (raw, kind) => {
    for (const entry of String(raw || '').split(',')) {
      add(entry.trim().split(/\s+/)[0], kind);
    }
  };
  const addCssUrls = (css, kind, baseUrl) => {
    const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    for (const match of String(css || '').matchAll(pattern)) add(match[2], kind, baseUrl);
  };

  for (const img of doc.querySelectorAll('img[src]')) add(img.getAttribute('src'), 'img');
  for (const img of doc.querySelectorAll('img[srcset]')) addSrcset(img.getAttribute('srcset'), 'img-srcset');
  for (const source of doc.querySelectorAll('source[src]')) add(source.getAttribute('src'), 'source');
  for (const source of doc.querySelectorAll('source[srcset]')) addSrcset(source.getAttribute('srcset'), 'source-srcset');
  for (const input of doc.querySelectorAll('input[type="image"][src]')) add(input.getAttribute('src'), 'input-image');
  for (const video of doc.querySelectorAll('video[poster]')) add(video.getAttribute('poster'), 'video-poster');
  for (const script of doc.querySelectorAll('script[src]')) add(script.getAttribute('src'), 'script');
  for (const link of doc.querySelectorAll('link[href]')) {
    const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (rel.some((value) => ['stylesheet', 'icon', 'preload', 'modulepreload'].includes(value))) {
      add(link.getAttribute('href'), `link-${rel.join('-')}`);
    }
  }
  for (const element of doc.querySelectorAll('[style]')) {
    addCssUrls(element.getAttribute('style'), 'inline-css', doc.baseURI);
  }
  for (const style of doc.querySelectorAll('style')) {
    addCssUrls(style.textContent, 'style-tag', doc.baseURI);
  }
  for (const sheet of [...doc.styleSheets]) {
    try {
      for (const rule of [...sheet.cssRules]) {
        addCssUrls(rule.cssText, 'stylesheet-css', sheet.href || doc.baseURI);
      }
    } catch {
      // A cross-origin sheet can be opaque. Its URL is intentionally excluded
      // from this same-origin closure; its own <link> is skipped by add().
    }
  }

  const rows = await Promise.all([...assets].map(async ([url, kinds]) => {
    try {
      // Fetch from the controlled preview client. The editor shell is outside
      // the Service Worker's scope and would give a misleading result.
      const response = await win.fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      const bytes = await response.arrayBuffer();
      const contentType = response.headers.get('content-type') || '';
      const typedAsset = /\.(?:gif|png|jpe?g|svg|webp|ico|css|js|mjs|woff2?|ttf|eot)(?:[?#]|$)/i.test(url);
      return {
        url,
        kinds: [...kinds],
        status: response.status,
        contentType,
        length: bytes.byteLength,
        source: response.headers.get('x-igpreview-source') || '',
        bad: !response.ok || bytes.byteLength === 0 || (typedAsset && /text\/html/i.test(contentType)),
      };
    } catch (error) {
      return {
        url,
        kinds: [...kinds],
        status: 0,
        contentType: '',
        length: 0,
        source: '',
        bad: true,
        error: String(error),
      };
    }
  }));

  const images = [...doc.querySelectorAll('img[src], input[type="image"][src]')];
  const brokenImages = images.filter((image) => !image.complete || image.naturalWidth === 0);
  const badAssets = rows.filter((row) => row.bad);
  const jqueryCompatScript = doc.querySelector(
    'script[data-fhir-ig-editor-preview-compat="jquery-3.7.0-ui-tabs-1.11.1"]' +
    '[data-producer="publisher-runtime"]',
  );
  const scripts = [...doc.querySelectorAll('script[src]')];
  const jqueryIndex = scripts.findIndex((script) => new URL(script.getAttribute('src'), doc.baseURI).pathname.endsWith('/assets/js/jquery.js'));
  const jqueryCompatIndex = scripts.indexOf(jqueryCompatScript);
  const jqueryUiIndex = scripts.findIndex((script) => new URL(script.getAttribute('src'), doc.baseURI).pathname.endsWith('/assets/js/jquery-ui.min.js'));
  return {
    page: {
      expected: expectedPage,
      pathname: win.location.pathname,
      htmlLength: doc.documentElement.outerHTML.length,
      textLength: doc.body.innerText.length,
    },
    globals: {
      filterDesc: typeof win.filterDesc,
      fhirTableInit: typeof win.fhirTableInit,
    },
    compatibility: {
      jqueryPreviewMarker: !!jqueryCompatScript,
      jqueryPreviewScriptPath: jqueryCompatScript
        ? new URL(jqueryCompatScript.getAttribute('src'), doc.baseURI).pathname
        : '',
      jqueryPreviewScriptOrder:
        jqueryIndex >= 0 && jqueryIndex < jqueryCompatIndex && jqueryCompatIndex < jqueryUiIndex,
      jqueryAjaxShimActive: !!win.jQuery?.ajax?.__fhirIgEditorLegacyJqxhrCompat,
    },
    images: {
      elements: images.length,
      loaded: images.filter((image) => image.naturalWidth > 0).length,
      broken: brokenImages.length,
      brokenSamples: brokenImages.slice(0, 30).map((image) => image.src),
    },
    assets: {
      referenced: rows.length,
      ok: rows.length - badAssets.length,
      bad: badAssets.length,
      badSamples: badAssets.slice(0, 50),
    },
  };
}

export function runtimeClosureExpression(expectedPage) {
  return `(${collectPreviewRuntimeClosure.toString()})(${JSON.stringify(expectedPage)})`;
}

export function assessRuntimeClosure(closure, exceptions = []) {
  const failures = [];
  const unexpectedExceptions = [];

  for (const exception of exceptions) {
    const description = typeof exception === 'string'
      ? exception
      : String(exception?.description || exception?.text || exception || '');
    unexpectedExceptions.push(description);
  }

  if (!closure || closure.error) failures.push(closure?.error || 'runtime closure result is missing');
  if (closure?.page?.expected && !closure?.page?.pathname?.endsWith(`/${closure.page.expected}`)) {
    failures.push(`runtime closure inspected ${closure.page.pathname}, expected ${closure.page.expected}`);
  }
  if (!(closure?.assets?.referenced > 0)) failures.push('rendered page declared no runtime assets');
  if (!(closure?.images?.elements > 0)) failures.push('rendered page contained no image elements to validate');
  if (closure?.assets?.bad > 0) failures.push(`${closure.assets.bad} runtime asset(s) failed closure`);
  if (closure?.images?.broken > 0) failures.push(`${closure.images.broken} rendered image element(s) failed to decode`);
  if (closure?.globals?.filterDesc !== 'function') failures.push('filterDesc is not available in the rendered page');
  if (closure?.globals?.fhirTableInit !== 'function') failures.push('fhirTableInit is not available in the rendered page');
  if (!closure?.compatibility?.jqueryPreviewMarker) failures.push('jQuery preview compatibility marker is absent');
  if (!closure?.compatibility?.jqueryPreviewScriptPath?.endsWith('/_fhir-ig-editor/compat/jquery-3.7.0-ui-tabs-1.11.1.js')) {
    failures.push(`unexpected jQuery preview compatibility path: ${closure?.compatibility?.jqueryPreviewScriptPath || '(absent)'}`);
  }
  if (!closure?.compatibility?.jqueryPreviewScriptOrder) failures.push('jQuery preview compatibility script is not between jQuery and jQuery UI');
  if (!closure?.compatibility?.jqueryAjaxShimActive) failures.push('jQuery preview compatibility shim did not execute');
  if (unexpectedExceptions.length) failures.push(`${unexpectedExceptions.length} uncaught browser exception(s)`);

  return { failures, unexpectedExceptions };
}
