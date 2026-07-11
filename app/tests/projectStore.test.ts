import { describe, expect, test } from 'bun:test';
import { ProjectStore } from '../src/vfs/store';

describe('project resource source authority', () => {
  test('predefined objects and raw site bytes come from the same authored files', async () => {
    const store = await ProjectStore.create();
    await store.loadAll([{
      path: 'input/resources/Patient-p.json',
      text: '{ "id": "p", "resourceType": "Patient" }',
    }]);

    expect(store.predefinedResources()).toEqual({
      'input/resources/Patient-p.json': { id: 'p', resourceType: 'Patient' },
    });
    expect(store.siteFiles()['input/resources/Patient-p.json']).toBeTruthy();
    expect(store.predefinedDisplayResources()[0]).toMatchObject({
      filename: 'Patient-p.json',
      resourceType: 'Patient',
      id: 'p',
      definition: {
        kind: 'predefined-resource',
        path: 'input/resources/Patient-p.json',
        line: 1,
        column: 0,
      },
    });
  });

  test('malformed authored JSON fails instead of disappearing from predefined input', async () => {
    const store = await ProjectStore.create();
    await store.loadAll([{ path: 'input/resources/bad.json', text: '{' }]);
    expect(() => store.predefinedResources()).toThrow();
  });

  test('resources and examples share one exact local-resource input without losing source ownership', async () => {
    const store = await ProjectStore.create();
    await store.loadAll([
      {
        path: 'input/resources/Patient-shared.json',
        text: '{"resourceType":"Patient","id":"definition"}',
      },
      {
        path: 'input/examples/Patient-shared.json',
        text: '{"resourceType":"Patient","id":"example"}',
      },
    ]);

    expect(store.predefinedResources()).toEqual({
      'input/examples/Patient-shared.json': { resourceType: 'Patient', id: 'example' },
      'input/resources/Patient-shared.json': { resourceType: 'Patient', id: 'definition' },
    });
    expect(Object.keys(store.siteFiles()).sort()).toEqual([
      'input/examples/Patient-shared.json',
      'input/resources/Patient-shared.json',
    ]);
    expect(store.predefinedDisplayResources().map((resource) => resource.definition.path).sort())
      .toEqual([
        'input/examples/Patient-shared.json',
        'input/resources/Patient-shared.json',
      ]);
  });

  test('PreparedGuide receives the complete authored Publisher input roots', async () => {
    const store = await ProjectStore.create();
    await store.loadAll([
      { path: 'input/pagecontent/index.md', text: '# Home' },
      { path: 'input/pages/secondary.md', text: '# Secondary' },
      { path: 'input/intro-notes/StructureDefinition-p-intro.md', text: 'Intro' },
      { path: 'input/resource-docs/StructureDefinition-p-notes.md', text: 'Notes' },
      { path: 'input/includes/custom.xhtml', text: '<p>Custom</p>' },
      { path: 'input/data/table.csv', text: 'a,b' },
      { path: 'input/examples/Patient-example.json', text: '{"resourceType":"Patient","id":"example"}' },
      { path: 'input/images-source/diagram.plantuml', text: '@startuml\n@enduml' },
    ]);
    const files = Object.keys(store.siteFiles()).sort();
    expect(files).toEqual([
      'input/data/table.csv',
      'input/examples/Patient-example.json',
      'input/images-source/diagram.plantuml',
      'input/includes/custom.xhtml',
      'input/intro-notes/StructureDefinition-p-intro.md',
      'input/pagecontent/index.md',
      'input/pages/secondary.md',
      'input/resource-docs/StructureDefinition-p-notes.md',
    ]);
  });

  test('an exact immutable source is reused with its binary assets until edited', async () => {
    const store = await ProjectStore.create();
    const identity = `catalog-source-sha256:${'a'.repeat(64)}`;
    const first = await store.loadAll(
      [{ path: 'sushi-config.yaml', text: 'name: Example' }],
      [{ path: 'input/images/logo.png', base64: 'iVBORw0KGgo=' }],
      identity,
    );
    expect(first.reused).toBe(false);
    expect(store.siteFiles()['input/images/logo.png']).toBe('iVBORw0KGgo=');

    const second = await store.loadAll([], [], identity);
    expect(second.reused).toBe(true);
    expect(store.read('sushi-config.yaml')).toBe('name: Example');
    expect(store.siteFiles()['input/images/logo.png']).toBe('iVBORw0KGgo=');

    await store.write('sushi-config.yaml', 'name: Edited');
    expect(store.hasSource(identity)).toBe(false);
  });
});
