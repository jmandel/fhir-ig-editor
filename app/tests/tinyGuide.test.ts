import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const TINY = resolve(ROOT, 'demo/tiny-guide');
const read = (path: string) => readFileSync(resolve(TINY, path), 'utf8');

describe('purpose-built tiny authoring guide', () => {
  test('uses the standard HL7 template and one unambiguous first artifact', () => {
    const config = read('sushi-config.yaml');
    const primary = read('input/fsh/00-EditorUser.fsh');

    expect(config).toContain('template: hl7.fhir.template#1.0.0');
    expect(read('ig.ini')).toContain('template = hl7.fhir.template#1.0.0');
    expect(primary.match(/^Profile:/gm)).toHaveLength(1);
    expect(primary).toContain('Profile: EditorUser');
    expect(primary).toContain('* name.given 1..* MS');
    expect(primary).toContain('Try changing 1..* to 2..*');
    expect(primary).toContain('from http://hl7.org/fhir/ValueSet/languages (required)');
  });

  test('keeps the suggested edit valid and demonstrates more than one FSH artifact kind', () => {
    const example = read('input/fsh/02-Example.fsh');
    expect(example).toContain('* name.given[0] = "Curious"');
    expect(example).toContain('* name.given[1] = "Builder"');
    expect(read('input/fsh/01-ExperimentNote.fsh')).toContain('Extension: ExperimentNote');
    expect(read('input/fsh/03-Capabilities.fsh')).toContain('InstanceOf: CapabilityStatement');
    expect(read('input/fsh/03-Capabilities.fsh')).toContain('* rest.resource.profile = Canonical(EditorUser)');
  });

  test('teaches the exact Source to Definition to Preview story in its own page', () => {
    const page = read('input/pagecontent/index.md');
    expect(page).toContain('00-EditorUser.fsh');
    expect(page).toContain('[IG Editor User StructureDefinition](StructureDefinition-editor-user.html)');
    expect(page).toContain('[CapabilityStatement](CapabilityStatement-demo-capabilities.html)');
    expect(page).toMatch(/standard\s+HL7 FHIR IG (?:Publisher )?template/);
  });
});
