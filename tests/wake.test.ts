import { afterEach, describe, expect, it } from 'vitest';
import { createHandlers } from '../src/main/ipc/handlers';
import { learnableVariants, matchWake } from '../src/main/voice/wakeMatch';
import type { ChatResult } from '../src/main/providers/types';
import { FakeSpeech, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

describe('wake word matching', () => {
  it('accepts sound-alikes of the phrase but not other common speech', () => {
    const P = ['hey keo'];
    for (const t of ['hey keo', 'Hey Kio', 'hay keo', 'hey kayo', 'he keo', 'hey key oh']) expect(matchWake([t], P, [])?.phrase).toBe('hey keo');
    for (const t of ['okay', 'hey go', 'hey Siri', 'okay google', 'they know', 'hey cool', 'hey kill', 'hello']) expect(matchWake([t], P, [])).toBeNull();
  });

  it('splits off a command said in the same breath, keeping numbers', () => {
    expect(matchWake(['Hey, Keo. Look at line 10 in the add variable function'], ['hey keo'], [])).toMatchObject({ how: 'exact', rest: 'Look at line 10 in the add variable function' });
    expect(matchWake(['hey key oh open notepad'], ['hey keo'], [])).toMatchObject({ how: 'sounds_like', rest: 'open notepad' });
  });

  it('accepts versions learned from the user’s voice, and checks alternates', () => {
    expect(matchWake(['a cleo read my email'], ['hey keo'], ['a cleo'])).toMatchObject({ how: 'learned', rest: 'read my email' });
    expect(matchWake(['lake view', 'hey kio'], ['hey keo'], [])?.how).toBe('sounds_like');
  });

  it('never learns common words as a wake phrase', () => {
    expect(learnableVariants(['okay', 'hey', 'a cleo', 'hey keo', 'a cleo'], 'hey keo', [])).toEqual(['a cleo']);
  });
});

describe('wake service', () => {
  const start = async (script?: () => ChatResult) => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: script ?? (() => reply('Done.')) });
    let shown = 0;
    h.services.ui = { showCommandBar: () => shown++, notify: () => undefined };
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    return { speech, shown: () => shown };
  };
  const convId = () => h.services.settings.get().commandBar.conversationId;

  it('wakes on a sound-alike the recognizer heard as dictation', async () => {
    const { speech, shown } = await start();
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'hey kio', confidence: 0.4, alts: [] });
    await waitFor(() => speech.cmds().includes('capture'));
    expect(shown()).toBe(1);
  });

  it('“Hey Keo, look at line 10 …” in one breath is sent at once, without a second listen', async () => {
    const { speech } = await start();
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'Hey Keo look at line 10 in the add variable function', confidence: 0.6, alts: [] });
    await waitFor(() => !!convId() && h.services.conversations.messages(convId()!).some((m) => m.role === 'user'));
    expect(h.services.conversations.messages(convId()!)[0]?.content).toBe('look at line 10 in the add variable function');
    expect(speech.cmds()).not.toContain('capture');
  });

  it('wakes on a learned version of the user’s voice, which is also added to the recognizer grammar', async () => {
    const { speech } = await start();
    h.services.settings.update({ wake: { learned: ['a cleo'] } });
    await waitFor(() => speech.sent.some((c) => c.cmd === 'wake' && (c.phrases as string[]).includes('a cleo')));
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'a cleo', confidence: 0.5, alts: [] });
    await waitFor(() => speech.cmds().includes('capture'));
  });

  it('a near miss explains what was heard; other speech nearby is ignored silently', async () => {
    const { speech } = await start();
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'we should go shopping later', confidence: 0.7, alts: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.services.wake.getState().message).toBeNull();
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'hey Cleo', confidence: 0.5, alts: [] });
    await waitFor(() => /Heard “hey Cleo”/.test(h.services.wake.getState().message ?? ''));
    expect(speech.cmds()).not.toContain('capture');
  });

  it('Teach Keo your voice learns what Windows hears, and Test then recognises it', async () => {
    const { speech } = await start();
    const handlers = createHandlers(h.services, {
      appInfo: () => ({ name: 'Keo', version: '1', electron: '', chrome: '', node: '', platform: '', packaged: false }),
      openPath: async () => true,
      pickExecutable: async () => null,
      relaunch: () => undefined,
    } as never);
    speech.nextTest = { recognized: false, confidence: 0.6, heardSomething: true, text: 'a cleo', alts: ['a clear'], grammar: 'competitor' };
    const learned = await handlers['wake:learnSample']({ phrase: 'hey keo' });
    expect(learned).toMatchObject({ heard: 'a cleo', added: ['a cleo', 'a clear'] });
    expect(h.services.settings.get().wake.learned).toEqual(['a cleo', 'a clear']);
    speech.nextTest = { recognized: false, confidence: 0.6, heardSomething: true, text: 'a cleo', alts: [], grammar: 'competitor' };
    const test = await handlers['wake:testPhrase']({ phrase: 'hey keo' });
    expect(test).toMatchObject({ ok: true });
    expect(test.message).toMatch(/learned/);
    await handlers['wake:forgetLearned']({});
    expect(h.services.settings.get().wake.learned).toEqual([]);
  });

  it('tells the agent which window the user was in when they called Keo', async () => {
    let system = '';
    const { speech } = await start();
    h.provider.setScript((req) => {
      system = req.system;
      return reply('Looking.');
    });
    h.services.settings.update({ permissions: { observationEnabled: true, allowedApps: [{ processName: 'code', label: 'VS Code' }] } });
    h.desktop.windows.push({ hwnd: '777', pid: 4242, processName: 'Code', title: 'add.ts — keo — Visual Studio Code', className: 'Chrome_WidgetWin_1', minimized: false, x: 0, y: 0, width: 1400, height: 900, foreground: true });
    h.desktop.foreground = '777';
    speech.fire({ event: 'heard', grammar: 'competitor', text: 'hey keo explain the error on line 10', confidence: 0.6, alts: [] });
    await waitFor(() => system.length > 0);
    expect(system).toContain('add.ts — keo — Visual Studio Code');
    expect(system).toContain('"hwnd":"777"');
    expect(system).toMatch(/“the error”, “line 10”/);
  });
});
