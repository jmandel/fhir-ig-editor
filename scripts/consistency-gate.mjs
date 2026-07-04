// Consistency gate (editor spec §6 tier 3): the in-engine tier-1 expander
// (`expand_enumerable`) MUST agree, ON THE SHARED DOMAIN, with every committed
// expansion-cache entry for the default IG. The committed cache is the tx-sourced
// AUTHORITY (refreshed deliberately by a maintainer, never by CI). Two expanders
// are tolerable only while provably agreeing; on mismatch the cached tx answer
// wins and the evaluator is fixed.
//
//   node scripts/consistency-gate.mjs <wasm-nodejs-dir> [<cache-dir>]
//
// This CYCLE's committed cache is EMPTY (no external-system ValueSet needs a
// server for the demo IG), so over the real cache the gate is trivially green.
// To prove the PLUMBING is real (not vacuously passing), the script ALSO runs a
// bundled fixture-based SELF-TEST: a known ValueSet + a committed-shape cache
// entry whose code set it must match, plus a deliberately-wrong entry it must
// REJECT. If the self-test's comparison logic is broken, the gate fails — so a
// green gate means the machinery genuinely compares.
//
// Cache entry shape (matches app/src/vfs/txCache.ts, the live cache writer):
//   { hash, valueSet, server, fetchedAt, expansion, usedCodeSystems,
//     referencedResources? }
// `referencedResources` (the IG-local CodeSystems/ValueSets the compose reaches)
// is what the evaluator needs to reproduce the expansion; committed entries carry
// it so the gate is self-contained (no live compile required).

import fs from 'node:fs';
import path from 'node:path';

const [WASM_DIR, CACHE_DIR_ARG] = process.argv.slice(2);
if (!WASM_DIR) {
  console.error('usage: node scripts/consistency-gate.mjs <wasm-nodejs-dir> [<cache-dir>]');
  process.exit(2);
}
const wasmDir = path.resolve(WASM_DIR);
// The COMMITTED cache lives at repo-root `expansions/` (tracked in git — the
// tx-sourced authority). `app/public/data/expansions/` is the GITIGNORED staged
// copy served to the browser for warm start; the gate reads the committed source.
const cacheDir = path.resolve(
  CACHE_DIR_ARG || path.join(path.dirname(new URL(import.meta.url).pathname), '../expansions'),
);

const mod = await import(path.join(wasmDir, 'wasm_api.js'));
// nodejs-target builds auto-init on import; web-target builds need explicit init.
if (typeof mod.default === 'function') {
  const wasmPath = path.join(wasmDir, 'wasm_api_bg.wasm');
  if (fs.existsSync(wasmPath)) {
    await mod.default({ module_or_path: fs.readFileSync(wasmPath) });
  }
}
if (typeof mod.Session !== 'function') {
  console.error('FATAL: wasm module lacks Session (rebuild the wasm)');
  process.exit(2);
}

/** Recursively flatten an expansion's `contains` into a sorted set of `system|code`. */
function memberSet(expansion) {
  const out = new Set();
  const walk = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (c && c.code) out.add(`${c.system ?? ''}|${c.code}`);
      if (c && c.contains) walk(c.contains);
    }
  };
  walk(expansion?.contains);
  return out;
}

/** Compare the tier-1 evaluator's expansion of `vs` (given `refs`) against a
 *  golden `expansion`, on the shared DOMAIN (the `system|code` set). Returns
 *  { ok, detail }. */
function compareOnDomain(vs, refs, goldenExpansion) {
  const env = JSON.parse(mod.Session.global().expandValueSet(JSON.stringify(vs), JSON.stringify(refs ?? [])));
  if (!env.ok) throw new Error(`expandValueSet transport error: ${env.error?.message}`);
  const raw = env.result; // old-export payload verbatim: {ok, expansion, ...} | {ok:false, notEnumerable}
  if (!raw.ok) {
    return { ok: false, detail: `evaluator REFUSED an enumerable golden: ${raw.notEnumerable?.display}` };
  }
  const mine = memberSet(raw.expansion);
  const theirs = memberSet(goldenExpansion);
  const onlyMine = [...mine].filter((k) => !theirs.has(k));
  const onlyTheirs = [...theirs].filter((k) => !mine.has(k));
  if (onlyMine.length || onlyTheirs.length) {
    return {
      ok: false,
      detail: `code-set differs.\n    only in evaluator: ${JSON.stringify(onlyMine)}\n    only in cached golden: ${JSON.stringify(onlyTheirs)}`,
    };
  }
  return { ok: true, detail: `${mine.size} members agree` };
}

let failures = [];
let checked = 0;

// ---- (1) the committed cache on the shared domain ------------------------
let committed = [];
if (fs.existsSync(cacheDir)) {
  committed = fs
    .readdirSync(cacheDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(cacheDir, f), 'utf8')));
}
console.log(`[consistency-gate] committed cache entries: ${committed.length} (dir: ${path.relative(process.cwd(), cacheDir)})`);
for (const entry of committed) {
  // A committed entry must carry the VS it expanded + the local refs, else we
  // can't reproduce it — treat a malformed committed entry as a failure.
  if (!entry.valueSetResource) {
    failures.push(`committed entry ${entry.hash ?? '?'} lacks valueSetResource (cannot reproduce)`);
    continue;
  }
  const res = compareOnDomain(entry.valueSetResource, entry.referencedResources, entry.expansion);
  checked++;
  if (res.ok) console.log(`  [PASS] committed ${entry.valueSet}: ${res.detail}`);
  else failures.push(`committed ${entry.valueSet}: ${res.detail}`);
}

// ---- (2) fixture-based SELF-TEST — proves the plumbing actually compares --
// Bundled fixtures under scripts/fixtures/consistency/. Each `*.case.json` is
// `{ vs, refs, expansion, expectAgree }`: `expectAgree:true` means the evaluator
// MUST match the golden's domain; `expectAgree:false` is a deliberately-wrong
// golden the evaluator MUST NOT match (proving the comparison can fail).
const fixDir = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/consistency');
let selfTests = 0;
if (fs.existsSync(fixDir)) {
  for (const f of fs.readdirSync(fixDir).filter((x) => x.endsWith('.case.json'))) {
    const c = JSON.parse(fs.readFileSync(path.join(fixDir, f), 'utf8'));
    const res = compareOnDomain(c.vs, c.refs, c.expansion);
    selfTests++;
    if (c.expectAgree) {
      if (res.ok) console.log(`  [SELF-TEST PASS] ${f}: agrees as expected (${res.detail})`);
      else failures.push(`self-test ${f}: expected AGREEMENT but ${res.detail}`);
    } else {
      // The comparison MUST detect the mismatch (res.ok === false).
      if (!res.ok) console.log(`  [SELF-TEST PASS] ${f}: correctly REJECTED a wrong golden`);
      else failures.push(`self-test ${f}: expected a DETECTED MISMATCH but the gate said they agree — comparison is broken`);
    }
  }
}
if (selfTests === 0) {
  failures.push('no self-test fixtures found — the gate plumbing is unproven (add scripts/fixtures/consistency/*.case.json)');
}

console.log(`\n[consistency-gate] committed checked: ${checked}, self-tests: ${selfTests}`);
if (failures.length) {
  console.error('CONSISTENCY GATE: FAIL');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('CONSISTENCY GATE: PASS');
process.exit(0);
