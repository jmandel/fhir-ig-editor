import { describe, expect, spyOn, test } from 'bun:test';
import type { BuildEvent } from '../src/worker/protocol';
import { WorkspaceStartup } from '../src/vfs/workspaceStartup';

describe('page-process workspace startup owner', () => {
  test('single-flights repository creation and a project read across remounts', async () => {
    let createCalls = 0;
    let openCalls = 0;
    const events: BuildEvent[] = [];
    const repository = {
      async open(_projectId: string) {
        openCalls += 1;
        return null;
      },
    };
    const startup = new WorkspaceStartup(async () => {
      createCalls += 1;
      return repository;
    });

    const first = startup.open('tiny', (event) => events.push(event));
    const remount = startup.open('tiny', (event) => events.push(event));
    expect(remount).toBe(first);
    const [one, two] = await Promise.all([first, remount]);

    expect(one).toBe(two);
    expect(one.repository).toBe(repository);
    expect(one.workspace).toBeNull();
    expect(createCalls).toBe(1);
    expect(openCalls).toBe(1);
    expect(events.map((event) => event.phase)).toEqual([
      'workspace.repository-open',
      'workspace.open',
    ]);
  });

  test('shares one repository while opening distinct initial project keys', async () => {
    let createCalls = 0;
    const opened: string[] = [];
    const repository = {
      async open(projectId: string) {
        opened.push(projectId);
        return null;
      },
    };
    const startup = new WorkspaceStartup(async () => {
      createCalls += 1;
      return repository;
    });

    await Promise.all([
      startup.open('tiny', () => {}),
      startup.open('ips', () => {}),
    ]);

    expect(createCalls).toBe(1);
    expect(opened.sort()).toEqual(['ips', 'tiny']);
  });

  test('does not create a second owner after a startup failure', async () => {
    let createCalls = 0;
    const failure = new Error('OPFS unavailable');
    const startup = new WorkspaceStartup(async () => {
      createCalls += 1;
      throw failure;
    });

    const first = startup.open('tiny', () => {});
    const remount = startup.open('tiny', () => {});
    expect(remount).toBe(first);
    await expect(first).rejects.toBe(failure);
    await expect(remount).rejects.toBe(failure);
    expect(createCalls).toBe(1);
  });

  test('an observation failure cannot poison repository or workspace ownership', async () => {
    let openCalls = 0;
    const repository = {
      async open(_projectId: string) {
        openCalls += 1;
        return null;
      },
    };
    const startup = new WorkspaceStartup(async () => repository);

    const errorLog = spyOn(console, 'error').mockImplementation(() => {});
    await expect(startup.open('tiny', () => {
      throw new Error('broken metric sink');
    })).resolves.toEqual({ repository, workspace: null });
    expect(errorLog).toHaveBeenCalledTimes(2);
    errorLog.mockRestore();
    await expect(startup.open('tiny', () => {})).resolves.toEqual({ repository, workspace: null });
    expect(openCalls).toBe(1);
  });
});
