import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');

function members(label: string): string[] {
  const archive = resolve(ROOT, `public/data/bundles/${label}.tgz`);
  expect(existsSync(archive), `${label} must be assembled before app tests`).toBeTrue();
  const result = Bun.spawnSync(['tar', '-tzf', archive]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split('\n').filter(Boolean);
}

describe('complete browser package transport', () => {
  test('retains ordinary resources and Publisher core runtime assets', () => {
    const paths = members('hl7.fhir.r4.core#4.0.1');
    expect(paths).toContain('package/package.json');
    expect(paths.some((path) => path === 'package/StructureDefinition-Patient.json')).toBeTrue();
    expect(paths).toContain('package/other/fhir.css');
    expect(paths).toContain('package/other/icon_element.gif');
    expect(paths).toContain('package/other/tbl_spacer.png');
  });

  test('retains template content in the same normalized package root', () => {
    const paths = members('fhir.base.template#1.0.0');
    expect(paths).toContain('package/package.json');
    expect(paths).toContain('package/config.json');
    expect(paths.some((path) => path.startsWith('package/includes/'))).toBeTrue();
  });
});
