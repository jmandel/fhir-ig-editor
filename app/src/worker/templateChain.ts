// The template-chain walker (#40 live template loader) — the "Rust-decides /
// JS-fetches" split, applied to template packages.
//
// `Session.mountTemplate(coord)` materializes a template's `base` chain from the
// packages ALREADY MOUNTED in the engine (base-chain walk + union-copy + config
// deep-merge, byte-exact, no ant). Unlike regular packages, `mountTemplate` does
// NOT hand back a fetch list — the loader's `walk_base_chain` reads each
// `package.json`'s `base` + `dependencies[base]` to decide the chain. So the host
// must pre-stage the chain: this module mirrors that SAME walk in JS, fetching +
// mounting each package via the existing package transport (OPFS→local→baked→
// registry, `obtainAndMountPackage`) before `mountTemplate` runs.
//
// This mirrors `fig::template::acquire_and_materialize`'s native loop exactly:
//   loop: acquire+mount <coord>; read package.json; base = pj.base; if none, root
//   reached; else next = `${base}#${pj.dependencies[base]}`. Visited-guard on id.
// The base/deps read IS the loader's decision; we only re-do it because the wasm
// entry point consumes an already-mounted chain (Rust decides, host fetches).

import type { ResolverHost } from './packageResolver';
import { obtainAndMountPackage } from './packageResolver';

/** How the chain walk reports progress (a subset of the resolver's stages). */
export type ChainProgress = (ev: {
  stage: 'bundle-fetch' | 'bundle-cache-hit' | 'bundle-mount';
  label?: string;
  message: string;
}) => void;

/** Decode a UTF-8 text file out of an inflated bundle's `{name: base64}` map. */
function readText(files: Record<string, string>, name: string): string | null {
  const b64 = files[name];
  if (b64 == null) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const MAX_CHAIN = 16; // a base chain this deep is pathological (loop guard backstop).

/**
 * Walk + mount a template's `base` chain, leaf→root, so a subsequent
 * `Session.mountTemplate(coord)` finds every chain package mounted.
 *
 * Returns the chain labels in walk order (leaf first). Throws with a precise
 * message if a chain package cannot be obtained (so the adapter can surface it
 * and fall back), if a package is not a template (`type` check is the loader's,
 * left to the engine), or if the chain recurses.
 */
export async function mountTemplateChain(
  host: ResolverHost,
  coord: string,
  onProgress: ChainProgress,
): Promise<{ chain: string[] }> {
  const chain: string[] = [];
  const visitedIds = new Set<string>();
  let current = coord;

  for (let step = 0; step < MAX_CHAIN; step++) {
    onProgress({ stage: 'bundle-fetch', label: current, message: `Fetching template package ${current}…` });
    const files = await obtainAndMountPackage(host, current, (ev) => {
      // Normalize the resolver's stage set to the chain's subset (registry-fetch /
      // package-blocked / resolve all read as "fetching" in the template context).
      const stage = ev.stage === 'bundle-cache-hit' ? 'bundle-cache-hit' : 'bundle-fetch';
      onProgress({ stage, label: ev.label, message: ev.message });
    });
    if (!files) {
      throw new Error(
        `template chain: could not obtain ${current} from any source (baked bundles, local drops, or registry)`,
      );
    }
    chain.push(current);

    // The inflate strips the tarball's `package/` prefix, so package.json sits at
    // the map root — the same file `walk_base_chain` reads (`<pkg>/package/package.json`).
    const pjText = readText(files, 'package.json');
    if (!pjText) throw new Error(`template chain: ${current} has no package.json`);
    let pj: { name?: string; base?: string; dependencies?: Record<string, string> };
    try {
      pj = JSON.parse(pjText);
    } catch (e) {
      throw new Error(`template chain: ${current} package.json parse failed: ${String(e)}`);
    }

    const id = pj.name ?? current.split('#')[0];
    if (visitedIds.has(id)) {
      throw new Error(`template chain: parents recurse at ${id} (${[...visitedIds, id].join(' → ')})`);
    }
    visitedIds.add(id);

    const base = pj.base;
    if (!base) break; // root reached (no `base`) — the loader's stop condition.
    const ver = pj.dependencies?.[base];
    if (!ver) {
      throw new Error(`template chain: ${current} declares base '${base}' but does not list it in dependencies`);
    }
    current = `${base}#${ver}`;
  }

  return { chain };
}
