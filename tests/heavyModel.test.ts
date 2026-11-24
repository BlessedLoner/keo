import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'x', native: undefined });

describe('the strongest model for building', () => {
  it('a request to build a game uses the heavy model; small talk keeps the chosen one', async () => {
    const models: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest) => {
        models.push(req.model);
        return reply('ok');
      },
    });
    h.services.agent.heavyModel = () => 'keo-test-heavy';
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'build me a realistic 3D car racing game with a real city').done;
    await h.services.agent.send(c.id, 'thanks, how are you?').done;
    expect(models[0]).toBe('keo-test-heavy');
    expect(models[1]).not.toBe('keo-test-heavy');
  });

  it('a build started on a lighter model moves to the heavy one for the rest of the turn', async () => {
    const models: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest, n) => {
        models.push(req.model);
        if (n === 0) return { text: '', toolCalls: [{ id: 'b1', name: 'build__list', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'x', native: undefined };
        return reply('done');
      },
    });
    h.services.agent.heavyModel = () => 'keo-test-heavy';
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'show me the things you made').done;
    expect(models[0]).not.toBe('keo-test-heavy');
    expect(models[1]).toBe('keo-test-heavy');
  });

  it('a Keo build uses Keo Strong; Keo Best only when the user chose it or asks for it', () => {
    h = makeHarness();
    const pick = h.services.agent.heavyModel!;
    const keo = { id: 'keo' } as never;
    const set = (ids: string[]) => ((h.services.account as unknown as { modelList: Array<{ id: string }> }).modelList = ids.map((id) => ({ id })));
    const build = 'build me a landing page for my bakery';
    // Max: Strong by default, even though Best is in the plan.
    set(['keo-fast', 'keo-strong', 'keo-best']);
    expect(pick(keo, 'keo-fast', build)).toBe('keo-strong');
    // Asked for in the user's own words.
    expect(pick(keo, 'keo-fast', 'build me a game with Keo Best')).toBe('keo-best');
    expect(pick(keo, 'keo-fast', 'use the best model to build my portfolio site')).toBe('keo-best');
    // The user picked Best as their model: never replaced by Strong.
    expect(pick(keo, 'keo-best', build)).toBeNull();
    // Already on Strong: nothing to change.
    expect(pick(keo, 'keo-strong', build)).toBeNull();
    // Pro and Creator: no Best, so asking for it still gives Strong.
    set(['keo-fast', 'keo-strong']);
    expect(pick(keo, 'keo-fast', 'build it with Keo Best')).toBe('keo-strong');
    // Free: nothing stronger to move to.
    set(['keo-fast']);
    expect(pick(keo, 'keo-fast', build)).toBeNull();
    // Another provider: the user's own model choice stands.
    expect(pick({ id: 'openrouter' } as never, 'x', build)).toBeNull();
  });
});
