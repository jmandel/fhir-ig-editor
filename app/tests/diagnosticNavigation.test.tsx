import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ArtifactTrail } from '../src/views/ArtifactTrail';
import { DiagnosticsPanel } from '../src/views/DiagnosticsPanel';
import { summarizeSiteError } from '../src/views/PreviewPane';
import type { CompiledResource, Diagnostic } from '../src/worker/protocol';

const resource: CompiledResource = {
  filename: 'StructureDefinition-demo.json',
  text: '{}',
  resourceType: 'StructureDefinition',
  id: 'demo',
  definition: {
    kind: 'fsh-declaration',
    path: 'input/fsh/Profile.fsh',
    line: 1,
    column: 0,
  },
};

const page = {
  path: 'en/StructureDefinition-demo.html',
  kind: 'page' as const,
  mediaType: 'text/html',
  subject: { resourceType: 'StructureDefinition', id: 'demo' },
  subjectPage: 'primary' as const,
};

test('owned diagnostics expose exact source, definition, and published consequence actions', () => {
  const diagnostic: Diagnostic = {
    severity: 'error',
    message: 'Unable to find definition for RuleSet Missing.',
    file: 'input/fsh/Profile.fsh',
    line: 3,
    ownerDefinition: resource.definition,
  };
  const html = renderToStaticMarkup(
    <DiagnosticsPanel
      diagnostics={[diagnostic]}
      resources={[resource]}
      pages={[page]}
      publishedLabel="Previous published page"
      onNavigate={() => undefined}
      onOpenDefinition={() => undefined}
      onOpenPreview={() => undefined}
    />,
  );
  expect(html).toContain('<button type="button" class="diag-source"');
  expect(html).toContain('input/fsh/Profile.fsh:3');
  expect(html).toContain('Definition</button>');
  expect(html).toContain('Previous published page</button>');
});

test('unattributed diagnostics never invent definition or preview ownership', () => {
  const html = renderToStaticMarkup(
    <DiagnosticsPanel
      diagnostics={[{ severity: 'warning', message: 'Global warning', file: 'sushi-config.yaml', line: 1 }]}
      resources={[resource]}
      pages={[page]}
      publishedLabel="Published page"
      onNavigate={() => undefined}
      onOpenDefinition={() => undefined}
      onOpenPreview={() => undefined}
    />,
  );
  expect(html).toContain('sushi-config.yaml:1');
  expect(html).not.toContain('Definition</button>');
  expect(html).not.toContain('Published page</button>');
});

test('artifact trail marks only the actually displayed view as current', () => {
  const html = renderToStaticMarkup(
    <ArtifactTrail
      resource={resource}
      page={page}
      currentMode="preview"
      activeSourcePath="input/fsh/Profile.fsh"
      selectedPagePath={page.path}
      onOpenSource={() => undefined}
      onOpenDefinition={() => undefined}
      onOpenPreview={() => undefined}
    />,
  );
  expect(html.match(/aria-current="step"/g)).toHaveLength(1);
  expect(html).toContain('Published page');
});

test('site errors present one useful line before technical stack details', () => {
  expect(summarizeSiteError('Error: dependency package is missing\n    at prepare (worker.js:1:2)'))
    .toBe('dependency package is missing');
  expect(summarizeSiteError('Error: Error: dependency package is missing at $ (worker.js:1:2)'))
    .toBe('dependency package is missing');
});
