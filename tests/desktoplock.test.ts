import { afterEach, describe, expect, it } from 'vitest';
import { DesktopService } from '../src/main/desktop/desktopService';
import { CapabilityError } from '../src/main/capabilities/types';
import { FakeDesktop, makeHarness, tempDir, type Harness } from './helpers';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('one owner for the physical desktop', () => {
  it('runs desktop work one at a time, in order', async () => {
    const d = new DesktopService(new FakeDesktop());
    const log: string[] = [];
    const job = (name: string, ms: number) =>
      d.exclusive(name, async () => {
        log.push(`${name}:start`);
        await sleep(ms);
        log.push(`${name}:end`);
        return name;
      });
    const results = await Promise.all([job('a', 30), job('b', 5), job('c', 1)]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('a cancelled waiter gives up without blocking the queue; a failure releases the desktop', async () => {
    const d = new DesktopService(new FakeDesktop());
    const ac = new AbortController();
    const first = d.exclusive('first', async () => {
      await sleep(30);
      throw new Error('boom');
    });
    const waiting = d.exclusive('cancelled', async () => 'never', ac.signal);
    ac.abort();
    await expect(waiting).rejects.toBeInstanceOf(CapabilityError);
    await expect(first).rejects.toThrow('boom');
    expect(await d.exclusive('next', async () => 'ran')).toBe('ran');
    expect(d.inputOwner()).toEqual({ owner: null, waiting: 0 });
  });

  it('work scheduled during an owner’s turn waits for it (no slipping past the lock)', async () => {
    const d = new DesktopService(new FakeDesktop());
    const log: string[] = [];
    let scheduled: Promise<unknown> | null = null;
    await d.exclusive('owner', async () => {
      scheduled = new Promise((r) => setTimeout(() => r(d.exclusive('timer', async () => void log.push('timer'))), 0));
      await sleep(20);
      log.push('owner done');
    });
    await scheduled;
    expect(log).toEqual(['owner done', 'timer']);
  });
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('shortcut layout (Ctrl+K voice, Ctrl+Shift+K mini-chat)', () => {
  it('moves a mini-chat still on the old default once, and keeps a custom one', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ shortcuts: { commandBar: 'Control+K' } }));
    h = makeHarness({ dir });
    expect(h.services.settings.get().shortcuts).toMatchObject({ commandBar: 'Control+Shift+K', voice: 'Control+K', layoutV2: true });
    await h.close();

    const dir2 = tempDir();
    fs.writeFileSync(path.join(dir2, 'settings.json'), JSON.stringify({ shortcuts: { commandBar: 'Control+Alt+K' } }));
    h = makeHarness({ dir: dir2 });
    expect(h.services.settings.get().shortcuts).toMatchObject({ commandBar: 'Control+Alt+K', voice: 'Control+K', layoutV2: true });
    // Once migrated, a later choice of Ctrl+K for the mini-chat is respected.
    h.services.settings.update({ shortcuts: { commandBar: 'Control+K', voiceEnabled: false } });
    expect(h.services.settings.get().shortcuts.commandBar).toBe('Control+K');
  });

  it('Ctrl+K toggles a voice conversation', async () => {
    h = makeHarness({ voiceIo: { listen: () => new Promise(() => undefined), speak: async () => undefined } });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMain: () => undefined };
    h.services.toggleVoiceMode();
    await sleep(700);
    expect(h.services.voiceMode.isActive()).toBe(true);
    h.services.toggleVoiceMode();
    expect(h.services.voiceMode.isActive()).toBe(false);
  });
});
