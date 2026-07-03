// Shared helpers for reading StructureDefinition element lists (differential +
// snapshot). Kept view-agnostic.

export interface SdType {
  code?: string;
  targetProfile?: string[];
  profile?: string[];
}

export interface SdElement {
  id?: string;
  path: string;
  short?: string;
  definition?: string;
  min?: number;
  max?: string;
  type?: SdType[];
  mustSupport?: boolean;
  sliceName?: string;
  fixedCode?: string;
  binding?: { strength?: string; valueSet?: string };
  // pass-through for anything else
  [k: string]: unknown;
}

export interface StructureDefinition {
  resourceType: string;
  id?: string;
  url?: string;
  name?: string;
  type?: string;
  baseDefinition?: string;
  differential?: { element: SdElement[] };
  snapshot?: { element: SdElement[] };
}

export function isStructureDefinition(v: unknown): v is StructureDefinition {
  return !!v && typeof v === 'object' && (v as { resourceType?: string }).resourceType === 'StructureDefinition';
}

/** Cardinality string like `1..*` from an element (min/max may be absent). */
export function cardinality(e: SdElement): string {
  if (e.min == null && e.max == null) return '';
  return `${e.min ?? ''}..${e.max ?? ''}`;
}

/** Compact type display: `code(profile)` joined by ` | `. */
export function typeDisplay(e: SdElement): string {
  if (!e.type || e.type.length === 0) return '';
  return e.type
    .map((t) => {
      const prof = (t.profile ?? []).concat(t.targetProfile ?? []).map(short).join(', ');
      return prof ? `${t.code}(${prof})` : (t.code ?? '');
    })
    .join(' | ');
}

/** Flags column: MS / fixed / binding. */
export function flags(e: SdElement): string {
  const out: string[] = [];
  if (e.mustSupport) out.push('MS');
  if (e.binding?.strength) out.push(`bind:${e.binding.strength}`);
  if (e.sliceName) out.push(`slice:${e.sliceName}`);
  return out.join(' ');
}

function short(url: string): string {
  return url.split('/').pop() ?? url;
}

/** Nesting depth from the dotted path, for indentation. */
export function depthOf(path: string): number {
  return Math.max(0, path.split('.').length - 1);
}

/** Last path segment (the element's own name). */
export function tailOf(path: string): string {
  const seg = path.split('.');
  return seg[seg.length - 1];
}
