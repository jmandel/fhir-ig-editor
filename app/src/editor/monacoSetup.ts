// Wire @monaco-editor/react to the LOCALLY bundled monaco-editor instead of its
// default CDN loader — the whole app must work offline (spec §1). We also point
// Monaco's web workers at Vite-bundled worker entry points via
// MonacoEnvironment.getWorker, so no worker is fetched from a CDN either.

import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// Vite `?worker` imports give us bundled worker constructors. We only need the
// editor (base) worker + JSON worker (for the resource-JSON view); FSH uses a
// Monarch tokenizer that runs on the main thread, so no language worker.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

let configured = false;

export function configureMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      if (label === 'json') return new JsonWorker();
      return new EditorWorker();
    },
  };

  // Hand @monaco-editor/react our local instance (skips the CDN fetch).
  loader.config({ monaco });

  // Expose the instance for E2E driving / debugging (harmless in prod).
  (self as unknown as { monaco?: typeof monaco }).monaco = monaco;

  return monaco;
}
