# Publisher runtime asset pack

`scripts/build-publisher-runtime-pack.mjs` creates
`app/public/data/publisher-runtime/1.0.0.json`. The generated file is staged
application data and is intentionally ignored by Git. The JSON is a closed,
versioned catalog: every public path records MIME type, base64 bytes, SHA-256,
source id, and source path; every source records its package/version, license,
upstream URL, and role.

This pack is separate from the selected IG template. Publisher-generated
fragments refer to these files at the site root, but the template package does
not own or contain all of them.

## Sources and licenses

| Pack source | Files | Provenance | License |
| --- | --- | --- | --- |
| `fhir-r4-core` | `fhir.css`, `icon_*`, `tbl_*`, `cc0.png`, `external.png`, `help16.png` | `hl7.fhir.r4.core#4.0.1`, `other/` | Package-declared `CC0-1.0` |
| `fhir-r5-core` | active-table `tbl_*-open.png` controls missing from R4 | `hl7.fhir.r5.core#5.0.0`, `other/` | Package-declared `CC0-1.0` |
| `editor-table-runtime` | root `fhir-table-scripts.js` | `fhir.base.template#1.0.0`, plus the named null-safe class-filter patch in the generator | Package-declared `CC0-1.0` |
| `editor-jquery-compat` | `_fhir-ig-editor/compat/jquery-3.7.0-ui-tabs-1.11.1.js` | deterministic preview-host shim in the build script | `CC0-1.0` |
| `jquery-ui` | ui-lightness `ui-bg_*` and `ui-icons_*` PNGs | `https://code.jquery.com/ui/1.11.1/themes/ui-lightness/images/` | MIT; copyright 2007, 2014 jQuery Foundation and contributors |
| `font-awesome` | `fontawesome-webfont.{eot,woff,ttf}` | Font Awesome tag `v3.0.1`, `font/` | SIL Open Font License 1.1 |
| `open-sans-condensed` | root-relative `OpenSans-Cond*-webfont.*` files | bytes vendored by `fhir.base.template#1.0.0` | Apache License 2.0 |
| `us-core-output` | `tree-filter.png`, `assets/images/usa.svg` | official `hl7.fhir.us.core#9.0.0` published output | Guide-declared `CC0-1.0` |
| `editor-generated` | `assets/images/theme/up.png` | deterministic generator in the build script | `CC0-1.0` |

The jQuery UI license notice is available in the
[upstream 1.11.1 license](https://github.com/jquery/jquery-ui/blob/1.11.1/LICENSE.txt).
The Font Awesome 3.0.1 README declares the fonts under the
[SIL Open Font License](https://github.com/FortAwesome/Font-Awesome/tree/v3.0.1).
Only the font files, not the separately licensed pictogram artwork or CSS, are
copied from that project.

`project.css` refers to `assets/images/theme/up.png`, but neither
`fhir.base.template#1.0.0` nor the corresponding published IG output contains
that file. Rather than silently returning a placeholder, the pack has a named,
deterministic producer for a 25-by-25 back-to-top arrow and records that fact in
the asset's provenance.

The upstream table script assumes every child in a description cell has a
`class` attribute and calls `.includes` on the nullable result. Current rendered
tables legitimately contain unclassified children, producing uncaught
`filterDesc` errors. The pack builder requires the exact upstream statement and
replaces it with `childElement.classList.contains(prop)`. If the upstream script
changes, generation fails rather than applying a fuzzy or silent patch. The
derived asset records `patch:null-safe-class-filter-v1` in its source path.

## Exact-pair jQuery preview compatibility

The template deliberately retains its original jQuery 3.7.0 and custom jQuery
UI Tabs 1.11.1 files byte-for-byte. That historical combination is internally
incompatible: Tabs 1.11.1 calls the `jqXHR.success`, `jqXHR.error`, and
`jqXHR.complete` aliases removed by jQuery 3.

The stock preview computes SHA-256 over the actually selected catalog bytes and
inserts the separately provisioned `editor-jquery-compat` script immediately
after `assets/js/jquery.js` only when all three bytestrings match their pins:

- jQuery 3.7.0: `d8f9afbf492e4c139e9d2bcb9ba6ef7c14921eb509fb703bc7a3f911b774eff8`;
- custom jQuery UI Tabs 1.11.1: `4dd865e0f9932d4c8e31ad8c04f1271116dad7462455e4fb3fea8c46ebdd7075`;
- preview shim v1: `5ff89b5b73dd144e3bed959ab75251275127e501a290c4db7f1070c82d7b8f53`.

The transform also requires the jQuery script tag to precede the jQuery UI tag,
is idempotent through a named data marker, and otherwise fails closed. The shim
wraps `$.ajax` only on that matched preview page. `success` delegates to `done`,
`error` to `fail`, and `complete` adapts the Deferred callback back to its old
`(jqXHR, textStatus)` arguments and original callback context; directly aliasing
`complete` to `always` would not preserve those arguments. No template/package
asset is rewritten.

The build obtains external files only from the sources listed in the manifest
and rejects any byte sequence whose SHA-256 differs from the pinned value.
Package files are read from `FHIR_CACHE` and support both the registry
`package/` layout and Fig's flattened cache layout.

The canonical US Core output URLs are rolling aliases. Their two small audited
payloads are therefore embedded in the generator while retaining the official
source URL and hash in the manifest; a later publication cannot silently change
or break regeneration of runtime pack 1.0.0.

## Dynamic table backgrounds

`HierarchicalTableGenerator` discovers `tbl_bck<indent-state>.png` names while
rendering. No finite core package contains every possible indent combination.
Known names use the exact package PNGs. A novel name is handled by the explicit
`materializeMissingTableBackgrounds` producer, which replaces that one URL with
an inline 800-by-2 SVG implementing the Publisher's `genImage` pixel algorithm:
continued regular, slicer, and slice lines use black, green, and gold pixels at
16-pixel intervals and repeat every two rows. This keeps the already-sealed
Service Worker manifest closed without bounding profile depth or returning a
fake image.

## Template and IG layers

The final stock catalog has deterministic precedence:

1. Publisher runtime pack;
2. materialized template assets;
3. authored `input/images` files.

The catalog retains all layers and their provenance. Removing an authored file
reveals the template/runtime entry it had overridden. Warm template artifacts
and live engine mounts use the same projection. While resolving a live template
chain, the worker retains the public static files from the exact package maps it
already fetched and merges them base-to-leaf, matching the engine's materialize
order. The leaf therefore wins exact-path collisions without a second registry
walk or a separate, eventually-consistent asset lookup.
