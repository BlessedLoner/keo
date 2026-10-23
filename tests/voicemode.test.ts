import { afterEach, describe, expect, it, vi } from 'vitest';
import { spokenVersion } from '../src/main/voice/voiceMode';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { FakeSpeech, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
let seq = 0;
const call = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: `t${++seq}`, name, input }], stopReason: 'tool_use', usage: null, model: 'keo-test-1', native: undefined });

/** A scripted microphone and speaker for voice mode. */
class FakeVoice {
  heard: Array<string | null> = [];
  spoken: string[] = [];
  listens = 0;
  async listen() {
    this.listens++;
    await new Promise((r) => setTimeout(r, 5));
    const next = this.heard.shift();
    return next === undefined || next === null ? { text: null, reason: 'silence' } : { text: next, reason: 'ok' };
  }
  async speak(text: string) {
    this.spoken.push(text);
  }
}

function setup(script: (req: ChatRequest, n: number) => ChatResult) {
  const io = new FakeVoice();
  const speech = new FakeSpeech();
  h = makeHarness({ speech, script, voiceIo: { listen: () => io.listen(), speak: (t) => io.speak(t) } });
  h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMain: () => undefined };
  return { io, speech };
}

describe('voice mode', () => {
  it('holds a spoken conversation: answers aloud, listens again, ends on “stop”', async () => {
    const { io } = setup((req) => reply(`You said: ${JSON.stringify(req.messages.at(-1)?.content).includes('weather') ? 'weather' : 'joke'}`));
    io.heard = ['what is the weather like', 'tell me a joke', 'stop'];
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    expect(io.spoken).toEqual(['You said: weather', 'You said: joke', 'Okay.']);
    const conv = h.services.settings.get().commandBar.conversationId!;
    expect(h.services.conversations.messages(conv).filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['what is the weather like', 'tell me a joke']);
  });

  it('starts with a command spoken together with the wake word, and ends after two silences', async () => {
    const { io } = setup(() => reply('Opening it now.'));
    io.heard = [null, null];
    h.services.voiceMode.start('open notepad');
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    expect(io.spoken[0]).toBe('Opening it now.');
    expect(io.listens).toBe(2);
  });

  it('asks the model for short spoken answers while voice mode is on', async () => {
    let system = '';
    const { io } = setup((req) => {
      system = req.system;
      return reply('Fine.');
    });
    io.heard = ['hi', 'stop'];
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    expect(system).toMatch(/talking to you by voice/);
  });

  for (const [answer, expected] of [
    ['yes please', 'succeeded'],
    ['no', 'denied'],
] as const) {
    it(`asks for approval by voice and acts on “${answer}”`, async () => {
      // The model asks to focus Notepad when the user asks for it, and answers otherwise.
      const { io } = setup((req) => {
        const last = req.messages.at(-1);
        const askedForIt = last?.role === 'user' && JSON.stringify(last.content).includes('bring notepad to the front') && !JSON.stringify(last.content).includes('tool_result');
        return askedForIt && req.tools.length ? call('desktop__focus_window', { target: { hwnd: '1001', pid: 4242, processName: 'notepad' } }) : reply('Done.');
      });
      h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] }, agent: { approvalWaitSeconds: 10 } });
      io.heard = ['bring notepad to the front', answer, 'stop'];
      h.services.voiceMode.start();
      await waitFor(() => !h.services.voiceMode.isActive(), 8000);
      expect(io.spoken.some((x) => /^I need your OK to /.test(x))).toBe(true);
      const step = h.services.tasks.list(10).flatMap((t) => t.steps).find((x) => x.capabilityId === 'desktop.focus_window');
      expect(step?.state).toBe(expected);
    });
  }

  it('approves an always-ask action by voice, but never a critical one (it needs the screen)', async () => {
    const { io } = setup((req) => {
      const last = req.messages.at(-1);
      const said = last?.role === 'user' && !JSON.stringify(last.content).includes('tool_result');
      const text = JSON.stringify(last?.content ?? '');
      if (said && req.tools.length && text.includes('click the button')) return call('desktop__click', { target: { hwnd: '1001', pid: 4242, processName: 'notepad' }, x: 5, y: 5 });
      if (said && req.tools.length && text.includes('run the tests')) return call('files__run_script', { projectId: projectId!, script: 'test' });
      return reply('Done.');
    });
    let projectId: string | null = null;
    const root = (await import('./helpers')).tempDir();
    (await import('node:fs')).writeFileSync((await import('node:path')).join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    projectId = h.services.projects.create('P').id;
    h.services.settings.update({ projectWorkspaces: { [projectId]: root }, permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] }, agent: { approvalWaitSeconds: 10 } });
    io.heard = ['click the button', 'yes', 'run the tests', 'yes'];
    h.services.voiceMode.start();
    await waitFor(() => io.spoken.some((s) => /needs your approval on screen/.test(s)), 8000);
    const steps = h.services.tasks.list(10).flatMap((t) => t.steps);
    expect(steps.find((s) => s.capabilityId === 'desktop.click')?.approval?.decision).toBe('approved');
    expect(steps.find((s) => s.capabilityId === 'files.run_script')?.state).toBe('awaiting_authorization');
    h.services.voiceMode.stop();
  });

  it('asks by voice to read a window that is not allowed yet, and allows only that app', async () => {
    const { io } = setup((req) => {
      const last = req.messages.at(-1);
      const asked = last?.role === 'user' && JSON.stringify(last.content).includes('look at my screen') && !JSON.stringify(last.content).includes('tool_result');
      return asked && req.tools.length ? call('access__allow_app', { target: { hwnd: '1001', pid: 4242, processName: 'notepad' }, purpose: 'to explain what is on your screen' }) : reply('It is a note.');
    });
    h.services.settings.update({ autonomy: { level: 'hands_free' }, agent: { approvalWaitSeconds: 10 } });
    io.heard = ['look at my screen', 'yes', 'stop'];
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 8000);
    expect(io.spoken.some((x) => /^I need your OK to let keo read notepad/i.test(x))).toBe(true);
    const step = h.services.tasks.list(10).flatMap((t) => t.steps).find((x) => x.capabilityId === 'access.allow_app');
    expect(step?.state).toBe('succeeded');
    expect(step?.approval?.policy).toBeUndefined(); // approved by the user, not by the hands-free policy
    const p = h.services.settings.get().permissions;
    expect(p.observationEnabled).toBe(true);
    expect(p.allowedApps.map((a) => a.processName)).toEqual(['notepad']);
    expect(p.desktopControlEnabled).toBe(false);
    expect(Object.values(p.visionExport).some(Boolean)).toBe(false);
  });

  it('pauses the wake listener during the conversation and resumes after', async () => {
    const { io, speech } = setup(() => reply('ok'));
    h.services.settings.update({ wake: { enabled: true } });
    await waitFor(() => speech.cmds().includes('wake'));
    io.heard = ['hello', 'stop'];
    const before = speech.cmds().length;
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    const during = speech.cmds().slice(before);
    expect(during[0]).toBe('pause');
    expect(during.at(-1)).toBe('wake');
  });

  it('Stop everything ends voice mode', async () => {
    const { io } = setup(() => reply('ok'));
    io.heard = [];
    io.listen = () => new Promise(() => undefined); // waiting for the user to speak
    h.services.voiceMode.start();
    await waitFor(() => h.services.voiceMode.isActive());
    h.services.stopAll();
    expect(h.services.voiceMode.isActive()).toBe(false);
  });

  it('speaks plain text: no Markdown, code or links; long answers point to the screen', () => {
    expect(spokenVersion('**Hi** there, see [docs](https://x.y) and `npm test`.\n```js\nx()\n```')).toBe('Hi there, see docs and npm test. (code is on screen)');
    const long = spokenVersion(`${'This is a sentence. '.repeat(60)}`);
    expect(long.endsWith('The rest is on screen.')).toBe(true);
    expect(long.length).toBeLessThan(650);
  });
});

describe('spoken replies', () => {
  type Pushed = { channel: string; payload: { type?: string; id?: string; text?: string } };
  function speaker(answer: 'spoken' | 'no_start' | 'skipped' | null) {
    const said: string[] = [];
    h = makeHarness({ deps: { windowsSpeak: async (t) => void said.push(t) } });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, ensureVoiceWindow: async () => undefined };
    const pushed: Pushed[] = [];
    h.services.setPush(((channel: string, payload: Pushed['payload']) => {
      pushed.push({ channel, payload });
      // The main window answers like the real one: the voice spoke, or never started.
      if (answer && payload.type === 'voice_say') setTimeout(() => h.services.voiceDone(payload.id!, null, answer), 5);
    }) as never);
    const speak = (text: string, queue = false) => (h.services as unknown as { voiceSpeak(t: string, q: boolean): Promise<void> }).voiceSpeak(text, queue);
    return { said, pushed, speak };
  }

  it('a reply the app voice spoke is not repeated', async () => {
    const { said, speak } = speaker('spoken');
    await speak('Hello there.');
    expect(said).toEqual([]);
  });

  it('when the app voice never starts, it is cancelled and Windows’ own voice says the reply', async () => {
    const { said, pushed, speak } = speaker('no_start');
    await speak('The weather is sunny.');
    expect(said).toEqual(['The weather is sunny.']);
    const types = pushed.filter((p) => p.channel === 'presence:command').map((p) => p.payload.type);
    expect(types.indexOf('stop_speaking')).toBeGreaterThan(types.indexOf('voice_say'));
  });

  it('a part skipped mid-reply is not said in Windows’ voice, and the reply is not cut off', async () => {
    const { said, pushed, speak } = speaker('skipped');
    await Promise.all([speak('First part.', true), speak('Second part.', true)]);
    expect(said).toEqual([]);
    expect(pushed.some((p) => p.payload.type === 'stop_speaking')).toBe(false);
  });

  it('a queued part waits behind the parts before it instead of timing out', async () => {
    vi.useFakeTimers();
    try {
      const { said, pushed, speak } = speaker(null);
      let done = false;
      void speak('A part queued behind a long answer.', true).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(done).toBe(false);
      expect(said).toEqual([]);
      const id = pushed.find((p) => p.payload.type === 'voice_say')!.payload.id!;
      h.services.voiceDone(id, null, 'spoken');
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(said).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('queued parts the window could not say are said by Windows one at a time, in order, without stopping the window', async () => {
    const order: string[] = [];
    h = makeHarness({
      deps: {
        windowsSpeak: async (t) => {
          order.push(`start ${t}`);
          await new Promise((r) => setTimeout(r, 20));
          order.push(`end ${t}`);
        },
      },
    });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, ensureVoiceWindow: async () => undefined };
    const types: string[] = [];
    h.services.setPush(((_c: string, payload: { type?: string; id?: string }) => {
      if (payload.type) types.push(payload.type);
      if (payload.type === 'voice_say') setTimeout(() => h.services.voiceDone(payload.id!, null, 'no_start'), 5);
    }) as never);
    const speak = (t: string) => (h.services as unknown as { voiceSpeak(t: string, q: boolean): Promise<void> }).voiceSpeak(t, true);
    await Promise.all([speak('One.'), speak('Two.')]);
    expect(order).toEqual(['start One.', 'end One.', 'start Two.', 'end Two.']);
    expect(types).not.toContain('stop_speaking');
  });
});

describe('cloud voice parts', () => {
  it('starts with a short sentence and keeps sentences whole', async () => {
    const { speechParts } = await import('../src/shared/speech');
    const text = 'Here is what I found. The MacBook Air costs 1,099 dollars at Apple and 999 at Best Buy this week. The Pro starts at 1,599. ' + 'It has a brighter screen and more ports. '.repeat(12);
    const parts = speechParts(text);
    expect(parts[0]!.startsWith('Here is what I found.')).toBe(true);
    expect(parts[0]!.length).toBeLessThanOrEqual(140);
    expect(parts[0]!.endsWith('.')).toBe(true);
    expect(parts.every((p) => p.length <= 360)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(text.trim().replace(/\s+/g, ' '));
    expect(speechParts('Okay')).toEqual(['Okay']);
  });
});

describe('speaking while the reply is written', () => {
  it('says finished sentences early and the rest at the end, nothing twice', async () => {
    const { io } = setup(() => reply('Sure thing. The weather today is sunny and warm across the city. Have fun outside!'));
    io.heard = ['what is the weather'];
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    const said = io.spoken.filter((t) => !/^okay\.?$/i.test(t));
    expect(said.join(' ')).toContain('Sure thing. The weather today is sunny and warm across the city. Have fun outside!');
    expect(said.join(' ').match(/Have fun outside/g)).toHaveLength(1);
    expect(said.join(' ').match(/Sure thing/g)).toHaveLength(1);
  });

  it('finds sentence ends, not decimals, abbreviations or code', async () => {
    const { lastSentenceEnd } = await import('../src/main/voice/voiceMode');
    const t = 'The price is 1,299.99 dollars today. Ask Dr. Lee about it. ';
    expect(t.slice(0, lastSentenceEnd(t))).toBe('The price is 1,299.99 dollars today. Ask Dr. Lee about it.');
    expect(lastSentenceEnd('Short. ')).toBe(0);
    expect(lastSentenceEnd('Here is code: ```js\nconst a = 1. ')).toBe(0);
  });
});
