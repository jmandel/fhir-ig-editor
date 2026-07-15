#!/usr/bin/env node

/** Fail the production build if Vite collapses either optional capability seam. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const dist = resolve(process.argv[2] || 'app/dist');
const assets = resolve(dist, 'assets');
const names = await readdir(assets);

function exactlyOne(prefix) {
  const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one ${prefix}*.js production chunk, found ${matches.length}`);
  }
  return matches[0];
}

const engineName = exactlyOne('engine.worker-');
const cycleName = exactlyOne('cycleRuntime-');
const reactName = exactlyOne('reactBootstrap-');
const codeEditorName = exactlyOne('CodeEditor-');
const resourceJsonName = exactlyOne('ResourceJson-');
const monacoName = exactlyOne('monacoSetup-');
const editorWorkerName = exactlyOne('editor.worker-');
const jsonWorkerName = exactlyOne('json.worker-');
const enginePath = resolve(assets, engineName);
const cyclePath = resolve(assets, cycleName);
const [
  engine,
  cycle,
  react,
  codeEditor,
  resourceJson,
  indexHtml,
  engineStat,
  cycleStat,
  reactStat,
  monacoStat,
] = await Promise.all([
  readFile(enginePath, 'utf8'),
  readFile(cyclePath, 'utf8'),
  readFile(resolve(assets, reactName), 'utf8'),
  readFile(resolve(assets, codeEditorName), 'utf8'),
  readFile(resolve(assets, resourceJsonName), 'utf8'),
  readFile(resolve(dist, 'index.html'), 'utf8'),
  stat(enginePath),
  stat(cyclePath),
  stat(resolve(assets, reactName)),
  stat(resolve(assets, monacoName)),
]);

if (!engine.includes(cycleName)) {
  throw new Error(`${engineName} has no dynamic import edge to ${cycleName}`);
}
for (const marker of ['react-dom', 'markdown-it', 'renderer-package']) {
  if (engine.includes(marker)) throw new Error(`${engineName} eagerly contains Cycle marker ${marker}`);
  if (!cycle.includes(marker)) throw new Error(`${cycleName} is missing expected Cycle marker ${marker}`);
}
if (engineStat.size >= 256 * 1024) {
  throw new Error(`${engineName} is ${engineStat.size} bytes; the lazy worker entry must stay below 256 KiB`);
}
if (cycleStat.size <= engineStat.size * 4) {
  throw new Error(`${cycleName} no longer contains a meaningfully separate renderer graph`);
}

const eagerReferences = [];
for (const name of names.filter((name) => name.endsWith('.js') && name !== cycleName && name !== engineName)) {
  if ((await readFile(resolve(assets, name), 'utf8')).includes(cycleName)) eagerReferences.push(name);
}
if (indexHtml.includes(cycleName)) {
  eagerReferences.push('index.html');
}
if (eagerReferences.length) {
  throw new Error(`Cycle runtime is eagerly referenced outside the Worker: ${eagerReferences.join(', ')}`);
}

process.stderr.write(
  `[worker-bundle] lazy Cycle boundary: ${engineName} ${engineStat.size} bytes; `
  + `${cycleName} ${cycleStat.size} bytes\n`,
);

if (!react.includes(codeEditorName) || !react.includes(resourceJsonName)) {
  throw new Error(`${reactName} is missing a dynamic Monaco-surface edge`);
}
for (const [name, source] of [
  [codeEditorName, codeEditor],
  [resourceJsonName, resourceJson],
]) {
  if (!source.includes(monacoName)) {
    throw new Error(`${name} does not load the shared ${monacoName} capability`);
  }
}
if (indexHtml.includes(monacoName) || indexHtml.includes(codeEditorName) || indexHtml.includes(resourceJsonName)) {
  throw new Error('index.html eagerly preloads a Monaco capability chunk');
}
if (reactStat.size >= 512 * 1024) {
  throw new Error(`${reactName} is ${reactStat.size} bytes; Monaco has leaked into the eager React graph`);
}
if (monacoStat.size <= reactStat.size * 4) {
  throw new Error(`${monacoName} is no longer a meaningfully separate editor capability`);
}

function staticImports(source) {
  const imports = [];
  const pattern = /\bimport(?!\s*\()(?:[^"'();]*?\bfrom\s*)?["']\.\/([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

const eagerReactClosure = new Set();
const pendingStaticImports = [reactName];
while (pendingStaticImports.length) {
  const name = pendingStaticImports.pop();
  if (eagerReactClosure.has(name)) continue;
  eagerReactClosure.add(name);
  const source = await readFile(resolve(assets, name), 'utf8');
  for (const dependency of staticImports(source)) {
    if (names.includes(dependency)) pendingStaticImports.push(dependency);
  }
}
for (const lazyName of [codeEditorName, resourceJsonName, monacoName]) {
  if (eagerReactClosure.has(lazyName)) {
    throw new Error(`${lazyName} is statically reachable from ${reactName}`);
  }
}

for (const workerName of [editorWorkerName, jsonWorkerName]) {
  const owners = [];
  for (const name of names.filter((candidate) => candidate.endsWith('.js'))) {
    if ((await readFile(resolve(assets, name), 'utf8')).includes(workerName)) owners.push(name);
  }
  if (owners.length !== 1 || owners[0] !== monacoName) {
    throw new Error(`${workerName} must be rooted only by ${monacoName}; found ${owners.join(', ')}`);
  }
}

process.stderr.write(
  `[worker-bundle] lazy Monaco boundary: ${reactName} ${reactStat.size} bytes; `
  + `${monacoName} ${monacoStat.size} bytes\n`,
);
