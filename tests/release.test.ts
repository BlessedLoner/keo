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

describe('automatic updates', () => {
  class FakeUpdater {
    autoDownload = false;
    autoInstallOnAppQuit = false;
    handlers = new Map<string, (a?: unknown) => void>();
    checks = 0;
    installed: unknown[] = [];
    on(event: string, fn: (a: never) => void) {
      this.handlers.set(event, fn as (a?: unknown) => void);
      return this;
    }
    emit(event: string, a?: unknown) {
      this.handlers.get(event)?.(a);
    }
    async checkForUpdates() {
      this.checks++;
    }
    quitAndInstall(...args: unknown[]) {
      this.installed.push(args);
    }
  }

  it('downloads in the background, announces once ready, and installs only on request', async () => {
    const { AutoUpdate } = await import('../src/main/updates/autoUpdate');
    const u = new FakeUpdater();
    const states: string[] = [];
    const ready: string[] = [];
    const now = 0;
    const a = new AutoUpdate(u, () => true, log, (s) => states.push(s.state), (v) => ready.push(v), () => now);
    expect(a.install()).toBe(false); // nothing downloaded yet
    await a.check();
    expect(u.autoDownload).toBe(true);
    expect(u.autoInstallOnAppQuit).toBe(true);
    u.emit('update-available', { version: '1.2.0' });
    u.emit('download-progress', { percent: 42.4 });
    expect(a.status()).toMatchObject({ state: 'downloading', version: '1.2.0', percent: 42 });
    u.emit('update-downloaded', { version: '1.2.0' });
    expect(ready).toEqual(['1.2.0']);
    expect(u.installed).toEqual([]);
    await a.check(true); // no re-check once ready
    expect(u.checks).toBe(1);
    expect(a.install()).toBe(true);
    expect(u.installed).toEqual([[false, true]]);
    expect(states).toEqual(['downloading', 'downloading', 'ready']);
  });

  it('respects the setting, checks at most daily, and reports failures without details', async () => {
    const { AutoUpdate } = await import('../src/main/updates/autoUpdate');
    const u = new FakeUpdater();
    let on = false;
    let now = 0;
    const a = new AutoUpdate(u, () => on, log, () => undefined, () => undefined, () => now);
    await a.check(true);
    expect(u.checks).toBe(0);
    on = true;
    await a.check();
    await a.check();
    expect(u.checks).toBe(1);
    now += 25 * 60 * 60 * 1000;
    await a.check();
    expect(u.checks).toBe(2);
    u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED at https://x'));
    expect(a.status()).toMatchObject({ state: 'failed' });
    expect(a.status().error).not.toMatch(/net::|https/);
  });

  it('a development run has no updater', async () => {
    const { AutoUpdate } = await import('../src/main/updates/autoUpdate');
    const a = new AutoUpdate(null, () => true, log, () => undefined, () => undefined);
    expect((await a.check(true)).state).toBe('none');
    expect(a.install()).toBe(false);
  });
});
