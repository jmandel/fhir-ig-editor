import { expect, test } from 'bun:test';
import { fetchGithubIgManifest, loadGithubIg } from '../src/vfs/githubIg';
import { WorkspaceRepository } from '../src/vfs/workspace';

test('GitHub source identity reuses a workspace before fetching file bodies', async () => {
  const commitSha = 'fedcba9876543210fedcba9876543210fedcba98';
  const treeSha = '0123456789abcdef0123456789abcdef01234567';
  const workspaces = await WorkspaceRepository.create();
  const existing = (await workspaces.installSource({
    projectId: 'github-fast-path',
    name: 'GitHub Fast Path',
    sourceIdentity: `github-tree-sha1:${treeSha};root=;selection=publisher-input-v1`,
    files: [{ path: 'sushi-config.yaml', text: 'name: Existing' }],
  })).workspace;
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/commits/')) {
      return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (url.includes('/git/trees/')) {
      return Response.json({
        sha: treeSha,
        truncated: false,
        tree: [
          { path: 'sushi-config.yaml', type: 'blob' },
          { path: 'input/fsh/Profile.fsh', type: 'blob' },
        ],
      });
    }
    throw new Error(`unexpected file-body fetch ${url}`);
  }) as typeof fetch;

  try {
    const loaded = await loadGithubIg(workspaces, 'github-fast-path', {
      owner: 'example',
      repo: 'guide',
      ref: 'main',
    });
    expect(loaded.workspace).toBe(existing);
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => url.includes('api.github.com/'))).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub file bodies are fetched from the resolved commit, not the tree object', async () => {
  const commitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const treeSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/commits/')) {
      return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (url.includes('/git/trees/')) {
      return Response.json({
        sha: treeSha,
        truncated: false,
        tree: [{ path: 'sushi-config.yaml', type: 'blob' }],
      });
    }
    if (url.includes('raw.githubusercontent.com')) {
      return new Response('name: Immutable');
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  try {
    const manifest = await fetchGithubIgManifest({
      owner: 'example',
      repo: 'guide',
      ref: 'main',
    });
    expect(manifest.sourceIdentity)
      .toBe(`github-tree-sha1:${treeSha};root=;selection=publisher-input-v1`);
    expect(requested.find((url) => url.includes('raw.githubusercontent.com')))
      .toContain(`/${commitSha}/sushi-config.yaml`);
    expect(requested.some((url) => url.includes(`/${treeSha}/sushi-config.yaml`))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a dirty GitHub workspace reopens without any network access', async () => {
  const workspaces = await WorkspaceRepository.create();
  const existing = (await workspaces.installSource({
    projectId: 'github-offline-dirty',
    name: 'Offline Edit',
    sourceIdentity: 'github-tree-sha1:old;root=;selection=publisher-input-v1',
    files: [{ path: 'sushi-config.yaml', text: 'name: Original' }],
  })).workspace;
  await existing.write('sushi-config.yaml', 'name: Local Edit');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network must not be used for a dirty reopen');
  }) as typeof fetch;

  try {
    const loaded = await loadGithubIg(workspaces, 'github-offline-dirty', {
      owner: 'example',
      repo: 'guide',
      ref: 'main',
    });
    expect(loaded.workspace).toBe(existing);
    expect(loaded.workspace.read('sushi-config.yaml')).toBe('name: Local Edit');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GitHub subdirectory participates in identity and is encoded by path segment', async () => {
  const commitSha = 'cccccccccccccccccccccccccccccccccccccccc';
  const treeSha = 'dddddddddddddddddddddddddddddddddddddddd';
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/commits/')) {
      return Response.json({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (url.includes('/git/trees/')) {
      return Response.json({
        sha: treeSha,
        truncated: false,
        tree: [{ path: 'guides/a b/sushi-config.yaml', type: 'blob' }],
      });
    }
    if (url.includes('raw.githubusercontent.com')) return new Response('name: Rooted');
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  try {
    const manifest = await fetchGithubIgManifest({
      owner: 'example',
      repo: 'guide',
      ref: 'main',
      root: 'guides/a b',
    });
    expect(manifest.sourceIdentity).toContain('root=guides%2Fa%20b%2F');
    expect(requested.find((url) => url.includes('raw.githubusercontent.com')))
      .toContain('/guides/a%20b/sushi-config.yaml');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
