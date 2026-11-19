import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildProjects } from '../src/main/build/projects';
import { tempDir } from './helpers';

const log = { info: () => undefined };

describe('Builds belong to one account', () => {
  it('a new account on the same PC does not see another account’s builds, and cannot open them by id', () => {
    const docs = tempDir('keo-docs-');
    const root = path.join(docs, 'Builds');
    const forAccount = (dir: string, mayClaim = true) => new BuildProjects({ root: () => root, modules: () => path.join(__dirname, '..', 'node_modules'), log, accountDir: () => dir, mayClaim: () => mayClaim });
    const a = forAccount(tempDir('keo-acct-a-'));
    const b = forAccount(tempDir('keo-acct-b-'));
    const mine = a.create({ title: 'My site', kind: 'website' });
    expect(a.list().map((m) => m.id)).toEqual([mine.id]);
    expect(b.list()).toEqual([]);
    expect(() => b.dir(mine.id)).toThrow(/no such build/);
    const theirs = b.create({ title: 'My site', kind: 'website' });
    expect(a.list().map((m) => m.id)).toEqual([mine.id]);
    expect(b.list().map((m) => m.id)).toEqual([theirs.id]);
    // The files themselves stay in Documents\Keo\Builds, in separate folders.
    expect(a.dir(mine.id)).not.toBe(b.dir(theirs.id));
    expect(path.dirname(a.dir(mine.id))).toBe(root);
  });

  it('builds from before go to the first account that opens them (never a signed-out Keo), and only to it', () => {
    const docs = tempDir('keo-docs-');
    const root = path.join(docs, 'Builds');
    const old = new BuildProjects({ root: () => root, modules: () => path.join(__dirname, '..', 'node_modules'), log });
    const made = old.create({ title: 'Old game', kind: 'game' });
    expect(fs.existsSync(path.join(root, 'builds.json'))).toBe(true);
    const mk = (dir: string, mayClaim: boolean) => new BuildProjects({ root: () => root, modules: () => path.join(__dirname, '..', 'node_modules'), log, accountDir: () => dir, mayClaim: () => mayClaim });
    expect(mk(tempDir('keo-out-'), false).list()).toEqual([]);
    const first = mk(tempDir('keo-first-'), true);
    expect(first.list().map((m) => m.id)).toEqual([made.id]);
    expect(fs.existsSync(path.join(root, 'builds.json'))).toBe(false);
    expect(mk(tempDir('keo-second-'), true).list()).toEqual([]);
  });
});
