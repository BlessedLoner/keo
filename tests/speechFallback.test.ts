import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../src/main/providers/types';
import { spreadEvenly, wavSeconds } from '../src/main/services';
import { wavOf } from '../src/main/studio/captions';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('captions when the user’s OpenAI key is out of credit', () => {
  it('a WAV clip’s length comes from its header, and a plain transcript is spread over it', () => {
    const wav = wavOf(new Int16Array(16000 * 3), 16000, 0, 3);
    expect(wavSeconds(wav)).toBeCloseTo(3, 1);
    expect(spreadEvenly('one two three', 3)).toEqual([
      { text: 'one', start: 0, end: 1 },
      { text: 'two', start: 1, end: 2 },
      { text: 'three', start: 2, end: 3 },
    ]);
    expect(spreadEvenly('   ', 3)).toEqual([]);
  });

  it('carries on with the Keo account instead of failing, and leaves the dead key alone afterwards', async () => {
    h = makeHarness({});
    const s = h.services as unknown as {
      videoTranscribe: unknown;
      secrets: { set(k: string, v: string): void };
      account: { signedIn(): boolean; transcribe(wav: Buffer, lang: string, signal: AbortSignal): Promise<string> };
      providers: { openai: { transcribeWords(...a: unknown[]): Promise<unknown> } };
      studioTranscriber(): { destination: string; words?: (wav: Buffer, s: AbortSignal) => Promise<Array<{ text: string }>>; text?: unknown } | null;
    };
    s.videoTranscribe = null;
    s.secrets.set('openai', 'sk-test');
    s.account.signedIn = () => true;
    let keoCalls = 0;
    s.account.transcribe = async () => (keoCalls++, 'hello there friend');
    s.providers.openai.transcribeWords = async () => {
      throw new ProviderError('quota', 'OpenAI reports the account quota is exhausted.');
    };
    const first = s.studioTranscriber()!;
    expect(first.destination).toMatch(/Keo Cloud if your OpenAI key is out of credit/);
    const words = await first.words!(wavOf(new Int16Array(16000 * 3), 16000, 0, 3), new AbortController().signal);
    expect(words.map((w) => w.text)).toEqual(['hello', 'there', 'friend']);
    expect(keoCalls).toBe(1);
    // Next time the dead key is skipped.
    const next = s.studioTranscriber()!;
    expect(next.destination).toBe('Keo Cloud');
    expect(typeof next.text).toBe('function');
  });

  it('another kind of failure is not hidden behind the fallback', async () => {
    h = makeHarness({});
    const s = h.services as unknown as {
      videoTranscribe: unknown;
      secrets: { set(k: string, v: string): void };
      account: { signedIn(): boolean };
      providers: { openai: { transcribeWords(...a: unknown[]): Promise<unknown> } };
      studioTranscriber(): { words?: (wav: Buffer, s: AbortSignal) => Promise<unknown> } | null;
    };
    s.videoTranscribe = null;
    s.secrets.set('openai', 'sk-test');
    s.account.signedIn = () => true;
    s.providers.openai.transcribeWords = async () => {
      throw new ProviderError('network', 'Could not reach OpenAI.');
    };
    await expect(s.studioTranscriber()!.words!(wavOf(new Int16Array(1600), 16000, 0, 0.1), new AbortController().signal)).rejects.toThrow(/Could not reach OpenAI/);
  });
});
