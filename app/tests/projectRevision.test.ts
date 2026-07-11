import { describe, expect, test } from 'bun:test';

import { projectCompileRevision } from '../src/build/projectRevision';

describe('project compile revision', () => {
  test('is order-independent but changes with every compile input class', async () => {
    const left = {
      config: 'id: demo',
      files: { 'input/fsh/b.fsh': 'B', 'input/fsh/a.fsh': 'A' },
      predefined: { 'input/resources/p.json': { id: 'p', resourceType: 'Patient' } },
      siteFiles: { 'input/images/x.png': 'eA==', 'input/pagecontent/index.md': 'IyBIaQ==' },
      packageClosure: '["example.pkg#1.0.0"]',
    };
    const reordered = {
      config: left.config,
      files: { 'input/fsh/a.fsh': 'A', 'input/fsh/b.fsh': 'B' },
      predefined: { 'input/resources/p.json': { resourceType: 'Patient', id: 'p' } },
      siteFiles: { 'input/pagecontent/index.md': 'IyBIaQ==', 'input/images/x.png': 'eA==' },
      packageClosure: left.packageClosure,
    };
    const original = await projectCompileRevision(left);
    expect(await projectCompileRevision(reordered)).toBe(original);

    for (const changed of [
      { ...left, config: 'id: changed' },
      { ...left, files: { ...left.files, 'input/fsh/a.fsh': 'changed' } },
      { ...left, predefined: { 'input/resources/p.json': { resourceType: 'Patient', id: 'changed' } } },
      { ...left, siteFiles: { ...left.siteFiles, 'input/images/x.png': 'eQ==' } },
      { ...left, packageClosure: '["example.pkg#2.0.0"]' },
      { ...left, packageClosure: JSON.stringify({
        packages: [{ label: 'example.pkg#1.0.0', cacheKey: 'republished-content-key' }],
      }) },
    ]) {
      expect(await projectCompileRevision(changed)).not.toBe(original);
    }
  });
});
