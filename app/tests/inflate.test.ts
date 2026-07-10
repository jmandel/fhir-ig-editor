import { describe, expect, test } from 'bun:test';

import { untarPackage } from '../src/worker/inflate';

const text = new TextEncoder();

function ascii(target: Uint8Array, offset: number, width: number, value: string): void {
  const bytes = text.encode(value);
  if (bytes.length > width) throw new Error(`fixture field too long: ${value}`);
  target.set(bytes, offset);
}

function octal(target: Uint8Array, offset: number, width: number, value: number): void {
  ascii(target, offset, width, `${value.toString(8).padStart(width - 1, '0')}\0`);
}

function member(args: {
  name: string;
  body?: Uint8Array;
  prefix?: string;
  type?: string;
}): Uint8Array {
  const body = args.body || new Uint8Array();
  const header = new Uint8Array(512);
  ascii(header, 0, 100, args.name);
  octal(header, 100, 8, 0o644);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, body.length);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  ascii(header, 156, 1, args.type || '0');
  ascii(header, 257, 6, 'ustar\0');
  ascii(header, 263, 2, '00');
  if (args.prefix) ascii(header, 345, 155, args.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  ascii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);

  const result = new Uint8Array(512 + Math.ceil(body.length / 512) * 512);
  result.set(header);
  result.set(body, 512);
  return result;
}

function archive(...members: Uint8Array[]): Uint8Array {
  const length = members.reduce((sum, value) => sum + value.length, 1024);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of members) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function paxRecord(key: string, value: string): Uint8Array {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  while (`${length} `.length + body.length !== length) {
    length = `${length} `.length + body.length;
  }
  return text.encode(`${length} ${body}`);
}

describe('FHIR package tar boundary', () => {
  test('retains safe nested template members after the package root', () => {
    const files = untarPackage(archive(
      member({ name: 'package/package.json', body: text.encode('{}') }),
      member({ name: 'package/includes/menu.xml', body: text.encode('<menu/>') }),
    ));
    expect(Object.keys(files).sort()).toEqual(['includes/menu.xml', 'package.json']);
  });

  test('joins the USTAR prefix before classifying a path', () => {
    const files = untarPackage(archive(member({
      prefix: 'package/nested',
      name: 'package.json',
      body: text.encode('{}'),
    })));
    expect(Object.keys(files)).toEqual(['nested/package.json']);
    expect(files['package.json']).toBeUndefined();
  });

  test('honors PAX and GNU long-name paths for the following member', () => {
    const pax = untarPackage(archive(
      member({ name: 'PaxHeader', type: 'x', body: paxRecord('path', 'package/pax/package.json') }),
      member({ name: 'package.json', body: text.encode('pax') }),
    ));
    expect(Object.keys(pax)).toEqual(['pax/package.json']);

    const gnu = untarPackage(archive(
      member({ name: '././@LongLink', type: 'L', body: text.encode('package/gnu/package.json\0') }),
      member({ name: 'package.json', body: text.encode('gnu') }),
    ));
    expect(Object.keys(gnu)).toEqual(['gnu/package.json']);
  });

  test('rejects traversal, corrupt checksums, and unsupported global metadata', () => {
    expect(() => untarPackage(archive(member({ name: 'package/../package.json' })))).toThrow('unsafe');

    const corrupt = archive(member({ name: 'package/package.json' }));
    corrupt[0] ^= 1;
    expect(() => untarPackage(corrupt)).toThrow('checksum');

    expect(() => untarPackage(archive(member({ name: 'GlobalHead', type: 'g' })))).toThrow(
      'unsupported stateful tar header',
    );
  });
});
