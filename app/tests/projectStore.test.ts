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
  });

  test('malformed authored JSON fails instead of disappearing from predefined input', async () => {
    const store = await ProjectStore.create();
    await store.loadAll([{ path: 'input/resources/bad.json', text: '{' }]);
    expect(() => store.predefinedResources()).toThrow();
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
