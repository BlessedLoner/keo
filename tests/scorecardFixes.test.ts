import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BuildProjects } from '../src/main/build/projects';
import { ProviderError, type ChatRequest, type ChatResult } from '../src/main/providers/types';
import { makeHarness, tempDir, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string, toolCalls: ChatResult['toolCalls'] = [], stopReason: ChatResult['stopReason'] = toolCalls.length ? 'tool_use' : 'end'): ChatResult => ({ text, toolCalls, stopReason, usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined });
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('AI pictures when the user’s OpenAI key is out of credit', () => {
  it('the Keo account makes the picture instead, and the dead key is left alone afterwards', async () => {
    h = makeHarness({});
    const s = h.services as unknown as {
      secrets: { set(k: string, v: string): void };
      account: { signedIn(): boolean; image(o: unknown, signal: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }> };
      providers: { openai: { generateImage(...a: unknown[]): Promise<unknown>; imageModels(...a: unknown[]): Promise<string[]> } };
      pictures: { d: { ai(): { generate(o: unknown, signal: AbortSignal): Promise<Buffer> } | null } };
    };
    s.secrets.set('openai', 'sk-test');
    s.account.signedIn = () => true;
    let keo = 0;
    let openai = 0;
    s.account.image = async () => (keo++, { bytes: PNG, mediaType: 'image/png' });
    s.providers.openai.imageModels = async () => ['gpt-image-1'];
    s.providers.openai.generateImage = async () => {
      openai++;
      throw new ProviderError('quota', 'OpenAI reports the account quota is exhausted.');
    };
    const o = { prompt: 'a cake', size: '1024x1024', quality: 'low' };
    expect(await s.pictures.d.ai()!.generate(o, new AbortController().signal)).toEqual(PNG);
    expect([openai >= 1, keo]).toEqual([true, 1]);
    const before = openai;
    await s.pictures.d.ai()!.generate(o, new AbortController().signal);
    expect(openai).toBe(before); // straight to the Keo account now
    expect(keo).toBe(2);
  });
});

describe('the reply loop recovers instead of stopping', () => {
  it('a step cut off by the output limit is asked for again in smaller pieces', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(req);
        if (n === 0) return reply('', [{ id: 'c1', name: 'memory__list', input: {} }], 'max_tokens');
        return reply('Done in smaller pieces.');
      },
    });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'write the long file').done;
    expect(JSON.stringify(seen[1]!.messages)).toContain('was cut off by the output limit, so it did NOT run');
    expect(msg.content).toContain('Done in smaller pieces.');
    expect(msg.content).not.toContain('so it was not run');
  });

  it('an answer that breaks off midway is asked for once more, and the user is told', async () => {
    let calls = 0;
    h = makeHarness({ script: () => reply('Here is the full summary.') });
    const p = h.provider as unknown as { stream: (req: ChatRequest, cb: { onText?: (d: string) => void }, signal: AbortSignal) => Promise<ChatResult> };
    const real = p.stream.bind(p);
    p.stream = async (req, cb, signal) => {
      calls++;
      if (calls === 1) {
        cb.onText?.('Here is the sum');
        throw new ProviderError('malformed', 'The answer came back garbled.');
      }
      return real(req, cb, signal);
    };
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'summarise my email').done;
    expect(calls).toBe(2);
    expect(msg.content).toContain('The answer broke off — Keo is asking again.');
    expect(msg.content).toContain('Here is the full summary.');
    expect(msg.status).toBe('complete');
  });
});

describe('builds of another account', () => {
  it('a build that is on this PC but not on this account’s list: Keo is told to ask before copying it', () => {
    const root = tempDir('keo-builds-');
    const log = { info: () => undefined, warn: () => undefined };
    const modules = path.join(__dirname, '..', 'node_modules');
    const accA = tempDir('keo-acct-a-');
    const accB = tempDir('keo-acct-b-');
    const a = new BuildProjects({ root: () => root, modules: () => modules, log, accountDir: () => accA } as never);
    const m = a.create({ title: 'Bakery', kind: 'website' });
    expect(fs.existsSync(path.join(a.dir(m.id), 'keo-build.json'))).toBe(true);
    const b = new BuildProjects({ root: () => root, modules: () => modules, log, accountDir: () => accB } as never);
    expect(() => b.dir(m.id)).toThrow(/no such build.*folder is still on this PC.*Ask the user/);
    expect(() => b.dir('bd_000000')).toThrow(/no such build/);
  });
});

describe('cheaper long tasks', () => {
  it('files written in older steps are not resent in full; the last two steps stay whole', async () => {
    const { shrinkOldCalls } = await import('../src/main/agent/workPlan');
    const big = 'x'.repeat(5000);
    const step = (id: string) => [
      { role: 'assistant' as const, content: [{ type: 'tool_call' as const, id, name: 'build__write', input: { build: 'bd_1', files: [{ path: 'index.html', content: big }] } }] },
      { role: 'user' as const, content: [{ type: 'tool_result' as const, callId: id, content: '{"status":"succeeded"}' }] },
    ];
    const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'build it' }] }, ...step('a'), ...step('b'), ...step('c')];
    expect(shrinkOldCalls(messages as never, 1)).toBe(1);
    const inputs = messages.filter((m) => m.role === 'assistant').map((m) => JSON.stringify((m.content[0] as { input: unknown }).input));
    expect(inputs[0]).toContain('[Sent earlier: 5000 characters');
    expect(inputs[1]).toContain('xxxxx');
    expect(inputs[2]).toContain('xxxxx');
    expect(shrinkOldCalls(messages as never, 1)).toBe(0); // done once
  });

  it('the checklist rides at the end of the request without changing the stored conversation', async () => {
    const { withTrailingNote } = await import('../src/main/agent/agentService');
    const msgs = [{ role: 'user' as const, content: [{ type: 'tool_result' as const, callId: 'a', content: 'ok' }] }];
    const out = withTrailingNote(msgs as never, '[x] step one');
    expect(out.at(-1)!.content.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(msgs[0]!.content).toHaveLength(1);
    expect(withTrailingNote(msgs as never, '')).toBe(msgs);
    // Before the user's own words, so they stay the last thing read.
    const asked = withTrailingNote([{ role: 'user', content: [{ type: 'text', text: 'build it' }] }] as never, '[ ] plan');
    expect(asked.at(-1)!.content.map((b) => (b as { text: string }).text)).toEqual(['[ ] plan', 'build it']);
    const afterAssistant = withTrailingNote([{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }] as never, 'note');
    expect(afterAssistant.at(-1)).toEqual({ role: 'user', content: [{ type: 'text', text: 'note' }] });
  });
});
