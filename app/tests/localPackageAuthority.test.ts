import { describe, expect, test } from 'bun:test';

import {
  addLocalPackage,
  getLocalPackage,
  localPackageEpoch,
  LocalPackageAuthority,
  stageLocalPackage,
} from '../src/worker/localPackages';

describe('local package authority lifecycle', () => {
  test('recycles before replacing an already-mounted baked coordinate', async () => {
    const label = 'authority-baked-to-local.pkg#1.0.0';
    const authority = new LocalPackageAuthority();
    const before = localPackageEpoch();
    const installation = stageLocalPackage(label, {
      'package.json': 'local-package-json',
      'StructureDefinition-local.json': 'local-profile',
    });

    authority.accept(installation, true);
    expect(localPackageEpoch()).toBe(before + 1);
    expect(authority.requiresRecycle).toBe(true);
    let recycles = 0;
    expect(await authority.reconcile(async () => { recycles += 1; })).toBe(true);
    authority.commit();

    expect(recycles).toBe(1);
    expect(authority.requiresRecycle).toBe(false);
    expect(getLocalPackage(label)?.files['StructureDefinition-local.json'])
      .toBe('local-profile');
  });

  test('failed override restores baked authority and requires a clean recovery worker', async () => {
    const label = 'authority-failed-local.pkg#1.0.0';
    const authority = new LocalPackageAuthority();
    const before = localPackageEpoch();
    const installation = stageLocalPackage(label, {
      'package.json': 'candidate-that-fails-later-preparation',
    });

    authority.accept(installation, true);
    let recycles = 0;
    await authority.reconcile(async () => { recycles += 1; });
    // Model a failure after the candidate may have committed to Rust. The
    // absent prior local entry means ordinary baked transport becomes
    // authoritative again after rollback.
    authority.rollback();

    expect(getLocalPackage(label)).toBeNull();
    expect(localPackageEpoch()).toBe(before + 2);
    expect(authority.requiresRecycle).toBe(true);
    expect(await authority.reconcile(async () => { recycles += 1; })).toBe(true);
    expect(recycles).toBe(2);
    expect(authority.requiresRecycle).toBe(false);
  });

  test('identical effective local bytes do not request another recycle', async () => {
    const label = 'authority-unchanged-local.pkg#1.0.0';
    addLocalPackage(label, {
      'package.json': 'same',
      'StructureDefinition-same.json': 'same-profile',
    });
    const authority = new LocalPackageAuthority();
    const before = localPackageEpoch();
    const installation = stageLocalPackage(label, {
      'StructureDefinition-same.json': 'same-profile',
      'package.json': 'same',
    });

    expect(installation.changed).toBe(false);
    expect(localPackageEpoch()).toBe(before);
    authority.accept(installation, true);
    expect(authority.requiresRecycle).toBe(false);
    let recycles = 0;
    expect(await authority.reconcile(async () => { recycles += 1; })).toBe(false);
    expect(recycles).toBe(0);
    authority.commit();
  });

  test('multiple pending local replacements roll back to prior bytes in reverse order', () => {
    const label = 'authority-multiple-pending.pkg#1.0.0';
    addLocalPackage(label, { 'package.json': 'original' });
    const authority = new LocalPackageAuthority();
    const before = localPackageEpoch();
    const second = stageLocalPackage(label, { 'package.json': 'second' });
    authority.accept(second, true);
    const third = stageLocalPackage(label, { 'package.json': 'third' });
    authority.accept(third, true);

    expect(getLocalPackage(label)?.files['package.json']).toBe('third');
    expect(authority.rollback()).toBe(true);
    expect(getLocalPackage(label)?.files['package.json']).toBe('original');
    expect(localPackageEpoch()).toBe(before + 4);
    expect(authority.requiresRecycle).toBe(true);
  });
});
