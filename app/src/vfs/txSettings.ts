// Tier-2 terminology settings (spec §6 tier 2): a user-configured `$expand`
// endpoint. Default is NONE — with no endpoint, un-enumerable ValueSets show a
// scoped, honest "needs terminology server" state and offer no server action;
// they NEVER silently partial-expand.
//
// Persisted in localStorage (a single small URL string), so the setting survives
// reloads without touching the OPFS project store.

const KEY = 'fhir-ig-editor.tx-endpoint';

/** The configured tx `$expand` base URL (e.g. `https://tx.fhir.org/r4`), or ''. */
export function getTxEndpoint(): string {
  try {
    return localStorage.getItem(KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Set (or clear, when empty) the tx endpoint. Trailing slash normalized off. */
export function setTxEndpoint(url: string): void {
  const v = url.trim().replace(/\/+$/, '');
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* private-mode: setting is session-only, honest degradation */
  }
}

/** A stable identity string for the configured server, used as a cache-key
 *  component so a cached expansion is invalidated when the endpoint changes. */
export function txServerIdentity(): string {
  return getTxEndpoint() || '(none)';
}
