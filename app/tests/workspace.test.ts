import { describe, expect, test } from 'bun:test';
import { WorkspaceRepository } from '../src/vfs/workspace';

async function install(
  workspaces: WorkspaceRepository,
  projectId: string,
  files: Array<{ path: string; text: string }>,
  sourceIdentity = `source:${projectId}`,
) {
  return (await workspaces.installSource({
    projectId,
    name: projectId,
    sourceIdentity,
    files,
  })).workspace;
}

describe('project workspace and immutable revision', () => {
  test('predefined objects and raw site bytes come from the same authored files', async () => {
    const workspaces = await WorkspaceRepository.create();
    const workspace = await install(workspaces, 'resources', [{
      path: 'input/resources/Patient-p.json',
      text: '{ "id": "p", "resourceType": "Patient" }',
    }]);
    const captured = workspace.capture(1);

    expect(captured.revision.predefined).toEqual({
      'input/resources/Patient-p.json': { id: 'p', resourceType: 'Patient' },
    });
    expect(captured.revision.siteFiles['input/resources/Patient-p.json']).toBeTruthy();
    expect(captured.predefinedDisplay[0]).toMatchObject({
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

  test('malformed authored JSON fails instead of disappearing from revision input', async () => {
    const workspaces = await WorkspaceRepository.create();
    const workspace = await install(workspaces, 'malformed', [
      { path: 'input/resources/bad.json', text: '{' },
    ]);
    expect(() => workspace.capture(1)).toThrow();
  });

  test('resources and examples share one exact local-resource input without losing source ownership', async () => {
    const workspaces = await WorkspaceRepository.create();
    const workspace = await install(workspaces, 'examples', [
      {
        path: 'input/resources/Patient-shared.json',
        text: '{"resourceType":"Patient","id":"definition"}',
      },
      {
        path: 'input/examples/Patient-shared.json',
        text: '{"resourceType":"Patient","id":"example"}',
      },
    ]);
    const captured = workspace.capture(1);

    expect(captured.revision.predefined).toEqual({
      'input/examples/Patient-shared.json': { resourceType: 'Patient', id: 'example' },
      'input/resources/Patient-shared.json': { resourceType: 'Patient', id: 'definition' },
    });
    expect(Object.keys(captured.revision.siteFiles).sort()).toEqual([
      'input/examples/Patient-shared.json',
      'input/resources/Patient-shared.json',
    ]);
    expect(captured.predefinedDisplay.map((resource) => resource.definition?.path).sort())
      .toEqual([
        'input/examples/Patient-shared.json',
        'input/resources/Patient-shared.json',
      ]);
  });

  test('PreparedGuide receives the complete authored Publisher input roots', async () => {
    const workspaces = await WorkspaceRepository.create();
    const workspace = await install(workspaces, 'authored', [
      { path: 'input/pagecontent/index.md', text: '# Home' },
      { path: 'input/pages/secondary.md', text: '# Secondary' },
      { path: 'input/intro-notes/StructureDefinition-p-intro.md', text: 'Intro' },
      { path: 'input/resource-docs/StructureDefinition-p-notes.md', text: 'Notes' },
      { path: 'input/includes/custom.xhtml', text: '<p>Custom</p>' },
      { path: 'input/data/table.csv', text: 'a,b' },
      { path: 'input/examples/Patient-example.json', text: '{"resourceType":"Patient","id":"example"}' },
      { path: 'input/images-source/diagram.plantuml', text: '@startuml\n@enduml' },
    ]);
    expect(Object.keys(workspace.capture(1).revision.siteFiles).sort()).toEqual([
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

  test('A -> B -> A preserves the exact dirty A workspace and binary assets', async () => {
    const workspaces = await WorkspaceRepository.create();
    const a = (await workspaces.installSource({
      projectId: 'a',
      name: 'A',
      sourceIdentity: 'source:a',
      files: [{ path: 'sushi-config.yaml', text: 'name: A' }],
      binaryFiles: [{ path: 'input/images/logo.png', base64: 'iVBORw0KGgo=' }],
    })).workspace;
    await a.write('sushi-config.yaml', 'name: Edited A');
    await install(workspaces, 'b', [{ path: 'sushi-config.yaml', text: 'name: B' }]);

    const reopened = await workspaces.open('a');
    expect(reopened).toBe(a);
    expect(reopened?.read('sushi-config.yaml')).toBe('name: Edited A');
    expect(reopened?.sourceIdentity).toBe('source:a');
    expect(reopened?.dirty).toBe(true);
    expect(reopened?.capture(1).revision.siteFiles['input/images/logo.png']).toBe('iVBORw0KGgo=');
  });

  test('a captured revision is immutable and remains bound to its workspace id', async () => {
    const workspaces = await WorkspaceRepository.create();
    const workspace = await install(workspaces, 'revision-a', [
      { path: 'sushi-config.yaml', text: 'name: Before' },
      { path: 'input/fsh/a.fsh', text: 'Profile: Before' },
    ]);
    const captured = workspace.capture(1700000000).revision;
    await workspace.write('input/fsh/a.fsh', 'Profile: After');

    expect(captured.projectId).toBe('revision-a');
    expect(captured.files['input/fsh/a.fsh']).toBe('Profile: Before');
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen(captured.files)).toBe(true);
  });

  test('an invalid replacement is rejected without replacing the committed workspace', async () => {
    const workspaces = await WorkspaceRepository.create();
    const committed = await install(workspaces, 'transactional', [
      { path: 'sushi-config.yaml', text: 'name: Committed' },
    ]);
    await expect(workspaces.installSource({
      projectId: 'transactional',
      name: 'Broken',
      sourceIdentity: 'source:broken',
      files: [
        { path: 'sushi-config.yaml', text: 'name: Broken' },
        { path: 'sushi-config.yaml', text: 'name: Duplicate' },
      ],
    })).rejects.toThrow('duplicate workspace path');

    expect(await workspaces.open('transactional')).toBe(committed);
    expect(committed.read('sushi-config.yaml')).toBe('name: Committed');
  });

  test('an explicitly observed empty workspace can install its first source generation', async () => {
    const workspaces = await WorkspaceRepository.create();
    const result = await workspaces.installSource({
      projectId: 'first-open',
      name: 'First Open',
      sourceIdentity: 'source:first-open',
      files: [{ path: 'sushi-config.yaml', text: 'name: First Open' }],
    }, { replace: null });

    expect(result.installed).toBe(true);
    expect(result.workspace.projectId).toBe('first-open');
    expect(result.workspace.read('sushi-config.yaml')).toBe('name: First Open');
  });

  test('an edit made while replacement source is in flight wins deterministically', async () => {
    const workspaces = await WorkspaceRepository.create();
    const existing = await install(workspaces, 'race', [
      { path: 'sushi-config.yaml', text: 'name: Original' },
    ], 'source:original');

    let releaseSource!: (source: Parameters<WorkspaceRepository['installSource']>[0]) => void;
    const sourceInFlight = new Promise<Parameters<WorkspaceRepository['installSource']>[0]>((resolve) => {
      releaseSource = resolve;
    });
    const replacement = sourceInFlight.then((source) => (
      workspaces.installSource(source, { replace: existing })
    ));

    await existing.write('sushi-config.yaml', 'name: Edited While Downloading');
    releaseSource({
      projectId: 'race',
      name: 'Downloaded Replacement',
      sourceIdentity: 'source:replacement',
      files: [{ path: 'sushi-config.yaml', text: 'name: Replacement' }],
    });

    const result = await replacement;
    expect(result.installed).toBe(false);
    expect(result.workspace).toBe(existing);
    expect(await workspaces.open('race')).toBe(existing);
    expect(existing.read('sushi-config.yaml')).toBe('name: Edited While Downloading');
    expect(existing.sourceIdentity).toBe('source:original');
    expect(existing.dirty).toBe(true);
  });

  test('concurrent first installs cannot let a losing rollback erase the committed source', async () => {
    const workspaces = await WorkspaceRepository.create();
    const source = (name: string) => ({
      projectId: 'concurrent-first-open',
      name,
      sourceIdentity: `source:${name}`,
      files: [{ path: 'sushi-config.yaml', text: `name: ${name}` }],
    });
    const results = await Promise.all([
      workspaces.installSource(source('A'), { replace: null }),
      workspaces.installSource(source('B'), { replace: null }),
    ]);

    expect(results.filter((result) => result.installed)).toHaveLength(1);
    const committed = results.find((result) => result.installed)!.workspace;
    expect(results.every((result) => result.workspace === committed)).toBe(true);
    (workspaces as unknown as { workspaces: Map<string, unknown> }).workspaces.clear();
    const reopened = await workspaces.open('concurrent-first-open');
    expect(reopened?.sourceIdentity).toBe(committed.sourceIdentity);
    expect(reopened?.read('sushi-config.yaml')).toBe(committed.read('sushi-config.yaml'));
  });

  test('a stale replacement condition cannot overwrite a newer source generation', async () => {
    const workspaces = await WorkspaceRepository.create();
    const observed = await install(workspaces, 'stale-replacement', [
      { path: 'sushi-config.yaml', text: 'name: Old' },
    ], 'source:old');
    const newer = await workspaces.installSource({
      projectId: 'stale-replacement',
      name: 'New',
      sourceIdentity: 'source:new',
      files: [{ path: 'sushi-config.yaml', text: 'name: New' }],
    }, { replace: observed });
    const stale = await workspaces.installSource({
      projectId: 'stale-replacement',
      name: 'Stale',
      sourceIdentity: 'source:stale',
      files: [{ path: 'sushi-config.yaml', text: 'name: Stale' }],
    }, { replace: observed });

    expect(newer.installed).toBe(true);
    expect(newer.workspace).not.toBe(observed);
    expect(stale.installed).toBe(false);
    expect(stale.workspace).toBe(newer.workspace);
    expect((await workspaces.open('stale-replacement'))?.sourceIdentity).toBe('source:new');
  });

  test('concurrent open calls return one mutable Workspace owner', async () => {
    const workspaces = await WorkspaceRepository.create();
    await install(workspaces, 'single-owner', [
      { path: 'sushi-config.yaml', text: 'name: Single Owner' },
    ]);
    (workspaces as unknown as { workspaces: Map<string, unknown> }).workspaces.clear();

    const [left, right] = await Promise.all([
      workspaces.open('single-owner'),
      workspaces.open('single-owner'),
    ]);
    expect(left).toBe(right);
  });
});
