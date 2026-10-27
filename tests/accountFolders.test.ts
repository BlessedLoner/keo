import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { accountProfile, folderFor, openFolder, readState, setAsideLegacy, userIdOfToken, writeState } from '../src/main/env/accounts';
import { resolveProfile } from '../src/main/env/profile';
import { makeHarness, tempDir } from './helpers';

const ANA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** Starts Keo's services on the folder for a state, as the app does, and returns them. */
function openAs(root: string, state: Parameters<typeof writeState>[1]) {
  const base = resolveProfile(root, { KEO_USER_DATA_DIR: root }, false);
  const { dir, claimed } = openFolder(root, state);
  const h = makeHarness({ dir, deps: { profile: accountProfile(base, dir, state) } });
  return { h, dir, claimed };
}

describe('one data folder per Keo account', () => {
  it('a new account starts empty and never sees another account’s chats, memory or keys', async () => {
    const root = tempDir();
    const ana = openAs(root, { mode: 'account', userId: ANA });
    const conv = ana.h.services.conversations.create('Ana’s secret plans');
    ana.h.services.memory.create({ kind: 'fact', content: 'Ana banks with Example Bank', status: 'confirmed', provenance: 'user_authored' });
    ana.h.services.secrets.set('email_password', 'ana-app-password');
    ana.h.services.settings.update({ email: { address: 'ana@example.test' } });
    await ana.h.close();

    const bob = openAs(root, { mode: 'account', userId: BOB });
    expect(bob.claimed).toBe(false);
    expect(bob.h.services.conversations.list().map((c) => c.title)).not.toContain('Ana’s secret plans');
    expect(bob.h.services.memory.search('bank', { limit: 10 })).toEqual([]);
    expect(bob.h.services.secrets.get('email_password')).toBeNull();
    expect(bob.h.services.settings.get().email.address).toBe('');
    await bob.h.close();

    // Ana signs in again: her data is all there.
    const again = openAs(root, { mode: 'account', userId: ANA });
    expect(again.h.services.conversations.get(conv.id)?.title).toBe('Ana’s secret plans');
    expect(again.h.services.secrets.get('email_password')).toBe('ana-app-password');
    await again.h.close();
    expect(again.dir).not.toBe(bob.dir);
  });

  it('data from before accounts goes to the first account that signs in — not to the sign-in screen or a later account', async () => {
    const root = tempDir();
    // Keo as it was: everything in the profile folder itself.
    fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ email: { address: 'owner@example.test' } }));
    fs.mkdirSync(path.join(root, 'web-browser'));
    fs.writeFileSync(path.join(root, 'background-jobs.json'), '[]');
    fs.mkdirSync(path.join(root, 'logs'));
    expect(setAsideLegacy(root)).toBe(true);
    expect(fs.existsSync(path.join(root, 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'logs'))).toBe(true); // shared files stay
    expect(setAsideLegacy(root)).toBe(false); // only once

    // The sign-in screen does not take it.
    const out = openFolder(root, { mode: 'signed-out', userId: null });
    expect(out.claimed).toBe(false);
    expect(fs.existsSync(path.join(out.dir, 'settings.json'))).toBe(false);

    const first = openFolder(root, { mode: 'account', userId: ANA });
    expect(first.claimed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(first.dir, 'settings.json'), 'utf8')).email.address).toBe('owner@example.test');
    expect(fs.existsSync(path.join(first.dir, 'web-browser'))).toBe(true);

    const later = openFolder(root, { mode: 'account', userId: BOB });
    expect(later.claimed).toBe(false);
    expect(fs.existsSync(path.join(later.dir, 'settings.json'))).toBe(false);
  });

  it('or to Keo without an account, if the user chooses their own API key first', () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'secrets.json'), '{}');
    setAsideLegacy(root);
    const local = openFolder(root, { mode: 'local', userId: null });
    expect(local.claimed).toBe(true);
    expect(path.basename(local.dir)).toBe('local');
    expect(openFolder(root, { mode: 'account', userId: ANA }).claimed).toBe(false);
  });

  it('remembers the mode safely, and reads the account from the sign-in', () => {
    const root = tempDir();
    expect(readState(root)).toEqual({ mode: 'signed-out', userId: null });
    writeState(root, { mode: 'account', userId: ANA });
    expect(readState(root)).toEqual({ mode: 'account', userId: ANA });
    writeState(root, { mode: 'local', userId: null });
    expect(readState(root)).toEqual({ mode: 'local', userId: null });
    // A folder name can only ever be an account id, "local" or "signed-out" (no ../ tricks).
    fs.writeFileSync(path.join(root, 'keo-session', 'state.json'), JSON.stringify({ mode: 'account', userId: '../../Windows' }));
    expect(readState(root)).toEqual({ mode: 'signed-out', userId: null });
    expect(folderFor({ mode: 'account', userId: ANA })).toBe(ANA);
    const token = `x.${Buffer.from(JSON.stringify({ sub: ANA })).toString('base64url')}.y`;
    expect(userIdOfToken(token)).toBe(ANA);
    expect(userIdOfToken('not-a-token')).toBeNull();
  });
});
