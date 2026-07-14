import { expect, test } from 'bun:test';
import {
  definitionsArePending,
  deriveBuildState,
  settledBuildStatus,
  summarizeProject,
} from '../src/views/ProjectOverview';

test('build state distinguishes initial, rebuilding, stale, ready, and failed output', () => {
  expect(deriveBuildState({ previewStale: false, compiling: false, siteBuilding: false, hasPublishedPreview: false, hasError: false })).toBe('checking');
  expect(deriveBuildState({ previewStale: false, compiling: true, siteBuilding: true, hasPublishedPreview: false, hasError: false })).toBe('building');
  expect(deriveBuildState({ previewStale: false, compiling: false, siteBuilding: false, hasPublishedPreview: true, hasError: false })).toBe('ready');
  expect(deriveBuildState({ previewStale: true, compiling: false, siteBuilding: false, hasPublishedPreview: true, hasError: false })).toBe('stale');
  expect(deriveBuildState({ previewStale: false, compiling: true, siteBuilding: true, hasPublishedPreview: true, hasError: false })).toBe('rebuilding');
  expect(deriveBuildState({ previewStale: true, compiling: false, siteBuilding: false, hasPublishedPreview: false, hasError: true })).toBe('failed');
  expect(deriveBuildState({ previewStale: true, compiling: false, siteBuilding: false, hasPublishedPreview: true, hasError: true })).toBe('failed-preview');
});

test('a settled project without a current preview is checking, never ready', () => {
  expect(settledBuildStatus('checking', 'Demo')).toBe('Checking the current project…');
  expect(settledBuildStatus('ready', 'Demo')).toBe('Demo ready.');
});

test('missing definitions are pending until the first compile answers, never zero', () => {
  expect(definitionsArePending('checking', 0)).toBe(true);
  expect(definitionsArePending('building', 0)).toBe(true);
  expect(definitionsArePending('rebuilding', 0)).toBe(true);
  expect(definitionsArePending('rebuilding', 4)).toBe(false);
  expect(definitionsArePending('failed', 0)).toBe(false);
  expect(definitionsArePending('ready', 4)).toBe(false);
});

test('overview groups existing compile/catalog presentation data without another manifest', () => {
  const summary = summarizeProject(
    ['sushi-config.yaml', 'input/fsh/demo.fsh', 'input/pagecontent/index.md'],
    [
      { filename: 'ImplementationGuide-guide.json', text: '{"fhirVersion":["4.0.1"]}', resourceType: 'ImplementationGuide', id: 'guide' },
      { filename: 'StructureDefinition-profile.json', text: '{"type":"Patient"}', resourceType: 'StructureDefinition', id: 'profile' },
      { filename: 'StructureDefinition-extension.json', text: '{"type":"Extension"}', resourceType: 'StructureDefinition', id: 'extension' },
      { filename: 'ValueSet-vs.json', text: '{}', resourceType: 'ValueSet', id: 'vs' },
    ],
    [
      { path: 'en/index.html', kind: 'page', mediaType: 'text/html', pageKind: 'narrative' },
      { path: 'en/Patient-example.html', kind: 'page', mediaType: 'text/html', pageKind: 'example' },
    ],
    [{ severity: 'warning', message: 'example' }],
  );
  expect(summary).toMatchObject({
    fhirVersion: '4.0.1',
    files: 3,
    profiles: 1,
    extensions: 1,
    valueSets: 1,
    examples: 1,
    pages: 2,
    errors: 0,
    warnings: 1,
  });
});
