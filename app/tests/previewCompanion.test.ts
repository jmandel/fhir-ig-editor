import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

describe('wide retained preview companion', () => {
  test('keeps exactly one PreviewPane and exposes it only after activation', () => {
    expect(APP.match(/<PreviewPane\b/g)).toHaveLength(1);
    expect(APP).toContain("window.matchMedia('(min-width: 1200px)')");
    expect(APP).toContain("workspaceMode !== 'preview'");
    expect(APP).toContain("activatedModes.has('preview')");
    expect(APP).toContain('Boolean(currentProjectPages)');
    expect(APP).toContain("data-preview-companion={previewCompanion ? 'true' : undefined}");
    expect(APP).toContain('hidden={!previewVisible}');
  });

  test('uses a labelled busy region as a companion and restores focus when hidden', () => {
    expect(APP).toContain("role={previewCompanion ? 'region' : 'tabpanel'}");
    expect(APP).toContain('aria-labelledby="workspace-tab-preview"');
    expect(APP).toContain('aria-busy={siteBuilding}');
    expect(APP).toContain('if (!query.matches) onBeforeNarrowRef.current()');
    expect(APP).toContain("if (workspaceMode === 'preview') return");
    expect(APP).toContain('panel.contains(document.activeElement)');
    expect(APP).toContain('document.getElementById(`workspace-tab-${workspaceMode}`)?.focus()');
  });

  test('splits only the wide companion layout, leaving selected and narrow preview exclusive', () => {
    expect(CSS).toContain('@media (min-width: 1200px)');
    expect(CSS).toContain(".workspace-views[data-preview-companion='true']");
    expect(CSS).toContain('grid-template-columns: minmax(720px, 3fr) minmax(420px, 2fr)');
    expect(CSS).toContain(".workspace-views[data-preview-companion='true'] > .preview-workspace");
  });
});
