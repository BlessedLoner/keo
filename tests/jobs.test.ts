import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { DesktopLease } from '../src/main/agent/backgroundJobs';
import { makeHarness, notepad, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const reply = (text: string, extra: Partial<ChatResult> = {}): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'keo-test-1', native: undefined, ...extra });
let callSeq = 0;
const toolCall = (name: string, input: unknown): ChatResult => reply('', { toolCalls: [{ id: `call_${++callSeq}`, name, input }], stopReason: 'tool_use' });

function lastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== 'user') continue;
    const texts = m.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text);
    if (texts.length) return texts[texts.length - 1]!;
  }
  return '';
}
const hasToolResult = (req: ChatRequest) => !!req.messages[req.messages.length - 1]?.content.some((b) => b.type === 'tool_result');

/** Jobs wait on a gate the test opens, so "long" work is under the test's control (no timers). */
const gates = new Map<string, () => void>();
const gate = (key: string) => new Promise<void>((r) => gates.set(key, r));
const open = (key: string) => {
  const g = gates.get(key);
  if (!g) throw new Error(`no gate ${key}`);
  gates.delete(key);
  g();
};

/**
 * Fake model: in the user's conversation "research X" starts a background job, "stop the X one"
 * cancels it, "slow X" keeps the turn busy, anything else is answered at once. Inside a job, the
 * brief "Research X" waits for gate X; "TYPE X" types X into Notepad, then waits for gate after-X.
 */
async function script(req: ChatRequest): Promise<ChatResult> {
  const text = lastUserText(req);
  if (req.system.includes('# Background job\n')) {
    const typing = /TYPE (\w+)/.exec(text);
    if (typing) {
      if (!hasToolResult(req)) return toolCall('desktop__type_text', { target: notepad, text: typing[1] });
      await gate(`after-${typing[1]}`);
      return reply(`Typed ${typing[1]}.`);
    }
    const key = /Research (\w+)/.exec(text)?.[1] ?? 'other';
    await gate(key);
    return reply(`Report for ${key}: three sources agree.`);
  }
  if (hasToolResult(req)) return reply('On it — I’ll tell you when it’s done.');
  const research = /^research (\w+)/.exec(text);
  if (research) return toolCall('jobs__start_background', { title: `Research ${research[1]}`, brief: `Research ${research[1]} thoroughly and report the findings.`, kind: 'research' });
  const stop = /^stop the (\w+) one/.exec(text);
  if (stop) return toolCall('jobs__cancel', { query: stop[1] });
  const slow = /^slow (\w+)/.exec(text);
  if (slow) {
    await gate(`slow-${slow[1]}`);
    return reply('Finally done.');
  }
  return reply('Hello!');
}

function setup(): { notes: string[] } {
  gates.clear();
  h = makeHarness({ script: (req) => script(req) });
  const notes: string[] = [];
  h.services.ui = { showCommandBar: () => undefined, notify: (title) => void notes.push(title) };
  return { notes };
}

describe('background jobs', () => {
  it('runs three jobs at once while a normal request is answered immediately; a fourth waits its turn', async () => {
    const { notes } = setup();
    const c = h.services.conversations.create();
    for (const k of ['alpha', 'beta', 'gamma']) {
      const m = await h.services.agent.send(c.id, `research ${k}`).done;
      expect(m.content).toContain('On it');
    }
    await waitFor(() => gates.size === 3);
    const jobs = h.services.jobs.list();
    expect(jobs.map((j) => j.state)).toEqual(['running', 'running', 'running']);
    // Each job has its own hidden conversation; the user's conversation is free.
    expect(new Set(jobs.map((j) => j.conversationId)).size).toBe(3);
    expect(jobs.every((j) => j.parentConversationId === c.id && h.services.jobs.isJobConversation(j.conversationId))).toBe(true);
    expect(h.services.agent.activeConversations()).not.toContain(c.id);

    const t0 = Date.now();
    const normal = await h.services.agent.send(c.id, 'hello there').done;
    expect(normal.content).toBe('Hello!');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(h.services.jobs.active().filter((j) => j.state === 'running')).toHaveLength(3);

    // A fourth job queues behind the cap (3 by default).
    await h.services.agent.send(c.id, 'research delta').done;
    const delta = h.services.jobs.list().find((j) => j.title === 'Research delta')!;
    expect(delta.state).toBe('queued');
    expect(gates.has('delta')).toBe(false);

    // A finished job reports at once in the conversation and as a notification; the queued one starts.
    open('beta');
    await waitFor(() => h.services.jobs.list().find((j) => j.title === 'Research beta')?.state === 'completed');
    const report = h.services.conversations.messages(c.id).find((m) => m.meta.jobId);
    expect(report?.content).toContain('Background job done — Research beta');
    expect(report?.content).toContain('Report for beta');
    expect(notes).toContain('Keo finished: Research beta');
    await waitFor(() => gates.has('delta'));
    expect(h.services.jobs.get(delta.id)?.state).toBe('running');

    for (const k of ['alpha', 'gamma', 'delta']) open(k);
    await waitFor(() => h.services.jobs.list().every((j) => j.state === 'completed'));
    expect(h.services.conversations.messages(c.id).filter((m) => m.meta.jobId)).toHaveLength(4);
  });

  it('lists and cancels jobs by name; a cancelled job reports that it stopped', async () => {
    const { notes } = setup();
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'research video').done;
    await h.services.agent.send(c.id, 'research prices').done;
    await waitFor(() => gates.size === 2);
    expect(h.services.agent.systemExtra(c.id)).toContain('Research video');

    const m = await h.services.agent.send(c.id, 'stop the video one').done;
    expect(m.meta.tools?.[0]).toMatchObject({ capabilityId: 'jobs.cancel', outcome: 'executed' });
    open('video'); // the model call returns, but the turn was cancelled
    await waitFor(() => h.services.conversations.messages(c.id).some((x) => x.content.includes('Background job stopped — Research video')));
    expect(h.services.jobs.list().find((j) => j.title === 'Research video')?.state).toBe('cancelled');
    expect(h.services.jobs.list().find((j) => j.title === 'Research prices')?.state).toBe('running');
    expect(notes.some((n) => n.includes('Research video'))).toBe(false); // the user stopped it: no alert

    // A queued job can be stopped from the UI before it starts.
    h.services.settings.update({ agent: { maxBackgroundJobs: 1 } });
    await h.services.agent.send(c.id, 'research later').done;
    const later = h.services.jobs.list().find((j) => j.title === 'Research later')!;
    expect(later.state).toBe('queued');
    expect(h.services.jobs.cancel(later.id)).toBe(true);
    expect(h.services.jobs.get(later.id)?.state).toBe('cancelled');
    open('prices');
    await waitFor(() => h.services.jobs.active().length === 0);
    expect(gates.has('later')).toBe(false);
  });

  it('a job may not start or stop other jobs', async () => {
    setup();
    const c = h.services.conversations.create();
    const job = h.services.jobs.start({ title: 'Nested', brief: 'Research nested', kind: 'research', parentConversationId: c.id });
    await waitFor(() => gates.has('nested'));
    const correlationId = 'c_test';
    const a = h.services.registry.admit({ capabilityId: 'jobs.start_background', input: { title: 'Inner', brief: 'Do more things please', kind: 'other' }, origin: 'model', correlationId });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expect(
      h.services.registry.runDirect(a, { signal: new AbortController().signal, idempotencyKey: 'k', correlationId, conversationId: job.conversationId, sourceMessageId: null, taskId: null, settings: h.services.settings.get() }),
    ).rejects.toThrow(/cannot start another/);
    open('nested');
  });

  it('serializes desktop-driving jobs: the second waits until the first is finished with the desktop', async () => {
    setup();
    h.services.settings.update({ permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] }, agent: { approvalWaitSeconds: 60 } });
    const c = h.services.conversations.create();
    const one = h.services.jobs.start({ title: 'Type one', brief: 'TYPE one', kind: 'other', parentConversationId: c.id });
    const two = h.services.jobs.start({ title: 'Type two', brief: 'TYPE two', kind: 'other', parentConversationId: c.id });
    const awaiting = () => h.services.tasks.list(20).filter((t) => t.state === 'awaiting_authorization');
    await waitFor(() => awaiting().length === 1);
    const first = awaiting()[0]!;
    const [owner, other] = first.conversationId === one.conversationId ? [one, two] : [two, one];
    const ownerWord = owner === one ? 'one' : 'two';
    const otherWord = owner === one ? 'two' : 'one';
    await waitFor(() => h.services.jobs.get(other.id)!.waitingForDesktop);
    // The approval still comes from the user; nothing ran before it.
    expect(h.desktop.inputCalls()).toHaveLength(0);
    h.services.tasks.approveStep(first.steps[0]!.id, first.steps[0]!.inputHash);
    await waitFor(() => gates.has(`after-${ownerWord}`));
    // The first job keeps the desktop until it ends, so the second has not even asked yet.
    expect(awaiting()).toHaveLength(0);
    expect(h.desktop.inputCalls().filter((x) => x.op === 'type').map((x) => x.args[1])).toEqual([ownerWord]);
    open(`after-${ownerWord}`);
    await waitFor(() => awaiting().length === 1);
    expect(h.services.jobs.get(owner.id)?.state).toBe('completed');
    const second = awaiting()[0]!;
    expect(second.conversationId).toBe(other.conversationId);
    h.services.tasks.approveStep(second.steps[0]!.id, second.steps[0]!.inputHash);
    await waitFor(() => gates.has(`after-${otherWord}`));
    open(`after-${otherWord}`);
    await waitFor(() => h.services.jobs.active().length === 0);
    expect(h.desktop.inputCalls().filter((x) => x.op === 'type').map((x) => x.args[1])).toEqual([ownerWord, otherWord]);
  });

  it('a new request while the conversation is busy goes to a background job instead of “still working”', async () => {
    setup();
    const c = h.services.conversations.create();
    const slow = h.services.agent.send(c.id, 'slow answer');
    await waitFor(() => gates.has('slow-answer'));
    const quick = await h.services.agent.send(c.id, 'research weather').done;
    expect(quick.content).toContain('in the background');
    const job = h.services.jobs.list()[0]!;
    expect(job.parentConversationId).toBe(c.id);
    // The user's own words reach the job; one-word answers are not turned into jobs.
    expect(h.services.conversations.messages(job.conversationId)[0]?.content).toContain('research weather');
    expect(() => h.services.agent.send(c.id, 'yes')).toThrow(/still responding/);
    open('slow-answer');
    expect((await slow.done).content).toBe('Finally done.');
    await waitFor(() => gates.has('other'));
    open('other');
    await waitFor(() => h.services.jobs.active().length === 0);
  });

  it('in a voice conversation the report is spoken after the current reply, never while listening', async () => {
    gates.clear();
    const spoken: string[] = [];
    const listens: Array<(v: { text: string | null; reason: string }) => void> = [];
    h = makeHarness({
      script: (req) => script(req),
      voiceIo: { listen: () => new Promise((r) => listens.push(r)), speak: async (t) => void spoken.push(t) },
    });
    h.services.ui = { showCommandBar: () => undefined, notify: () => undefined };
    const c = h.services.conversations.create();
    h.services.jobs.start({ title: 'Flights', brief: 'Research flights', kind: 'research', parentConversationId: c.id });
    await waitFor(() => gates.has('flights'));
    h.services.voiceMode.start();
    await waitFor(() => listens.length === 1);
    open('flights');
    await waitFor(() => h.services.jobs.list()[0]?.state === 'completed');
    await new Promise((r) => setTimeout(r, 50));
    expect(spoken).toEqual([]); // Keo is listening: nothing is said over the user
    listens.shift()!({ text: 'hello there', reason: 'ok' });
    await waitFor(() => listens.length === 1);
    expect(spoken[0]).toBe('Hello!');
    expect(spoken[1]).toContain('The Flights job is done.');
    expect(spoken[1]).toContain('Report for flights');
    h.services.voiceMode.stop();
  });
});

describe('desktop lease', () => {
  it('one owner at a time, in order; a cancelled waiter leaves the queue', async () => {
    const lease = new DesktopLease();
    await lease.acquire('a');
    await lease.acquire('a'); // re-entrant for the same owner
    const order: string[] = [];
    const b = lease.acquire('b').then(() => order.push('b'));
    const ac = new AbortController();
    const c = lease.acquire('c', ac.signal);
    const d = lease.acquire('d').then(() => order.push('d'));
    ac.abort();
    await expect(c).rejects.toThrow(/Cancelled/);
    expect(order).toEqual([]);
    lease.release('a');
    await b;
    expect(lease.holder()).toBe('b');
    lease.release('b');
    await d;
    expect(order).toEqual(['b', 'd']);
    lease.release('d');
    expect(lease.holder()).toBeNull();
  });
});
