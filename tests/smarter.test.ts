import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, ToolActivity, WorkPlan } from '../src/shared/domain';
import { needsPlan } from '../src/main/agent/routing';
import { compactTurn, finishIssues, parsePlan, PLAN_TOOL, RepeatGuard } from '../src/main/agent/workPlan';
import { CapabilityError } from '../src/main/capabilities/types';
import type { ChatRequest, ChatResult, NeutralMessage, ToolCall } from '../src/main/providers/types';
import { makeHarness, notepad, type Harness } from './helpers';

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
const plan = (...steps: Array<[string, WorkPlan['steps'][number]['status']]>): [string, unknown] => [PLAN_TOOL, { steps: steps.map(([title, status]) => ({ title, status })) }];
const results = (req: ChatRequest) => req.messages.flatMap((m) => m.content).filter((b): b is Extract<NeutralMessage['content'][number], { type: 'tool_result' }> => b.type === 'tool_result' && !b.content.includes('shown_to_user'));
const lastResults = (req: ChatRequest) => results(req).slice(-1)[0]?.content ?? '';
const notes = (req: ChatRequest) => req.messages.flatMap((m) => m.content).filter((b) => b.type === 'text' && b.text.includes('Before you finish'));

function enableDesktop() {
  h.services.settings.update({
    permissions: { desktopControlEnabled: true, observationEnabled: true, allowedApps: [{ processName: 'notepad', label: 'Notepad' }] },
    agent: { approvalWaitSeconds: 10, maxToolIterations: 10 },
  });
}

/** Approves every action that waits for the user, like a user clicking Approve. */
function approveAll() {
  const timer = setInterval(() => {
    for (const t of h.services.tasks.list(50)) {
      for (const s of t.steps) if (s.state === 'awaiting_authorization') h.services.tasks.approveStep(s.id, s.inputHash);
    }
  }, 5);
  stopApproving = () => clearInterval(timer);
}

function events() {
  const seen: AgentEvent[] = [];
  h.services.setPush((ch, p) => ch === 'agent:event' && seen.push(p as AgentEvent));
  return seen;
}

describe('planning multi-step requests', () => {
  it('a multi-step task gets a visible plan and works through it', async () => {
    const systems: string[] = [];
    h = makeHarness({
      script: (req, n) => {
        systems.push(req.system);
        if (n === 0) return calls(plan(['Find the Notepad window', 'in_progress'], ['Type the note', 'pending'], ['Save it', 'pending']), ['desktop__list_windows', {}]);
        if (n === 1) return calls(plan(['Find the Notepad window', 'done'], ['Type the note', 'in_progress'], ['Save it', 'pending']), ['desktop__type_text', { target: notepad, text: 'buy milk' }]);
        if (n === 2) return calls(plan(['Find the Notepad window', 'done'], ['Type the note', 'done'], ['Save it', 'in_progress']), ['desktop__press_keys', { target: notepad, combo: 'ctrl+s' }]);
        if (n === 3) return calls(plan(['Find the Notepad window', 'done'], ['Type the note', 'done'], ['Save it', 'done']));
        return reply('Typed "buy milk" into Notepad (read back and verified) and pressed Ctrl+S. Nothing is left open.');
      },
    });
    enableDesktop();
    approveAll();
    const seen = events();
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'find my notepad window, then type buy milk and after that save the file').done;

    // The plan is asked for up front, and from then on the current checklist travels with every request.
    expect(systems[0]).toContain('This request needs several steps');
    expect(systems[1]).toContain('[~] Find the Notepad window');
    expect(systems[4]).toContain('[x] Save it');
    expect(msg.meta.plan?.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(seen.filter((e) => e.type === 'plan')).toHaveLength(4);
    expect(h.desktop.inputCalls().map((x) => x.op)).toEqual(['focus', 'type', 'focus', 'keys']);
    expect(h.desktop.documentText).toContain('buy milk');
    // The checklist itself is not shown as an action card.
    expect(msg.meta.tools?.map((t) => t.capabilityId)).toEqual(['desktop.list_windows', 'desktop.type_text', 'desktop.press_keys']);
    expect(msg.status).toBe('complete');
    // The plan carries into later turns, so "what is left?" can be answered.
    await h.services.agent.send(c.id, 'what is left?').done;
    expect(JSON.stringify(h.provider.lastRequest?.messages)).toContain('[Plan in this reply]');
  });

  it('a simple question gets no plan and no extra model call', async () => {
    h = makeHarness({ script: () => reply('Paris.') });
    const seen = events();
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'what is the capital of France?').done;
    expect(h.provider.calls).toBe(1);
    expect(h.provider.lastRequest?.system).not.toContain('This request needs several steps');
    expect(h.provider.lastRequest?.system).not.toContain('Your working plan');
    expect(msg.meta.plan).toBeUndefined();
    expect(seen.some((e) => e.type === 'plan')).toBe(false);
    expect(msg.content).toBe('Paris.');
  });

  it('decides locally which requests need a plan', () => {
    for (const t of ['hi', 'what is the capital of France?', 'open notepad', 'thanks, that worked', 'what time is it in Lagos?', 'tell me a joke about cats'])
      expect(needsPlan(t), t).toBe(false);
    for (const t of [
      'open notepad, then type my shopping list and save it',
      'research the best laptops under $800 for video editing',
      'compare the prices of these two phones and send Mum the cheaper one',
      'please:\n- open WhatsApp\n- send Ada the photo',
    ])
      expect(needsPlan(t), t).toBe(true);
  });

  it('refuses a malformed checklist without breaking the turn', () => {
    expect('error' in parsePlan({ steps: [] })).toBe(true);
    expect('error' in parsePlan({ steps: [{ title: 'x', status: 'maybe' }] })).toBe(true);
    expect(parsePlan({ steps: [{ title: '  Look  it up ', status: 'pending', note: 'n' }] })).toEqual({ plan: { steps: [{ title: 'Look it up', status: 'pending', note: 'n' }] } });
  });
});

describe('checking steps and recovering from failures', () => {
  it('a failed step leads to an alternative, not a false "done"', async () => {
    const seenRequests: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seenRequests.push(structuredClone(req));
        if (n === 0) return calls(plan(['Type the note', 'in_progress'], ['Save it', 'pending']), ['desktop__type_text', { target: notepad, text: 'buy milk' }]);
        // The same call again after it failed: Keo refuses it.
        if (n === 1) return calls(['desktop__type_text', { target: notepad, text: 'buy milk' }]);
        // A premature "done": Keo checks it.
        if (n === 2) return reply('All done!');
        // The alternative: paste instead of typing.
        if (n === 3) return calls(['desktop__type_text', { target: notepad, text: 'buy milk', method: 'paste' }]);
        if (n === 4) return calls(plan(['Type the note', 'done'], ['Save it', 'skipped']));
        return reply('Typing failed the first time, so I pasted "buy milk" instead and read it back to check it. I did not save the file — say if you want that.');
      },
    });
    enableDesktop();
    approveAll();
    h.desktop.failNext = new CapabilityError('input_failed', 'The keyboard input was not delivered.', { dispatched: 'no' });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type buy milk in notepad and then save it').done;

    // The failure told the model to change approach; the identical retry never reached the desktop.
    expect(lastResults(seenRequests[1]!)).toContain('Do not repeat this exact call');
    expect(lastResults(seenRequests[2]!)).toContain('blocked_repeat');
    // First attempt failed at the focus step; the refused retry sent nothing; the alternative pasted.
    expect(h.desktop.inputCalls().map((x) => x.op)).toEqual(['focus', 'focus', 'paste']);
    // "All done!" over a failed step was sent back with the facts.
    expect(notes(seenRequests[3]!)).toHaveLength(1);
    expect(notes(seenRequests[3]!)[0]).toMatchObject({ text: expect.stringContaining('did not succeed') });
    expect(msg.content).toContain('Keo: not everything above worked');
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['failed', 'rejected', 'executed']);
    expect(h.desktop.documentText).toContain('buy milk');
    // The honest final answer stands without a warning.
    expect(msg.content).not.toContain('⚠');
    expect(msg.meta.plan?.steps.map((s) => s.status)).toEqual(['done', 'skipped']);
  });

  it('keeps warning when the reply still claims success over a failed step', async () => {
    h = makeHarness({
      script: (_req, n) => (n === 0 ? calls(['desktop__type_text', { target: notepad, text: 'buy milk' }]) : reply('Done — everything went well.')),
    });
    enableDesktop();
    approveAll();
    h.desktop.failNext = new CapabilityError('input_failed', 'The keyboard input was not delivered.', { dispatched: 'no' });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'type buy milk in notepad').done;
    expect(h.provider.calls).toBe(3); // one action, one premature "done", one check — then it stops
    expect(msg.content).toContain('⚠ Keo: this reply sounds finished, but these actions failed or could not be verified');
  });

  it('asks again before finishing with plan steps still open', async () => {
    h = makeHarness({
      script: (req, n) => {
        if (n === 0) return calls(plan(['Find the window', 'in_progress'], ['Type the note', 'pending']), ['desktop__list_windows', {}]);
        if (n === 1) return reply('Here are your windows.');
        if (n === 2) {
          expect(JSON.stringify(req.messages.at(-1))).toContain('your plan still has open steps');
          return calls(plan(['Find the window', 'done'], ['Type the note', 'skipped']));
        }
        return reply('I found the Notepad window. I did not type the note yet — it is still open for you to confirm.');
      },
    });
    enableDesktop();
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'find my notepad window and then type a note in it').done;
    expect(h.provider.calls).toBe(4);
    expect(msg.meta.plan?.steps.map((s) => s.status)).toEqual(['done', 'skipped']);
  });

  it('only counts problems the reply glosses over', () => {
    const a: ToolActivity = { callId: 'x', capabilityId: 'desktop.type_text', summary: 'Type 8 characters', outcome: 'failed', detail: '', taskId: 't' };
    const problems = [{ activity: a, why: 'failed' as const }];
    expect(finishIssues('All done!', undefined, problems)?.problems).toHaveLength(1);
    expect(finishIssues('Typing failed, so nothing was written.', undefined, problems)).toBeNull();
    expect(finishIssues('Here is what I found.', undefined, problems)).toBeNull();
    expect(finishIssues('Done.', { steps: [{ title: 'a', status: 'pending' }] }, [])?.open).toHaveLength(1);
  });
});

describe('loops of identical calls', () => {
  it('cuts off identical repeated calls and stops the turn', async () => {
    h = makeHarness({ script: () => calls(['desktop__list_windows', {}]) });
    enableDesktop();
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'list my windows').done;
    // Two runs, then two refusals, then Keo stops — well before the 10-round limit.
    expect(h.desktop.calls.filter((x) => x.op === 'list').length).toBe(2);
    expect(h.provider.calls).toBe(4);
    expect(msg.meta.tools?.map((t) => t.outcome)).toEqual(['executed', 'executed', 'rejected', 'rejected']);
    expect(msg.content).toContain('Keo stopped here');
    expect(msg.content).not.toContain('tool rounds');
  });

  it('allows the same look again after something changed in between', () => {
    const g = new RepeatGuard();
    const look: ToolCall = { id: '1', name: 'desktop__inspect_window', input: { target: { hwnd: '1', pid: 1, processName: 'notepad' } } };
    const act: ToolCall = { id: '2', name: 'desktop__invoke_element', input: { id: 'e1' } };
    g.record(look, 0, 'executed');
    g.record(act, 1, 'executed');
    expect(g.check({ ...look, input: { target: { processName: 'notepad', pid: 1, hwnd: '1' } } }, 2)).toBeNull(); // key order does not matter
    g.record(look, 2, 'executed');
    expect(g.check(look, 3)).toBeNull();
    g.record(look, 3, 'executed');
    expect(g.check(look, 4)).toContain('each of the last two rounds');
    // Spread out over the reply, a third repeat is still too many.
    const spread = new RepeatGuard();
    for (const round of [0, 2, 4]) spread.record(look, round, 'executed');
    expect(spread.check(look, 6)).toContain('three times');
    g.record(act, 5, 'failed');
    expect(g.check(act, 6)).toContain('already ended "failed"');
  });
});

describe('long runs', () => {
  it('older tool results are shortened while the goal, plan and latest result stay whole', async () => {
    const requests: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        requests.push(structuredClone(req));
        if (n === 0) return calls(plan(['List the windows', 'in_progress'], ['Pick the right one', 'pending']), ['desktop__list_windows', {}]);
        if (n === 1) return calls(plan(['List the windows', 'done'], ['Pick the right one', 'in_progress']), ['desktop__list_windows', {}]);
        return reply('Found it: notes.txt in Notepad. Nothing is left open.');
      },
    });
    enableDesktop();
    h.services.settings.update({ agent: { contextCharBudget: 2000 } });
    for (let i = 0; i < 60; i++) {
      h.desktop.windows.push({ hwnd: String(2000 + i), pid: 9000 + i, processName: 'notepad', title: `draft ${i} ${'lorem ipsum '.repeat(16)}`, className: 'Notepad', minimized: false, x: 0, y: 0, width: 10, height: 10, foreground: false });
    }
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'find my notepad windows and then compare their titles').done;
    const last = requests[2]!;
    const [older, newer] = results(last).slice(-2);
    expect(older?.content).toMatch(/^\[Older tool result shortened by Keo/);
    expect(older?.content).toContain('status: succeeded');
    expect(older!.content.length).toBeLessThan(1000);
    expect(newer?.content).not.toContain('shortened');
    // The request and the plan are untouched.
    expect(JSON.stringify(last.messages)).toContain('compare their titles');
    expect(last.system).toContain('[~] Pick the right one');
    expect(msg.meta.compactedResults).toBe(1);
    // In the first round nothing was shortened yet.
    expect(JSON.stringify(requests[1]!.messages)).not.toContain('shortened by Keo');
  });

  it('does not touch the context while it fits', () => {
    const msgs: NeutralMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'goal' }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'a', content: 'y'.repeat(1500), isError: false }] },
      { role: 'assistant', content: [{ type: 'tool_call', id: 'b', name: 'x', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', callId: 'b', content: 'z'.repeat(1500), isError: false }] },
    ];
    expect(compactTurn(msgs, 1, 10_000)).toBe(0);
    expect(compactTurn(msgs, 1, 2000)).toBe(1);
    expect((msgs[4]!.content[0] as { content: string }).content).toBe('z'.repeat(1500));
  });
});

describe('strongest model when it matters', () => {
  it('a quick request on the fast model moves to the strong one once it turns into real work', async () => {
    const models: string[] = [];
    h = makeHarness({
      script: (req, n) => {
        models.push(req.model);
        if (n === 0) return calls(plan(['List windows', 'in_progress'], ['Report', 'pending']), ['desktop__list_windows', {}]);
        if (n === 1) return calls(plan(['List windows', 'done'], ['Report', 'done']));
        return reply('You have Notepad open. Nothing is left open.');
      },
    });
    enableDesktop();
    h.services.settings.update({ routing: { enabled: true, fast: { provider: 'test', model: 'keo-fast' }, strong: { provider: 'test', model: 'keo-strong' } } });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'which windows are open?').done;
    expect(models).toEqual(['keo-fast', 'keo-strong', 'keo-strong']);
    expect(msg.meta.route).toBe('strong');
    expect(msg.meta.escalated).toBe('multi-step plan');
    expect(msg.meta.model).toBe('keo-strong');
  });

  it('multi-step requests start on the strong model; simple chat stays on the fast one with one call', async () => {
    const models: string[] = [];
    h = makeHarness({ script: (req) => (models.push(req.model), reply('ok')) });
    h.services.settings.update({ routing: { enabled: true, fast: { provider: 'test', model: 'keo-fast' }, strong: { provider: 'test', model: 'keo-strong' } } });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'hi there').done;
    await h.services.agent.send(c.id, 'open notepad, then type my list and after that save it').done;
    expect(models).toEqual(['keo-fast', 'keo-strong']);
  });
});
