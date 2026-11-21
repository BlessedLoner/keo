import { afterEach, describe, expect, it } from 'vitest';
import type { BackgroundJob, Message, WorkPlan } from '../src/shared/domain';
import { BackgroundJobs } from '../src/main/agent/backgroundJobs';
import { PLAN_TOOL } from '../src/main/agent/workPlan';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, notepad, waitFor, type Harness } from './helpers';

let h: Harness;
let stopApproving: (() => void) | null = null;
afterEach(async () => {
  stopApproving?.();
  stopApproving = null;
  await h?.close();
});

let seq = 0;
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 10, outputTokens: 5 }, model: 'keo-test-1', native: undefined });
const calls = (...cs: Array<[string, unknown]>): ChatResult => ({
  text: '',
  toolCalls: cs.map(([name, input]) => ({ id: `c${++seq}`, name, input })),
  stopReason: 'tool_use',
  usage: { inputTokens: 10, outputTokens: 5 },
  model: 'keo-test-1',
  native: undefined,
});
const planOf = (done: number, total: number): [string, unknown] => [
  PLAN_TOOL,
  { steps: Array.from({ length: total }, (_, k) => ({ title: `Line ${k + 1}`, status: (k < done ? 'done' : k === done ? 'in_progress' : 'pending') as WorkPlan['steps'][number]['status'] })) },
];

function setup(script: (n: number) => ChatResult, rounds = 3) {
  h = makeHarness({ script: (_req, n) => script(n) });
  h.services.settings.update({
    permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] },
    agent: { approvalWaitSeconds: 10, maxToolIterations: rounds },
  });
  const timer = setInterval(() => {
    for (const t of h.services.tasks.list(50)) for (const s of t.steps) if (s.state === 'awaiting_authorization') h.services.tasks.approveStep(s.id, s.inputHash);
  }, 5);
  stopApproving = () => clearInterval(timer);
}

describe('long tasks', () => {
  it('a task still moving forward at the round limit saves a checkpoint and carries on to the end', async () => {
    // Eight lines to type, three rounds allowed per stretch.
    setup((n) => (n < 8 ? calls(planOf(n, 8), ['desktop__type_text', { target: notepad, text: `line ${n + 1}` }]) : n === 8 ? calls(planOf(8, 8)) : reply('Typed all eight lines.')));
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type eight lines into notepad, one after another').done;
    expect(msg.status).toBe('complete');
    expect(msg.content).toContain('Checkpoint 1');
    expect(msg.content).not.toContain('Stopped after');
    expect(msg.meta.checkpoints).toBeGreaterThanOrEqual(2);
    expect(msg.meta.plan?.steps.every((s) => s.status === 'done')).toBe(true);
    expect(h.desktop.inputCalls().filter((x) => x.op === 'paste')).toHaveLength(8);
  });

  it('work that stopped moving forward still stops at the round limit', async () => {
    // Every round fails (no such window) and the checklist never moves.
    setup((n) => calls(planOf(0, 4), ['desktop__type_text', { target: { hwnd: '999', pid: 1, processName: 'notepad' }, text: `try ${n}` }]));
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type four lines into notepad').done;
    expect(msg.content).toMatch(/Stopped after|Keo paused here/);
    expect(msg.content).not.toContain('Checkpoint');
  });

  it('after a restart, a reply that was working through its checklist carries on by itself', async () => {
    setup(() => reply('Carried on and finished the last two steps.'));
    const c = h.services.conversations.create();
    h.services.conversations.addMessage({ conversationId: c.id, role: 'user', content: 'make the report', status: 'complete' });
    h.services.conversations.addMessage({
      conversationId: c.id,
      role: 'assistant',
      content: 'Working on it…',
      status: 'streaming',
      meta: { plan: { steps: [{ title: 'Gather', status: 'done' }, { title: 'Write', status: 'in_progress' }, { title: 'Save', status: 'pending' }] } },
    });
    // A plain chat that was cut off (no checklist) is only marked interrupted.
    const other = h.services.conversations.create();
    h.services.conversations.addMessage({ conversationId: other.id, role: 'user', content: 'hi', status: 'complete' });
    h.services.conversations.addMessage({ conversationId: other.id, role: 'assistant', content: 'Hel', status: 'streaming' });
    h.services.resumeDelayMs = 0;
    h.services.start();
    await waitFor(() => h.services.conversations.messages(c.id).some((m) => m.role === 'assistant' && m.status === 'complete'), 5000);
    const msgs = h.services.conversations.messages(c.id);
    expect(msgs[1]!.status).toBe('interrupted');
    expect(msgs[2]!.meta.auto).toBe('resume');
    expect(msgs[3]!.meta.resumed).toBe(true);
    expect(msgs[3]!.content).toContain('Carried on');
    expect(h.services.conversations.messages(other.id).map((m) => m.status)).toEqual(['complete', 'interrupted']);
  });

  it('a background job that was running when Keo closed carries on; older or queued ones are reported as interrupted', async () => {
    const now = Date.now();
    const job = (id: string, state: BackgroundJob['state'], startedMinAgo: number | null): BackgroundJob => ({
      id,
      title: id,
      kind: 'research',
      parentConversationId: 'parent',
      conversationId: `conv-${id}`,
      state,
      waitingForDesktop: false,
      createdAt: new Date(now).toISOString(),
      startedAt: startedMinAgo === null ? null : new Date(now - startedMinAgo * 60_000).toISOString(),
      finishedAt: null,
      result: null,
      error: null,
    });
    let saved: { jobs: BackgroundJob[]; hidden: string[] } = { jobs: [job('fresh', 'running', 10), job('old', 'running', 300), job('waiting', 'queued', null)], hidden: [] };
    const resumed: string[] = [];
    const sent: string[] = [];
    const done = (conversationId: string): Promise<Message> =>
      Promise.resolve({ id: 'm', conversationId, role: 'assistant', content: 'Finished.', status: 'complete', createdAt: new Date().toISOString(), meta: {} });
    const jobs = new BackgroundJobs({
      conversations: { get: (id: string) => ({ id }), addMessage: () => ({}) } as never,
      agent: () => ({
        send: (id) => (sent.push(id), { done: done(id) }),
        cancel: () => true,
        resume: (id) => (resumed.push(id), { done: done(id) }),
      }),
      getSettings: () => ({ agent: { maxBackgroundJobs: 3 } }) as never,
      audit: { record: () => undefined } as never,
      log: { info: () => undefined, warn: () => undefined } as never,
      store: { load: () => saved, save: (all) => (saved = JSON.parse(JSON.stringify(all))) },
      resumeDelayMs: 0,
      finished: () => undefined,
      changed: () => undefined,
    });
    expect(jobs.recover(now)).toBe(2);
    await waitFor(() => saved.jobs.find((j) => j.id === 'fresh')?.state === 'completed', 3000);
    expect(resumed).toEqual(['conv-fresh']);
    expect(sent).toEqual([]);
    expect(saved.jobs.find((j) => j.id === 'old')!.state).toBe('interrupted');
    expect(saved.jobs.find((j) => j.id === 'waiting')!.state).toBe('interrupted');
  });
});
