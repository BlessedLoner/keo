import { afterEach, describe, expect, it } from 'vitest';
import { ProviderError, type ChatRequest, type ChatResult } from '../src/main/providers/types';
import { makeHarness, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined, ...extra });
const RESETS = '2026-11-25T00:00:00.000Z';
/** What Keo Cloud answers when a window of the AI allowance is used up. */
const paused = () =>
  new ProviderError('quota', 'You’ve used today’s share of your Pro AI allowance. Keo paused here and kept your work; it can carry on when the allowance resets at 00:00 UTC.', {
    status: 429,
    cloudCode: 'allowance_paused',
    paused: { window: 'day', until: RESETS },
  });
const lastText = (req: ChatRequest) => {
  const m = [...req.messages].reverse().find((x) => x.role === 'user');
  const texts = (m?.content.filter((b) => b.type === 'text') as Array<{ text: string }> | undefined) ?? [];
  return texts.at(-1)?.text ?? '';
};
const hasToolResult = (req: ChatRequest) => !!req.messages[req.messages.length - 1]?.content.some((b) => b.type === 'tool_result');

describe('a used-up AI allowance pauses the task (never a failure, never a silent model switch)', () => {
  it('the reply keeps what was done, says why it paused and when it can carry on', async () => {
    let calls = 0;
    const models: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest) => {
        calls++;
        models.push(req.model);
        if (calls === 1) return reply('', { toolCalls: [{ id: 't1', name: 'build__list', input: {} }], stopReason: 'tool_use' });
        throw paused();
      },
    });
    const c = h.services.conversations.create();
    const m = await h.services.agent.send(c.id, 'list the things you built, then tidy them up').done;
    expect(m.status).toBe('complete');
    expect(m.meta.paused).toEqual({ window: 'day', until: RESETS });
    expect(m.meta.ending?.kind).toBe('blocked');
    expect(m.meta.ending?.why).toContain('Paused');
    expect(m.content).toContain('Keo paused here and kept your work');
    expect(m.content).toContain('Say “continue”');
    expect(m.content).toContain('Buy AI top-up');
    // The step that ran is kept, and the same model was used throughout (no quiet switch).
    expect(m.meta.tools?.length).toBe(1);
    expect(new Set(models).size).toBe(1);
    expect(m.meta.error).toBeUndefined();
  });

  it('a paused background job waits, then carries on by itself when the allowance resets', async () => {
    let jobCalls = 0;
    h = makeHarness({
      script: (req: ChatRequest) => {
        if (req.system.includes('# Background job\n')) {
          jobCalls++;
          if (jobCalls === 1) throw paused();
          return reply('Report: all three sources agree.');
        }
        if (hasToolResult(req)) return reply('On it.');
        if (/^research/.test(lastText(req))) return reply('', { toolCalls: [{ id: 'j1', name: 'jobs__start_background', input: { title: 'Research ovens', brief: 'Research ovens and report.', kind: 'research' } }], stopReason: 'tool_use' });
        return reply('Hello!');
      },
    });
    // Catch the wake-up timer instead of waiting for midnight.
    const timers: Array<{ fn: () => void; ms: number }> = [];
    (h.services.jobs as unknown as { d: { setTimer: (fn: () => void, ms: number) => unknown } }).d.setTimer = (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    };
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'research ovens').done;
    await waitFor(() => h.services.jobs.list()[0]?.state === 'paused');
    const job = h.services.jobs.list()[0]!;
    expect(job.resumeAt).toBe(RESETS);
    // The user is told it paused (not that it failed), and when it carries on.
    const note = h.services.conversations.messages(c.id).find((m) => m.meta.jobId && m.content.includes('paused'));
    expect(note?.content).toContain('Background job paused — Research ovens');
    expect(note?.content).toContain('carries on by itself');
    // It waits for the reset plus a minute.
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBeGreaterThanOrEqual(60_000);
    // The allowance resets: the job carries on where it stopped and finishes.
    timers[0]!.fn();
    await waitFor(() => h.services.jobs.list()[0]?.state === 'completed');
    expect(jobCalls).toBe(2);
    expect(h.services.conversations.messages(c.id).some((m) => m.meta.jobId && m.content.includes('Report: all three sources agree.'))).toBe(true);
  });

  it('a paused background job can be stopped', async () => {
    h = makeHarness({
      script: (req: ChatRequest) => {
        if (req.system.includes('# Background job\n')) throw paused();
        if (hasToolResult(req)) return reply('On it.');
        return reply('', { toolCalls: [{ id: 'j2', name: 'jobs__start_background', input: { title: 'Research kettles', brief: 'Research kettles.', kind: 'research' } }], stopReason: 'tool_use' });
      },
    });
    const cleared: unknown[] = [];
    const d = (h.services.jobs as unknown as { d: { setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (t: unknown) => void } }).d;
    d.setTimer = () => 'timer-1';
    d.clearTimer = (t) => void cleared.push(t);
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'research kettles').done;
    await waitFor(() => h.services.jobs.list()[0]?.state === 'paused');
    expect(h.services.jobs.cancel(h.services.jobs.list()[0]!.id)).toBe(true);
    expect(h.services.jobs.list()[0]!.state).toBe('cancelled');
    expect(cleared).toEqual(['timer-1']);
  });
});

describe('the plan sets how many background jobs run at once', () => {
  it('on Keo’s AI, the plan’s background_jobs limit applies (smaller than the setting)', async () => {
    const gates: Array<() => void> = [];
    h = makeHarness({
      script: async (req: ChatRequest) => {
        if (req.system.includes('# Background job\n')) {
          await new Promise<void>((r) => gates.push(r));
          return reply('Done.');
        }
        if (hasToolResult(req)) return reply('On it.');
        const n = /^research (\w+)/.exec(lastText(req))?.[1] ?? 'x';
        return reply('', { toolCalls: [{ id: `j-${n}`, name: 'jobs__start_background', input: { title: `Research ${n}`, brief: `Research ${n}.`, kind: 'research' } }], stopReason: 'tool_use' });
      },
    });
    (h.services.jobs as unknown as { d: { planJobs: () => number | undefined } }).d.planJobs = () => 2;
    const c = h.services.conversations.create();
    for (const k of ['a', 'b', 'c']) await h.services.agent.send(c.id, `research ${k}`).done;
    await waitFor(() => gates.length === 2);
    expect(h.services.jobs.list().map((j) => j.state).sort()).toEqual(['queued', 'running', 'running']);
    while (gates.length) gates.shift()!();
    await waitFor(() => gates.length === 1);
    gates.shift()!();
    await waitFor(() => h.services.jobs.list().every((j) => j.state === 'completed'));
  });
});
