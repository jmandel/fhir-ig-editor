import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const SOURCE = readFileSync(
  new URL('../../scripts/preview-runtime-closure.mjs', import.meta.url),
  'utf8',
);

describe('Publisher preview compatibility ownership', () => {
  test('requires the renderer-owned compatibility output, not an editor patch', () => {
    expect(SOURCE).toContain('[data-producer="publisher-runtime"]');
    expect(SOURCE).not.toContain('[data-producer="editor-jquery-compat"]');
    expect(SOURCE).toContain('jqueryPreviewScriptOrder');
    expect(SOURCE).toContain('jqueryAjaxShimActive');
  });
});
