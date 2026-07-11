import { expect, test } from 'bun:test';
import { BuildRuntimeRegistry } from '../src/worker/buildRuntimeRegistry';

test('build runtimes retain current and immediate predecessor only', () => {
  const runtimes = new BuildRuntimeRegistry<number>();
  runtimes.install('a', 1);
  runtimes.install('b', 2);
  expect(runtimes.get('a')).toBe(1);
  expect(runtimes.get('b')).toBe(2);
  runtimes.install('c', 3);
  expect(runtimes.get('a')).toBeUndefined();
  expect(runtimes.handles()).toEqual(['c', 'b']);
});

test('a failed preparation cannot evict retained handles', () => {
  const runtimes = new BuildRuntimeRegistry<number>();
  runtimes.install('a', 1);
  runtimes.install('b', 2);
  expect(() => { throw new Error('prepare failed before install'); }).toThrow();
  expect(runtimes.handles()).toEqual(['b', 'a']);
  expect(runtimes.get('a')).toBe(1);
  expect(runtimes.get('b')).toBe(2);
});
