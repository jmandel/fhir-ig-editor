// Drop-in replacement for cycle's `site-gen/core/db.ts`, injected via a Vite
// `resolve.alias` so the submodule's renderer (`chrome/Menu.tsx`,
// `chrome/Layout.tsx`, `build.tsx`-derived code) imports THIS instead of the
// bun:sqlite version. Same exported surface, backed by an in-memory `RowStore`
// the worker installs (`setActiveStore`) before each render.
//
// The original opens a SQLite file at module load and throws if absent — that is
// exactly what we must avoid in the browser. Here import has no side effects;
// calling a query before `setActiveStore` throws a clear error.

import type { RowStore, ResourceRow, PageRow, MenuRow } from './rowStore';

export type { ResourceRow, PageRow, MenuRow };

let active: RowStore | null = null;

/** Install the row store the db functions read from (call before rendering). */
export function setActiveStore(store: RowStore): void {
  active = store;
}

function store(): RowStore {
  if (!active) throw new Error('preview db not initialized: call setActiveStore() first');
  return active;
}

export function metadata(): Record<string, string> { return store().metadata(); }
export function resources(type?: string): ResourceRow[] { return store().resources(type); }
export function parse(r: ResourceRow): any { return store().parse(r); }
export function valueSetCodes(url: string) { return store().valueSetCodes(url); }
export function concepts(resourceKey: number) { return store().concepts(resourceKey); }
export function pages(): PageRow[] { return store().pages(); }
export function menu(): MenuRow[] { return store().menu(); }
export function siteConfig(name: string): any { return store().siteConfig(name); }
export function asset(name: string): string | null { return store().asset(name); }
export function textAsset(name: string): string | null { return store().textAsset(name); }
export function assets() { return store().assets(); }
export function ig(): any { return store().ig(); }

/** The raw handle the `{% sql %}` executor uses: `db.db.query(sql).all()`. */
export const db = {
  query(sql: string) {
    return { all: () => store().query(sql) };
  },
};
