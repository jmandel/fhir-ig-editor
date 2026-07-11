import { expect, test } from 'bun:test';
import {
  mergeResourcesByIdentity,
  primaryPageForResource,
  resourceIdentity,
  resourceForSubject,
  soleResourceDeclaredIn,
} from '../src/views/artifactSelection';
import type { CompiledResource } from '../src/worker/protocol';

const resources: CompiledResource[] = [
  {
    filename: 'StructureDefinition-patient.json',
    text: '{}',
    resourceType: 'StructureDefinition',
    id: 'patient',
    definition: { kind: 'fsh-declaration', path: 'input/fsh/profiles.fsh', line: 3, column: 0 },
  },
  {
    filename: 'ValueSet-status.json',
    text: '{}',
    resourceType: 'ValueSet',
    id: 'status',
    definition: { kind: 'fsh-declaration', path: 'input/fsh/terminology.fsh', line: 8, column: 0 },
  },
];

test('joins definition and renderer page only through an exact resource subject', () => {
  const resource = resourceForSubject(resources, { resourceType: 'StructureDefinition', id: 'patient' });
  expect(resource?.definition?.line).toBe(3);
  expect(primaryPageForResource([
    { path: 'renamed-details.html', kind: 'page', mediaType: 'text/html', subject: { resourceType: 'StructureDefinition', id: 'patient' }, subjectPage: 'companion' },
    { path: 'configured-landing.html', kind: 'page', mediaType: 'text/html', subject: { resourceType: 'StructureDefinition', id: 'patient' }, subjectPage: 'primary' },
  ], resource)?.path).toBe('configured-landing.html');
});

test('fails closed rather than guessing a page or ambiguous source declaration', () => {
  expect(primaryPageForResource([
    { path: 'StructureDefinition-patient.html', kind: 'page', mediaType: 'text/html' },
  ], resources[0])).toBeNull();
  expect(soleResourceDeclaredIn([...resources, { ...resources[1], filename: 'ValueSet-other.json', id: 'other' }], 'input/fsh/terminology.fsh')).toBeNull();
  expect(soleResourceDeclaredIn(resources, 'input/fsh/profiles.fsh')?.id).toBe('patient');
});

test('selection identity is exact subject plus source, never an output filename', () => {
  const sameFilenameDifferentArtifact: CompiledResource = {
    ...resources[1],
    filename: resources[0].filename,
  };
  expect(resourceIdentity(sameFilenameDifferentArtifact)).not.toBe(resourceIdentity(resources[0]));

  const renamedSameArtifact: CompiledResource = {
    ...resources[0],
    filename: 'publisher-renamed-output.json',
  };
  expect(resourceIdentity(renamedSameArtifact)).toBe(resourceIdentity(resources[0]));
  expect(mergeResourcesByIdentity([resources[0]], [renamedSameArtifact, sameFilenameDifferentArtifact]))
    .toEqual([resources[0], sameFilenameDifferentArtifact]);
});

test('subject and page collisions fail closed instead of choosing the first match', () => {
  const secondDeclaration: CompiledResource = {
    ...resources[0],
    // Same subject and basename, but a distinct exact authored source.
    filename: resources[0].filename,
    definition: {
      kind: 'predefined-resource',
      path: 'input/examples/nested/StructureDefinition-patient.json',
      line: 1,
      column: 0,
    },
  };
  expect(resourceIdentity(secondDeclaration)).not.toBe(resourceIdentity(resources[0]));
  expect(mergeResourcesByIdentity([resources[0]], [secondDeclaration])).toHaveLength(2);
  expect(resourceForSubject([...resources, secondDeclaration], {
    resourceType: 'StructureDefinition',
    id: 'patient',
  })).toBeNull();
  expect(primaryPageForResource([
    { path: 'one.html', kind: 'page', mediaType: 'text/html', subject: { resourceType: 'StructureDefinition', id: 'patient' }, subjectPage: 'primary' },
    { path: 'two.html', kind: 'page', mediaType: 'text/html', subject: { resourceType: 'StructureDefinition', id: 'patient' }, subjectPage: 'primary' },
  ], resources[0])).toBeNull();
});
