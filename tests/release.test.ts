import { describe, expect, it } from 'vitest';
import { UpdateService } from '../src/main/updates/updateService';
import { Logger } from '../src/main/logging/logger';
import { compareVersions, LINKS, RELEASE } from '../src/shared/release';
import { invokeSchemas } from '../src/shared/ipc';
import { tempDir } from './helpers';

const log = new Logger(tempDir(), false);

describe('release & updates', () => {
  it('compares versions, including pre-releases', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('v1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.2')).toBeGreaterThan(0);
    expect(compareVersions('2.1.0', 'v2.1.0')).toBe(0);
  });

  it('reports a newer release from GitHub, at most once a day unless forced', async () => {
    let calls = 0;
    let now = 1_000_000;
    const svc = new UpdateService(
      '1.0.0',
      log,
      async (url) => {
        calls++;
        expect(url).toBe(`https://api.github.com/repos/${RELEASE.owner}/${RELEASE.repo}/releases/latest`);
        return { ok: true, status: 200, json: async () => ({ tag_name: 'v1.1.0', html_url: `https://github.com/${RELEASE.owner}/${RELEASE.repo}/releases/tag/v1.1.0`, body: 'Faster live chats' }) };
      },
      () => now,
    );
    const a = await svc.check();
    expect(a).toMatchObject({ current: '1.0.0', latest: '1.1.0', newer: true, notes: 'Faster live chats' });
    await svc.check();
    expect(calls).toBe(1);
    now += 25 * 60 * 60 * 1000;
    await svc.check();
    await svc.check(true);
    expect(calls).toBe(3);
  });

  it('never links anywhere but Keo’s own repository, and handles “no release yet” and offline', async () => {
    const evil = new UpdateService('1.0.0', log, async () => ({ ok: true, status: 200, json: async () => ({ tag_name: 'v9.9.9', html_url: 'https://evil.example/keo.exe' }) }));
    expect((await evil.check()).url).toBe(LINKS.releases);
    const none = new UpdateService('1.0.0', log, async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await none.check()).toMatchObject({ newer: false, error: 'No published release yet.' });
    const offline = new UpdateService('1.0.0', log, async () => {
      throw new TypeError('fetch failed');
    });
    expect(await offline.check()).toMatchObject({ newer: false, error: /Could not reach GitHub/ });
  });

  it('the renderer can open only allow-listed links', () => {
    expect(invokeSchemas['app:openLink'].safeParse({ id: 'openrouterKeys' }).success).toBe(true);
    expect(invokeSchemas['app:openLink'].safeParse({ id: 'https://evil.example' }).success).toBe(false);
    expect(Object.values(LINKS).every((u) => u.startsWith('https://'))).toBe(true);
  });
});
