// The JS row store for M2 site preview. It implements the EXACT query surface of
// cycle's `site-gen/core/db.ts` over the row set the Rust producer emits
// (wasm `build_site_db` -> rows JSON). We deliberately DON'T use wa-sqlite: the
// cycle renderer uses no `{% sql %}` on any page (verified — its liquid uses only
// `{% include %}`/`{% assign %}`), so a thin typed row store over the columns
// `core/db.ts` selects is enough and far lighter than shipping a wasm SQLite.
//
// The one raw-SQL escape hatch — `{% sql %}` / `db.db.query(sql).all()` — is
// supported for the handful of trivial `SELECT ... FROM Metadata`-shaped queries
// the liquid docs mention, via a tiny interpreter (`runSql`). Anything it can't
// parse throws a clear "unsupported in-browser SQL" error rather than silently
// returning nothing (fail loud, matching the renderer's own discipline).
//
// Column casing matches the SQLite schema / `core/db.ts` interfaces exactly
// (the Rust `SiteDb` serde renames produce `Key`, `Type`, `Json`, base64 `Content`
// etc.), so these rows are consumed with no translation.

export interface ResourceRow {
  Key: number;
  Type: string;
  Custom: number;
  Id: string;
  Web: string;
  Url?: string | null;
  Version?: string | null;
  Status?: string | null;
  Date?: string | null;
  Name?: string | null;
  Title?: string | null;
  Description?: string | null;
  derivation?: string | null;
  standardStatus?: string | null;
  kind?: string | null;
  sdType?: string | null;
  base?: string | null;
  content?: string | null;
  supplements?: string | null;
  Json: string;
}
export interface MetadataRow { Key: number; Name: string; Value: string }
export interface ConceptRow { Key: number; ResourceKey: number; ParentKey: number | null; Code?: string | null; Display?: string | null; Definition?: string | null }
export interface ValueSetCodeRow { Key: number; ResourceKey: number; ValueSetUri: string; ValueSetVersion: string; System: string; Version?: string | null; Code: string; Display?: string | null }
export interface PageRow { Slug: string; NameUrl: string; Title: string; Generation: string; Ord: number; Depth: number; Body: string | null }
export interface MenuRow { Id: number; ParentId: number | null; Ord: number; Depth: number; Path: string; Label: string; Href: string | null; Kind: string }
export interface SiteConfigRow { Name: string; Json: string }
/** Content arrives base64; text assets decode to string, binary stay bytes. */
export interface AssetRow { Name: string; Mime: string; Content: string }

/** The row set exactly as `wasm build_site_db` serializes it. */
export interface SiteDbRows {
  metadata: MetadataRow[];
  resources: ResourceRow[];
  concepts: ConceptRow[];
  valueSetCodes: ValueSetCodeRow[];
  pages: PageRow[];
  menu: MenuRow[];
  siteConfig: SiteConfigRow[];
  assets: AssetRow[];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TEXTUAL_MIME = (mime: string): boolean => {
  const m = (mime || '').toLowerCase();
  return m.startsWith('text/') || m === 'image/svg+xml' || m === 'application/xml' || m === 'application/xhtml+xml';
};

/**
 * The row store. Constructed from the wasm-produced rows; exposes the `core/db.ts`
 * function surface (see `dbShim.ts`, which delegates to the active store). The
 * `query(sql)` method backs the liquid `{% sql %}` executor.
 */
export class RowStore {
  constructor(private rows: SiteDbRows) {}

  metadata(): Record<string, string> {
    return Object.fromEntries(this.rows.metadata.map((r) => [r.Name, r.Value]));
  }

  resources(type?: string): ResourceRow[] {
    const rs = type ? this.rows.resources.filter((r) => r.Type === type) : this.rows.resources.slice();
    // ORDER BY Id (type given) / Type, Id (all) — matches core/db.ts.
    rs.sort((a, b) =>
      type ? a.Id.localeCompare(b.Id) : a.Type.localeCompare(b.Type) || a.Id.localeCompare(b.Id),
    );
    return rs;
  }

  parse(r: ResourceRow): any {
    return JSON.parse(r.Json);
  }

  valueSetCodes(url: string): { system: string; code: string; display?: string }[] {
    return this.rows.valueSetCodes
      .filter((r) => r.ValueSetUri === url)
      .sort((a, b) => a.System.localeCompare(b.System) || a.Code.localeCompare(b.Code))
      .map((r) => ({ system: r.System, code: r.Code, display: r.Display ?? undefined }));
  }

  concepts(resourceKey: number): { Key: number; ParentKey: number | null; Code: string; Display?: string; Definition?: string }[] {
    return this.rows.concepts
      .filter((r) => r.ResourceKey === resourceKey)
      .sort((a, b) => a.Key - b.Key)
      .map((r) => ({ Key: r.Key, ParentKey: r.ParentKey, Code: r.Code ?? '', Display: r.Display ?? undefined, Definition: r.Definition ?? undefined }));
  }

  pages(): PageRow[] {
    return this.rows.pages.slice().sort((a, b) => a.Ord - b.Ord);
  }

  menu(): MenuRow[] {
    return this.rows.menu.slice().sort((a, b) => a.Ord - b.Ord);
  }

  siteConfig(name: string): any {
    const r = this.rows.siteConfig.find((s) => s.Name === name);
    return r ? JSON.parse(r.Json) : null;
  }

  asset(name: string): string | null {
    const r = this.rows.assets.find((a) => a.Name === name);
    if (!r) return null;
    return new TextDecoder().decode(b64ToBytes(r.Content));
  }

  textAsset(name: string): string | null {
    const r = this.rows.assets.find((a) => a.Name === name);
    if (!r) return null;
    if (!TEXTUAL_MIME(r.Mime)) return null;
    return new TextDecoder().decode(b64ToBytes(r.Content));
  }

  /** All assets (for verbatim write-out). Content stays base64 here; the iframe
   *  asset server (`assetBytes`) decodes on demand. */
  assets(): AssetRow[] {
    return this.rows.assets.slice();
  }

  /** Decoded bytes for an asset, for blob-URL serving in the preview iframe. */
  assetBytes(name: string): { mime: string; bytes: Uint8Array } | null {
    const r = this.rows.assets.find((a) => a.Name === name);
    if (!r) return null;
    return { mime: r.Mime, bytes: b64ToBytes(r.Content) };
  }

  ig(): any {
    const r = this.rows.resources.find((x) => x.Type === 'ImplementationGuide');
    if (!r) throw new Error('no ImplementationGuide row in site.db');
    const o = JSON.parse(r.Json);
    o.contact = (o.contact || []).map((c: any) => ({ ...c, telecom: (c.telecom || []).map((t: any) => t.value ?? t) }));
    return o;
  }

  /** The `{% sql %}` executor. Supports the trivial `SELECT ... FROM <Table>`
   *  shapes cycle authoring uses (Metadata name/value etc.); throws clearly on
   *  anything richer so a page never silently loses data. */
  query(sql: string): Record<string, any>[] {
    return runSql(sql, this.rows);
  }
}

// ---- tiny SQL interpreter for {% sql %} (cycle uses none; docs show Metadata) --

function runSql(sql: string, rows: SiteDbRows): Record<string, any>[] {
  const q = sql.trim().replace(/;+\s*$/, '');
  // SELECT <cols> FROM <Table> [WHERE Col = 'x'] [ORDER BY Col]
  const m = /^select\s+(.+?)\s+from\s+([A-Za-z_]+)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(.+?))?$/i.exec(q);
  if (!m) throw new Error(`Unsupported in-browser SQL (M2 preview supports simple SELECT ... FROM <table>): ${sql}`);
  const [, colsRaw, table, whereRaw, orderRaw] = m;
  const source: Record<string, any>[] = tableRows(table, rows);
  let out = source;
  if (whereRaw) {
    const wm = /^([A-Za-z_]+)\s*=\s*'([^']*)'$/.exec(whereRaw.trim());
    if (!wm) throw new Error(`Unsupported WHERE clause in preview SQL: ${whereRaw}`);
    out = out.filter((r) => String(r[wm[1]]) === wm[2]);
  }
  if (orderRaw) {
    const cols = orderRaw.split(',').map((c) => c.trim().replace(/\s+(asc|desc)$/i, ''));
    out = out.slice().sort((a, b) => {
      for (const c of cols) {
        const d = String(a[c] ?? '').localeCompare(String(b[c] ?? ''));
        if (d) return d;
      }
      return 0;
    });
  }
  // Projection with `Col as alias` support.
  const cols = colsRaw.trim() === '*' ? null : colsRaw.split(',').map((c) => {
    const am = /^(.+?)\s+as\s+(.+)$/i.exec(c.trim());
    return am ? { src: am[1].trim(), out: am[2].trim() } : { src: c.trim(), out: c.trim() };
  });
  if (!cols) return out.map((r) => ({ ...r }));
  return out.map((r) => Object.fromEntries(cols.map((c) => [c.out, r[c.src]])));
}

function tableRows(table: string, rows: SiteDbRows): Record<string, any>[] {
  switch (table) {
    case 'Metadata': return rows.metadata as any;
    case 'Resources': return rows.resources as any;
    case 'Concepts': return rows.concepts as any;
    case 'ValueSet_Codes': return rows.valueSetCodes as any;
    case 'Pages': return rows.pages as any;
    case 'Menu': return rows.menu as any;
    case 'SiteConfig': return rows.siteConfig as any;
    case 'Assets': return rows.assets as any;
    default: throw new Error(`Unknown table in preview SQL: ${table}`);
  }
}
