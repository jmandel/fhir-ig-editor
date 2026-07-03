# Committed expansion cache (spec §6 tier 3)

This directory holds the **tx.fhir.org-sourced expansion cache** for the default
IG — warm-start data AND the AUTHORITY the in-engine tier-1 evaluator is gated
against (`scripts/consistency-gate.mjs`).

**This cycle's cache is empty.** The demo IG (cycle) has no ValueSet whose
compose needs an external terminology server: every ValueSet is tier-1 enumerable
(local CodeSystem codes + authored SNOMED code/display lists), so nothing here
requires a committed `$expand` answer. The consistency gate is therefore
**trivially green over the committed set** — but it is fully WIRED (and proven by
a fixture-based self-test), so the moment a maintainer commits a real entry, the
gate begins asserting `expand_enumerable` agrees with it on the shared domain.

## Discipline

- Entries are added **deliberately** by a maintainer running a refresh against a
  real tx server and committing the result (like goldens). **CI never calls a tx
  server** — builds stay hermetic.
- Each entry stores the full `$expand` response INCLUDING `expansion.parameter`
  (the `used-codesystem` version pins), plus the `valueSetResource` and its
  `referencedResources`, so the gate can reproduce it without a live compile.
- Entry file shape (matches the live cache writer, `app/src/vfs/txCache.ts`):

  ```json
  {
    "hash": "<content hash of VS + refs + server>",
    "valueSet": "<canonical url>",
    "server": "https://tx.fhir.org/r4",
    "fetchedAt": "<ISO timestamp>",
    "expansion": { "total": N, "parameter": [...], "contains": [...] },
    "usedCodeSystems": [{ "system": "...", "version": "..." }],
    "valueSetResource": { ...the ValueSet... },
    "referencedResources": [ ...IG-local CodeSystems/ValueSets the compose reaches... ]
  }
  ```

- On a mismatch the **cached tx answer wins** and the evaluator is fixed — two
  expanders are tolerable only while provably agreeing on the shared domain.
