import { afterEach, describe, expect, it } from 'vitest';
import { chooseRoute } from '../src/main/agent/routing';
import type { ChatResult } from '../src/main/providers/types';
import { defaultSettings, mergeSettings } from '../src/shared/settings';
import { FakeSpeech, makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
const typed = (text: string) => chooseRoute({ text, voice: false, images: false, openQuestion: false }).route;

/** Records which model answered each turn. */
function routed() {
  const models: string[] = [];
  h = makeHarness({
    script: (req) => {
      models.push(req.model);
      return reply('ok');
    },
  });
  h.services.settings.update({ routing: { enabled: true, fast: { provider: 'test', model: 'keo-fast' }, strong: { provider: 'test', model: 'keo-strong' } } });
  return models;
}

describe('smart routing settings', () => {
  it('is off by default with no models chosen', () => {
    const s = defaultSettings();
    expect(s.routing).toEqual({ enabled: false, fast: { provider: null, model: '' }, strong: { provider: null, model: '' } });
  });

  it('rejects unknown keys, providers and invalid model ids', () => {
    const s = defaultSettings();
    expect(() => mergeSettings(s, { routing: { extra: true } })).toThrow();
    expect(() => mergeSettings(s, { routing: { fast: { provider: 'somewhere' } } })).toThrow();
    expect(() => mergeSettings(s, { routing: { strong: { model: 'bad model; rm' } } })).toThrow();
    expect(mergeSettings(s, { routing: { strong: { provider: 'openrouter', model: 'anthropic/claude-opus-5.5' } } }).routing.strong.model).toBe('anthropic/claude-opus-5.5');
  });
});

describe('route choice', () => {
  it('sends small talk and quick questions to the fast model', () => {
    for (const t of ['hi', 'thanks!', 'what time is it in Lagos?', 'open notepad', 'who wrote Things Fall Apart?']) expect(typed(t)).toBe('fast');
  });

  it('sends complex work to the strong model', () => {
    for (const t of [
      'research the best laptops under $800 for video editing',
      'write a Python script that renames my photos by date',
      'help me plan a three-day trip to Accra',
      'compare these two phone contracts',
      'open WhatsApp, then send Mum the photo and after that search for flights',
      'fix this:\n```js\nconst a = 1\n```',
      `${'Please read this carefully. '.repeat(15)}`,
    ])
      expect(typed(t), t).toBe('strong');
  });

  it('keeps voice on the fast model, even for long transcripts, unless it is complex work', () => {
    const voice = (text: string) => chooseRoute({ text, voice: true, images: false, openQuestion: false }).route;
    expect(voice('tell me a joke')).toBe('fast');
    expect(voice('so I was thinking about what we talked about yesterday and I just wanted to say it was really nice and I hope you had a good day too because I certainly did and now I am going to bed soon '.repeat(2))).toBe('fast');
    expect(voice('research the cheapest flights to London next month')).toBe('strong');
  });

  it('uses the strong model for pictures and for continuing a task', () => {
    expect(chooseRoute({ text: 'what is this?', voice: false, images: true, openQuestion: false }).route).toBe('strong');
    expect(chooseRoute({ text: 'Personal', voice: false, images: false, openQuestion: true }).route).toBe('strong');
  });
});

describe('routed turns', () => {
  it('changes nothing while routing is off', async () => {
    const models: string[] = [];
    h = makeHarness({ script: (req) => { models.push(req.model); return reply('ok'); } });
    h.services.settings.update({ routing: { fast: { provider: 'test', model: 'keo-fast' } } });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'hi').done;
    expect(models).toEqual(['keo-test-1']);
    expect(msg.meta.model).toBe('keo-test-1');
    expect(msg.meta.route).toBeUndefined();
  });

  it('answers each message with the chosen model and labels the reply', async () => {
    const models = routed();
    const c = h.services.conversations.create();
    const quick = await h.services.agent.send(c.id, 'hello there').done;
    const hard = await h.services.agent.send(c.id, 'research and compare the three best budget laptops').done;
    expect(models).toEqual(['keo-fast', 'keo-strong']);
    expect(quick.meta).toMatchObject({ providerId: 'test', model: 'keo-fast', route: 'fast' });
    expect(hard.meta).toMatchObject({ providerId: 'test', model: 'keo-strong', route: 'strong' });
    // A routed model the provider does not list keeps the provider's declared capabilities (tools).
    expect(h.provider.lastRequest?.tools.length).toBeGreaterThan(0);
  });

  it('uses the provider’s own model when a side names no model', async () => {
    const models = routed();
    h.services.settings.update({ routing: { fast: { model: '' } } });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'hi').done;
    expect(models).toEqual(['keo-test-1']);
  });

  it('falls back to the active provider when a side’s provider is not set up', async () => {
    const models = routed();
    h.services.settings.update({ routing: { strong: { provider: 'anthropic', model: 'claude-opus-5-5' } } }); // no Anthropic key stored
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'write a script that backs up my documents').done;
    expect(msg.status).toBe('complete');
    expect(models).toEqual(['keo-test-1']);
    expect(msg.meta).toMatchObject({ providerId: 'test', model: 'keo-test-1', route: 'strong' });
  });

  it('routes voice conversations to the fast model', async () => {
    const models: string[] = [];
    const heard: Array<string | null> = ['let me tell you about my day, it was long and busy and honestly quite tiring but also good in the end because I finished everything I had on my list and still had time to cook a proper dinner for everyone. '.repeat(2), 'stop'];
    h = makeHarness({
      speech: new FakeSpeech(),
      script: (req) => { models.push(req.model); return reply('Nice.'); },
      voiceIo: {
        listen: async () => {
          const next = heard.shift();
          return next ? { text: next, reason: 'ok' } : { text: null, reason: 'silence' };
        },
        speak: async () => undefined,
      },
    });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined, showMain: () => undefined };
    h.services.settings.update({ routing: { enabled: true, fast: { provider: 'test', model: 'keo-fast' }, strong: { provider: 'test', model: 'keo-strong' } } });
    h.services.voiceMode.start();
    await waitFor(() => !h.services.voiceMode.isActive(), 5000);
    expect(models).toEqual(['keo-fast']);
  });
});
