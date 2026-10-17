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

  it('never learns common words, or sounds unlike the phrase, as a wake phrase', () => {
    expect(learnableVariants(['okay', 'hey', 'a cleo', 'hey keo', 'a cleo'], 'hey keo', [])).toEqual(['a cleo']);
    expect(learnableVariants(['But all', 'Jamal'], 'hi siri', [])).toEqual([]);
    // Already-saved implausible versions are ignored when matching.
    expect(matchWake(['but all'], ['hi siri'], ['but all'])).toBeNull();
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
    expect(shown()).toBe(0);
    expect(h.services.voiceMode.isActive()).toBe(true);
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
    expect(learned).toMatchObject({ heard: 'a cleo', added: ['a cleo'] }); // “a clear” sounds too different to trust
    expect(h.services.settings.get().wake.learned).toEqual(['a cleo']);
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

describe('reliable listening', () => {
  it('a cancelled capture never blocks the next one, and its late events are ignored', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    const first = h.services.wake.capture();
    await waitFor(() => speech.cmds().includes('capture'));
    const firstId = speech.lastCaptureId();
    h.services.wake.cancelCapture(); // the helper never answers this cancel
    expect((await first).reason).toBe('cancelled');
    const second = h.services.wake.capture();
    await waitFor(() => speech.lastCaptureId() !== firstId);
    speech.fire({ event: 'capture_cancelled', id: firstId }); // late event of the old capture
    speech.fire({ event: 'command', text: 'open notepad', confidence: 0.9, id: speech.lastCaptureId() });
    expect(await second).toEqual({ text: 'open notepad', reason: 'ok' });
  });

  it('a new capture replaces one still running instead of answering “busy”', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    const first = h.services.wake.capture();
    await waitFor(() => speech.cmds().includes('capture'));
    const second = h.services.wake.capture();
    expect((await first).reason).toBe('cancelled');
    await waitFor(() => speech.cmds().filter((c) => c === 'capture').length === 2);
    speech.fire({ event: 'command', text: 'hello', confidence: 0.9, id: speech.lastCaptureId() });
    expect((await second).text).toBe('hello');
  });

  it('restarts a crashed speech helper on its own so the wake word stays ready', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    const before = speech.started;
    speech.crash();
    await waitFor(() => speech.started > before, 5000);
    await waitFor(() => h.services.wake.getState().status === 'listening', 5000);
  });

  it('voice mode retries once after a recognizer hiccup instead of ending with an error', async () => {
    const speech = new FakeSpeech();
    const spoken: string[] = [];
    const results = [{ text: null, reason: 'error' }, { text: 'stop', reason: 'ok' }];
    h = makeHarness({ speech, script: () => reply('ok'), voiceIo: { listen: async () => results.shift() ?? { text: null, reason: 'silence' }, speak: async (t) => void spoken.push(t) } });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMain: () => undefined };
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    expect(spoken).toEqual(['Okay.']);
  });
});

describe('wake word always comes back', () => {
  it('resumes listening even when the “finished speaking” signal was lost', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    h.services.wake.setSpeaking(true); // Keo starts speaking, then playback is cut off without a "done"
    expect(speech.cmds().at(-1)).toBe('pause');
    const wakes = speech.cmds().filter((c) => c === 'wake').length;
    const realNow = Date.now;
    Date.now = () => realNow() + 3 * 60_000;
    try {
      await h.services.wake.heal();
    } finally {
      Date.now = realNow;
    }
    expect(speech.cmds().filter((c) => c === 'wake').length).toBe(wakes + 1);
  });

  it('restarts listening after a recognizer error', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    const wakes = speech.cmds().filter((c) => c === 'wake').length;
    speech.fire({ event: 'error', code: 'speech_error', message: 'audio device busy' });
    await h.services.wake.heal();
    expect(speech.cmds().filter((c) => c === 'wake').length).toBe(wakes + 1);
  });

  it('does not restart while it is already listening, muted, or in a conversation', async () => {
    const speech = new FakeSpeech();
    h = makeHarness({ speech, script: () => reply('ok') });
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    const n = speech.sent.length;
    await h.services.wake.heal();
    expect(speech.sent.length).toBe(n);
    h.services.wake.setVoiceMode(true);
    speech.fire({ event: 'error', code: 'speech_error' });
    const m = speech.sent.length;
    await h.services.wake.heal();
    expect(speech.sent.length).toBe(m);
  });
});

describe('transcription', () => {
  it('drops phrases speech-to-text invents for silence, keeps real short answers', async () => {
    const { dropHallucination } = await import('../src/main/voice/voiceService');
    for (const t of ['Thanks for watching!', 'Gracias.', 'Subtítulos realizados por la comunidad de Amara.org', '...', 'you']) expect(dropHallucination(t)).toBe('');
    for (const t of ['Okay', 'Thank you', 'yes please', 'open WhatsApp', 'no']) expect(dropHallucination(t)).toBe(t);
  });
});
