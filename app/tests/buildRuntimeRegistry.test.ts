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

test('a released superseded runtime cannot evict the published predecessor', () => {
  const runtimes = new BuildRuntimeRegistry<number>();
  runtimes.install('published-a', 1);
  runtimes.install('superseded-b', 2);
  expect(runtimes.release('superseded-b')).toBeTrue();
  expect(runtimes.release('superseded-b')).toBeFalse();
  runtimes.install('latest-c', 3);
  expect(runtimes.handles()).toEqual(['latest-c', 'published-a']);
  expect(runtimes.get('published-a')).toBe(1);
});

test('an exact retained runtime is reused and touched without reconstruction', () => {
  const runtimes = new BuildRuntimeRegistry<object>();
  const a = { build: 'a' };
  const b = { build: 'b' };
  runtimes.install('a', a);
  runtimes.install('b', b);
  expect(runtimes.handles()).toEqual(['b', 'a']);

  expect(runtimes.touch('a')).toBe(a);
  expect(runtimes.handles()).toEqual(['a', 'b']);
  expect(runtimes.touch('missing')).toBeUndefined();
  expect(runtimes.handles()).toEqual(['a', 'b']);

  runtimes.install('c', { build: 'c' });
  expect(runtimes.handles()).toEqual(['c', 'a']);
  expect(runtimes.get('a')).toBe(a);
  expect(runtimes.get('b')).toBeUndefined();
});
