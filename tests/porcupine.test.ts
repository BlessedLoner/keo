import { afterEach, describe, expect, it } from 'vitest';
import type { FrameSource, PorcupineFactory, WakeDetector } from '../src/main/voice/porcupineEngine';
import type { ChatResult } from '../src/main/providers/types';
import { FakeSpeech, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

/** A fake Porcupine: "hears" the keyword when the test says so. */
function fakePorcupine() {
  const state = { created: 0, keywords: [] as string[], keys: [] as string[], recording: false, fire: false, released: 0 };
  const factory: PorcupineFactory = {
    detector(key, kw) {
      state.created++;
      state.keys.push(key);
      state.keywords.push(...kw);
      const d: WakeDetector = { frameLength: 512, process: () => (state.fire ? ((state.fire = false), 0) : -1), release: () => void state.released++ };
      return d;
    },
    recorder() {
      const r: FrameSource = {
        start: () => void (state.recording = true),
        stop: () => void (state.recording = false),
        release: () => undefined,
        read: () => new Promise((res) => setTimeout(() => res(new Int16Array(512)), 5)),
      };
      return r;
    },
    builtinPath: (k) => `C:/pv/${k}_windows.ppn`,
  };
  return { state, factory };
}

describe('trained wake word (Porcupine)', () => {
  it('wakes on the keyword and starts a voice conversation; Windows speech stays idle meanwhile', async () => {
    const speech = new FakeSpeech();
    const pv = fakePorcupine();
    h = makeHarness({ speech, script: () => reply('ok'), voiceIo: { listen: () => new Promise(() => undefined), speak: async () => undefined }, deps: { porcupineFactory: () => pv.factory } });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMain: () => undefined };
    h.services.secrets.set('picovoice', 'test-access-key-123');
    h.services.settings.update({ wake: { enabled: true, engine: 'porcupine', porcupine: { builtin: 'jarvis' } } });
    await waitFor(() => pv.state.recording, 5000);
    expect(pv.state.keywords).toEqual(['C:/pv/jarvis_windows.ppn']);
    expect(pv.state.keys).toEqual(['test-access-key-123']);
    expect(speech.cmds()).not.toContain('wake'); // the Windows recognizer is not listening
    expect(h.services.wake.engineInfo().kind).toBe('porcupine');
    pv.state.fire = true;
    await waitFor(() => h.services.voiceMode.isActive(), 5000);
    expect(pv.state.recording).toBe(false); // paused during the conversation
    h.services.voiceMode.stop();
  });

  it('without an access key it says why and falls back to Windows speech', async () => {
    const speech = new FakeSpeech();
    const pv = fakePorcupine();
    h = makeHarness({ speech, script: () => reply('ok'), deps: { porcupineFactory: () => pv.factory } });
    h.services.settings.update({ wake: { enabled: true, engine: 'porcupine', porcupine: { builtin: 'jarvis' } } });
    await waitFor(() => speech.cmds().includes('wake'), 5000);
    expect(pv.state.created).toBe(0);
    expect(h.services.wake.engineInfo().fallbackReason).toMatch(/access key/i);
  });

  it('a missing .ppn file is reported, never the key', async () => {
    const speech = new FakeSpeech();
    const pv = fakePorcupine();
    h = makeHarness({ speech, script: () => reply('ok'), deps: { porcupineFactory: () => pv.factory } });
    h.services.secrets.set('picovoice', 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEF==');
    h.services.settings.update({ wake: { enabled: true, engine: 'porcupine', porcupine: { keywordPath: 'C:/nowhere/hey_keo_windows.ppn' } } });
    await waitFor(() => speech.cmds().includes('wake'), 5000);
    const why = h.services.wake.engineInfo().fallbackReason ?? '';
    expect(why).toMatch(/\.ppn/);
    expect(why).not.toMatch(/abcdefghijklmnopqrstuvwxyz/);
  });
});
