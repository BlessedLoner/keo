import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CreativeTrial, isCreativeCapability, isCreativeChannel, TRIAL_MS } from '../src/main/cloud/creativeTrial';

/** Studio and Builds without a Keo account: one free day from first use, then locked until sign-in. */
function setup(signedIn = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keo-trial-'));
  const clock = { now: Date.parse('2026-11-26T10:00:00Z') };
  const state = { signedIn };
  const trial = new CreativeTrial(path.join(dir, 'creative-trial.json'), () => state.signedIn, () => clock.now);
  return { trial, clock, state };
}

describe('Studio and Builds without a Keo account', () => {
  it('is open until first use, then for one day, then locked', () => {
    const t = setup();
    expect(t.trial.state()).toMatchObject({ signedIn: false, startedAt: null, locked: false });
    expect(t.trial.check()).toBeNull(); // first use starts the day
    expect(t.trial.state().startedAt).toBe('2026-11-26T10:00:00.000Z');
    t.clock.now += TRIAL_MS - 60_000;
    expect(t.trial.check()).toBeNull();
    t.clock.now += 60_000;
    expect(t.trial.check()).toMatch(/free Keo account/);
    expect(t.trial.state().locked).toBe(true);
  });

  it('signing in opens them again, and a signed-in user never starts a trial', () => {
    const t = setup();
    t.trial.use();
    t.clock.now += TRIAL_MS * 3;
    expect(t.trial.state().locked).toBe(true);
    t.state.signedIn = true;
    expect(t.trial.check()).toBeNull();
    expect(t.trial.state().locked).toBe(false);

    const fresh = setup(true);
    fresh.trial.use();
    expect(fresh.trial.state().startedAt).toBeNull();
  });

  it('locks only Studio and Builds work, and leaves their lists readable', () => {
    expect(isCreativeCapability('studio.edit')).toBe(true);
    expect(isCreativeCapability('build.write')).toBe(true);
    expect(isCreativeCapability('web.search')).toBe(false);
    expect(isCreativeChannel('studio:edit')).toBe(true);
    expect(isCreativeChannel('builds:open')).toBe(true);
    expect(isCreativeChannel('builds:list')).toBe(false);
    expect(isCreativeChannel('studio:list')).toBe(false);
    expect(isCreativeChannel('account:status')).toBe(false);
  });
});
