// Loaded only after the page-process EngineClient exists. App remains a normal
// React refresh boundary; this module owns only the root mount.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { EngineStartup } from './worker/engineStartup';

export function mountEditor(root: HTMLElement, startup: EngineStartup): void {
  createRoot(root).render(
    <React.StrictMode>
      <App startup={startup} />
    </React.StrictMode>,
  );
}
