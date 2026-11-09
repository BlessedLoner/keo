import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('replies made to be heard', () => {
  it('a request said aloud gets a short spoken-style reply; a typed one does not', async () => {
    const systems: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest) => {
        systems.push(req.system);
        return { text: 'It is three o’clock.', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined };
      },
    });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'what time is it', { voice: true }).done;
    await h.services.agent.send(c.id, 'what time is it').done;
    expect(systems[0]).toContain('Voice-first mode');
    expect(systems[1]).not.toContain('Voice-first mode');
  });
});
