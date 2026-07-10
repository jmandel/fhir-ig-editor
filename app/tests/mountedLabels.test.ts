import { describe, expect, test } from 'bun:test';
import { MountedLabels } from '../src/worker/mountedLabels';

describe('worker mounted-package mirror', () => {
  test('successful init replaces labels and a removed label can be mounted again', () => {
    const labels = new MountedLabels();
    labels.replace(['A#1']);
    labels.replace(['B#1']);

    const fresh = labels.fresh([{ label: 'A#1' }, { label: 'B#1' }]);
    expect(fresh.map((bundle) => bundle.label)).toEqual(['A#1']);
    labels.add(fresh);
    expect(labels.size).toBe(2);
  });

  test('failed mount selection does not mutate committed labels', () => {
    const labels = new MountedLabels();
    labels.replace(['A#1']);
    expect(() => labels.fresh([{ label: 'B#1' }, { label: 'B#1' }])).toThrow('duplicate new package');
    expect(labels.size).toBe(1);
  });
});
