import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TRIAL_MS } from '../src/main/cloud/creativeTrial';
import { makeHarness, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

const host = { appInfo: () => ({ name: 'Keo', version: '0', electron: '', chrome: '', node: '', platform: '', packaged: false, testProviderEnabled: true }), openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined };

describe('Builds and their chats', () => {
  it('"Ask Keo to change it" goes on in the chat where the build was made', async () => {
    h = await makeHarness();
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, host);
    const made = h.services.conversations.create('Build a bakery site');
    const b = h.services.builds.create({ title: 'Sunrise Bakery', kind: 'website', conversationId: made.id });
    expect((await handlers['builds:get']({ id: b.id })).build.conversationId).toBe(made.id);
    expect(await handlers['builds:conversation']({ id: b.id })).toEqual({ conversationId: made.id });
  });

  it('a build whose chat is gone gets one chat of its own, and keeps it', async () => {
    h = await makeHarness();
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, host);
    const b = h.services.builds.create({ title: 'Block Dodge', kind: 'game' });
    const first = (await handlers['builds:conversation']({ id: b.id })).conversationId;
    expect(h.services.conversations.get(first)?.title).toBe('Build · Block Dodge');
    expect((await handlers['builds:conversation']({ id: b.id })).conversationId).toBe(first);
    expect(h.services.builds.manifest(b.id).conversationId).toBe(first);
  });

  it('without a Keo account, Builds lock after the free day (the list stays readable)', async () => {
    h = await makeHarness();
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, host);
    const b = h.services.builds.create({ title: 'Old site', kind: 'website' });
    expect((await handlers['account:creativeAccess']({ use: true })).locked).toBe(false);
    // The free day began a day and a minute ago.
    const file = path.join(h.services.profile.userData, 'creative-trial.json');
    fs.writeFileSync(file, JSON.stringify({ startedAt: new Date(Date.now() - TRIAL_MS - 60_000).toISOString() }));
    expect((await handlers['account:creativeAccess']({})).locked).toBe(true);
    await expect(Promise.resolve().then(() => handlers['builds:conversation']({ id: b.id }))).rejects.toMatchObject({ code: 'locked' });
    expect((await handlers['builds:list']({})).map((x) => x.id)).toContain(b.id);
    // Keo's own Studio and Builds tools are refused too.
    expect(h.services.registry.admit({ capabilityId: 'build.read', input: { id: b.id, path: 'index.html' }, origin: 'model', correlationId: 'test' })).toMatchObject({ ok: false, code: 'locked' });
  });
});
