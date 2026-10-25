import { afterEach, describe, expect, it } from 'vitest';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { occurrenceAtOrAfter, repeatText } from '../src/main/schedule/scheduler';
import { makeHarness, notepad, tempDir, waitFor, type Harness } from './helpers';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
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
const lastToolResult = (req: ChatRequest): string | null => {
  const b = req.messages[req.messages.length - 1]?.content.find((x) => x.type === 'tool_result') as { content?: unknown } | undefined;
  return b ? JSON.stringify(b.content) : null;
};

/** Local wall-clock time as the model writes it (no offset). */
const pad = (n: number) => String(n).padStart(2, '0');
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Sunday 25 October 2026 is "today" in these tests; all times are local. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

/**
 * Fake model. In the user's conversation it turns "remind me … call Ana", "every monday … TYPE x" and
 * "cancel the … one" into tool calls and repeats the tool result back. Inside a background job it
 * types the word after TYPE into Notepad and reports.
 */
async function script(req: ChatRequest): Promise<ChatResult> {
  const text = lastUserText(req);
  const result = lastToolResult(req);
  if (req.system.includes('# Background job\n')) {
    const word = /TYPE (\w+)/.exec(text)?.[1] ?? 'nothing';
    if (!result) return toolCall('desktop__type_text', { target: notepad, text: word });
    return reply(`Typed ${word}: ${result.includes('error') ? 'not done' : 'done'}.`);
  }
  if (result) return reply(`Scheduled: ${result}`);
  if (/^remind me at 5 to call ana/i.test(text)) return toolCall('reminders__create', { kind: 'reminder', title: 'Call Ana', text: 'Call Ana', at: localIso(new Date(at(25, 17))), repeat: { every: 'once' } });
  if (/^every monday at 9/i.test(text))
    return toolCall('reminders__create', { kind: 'routine', title: 'Monday typing', text: 'TYPE hello into Notepad', at: localIso(new Date(at(26, 9))), repeat: { every: 'week', days: ['mon'] } });
  const cancel = /^cancel the (\w+) one/i.exec(text);
  if (cancel) return toolCall('reminders__cancel', { query: cancel[1] });
  return reply('Hello!');
}

function setup(clock: { now: number }, dir?: string, extra: Parameters<typeof makeHarness>[0] = {}) {
  const notes: Array<{ title: string; body: string }> = [];
  h = makeHarness({ script: (req) => script(req), ...(dir ? { dir } : {}), ...extra, deps: { clock: () => clock.now, ...(extra.deps ?? {}) } });
  h.services.ui = { showCommandBar: () => undefined, notify: (title, body) => void notes.push({ title, body }) };
  return { s: h.services, notes };
}

describe('schedule times', () => {
  it('keeps the local time of day for daily and weekly repeats, and counts real hours for hourly ones', () => {
    const first = new Date(at(26, 9)); // Monday 9:00
    expect(occurrenceAtOrAfter({ every: 'day' }, first, at(25, 10))).toBe(at(26, 9));
    expect(occurrenceAtOrAfter({ every: 'day' }, first, at(26, 9) + 1)).toBe(at(27, 9));
    // Weekly on Monday and Thursday: after Monday's run comes Thursday, then the next Monday.
    const monThu = { every: 'week' as const, days: ['mon' as const, 'thu' as const] };
    expect(occurrenceAtOrAfter(monThu, first, at(26, 9) + 1)).toBe(at(29, 9));
    expect(occurrenceAtOrAfter(monThu, first, at(29, 9) + 1)).toBe(at(26 + 7, 9));
    // A first time on a day that is not listed starts on the next listed day.
    expect(occurrenceAtOrAfter({ every: 'week', days: ['wed'] }, first, at(25, 10))).toBe(at(28, 9));
    expect(occurrenceAtOrAfter({ every: 'hours', hours: 3 }, first, at(26, 10))).toBe(at(26, 12));
    expect(occurrenceAtOrAfter({ every: 'once' }, first, at(26, 9) + 1)).toBeNull();
    expect(repeatText(monThu, first)).toBe('every Monday and Thursday at 9:00');
    expect(repeatText({ every: 'week', days: ['mon', 'tue', 'wed', 'thu', 'fri'] }, first)).toBe('every weekday at 9:00');
    expect(repeatText({ every: 'hours', hours: 4 }, first)).toBe('every 4 hours');
  });
});

describe('reminders', () => {
  it('a one-off reminder fires once at its time: notification, message in its conversation, confirmed time', async () => {
    const clock = { now: at(25, 10) };
    const { s, notes } = setup(clock);
    const c = s.conversations.create();
    const m = await s.agent.send(c.id, 'remind me at 5 to call Ana').done;
    expect(m.meta.tools?.[0]).toMatchObject({ capabilityId: 'reminders.create', outcome: 'executed' });
    expect(m.content).toContain('Sunday 25 October, 17:00'); // the exact time to confirm back
    const item = s.schedule.list()[0]!;
    expect(item).toMatchObject({ kind: 'reminder', state: 'active', repeatText: 'once', conversationId: c.id });
    expect(s.agent.systemExtra(c.id)).toContain('Call Ana');

    clock.now = at(25, 16, 59);
    expect(s.schedule.tick()).toBe(0);
    expect(notes).toHaveLength(0);

    clock.now = at(25, 17) + 5_000;
    expect(s.schedule.tick()).toBe(1);
    expect(notes).toEqual([{ title: 'Reminder', body: 'Call Ana' }]);
    const posted = s.conversations.messages(c.id).find((x) => x.meta.scheduleId === item.id);
    expect(posted?.content).toContain('⏰ **Reminder:** Call Ana');
    expect(posted?.content).not.toContain('Late');
    expect(s.schedule.get(item.id)).toMatchObject({ state: 'done', runs: 1, lastStatus: 'on_time', nextRunAt: null });

    clock.now = at(26, 17);
    expect(s.schedule.tick()).toBe(0);
    expect(notes).toHaveLength(1);
  });

  it('a recurring reminder fires at each time, and a time already passed is refused', () => {
    const clock = { now: at(25, 10) };
    const { s, notes } = setup(clock);
    const c = s.conversations.create();
    const item = s.schedule.create({ kind: 'reminder', title: 'Water', text: 'Drink water', conversationId: c.id, at: new Date(at(25, 12)), recurrence: { every: 'hours', hours: 2 } });
    expect(item.nextRunAt).toBe(new Date(at(25, 12)).toISOString());
    for (const hour of [12, 14, 16]) {
      clock.now = at(25, hour);
      expect(s.schedule.tick()).toBe(1);
    }
    expect(notes.map((n) => n.body)).toEqual(['Drink water', 'Drink water', 'Drink water']);
    expect(s.schedule.get(item.id)).toMatchObject({ state: 'active', runs: 3, nextRunAt: new Date(at(25, 18)).toISOString() });
    expect(() => s.schedule.create({ kind: 'reminder', title: 'Past', text: 'Too late', conversationId: c.id, at: new Date(at(25, 9)), recurrence: { every: 'once' } })).toThrow(/already passed/);
  });

  it('items missed while Keo was closed run once at the next start, marked late; missed repeats are not replayed', async () => {
    const dir = tempDir();
    const clock = { now: at(25, 10) };
    let { s } = setup(clock, dir);
    const c = s.conversations.create();
    const daily = s.schedule.create({ kind: 'reminder', title: 'Stretch', text: 'Stretch', conversationId: c.id, at: new Date(at(25, 18)), recurrence: { every: 'day' } });
    const once = s.schedule.create({ kind: 'reminder', title: 'Call Ana', text: 'Call Ana', conversationId: c.id, at: new Date(at(25, 17)), recurrence: { every: 'once' } });
    await h!.close();
    h = null;

    // Keo comes back three days later, at 9:00 on Wednesday.
    clock.now = at(28, 9);
    const again = setup(clock, dir);
    s = again.s;
    s.start();
    expect(again.notes.map((n) => n.title)).toEqual(['Reminder (late)', 'Reminder (late)']);
    expect(s.schedule.get(once.id)).toMatchObject({ state: 'done', runs: 1, lastStatus: 'late' });
    // The daily one ran once (not three times) and continues at its usual time.
    expect(s.schedule.get(daily.id)).toMatchObject({ state: 'active', runs: 1, lastStatus: 'late', nextRunAt: new Date(at(28, 18)).toISOString() });
    const posted = s.conversations.messages(c.id).filter((m) => m.meta.scheduleId);
    expect(posted).toHaveLength(2);
    expect(posted.every((m) => m.content.includes('Late: this was due'))).toBe(true);
    expect(s.schedule.tick()).toBe(0);
  });

  it('pause skips runs, resume continues from now, and cancel by name removes it', async () => {
    const clock = { now: at(25, 10) };
    const { s, notes } = setup(clock);
    const c = s.conversations.create();
    const item = s.schedule.create({ kind: 'reminder', title: 'Stretch', text: 'Stretch', conversationId: c.id, at: new Date(at(25, 18)), recurrence: { every: 'day' } });
    expect(s.schedule.setPaused(item.id, true)?.state).toBe('paused');
    clock.now = at(26, 19);
    expect(s.schedule.tick()).toBe(0);
    expect(notes).toHaveLength(0);
    // Resumed at 19:00 on Monday: Monday 18:00 was missed while paused, so the next run is Tuesday.
    expect(s.schedule.setPaused(item.id, false)).toMatchObject({ state: 'active', nextRunAt: new Date(at(27, 18)).toISOString() });
    expect(s.schedule.tick()).toBe(0);

    const m = await s.agent.send(c.id, 'cancel the stretch one').done;
    expect(m.meta.tools?.[0]).toMatchObject({ capabilityId: 'reminders.cancel', outcome: 'executed' });
    expect(s.schedule.get(item.id)).toBeNull();
    clock.now = at(27, 18);
    expect(s.schedule.tick()).toBe(0);
    expect(notes).toHaveLength(0);
  });

  it('in a voice conversation a due reminder is also spoken, at the next pause', async () => {
    const clock = { now: at(25, 10) };
    const spoken: string[] = [];
    const listens: Array<(v: { text: string | null; reason: string }) => void> = [];
    const { s } = setup(clock, undefined, { voiceIo: { listen: () => new Promise((r) => listens.push(r)), speak: async (t) => void spoken.push(t) } });
    const c = s.conversations.create();
    s.schedule.create({ kind: 'reminder', title: 'Call Ana', text: 'Call Ana', conversationId: c.id, at: new Date(at(25, 17)), recurrence: { every: 'once' } });
    s.voiceMode.start();
    await waitFor(() => listens.length === 1);
    clock.now = at(25, 17);
    s.schedule.tick();
    expect(spoken).toEqual([]); // never over the user while listening
    listens.shift()!({ text: 'hello there', reason: 'ok' });
    await waitFor(() => listens.length === 1);
    expect(spoken).toContain('Reminder: Call Ana');
    s.voiceMode.stop();
  });
});

describe('routines', () => {
  it('runs its instruction as a background job; its consequential action still asks the user, even in Hands-free', async () => {
    const clock = { now: at(25, 10) };
    const { s, notes } = setup(clock);
    s.settings.update({
      permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] },
      agent: { approvalWaitSeconds: 60 },
      autonomy: { level: 'hands_free' },
    });
    const c = s.conversations.create();
    const m = await s.agent.send(c.id, 'every monday at 9 TYPE hello into notepad').done;
    expect(m.content).toContain('every Monday at 9:00 (first: Monday 26 October, 9:00)');
    const routine = s.schedule.list()[0]!;
    expect(routine).toMatchObject({ kind: 'routine', repeatText: 'every Monday at 9:00', nextRunAt: new Date(at(26, 9)).toISOString() });

    clock.now = at(26, 9);
    expect(s.schedule.tick()).toBe(1);
    const job = s.jobs.list()[0]!;
    expect(job).toMatchObject({ scheduleId: routine.id, parentConversationId: c.id, title: 'Monday typing' });
    expect(s.jobs.isRoutineConversation(job.conversationId)).toBe(true);
    expect(s.conversations.messages(job.conversationId)[0]?.content).toContain('TYPE hello into Notepad');
    expect(s.agent.systemExtra(job.conversationId)).toContain('scheduled routine');

    // The user named the action in their conversation and Keo is Hands-free, yet the routine waits for them.
    const awaiting = () => s.tasks.list(20).filter((t) => t.state === 'awaiting_authorization' && t.conversationId === job.conversationId);
    await waitFor(() => awaiting().length === 1);
    expect(h!.desktop.inputCalls()).toHaveLength(0);
    const step = awaiting()[0]!.steps[0]!;
    expect(step.capabilityId).toBe('desktop.type_text');
    s.tasks.approveStep(step.id, step.inputHash);
    await waitFor(() => s.jobs.get(job.id)?.state === 'completed');
    expect(h!.desktop.inputCalls().filter((x) => x.op === 'type').map((x) => x.args[1])).toEqual(['hello']);
    expect(s.conversations.messages(c.id).some((x) => x.content.includes('Background job done — Monday typing'))).toBe(true);
    expect(notes.some((n) => n.title === 'Keo finished: Monday typing')).toBe(true);

    // It repeats next Monday; a background job may not schedule anything itself.
    expect(s.schedule.get(routine.id)).toMatchObject({ state: 'active', runs: 1, nextRunAt: new Date(at(26 + 7, 9)).toISOString() });
    const a = s.registry.admit({ capabilityId: 'reminders.create', input: { kind: 'reminder', title: 'Inner', text: 'Inner', at: localIso(new Date(at(27, 9))), repeat: { every: 'once' } }, origin: 'model', correlationId: 'c_test' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    await expect(
      s.registry.runDirect(a, { signal: new AbortController().signal, idempotencyKey: 'k', correlationId: 'c_test', conversationId: job.conversationId, sourceMessageId: null, taskId: null, settings: s.settings.get() }),
    ).rejects.toThrow(/cannot schedule/);
  });
});
