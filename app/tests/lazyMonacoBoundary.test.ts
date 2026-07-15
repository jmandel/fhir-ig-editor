import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const INSPECTOR = readFileSync(new URL('../src/views/ResourceInspector.tsx', import.meta.url), 'utf8');
const CODE_EDITOR = readFileSync(new URL('../src/editor/CodeEditor.tsx', import.meta.url), 'utf8');
const RESOURCE_JSON = readFileSync(new URL('../src/views/ResourceJson.tsx', import.meta.url), 'utf8');
const LAZY_PANE = readFileSync(new URL('../src/views/LazyPane.tsx', import.meta.url), 'utf8');

describe('lazy Monaco capability boundary', () => {
  test('loads Monaco only when Author or compiled JSON is rendered', () => {
    expect(APP).not.toMatch(/import\s+\{\s*CodeEditor\s*\}\s+from/u);
    expect(APP).toContain("import('./editor/CodeEditor')");
    expect(APP).toContain('<LazyPane loading="Loading source editor…">');

    expect(INSPECTOR).not.toMatch(/import\s+\{\s*ResourceJson\s*\}\s+from/u);
    expect(INSPECTOR).toContain("import('./ResourceJson')");
    expect(INSPECTOR).toContain("effectiveTab === 'json'");
    expect(INSPECTOR).toContain('<LazyPane loading="Loading JSON viewer…">');

    expect(CODE_EDITOR).toContain("from '@monaco-editor/react'");
    expect(RESOURCE_JSON).toContain("from '@monaco-editor/react'");
  });

  test('contains loading and import failure inside the active pane', () => {
    expect(LAZY_PANE).toContain('<Suspense fallback=');
    expect(LAZY_PANE).toContain('static getDerivedStateFromError');
    expect(LAZY_PANE).toContain('role="alert"');
    expect(LAZY_PANE).toContain('window.location.reload()');
  });
});
