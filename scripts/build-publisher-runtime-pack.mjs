#!/usr/bin/env node
// Build the fixed, versioned browser runtime that the Java IG Publisher copies
// beside generated HTML. This is deliberately separate from template assets:
// these files are referenced by Publisher-generated fragments even though they
// are not members of the selected template package.

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CACHE = path.resolve(process.env.FHIR_CACHE || path.join(REPO, '..', '.fhir-cache'));
const OUT = path.join(REPO, 'app/public/data/publisher-runtime/1.0.0.json');

const sources = {
  'fhir-r4-core': {
    package: 'hl7.fhir.r4.core#4.0.1',
    license: 'CC0-1.0',
    url: 'https://packages.fhir.org/hl7.fhir.r4.core/4.0.1',
    role: 'FHIR CSS, tree icons, joins, and exact Publisher table backgrounds',
  },
  'fhir-r5-core': {
    package: 'hl7.fhir.r5.core#5.0.0',
    license: 'CC0-1.0',
    url: 'https://packages.fhir.org/hl7.fhir.r5.core/5.0.0',
    role: 'active-table open-state joins absent from the R4 core package',
  },
  'editor-table-runtime': {
    package: 'fhir.base.template#1.0.0 table runtime + fhir-ig-editor compatibility patch',
    license: 'CC0-1.0',
    url: 'scripts/build-publisher-runtime-pack.mjs',
    role: 'null-safe class filtering for Publisher table cells without a class attribute',
  },
  'editor-jquery-compat': {
    package: 'fhir-ig-editor preview compatibility#1',
    license: 'CC0-1.0',
    url: 'scripts/build-publisher-runtime-pack.mjs',
    role: 'exact-pair jqXHR compatibility for the vendored jQuery 3.7.0 and jQuery UI Tabs 1.11.1',
  },
  'jquery-ui': {
    package: 'jQuery UI#1.11.1 ui-lightness theme',
    license: 'MIT',
    url: 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/',
    role: 'images referenced by the template\'s vendored jQuery UI 1.11.1 CSS',
  },
  'font-awesome': {
    package: 'Font Awesome#3.0.1 fonts',
    license: 'OFL-1.1',
    url: 'https://github.com/FortAwesome/Font-Awesome/tree/v3.0.1/font',
    role: 'fonts referenced by bootstrap-fhir.css',
  },
  'open-sans-condensed': {
    package: 'Open Sans Condensed fonts vendored by fhir.base.template#1.0.0',
    license: 'Apache-2.0',
    url: 'https://fonts.google.com/specimen/Open+Sans+Condensed',
    role: 'root-relative fonts referenced by the Publisher fhir.css',
  },
  'us-core-output': {
    package: 'hl7.fhir.us.core#9.0.0 published output',
    license: 'CC0-1.0',
    url: 'https://hl7.org/fhir/us/core/',
    role: 'Publisher-emitted filter control and US jurisdiction flag',
  },
  'editor-generated': {
    package: 'fhir-ig-editor publisher-runtime#1.0.0',
    license: 'CC0-1.0',
    url: 'scripts/build-publisher-runtime-pack.mjs',
    role: 'deterministic replacement for an upstream CSS reference whose file is absent',
  },
};

const remote = {
  'assets/css/images/ui-bg_diagonals-thick_18_b81900_40x40.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_diagonals-thick_18_b81900_40x40.png', 'ee95ffb44269f431984280b60e7fddc36ff937a01b56ab79a937f5aa85a42f41'],
  'assets/css/images/ui-bg_diagonals-thick_20_666666_40x40.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_diagonals-thick_20_666666_40x40.png', 'f89320f0d91486c034fff738ae531231d7e8afc4543ad76e2d22349ffbeffe57'],
  'assets/css/images/ui-bg_flat_10_000000_40x100.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_flat_10_000000_40x100.png', 'ec97fb7f9b5eedfdc043385975cb5e8fe9a255735c00f28672215c753bbebae4'],
  'assets/css/images/ui-bg_glass_100_f6f6f6_1x400.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_glass_100_f6f6f6_1x400.png', '29ce85f6bdfa49b13071af4e08a974b7421e8356c23c31868affee57001cae98'],
  'assets/css/images/ui-bg_glass_100_fdf5ce_1x400.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_glass_100_fdf5ce_1x400.png', '19c4d1db1a79435bdb581fa2ceb871889b941e843035c8cf8d19e6ee1999125a'],
  'assets/css/images/ui-bg_glass_65_ffffff_1x400.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_glass_65_ffffff_1x400.png', '126498a072d156849e1abce960bf23b705240e6be6ed01fa118a976b4e3603e7'],
  'assets/css/images/ui-bg_gloss-wave_35_f6a828_500x100.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_gloss-wave_35_f6a828_500x100.png', 'd1376927b64e131f8939bc781f94b3206305f8917cc6cc9789b408f6b2d4cef1'],
  'assets/css/images/ui-bg_highlight-soft_100_eeeeee_1x100.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_highlight-soft_100_eeeeee_1x100.png', 'bfbfd7d03625fdad05fbcde1988a8a0c1e108fd6d6009de5fcb5da284f6ef11a'],
  'assets/css/images/ui-bg_highlight-soft_75_ffe45c_1x100.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-bg_highlight-soft_75_ffe45c_1x100.png', '22acfe5a5d44636dc267c3fe1c762e74a5b96b2c75f0b5066574ecd43188d884'],
  'assets/css/images/ui-icons_222222_256x240.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-icons_222222_256x240.png', '672477447cf7284a47a9bdee1d39a87674c3cdd66e53b2318b3ab09edeef6791'],
  'assets/css/images/ui-icons_228ef1_256x240.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-icons_228ef1_256x240.png', 'bba2c151797def74c3afec416ad248afd9d3678bfd8b8e83672f7f8d5d2b2392'],
  'assets/css/images/ui-icons_ef8c08_256x240.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-icons_ef8c08_256x240.png', '3395480a7d0a35c92f77c5d846fb0648c95714d2e5e07024be36e35253cba187'],
  'assets/css/images/ui-icons_ffd27a_256x240.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-icons_ffd27a_256x240.png', '7bd5266d66b97d2bc935d2db6d7274211a3383673d67784ad46147458dfc9801'],
  'assets/css/images/ui-icons_ffffff_256x240.png': ['jquery-ui', 'https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/ui-icons_ffffff_256x240.png', 'd7c488629ad5151ba54c2db7d5ccf82867d55cb76aadfe2425d0ff37d408cf6e'],
  'assets/font/fontawesome-webfont.eot': ['font-awesome', 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/v3.0.1/font/fontawesome-webfont.eot', 'e07d3b0225ad8e9438927341d63485e01c767edf1e2930b16f0a0bf907ae0d82'],
  'assets/font/fontawesome-webfont.ttf': ['font-awesome', 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/v3.0.1/font/fontawesome-webfont.ttf', '1eb7466293db9378858da3694dd11620ec9c351fb7cefef1a94a3802803e1fa3'],
  'assets/font/fontawesome-webfont.woff': ['font-awesome', 'https://raw.githubusercontent.com/FortAwesome/Font-Awesome/v3.0.1/font/fontawesome-webfont.woff', 'a6fb906942932de53852ee244ee3fec27bca0bf63a96421672aa4784851b8d4b'],
  'assets/images/usa.svg': ['us-core-output', 'https://hl7.org/fhir/us/core/assets/images/usa.svg', 'e1792c011daad918fdbd99a21f7f46fd71018ffd052af5a7d7faf9954d593e31'],
  'tree-filter.png': ['us-core-output', 'https://hl7.org/fhir/us/core/tree-filter.png', '51102f8bc613490dbf56446d8cdf6d538d3cf229a907f44305fb37aa09b0d2b9'],
};

// These two official output URLs are rolling aliases. Keep the audited bytes
// in the generator so a future US Core publication cannot make an old runtime
// pack irreproducible; source URL + expected hash remain in `remote` above.
const embedded = {
  'assets/images/usa.svg': 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hsaW5rIiB3aWR0aD0iMTIzNSIgaGVpZ2h0PSI2NTAiIHZpZXdCb3g9IjAgMCA3NDEwIDM5MDAiPjxwYXRoIGZpbGw9IiNiMzE5NDIiIGQ9Ik0wIDBoNzQxMHYzOTAwSDAiLz48cGF0aCBzdHJva2U9IiNGRkYiIHN0cm9rZS13aWR0aD0iMzAwIiBkPSJNMCA0NTBoNzQxMG0wIDYwMEgwbTAgNjAwaDc0MTBtMCA2MDBIMG0wIDYwMGg3NDEwbTAgNjAwSDAiLz48cGF0aCBmaWxsPSIjMGEzMTYxIiBkPSJNMCAwaDI5NjR2MjEwMEgwIi8+PGcgZmlsbD0iI0ZGRiI+PGcgaWQ9ImQiPjxnIGlkPSJjIj48ZyBpZD0iZSI+PGcgaWQ9ImIiPjxwYXRoIGlkPSJhIiBkPSJtMjQ3IDkwIDcwLjUzNCAyMTcuMDgyLTE4NC42Ni0xMzQuMTY0aDIyOC4yNTNMMTc2LjQ2NiAzMDcuMDgyeiIvPjx1c2UgeGxpbms6aHJlZj0iI2EiIHk9IjQyMCIvPjx1c2UgeGxpbms6aHJlZj0iI2EiIHk9Ijg0MCIvPjx1c2UgeGxpbms6aHJlZj0iI2EiIHk9IjEyNjAiLz48L2c+PHVzZSB4bGluazpocmVmPSIjYSIgeT0iMTY4MCIvPjwvZz48dXNlIHhsaW5rOmhyZWY9IiNiIiB4PSIyNDciIHk9IjIxMCIvPjwvZz48dXNlIHhsaW5rOmhyZWY9IiNjIiB4PSI0OTQiLz48L2c+PHVzZSB4bGluazpocmVmPSIjZCIgeD0iOTg4Ii8+PHVzZSB4bGluazpocmVmPSIjYyIgeD0iMTk3NiIvPjx1c2UgeGxpbms6aHJlZj0iI2UiIHg9IjI0NzAiLz48L2c+PC9zdmc+',
  'tree-filter.png': 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABGdBTUEAAK/INwWK6QAAABl0RVh0U29mdHdhcmUAQWRvYmUgSW1hZ2VSZWFkeXHJZTwAAAKFSURBVHjapJO/T1NRFMe/997H+2HTCoJBiCLWHxj8QRw0MSZG/wYcHBwdNM5sLiYuJrqwODKaOGh00GjKgIEwMLEISf2tFBtSLbS2fa/3h+feZyu4epPbNu+c8z2f8+15zBiD/zme/ei/8Pz0icPR7PBIb1YLLntC33CfA4wZKGO4VKL8tV4LIPZfPLaiWlsrOD5+DpNXJlOBuzeHzz94uj6QNJrwe3cFwlPgFGEaUGij3WyhslnLXBpam+oLK4uffgQ54t6i0jlmR/hVL7/7Xm6MQButtTFKKhijoZWC0jDKKMYYEAVJQFoYevyMGZkk++7fCxwBNR7YuyfqsYVaSWgC08o4EcY4uGAQnCP0lvFmTuJksYiS74muB1LqVhyr3VRCEPSA0J21hjujdKzQn1kCqguotI7i4cAgLl+/9rMrwEmd2AlXWV4oKSGVHcO450cGC1C19/j8aBpnxw6CTxXg+77pCtgkbVtrazzhetZB291gtP8F6t9KWH85g3Asgjoz6/I9z2NdAXusSbajos5aSyTNGsZPvQUrPkH59QKCQwK1sSWwZhN21Fwux3YQ2ELXXQj3fevGVcxM1ZF83IQ/mkM8Pg9BiMZSpo2cAO8ApGZKxHGMRqOB4ocKJm8Di33T2MwX0Ipb0FK7RMLHxsYGdoxA/G4Ma6hNeFWYJ0PpL7WrTgEuuCOz8TAMsbq6yiYmJlKBdrttOs6nHqQj0UrR71TU7QjSWBRFKJVKf0cg8zKu/bbjdkL/8+ZQDuOpT9VqNbN9D9ZI+YDnCU1Bq8R06q5bdbrMEnW8SpJEZLPZL10Br8e7Q3MPUWJCV/y5nQJB4rwjZNMzmUyYz+eXbcJvAQYAzsJk4xkdqpsAAAAASUVORK5CYII=',
};

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function mimeFor(name) {
  const ext = path.extname(name).toLowerCase();
  return ({
    '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.eot': 'application/vnd.ms-fontobject',
    '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  })[ext] || 'application/octet-stream';
}

function packagePath(label, rel) {
  const candidates = [path.join(CACHE, label, rel), path.join(CACHE, label, 'package', rel)];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`missing ${label}/${rel} under FHIR_CACHE=${CACHE}`);
  return found;
}

const assets = {};
function add(publicPath, source, sourcePath, bytes, expectedHash) {
  const hash = sha256(bytes);
  if (expectedHash && hash !== expectedHash) {
    throw new Error(`${publicPath}: expected sha256 ${expectedHash}, got ${hash}`);
  }
  assets[publicPath] = {
    mime: mimeFor(publicPath),
    b64: bytes.toString('base64'),
    sha256: hash,
    source,
    sourcePath,
  };
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

/** Deterministic 25px back-to-top arrow. The upstream template CSS references
 *  this path, but fhir.base.template#1.0.0 and published IG output omit it. */
function generatedUpPng() {
  const width = 25;
  const height = 25;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const arrowHead = y >= 5 && y <= 12 && Math.abs(x - 12) <= y - 5;
      const stem = y >= 11 && y <= 20 && x >= 10 && x <= 14;
      if (arrowHead || stem) {
        const pixel = row + 1 + x * 4;
        raw[pixel] = 66; raw[pixel + 1] = 139; raw[pixel + 2] = 202; raw[pixel + 3] = 255;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// This is a preview host adapter, not a replacement for either template asset.
// The HTML handoff inserts it only after verifying the exact SHA-256 pair and
// only between jquery.js and jquery-ui.min.js. It restores the three jqXHR
// callback aliases removed by jQuery 3 while preserving the old complete
// callback's (jqXHR, textStatus) arguments (a direct `.always` alias would not).
const jqueryPreviewCompat = `/* fhir-ig-editor preview compatibility: jquery-3.7.0-ui-tabs-1.11.1 */
(function (global) {
  'use strict';
  var $ = global.jQuery;
  if (!$ || !$.fn || $.fn.jquery !== '3.7.0' || typeof $.ajax !== 'function') return;
  if ($.ajax.__fhirIgEditorLegacyJqxhrCompat === true) return;

  var originalAjax = $.ajax;

  function addCompleteCallbacks(xhr, callbacks) {
    function add(callback) {
      if (Array.isArray(callback)) {
        for (var i = 0; i < callback.length; i += 1) add(callback[i]);
      } else if (typeof callback === 'function') {
        xhr.always(function (_first, textStatus) {
          callback.call(this, xhr, textStatus);
        });
      }
    }
    for (var i = 0; i < callbacks.length; i += 1) add(callbacks[i]);
  }

  function decorate(xhr) {
    if (!xhr || typeof xhr.done !== 'function' || typeof xhr.fail !== 'function' || typeof xhr.always !== 'function') {
      return xhr;
    }
    if (typeof xhr.success !== 'function') {
      xhr.success = function () {
        this.done.apply(this, arguments);
        return this;
      };
    }
    if (typeof xhr.error !== 'function') {
      xhr.error = function () {
        this.fail.apply(this, arguments);
        return this;
      };
    }
    if (typeof xhr.complete !== 'function') {
      xhr.complete = function () {
        addCompleteCallbacks(this, arguments);
        return this;
      };
    }
    return xhr;
  }

  function compatibleAjax() {
    return decorate(originalAjax.apply(this, arguments));
  }
  for (var key in originalAjax) {
    if (Object.prototype.hasOwnProperty.call(originalAjax, key)) compatibleAjax[key] = originalAjax[key];
  }
  compatibleAjax.__fhirIgEditorLegacyJqxhrCompat = true;
  $.ajax = compatibleAjax;
})(window);
`;

const r4Other = packagePath('hl7.fhir.r4.core#4.0.1', 'other');
for (const name of fs.readdirSync(r4Other).sort()) {
  if (!/^(?:icon_.+\.(?:gif|png)|tbl_.+\.png)$/.test(name) && !['cc0.png', 'external.png', 'help16.png', 'strip.png', 'watermark.png'].includes(name)) continue;
  add(name, 'fhir-r4-core', `other/${name}`, fs.readFileSync(path.join(r4Other, name)));
}
add('fhir.css', 'fhir-r4-core', 'other/fhir.css', fs.readFileSync(path.join(r4Other, 'fhir.css')));

const r5Other = packagePath('hl7.fhir.r5.core#5.0.0', 'other');
for (const name of fs.readdirSync(r5Other).filter((name) => /^tbl_.+-open\.png$/.test(name)).sort()) {
  if (!assets[name]) add(name, 'fhir-r5-core', `other/${name}`, fs.readFileSync(path.join(r5Other, name)));
}

const tableScript = packagePath('fhir.base.template#1.0.0', 'content/assets/js/fhir-table-scripts.js');
const upstreamTableScript = fs.readFileSync(tableScript, 'utf8');
const unsafeTableFilter = "let classes = childElement.getAttribute('class');\n        if (classes.includes(prop)) {";
if (!upstreamTableScript.includes(unsafeTableFilter)) {
  throw new Error('fhir-table-scripts.js compatibility patch no longer matches its pinned upstream source');
}
const compatibleTableScript = upstreamTableScript.replace(
  unsafeTableFilter,
  "if (childElement.classList.contains(prop)) {",
);
add(
  'fhir-table-scripts.js',
  'editor-table-runtime',
  'content/assets/js/fhir-table-scripts.js + patch:null-safe-class-filter-v1',
  Buffer.from(compatibleTableScript),
);
for (const name of [
  'OpenSans-CondBold-webfont.eot', 'OpenSans-CondBold-webfont.svg',
  'OpenSans-CondBold-webfont.ttf', 'OpenSans-CondBold-webfont.woff',
  'OpenSans-CondLight-webfont.eot', 'OpenSans-CondLight-webfont.svg',
  'OpenSans-CondLight-webfont.ttf', 'OpenSans-CondLight-webfont.woff',
]) {
  const sourcePath = `content/assets/fonts/${name}`;
  add(name, 'open-sans-condensed', sourcePath, fs.readFileSync(packagePath('fhir.base.template#1.0.0', sourcePath)));
}

for (const publicPath of Object.keys(remote).sort()) {
  const [source, url, expectedHash] = remote[publicPath];
  let bytes;
  if (embedded[publicPath]) {
    bytes = Buffer.from(embedded[publicPath], 'base64');
  } else {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  add(publicPath, source, url, bytes, expectedHash);
}

add('assets/images/theme/up.png', 'editor-generated', 'generated:back-to-top-arrow-v1', generatedUpPng());
add(
  '_fhir-ig-editor/compat/jquery-3.7.0-ui-tabs-1.11.1.js',
  'editor-jquery-compat',
  'generated:preview-jquery-3.7.0-ui-tabs-1.11.1-v1',
  Buffer.from(jqueryPreviewCompat),
);

const sortedAssets = Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)));
const document = {
  schemaVersion: 1,
  id: 'hl7-fhir-publisher-runtime#1.0.0',
  generatedBy: 'scripts/build-publisher-runtime-pack.mjs',
  sources,
  assets: sortedAssets,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(document)}\n`);
console.log(`[publisher-runtime] ${Object.keys(sortedAssets).length} assets, ${fs.statSync(OUT).size} bytes -> ${path.relative(REPO, OUT)}`);
