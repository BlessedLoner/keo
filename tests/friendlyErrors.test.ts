import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/domain';
import { explainReplyError, explainStepError } from '../src/shared/friendlyErrors';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('problems in normal words', () => {
  it('a failed reply says what happened and what to do', () => {
    const net = explainReplyError('network', 'fetch failed: ECONNRESET');
    expect(net.what).toBe('Keo could not reach the AI service.');
    expect(net.todo).toContain('internet');
    expect(net.action).toBe('retry');
    expect(explainReplyError('auth', 'HTTP 401 {"error":"invalid_api_key"}').action).toBe('settings');
    expect(explainReplyError(undefined, undefined).what).toContain('Something went wrong');
    // Keo Cloud's own words about the plan are already plain: kept.
    expect(explainReplyError('quota', 'You have used today’s allowance on the Free plan. Upgrade for more.').what).toContain('Free plan');
    // A raw provider error is not.
    expect(explainReplyError('quota', 'HTTP 402 {"error":"insufficient_quota"}').what).toContain('credit or allowance');
  });

  it('a failed step reads as one plain sentence; the technical text is kept for Details', () => {
    const t = explainStepError('Error: connect ECONNREFUSED 127.0.0.1:8080');
    expect(t.text).toContain('could not connect');
    expect(t.technical).toContain('ECONNREFUSED');
    expect(explainStepError("ENOENT: no such file or directory, open 'C:\\\\x.txt'").text).toBe('The file or folder was not found.');
    expect(explainStepError('The helper timed out after 15000 ms').text).toContain('took too long');
    // Keo's own messages are already plain: unchanged.
    const plain = explainStepError('No window called WhatsApp is open.');
    expect(plain).toEqual({ text: 'No window called WhatsApp is open.', technical: null });
    const look = 'The text read back from the window does not match what was sent. Look at the window before doing anything else.';
    expect(explainStepError(look)).toEqual({ text: look, technical: null });
  });
});

describe('what Keo is doing right now', () => {
  it('each step is announced in words while it runs', async () => {
    const calls = (name: string, input: unknown): ChatResult => ({ text: '', toolCalls: [{ id: 'p1', name, input }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined });
    h = makeHarness({
      script: (_req, n) => (n === 0 ? calls('desktop__list_windows', {}) : { text: 'Notepad is open.', toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined }),
    });
    h.services.settings.update({ permissions: { observationEnabled: true, desktopControlEnabled: true } });
    const seen: AgentEvent[] = [];
    h.services.setPush((ch, p) => ch === 'agent:event' && seen.push(p as AgentEvent));
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'which windows are open?').done;
    const phases = seen.filter((e): e is Extract<AgentEvent, { type: 'phase' }> => e.type === 'phase');
    const step = phases.find((e) => e.detail);
    expect(step?.phase).toBe('gathering_context');
    expect(step?.detail?.length).toBeGreaterThan(3);
  });
});
