// Tier-2 tx `$expand` client (spec §6 tier 2). POSTs a `ValueSet/$expand`
// Parameters body to the user-configured endpoint. The referenced IG-local
// CodeSystems/ValueSets are included as `tx-resource` parameters so the server
// sees the same local content the tier-1 evaluator does — the realistic hosted
// endpoint (tx.fhir.org) then contributes the EXTERNAL systems (SNOMED/LOINC/…)
// tier-1 can't. No configured endpoint = this is never called (the UI gates it).

export interface TxExpandOk {
  ok: true;
  /** The `ValueSet.expansion` object (contains[], parameter[], total). */
  expansion: unknown;
  usedCodeSystems: { system: string; version?: string }[];
}
export interface TxExpandErr {
  ok: false;
  /** Human error (network / non-2xx / OperationOutcome text). */
  error: string;
}
export type TxExpandResult = TxExpandOk | TxExpandErr;

/** Lift `used-codesystem` pins out of an expansion.parameter array. */
function liftUsed(expansion: unknown): { system: string; version?: string }[] {
  const params = (expansion as { parameter?: unknown[] })?.parameter;
  if (!Array.isArray(params)) return [];
  const out: { system: string; version?: string }[] = [];
  for (const p of params) {
    const pr = p as { name?: string; valueUri?: string };
    if (pr.name === 'used-codesystem' && typeof pr.valueUri === 'string') {
      const [system, version] = pr.valueUri.split('|');
      out.push(version ? { system, version } : { system });
    }
  }
  return out;
}

/** Call `<endpoint>/ValueSet/$expand` (POST) for `valueSet`, supplying the
 *  referenced local resources as `tx-resource` parameters. */
export async function txExpand(
  endpoint: string,
  valueSet: unknown,
  referencedResources: unknown[],
): Promise<TxExpandResult> {
  const parameters = {
    resourceType: 'Parameters',
    parameter: [
      { name: 'valueSet', resource: valueSet },
      ...referencedResources.map((r) => ({ name: 'tx-resource', resource: r })),
      // Cap the returned set — a browser expansion view is not the place for a
      // 100k-code SNOMED subtree, and an uncapped `is-a` on a broad concept is
      // rejected by tx.fhir.org as `too-costly`. The cap keeps the honest cases
      // (small/medium external subsets) working; huge ones still degrade clearly.
      { name: 'count', valueInteger: 1000 },
    ],
  };
  const url = `${endpoint.replace(/\/+$/, '')}/ValueSet/$expand`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json' },
      body: JSON.stringify(parameters),
    });
  } catch (e) {
    return { ok: false, error: `network error contacting ${url}: ${String(e)}` };
  }
  const text = await resp.text();
  if (!resp.ok) {
    // Surface an OperationOutcome diagnostic if present, else the status.
    let detail = `${resp.status} ${resp.statusText}`;
    try {
      const oo = JSON.parse(text) as {
        resourceType?: string;
        issue?: { diagnostics?: string; details?: { text?: string } }[];
      };
      if (oo.resourceType === 'OperationOutcome' && oo.issue?.length) {
        // Prefer the human `details.text` (e.g. "expansion has too many codes")
        // over the server's timing `diagnostics` trace.
        detail = oo.issue.map((i) => i.details?.text || i.diagnostics || '').filter(Boolean).join('; ') || detail;
      }
    } catch {
      /* not JSON */
    }
    return { ok: false, error: detail };
  }
  let vs: { expansion?: unknown };
  try {
    vs = JSON.parse(text);
  } catch {
    return { ok: false, error: 'server returned non-JSON' };
  }
  if (!vs.expansion) return { ok: false, error: 'server response had no expansion' };
  return { ok: true, expansion: vs.expansion, usedCodeSystems: liftUsed(vs.expansion) };
}
