// Tiny page bootstrap: create the engine owner before loading or evaluating the
// React/editor graph. The static shell remains visible until that graph commits.

import { engineStartup } from './worker/engineStartup';
import type { BuildEvent } from './worker/protocol';
import './styles.css';

const mainStartedMs = performance.timeOrigin + performance.now();
const bootstrapTiming = {
  navigationStartedMs: performance.timeOrigin,
  mainStartedMs,
  appModuleStartedMs: 0,
  appModuleReadyMs: 0,
  reactRenderStartedMs: 0,
};
(window as unknown as { __igBootstrapTiming?: typeof bootstrapTiming }).__igBootstrapTiming = bootstrapTiming;

// Install the process observation sink before replaying startup events that may
// already have occurred during dependency-module evaluation.
const metrics: Array<{ at: number; event: BuildEvent }> = [];
(window as unknown as { __igDebug?: unknown }).__igDebug = {
  engine: engineStartup.engine,
  metrics,
};
engineStartup.subscribe((event) => {
  metrics.push({ at: performance.now(), event });
});

const root = document.getElementById('root');
if (!root) throw new Error('editor root element is missing');
const rootElement = root;

function replaceWithStartupShell(message: string, error = false): void {
  const shell = document.createElement('div');
  shell.className = 'app startup-shell';
  const body = document.createElement('div');
  body.className = error ? 'open-error' : 'lazy-progress';
  body.setAttribute(error ? 'role' : 'aria-live', error ? 'alert' : 'polite');
  if (error) {
    const copy = document.createElement('div');
    copy.className = 'open-error-body';
    copy.textContent = message;
    const actions = document.createElement('div');
    actions.className = 'open-error-actions';
    const reload = document.createElement('button');
    reload.className = 'btn';
    reload.type = 'button';
    reload.textContent = 'Reload editor';
    reload.addEventListener('click', () => window.location.reload());
    actions.append(reload);
    body.append(copy, actions);
  } else body.textContent = message;
  shell.append(body);
  rootElement.replaceChildren(shell);
}

replaceWithStartupShell('Starting FHIR IG Editor…');

// Worker/WASM initialization is already in flight. React, ReactDOM, and the
// complete editor now load as one independent UI graph beside it.
bootstrapTiming.appModuleStartedMs = performance.timeOrigin + performance.now();
void import('./reactBootstrap').then(({ mountEditor }) => {
  bootstrapTiming.appModuleReadyMs = performance.timeOrigin + performance.now();
  bootstrapTiming.reactRenderStartedMs = performance.timeOrigin + performance.now();
  mountEditor(rootElement, engineStartup);
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  engineStartup.dispose(new Error(`editor application module failed: ${message}`, {
    cause: error,
  }));
  replaceWithStartupShell(`Couldn't load the editor: ${message}`, true);
});
