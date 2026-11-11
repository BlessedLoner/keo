import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { actionLabel, actionScript, CheckAction, keyOf } from '../src/main/build/checkActions';
import { BuildProjects } from '../src/main/build/projects';
import { buildCapabilities } from '../src/main/capabilities/build';
import { carryPlan, finishIssues, parsePlan, renderPlan } from '../src/main/agent/workPlan';
import { ProviderError, type ChatRequest, type ChatResult } from '../src/main/providers/types';
import { makeHarness, tempDir, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 5, outputTokens: 5 }, model: 'x', native: undefined });
const declined: ChatResult = { text: '', toolCalls: [], stopReason: 'refusal', usage: { inputTokens: 5, outputTokens: 0 }, model: 'x', native: undefined };

describe('carrying on with another model', () => {
  it('a model that declines hands the request to another one, once, and the user is not left with a refusal', async () => {
    const models: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest) => {
        models.push(req.model);
        return req.model === 'keo-test-heavy' ? declined : reply('Here is the plan for the racing game.');
      },
    });
    h.services.agent.heavyModel = () => 'keo-test-heavy';
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'build me a realistic 3D car racing game').done;
    expect(models).toEqual(['keo-test-heavy', 'keo-test-1']);
    expect(msg.content).toContain('plan for the racing game');
    expect(msg.content).not.toContain('declined');
    expect(msg.meta.fallback).toMatchObject({ from: 'test/keo-test-heavy', to: 'test/keo-test-1', reason: 'the model declined' });
    expect(msg.meta.model).toBe('keo-test-1');
  });

  it('a model that cannot answer just now (its own limit) is swapped for another without the user doing anything', async () => {
    const models: string[] = [];
    h = makeHarness({
      script: (req: ChatRequest) => {
        models.push(req.model);
        if (req.model === 'keo-test-heavy') throw new ProviderError('rate_limit', 'This model is busy.');
        return reply('Done with the other model.');
      },
    });
    h.services.agent.heavyModel = () => 'keo-test-heavy';
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'build me a website for my bakery').done;
    expect(models).toEqual(['keo-test-heavy', 'keo-test-1']);
    expect(msg.status).toBe('complete');
    expect(msg.meta.fallback?.reason).toContain('rate_limit');
  });

  it('with no other model, a refusal is shown as it is; problems with the account are never retried elsewhere', async () => {
    h = makeHarness({ script: () => declined });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'hello there').done;
    expect(msg.content).toContain('declined');
    expect(msg.meta.fallback).toBeUndefined();

    const calls: string[] = [];
    h.provider.setScript((req: ChatRequest) => {
      calls.push(req.model);
      throw new ProviderError('quota', 'You’ve used today’s allowance.');
    });
    h.services.agent.heavyModel = () => 'keo-test-heavy';
    const failed = await h.services.agent.send(c.id, 'build me a game').done;
    expect(calls).toEqual(['keo-test-heavy']);
    expect(failed.meta.errorKind).toBe('quota');
  });
});

describe('how long things take', () => {
  it('every reply records its model time, step time and total; model calls are kept for the speed report', async () => {
    h = makeHarness({
      script: (_req: ChatRequest, n) => (n === 0 ? { text: '', toolCalls: [{ id: 'b1', name: 'build__list', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 9, outputTokens: 3 }, model: 'keo-test-1', native: undefined } : reply('Listed.')),
    });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'show me the things you made').done;
    expect(msg.meta.timings).toMatchObject({ modelCalls: 2 });
    expect(msg.meta.timings!.totalMs).toBeGreaterThanOrEqual(msg.meta.timings!.modelMs);
    expect(typeof msg.meta.tools?.[0]?.ms).toBe('number');
    const speeds = h.services.audit.modelSpeeds();
    expect(speeds.every((x) => x.providerId === 'test' && x.medianMs >= 0 && x.slowMs >= x.medianMs)).toBe(true);
    expect(speeds.reduce((n, x) => n + x.calls, 0)).toBe(2);
    expect(speeds.reduce((n, x) => n + x.inputTokens, 0)).toBe(14);
  });
});

describe('a plan that knows when each step is done', () => {
  it('keeps the goal and the done-when rules, and carries them over when a later update leaves them out', () => {
    const first = parsePlan({ goal: ' A racing game that drives ', steps: [{ title: 'Make the game', status: 'in_progress', doneWhen: 'the check reports a speed above zero' }, { title: 'Open it', status: 'pending' }] });
    if (!('plan' in first)) throw new Error('refused');
    expect(first.plan.goal).toBe('A racing game that drives');
    expect(first.plan.steps[0]!.doneWhen).toBe('the check reports a speed above zero');
    const later = parsePlan({ steps: [{ title: 'Make the game', status: 'done', note: 'speed 41 mph after holding W' }, { title: 'Open it', status: 'in_progress' }] });
    if (!('plan' in later)) throw new Error('refused');
    const merged = carryPlan(first.plan, later.plan);
    expect(merged.goal).toBe('A racing game that drives');
    expect(merged.steps[0]).toMatchObject({ status: 'done', doneWhen: 'the check reports a speed above zero', note: 'speed 41 mph after holding W' });
    expect(renderPlan(merged)).toContain('Goal: A racing game that drives');
    expect(renderPlan(merged)).toContain('(done when: the check reports a speed above zero)');
    // Plans written the old way still work.
    expect(parsePlan({ steps: [{ title: 'x', status: 'pending' }] })).toEqual({ plan: { steps: [{ title: 'x', status: 'pending' }] } });
  });

  it('a step called done without a word on what showed it is sent back before the reply may end', () => {
    const plan = { steps: [{ title: 'Make the game', status: 'done' as const, doneWhen: 'the check reports a speed above zero' }] };
    expect(finishIssues('Here it is.', plan, [])?.unproven.map((s) => s.title)).toEqual(['Make the game']);
    const proven = { steps: [{ ...plan.steps[0]!, note: 'speed 41 mph' }] };
    expect(finishIssues('Here it is.', proven, [])).toBeNull();
    // A step with no rule is not second-guessed.
    expect(finishIssues('Here it is.', { steps: [{ title: 'Say hello', status: 'done' }] }, [])).toBeNull();
  });
});

describe('using a build while checking it', () => {
  it('turns actions into page scripts: clicks by the words on a button, held keys, typing, reading a value', () => {
    expect(keyOf('KeyW')).toEqual({ code: 'KeyW', key: 'w', keyCode: 87 });
    expect(keyOf('Space')).toEqual({ code: 'Space', key: ' ', keyCode: 32 });
    expect(keyOf('Digit2')).toEqual({ code: 'Digit2', key: '2', keyCode: 50 });
    const click = CheckAction.parse({ do: 'click', text: 'Play' });
    expect(actionScript(click).script).toContain('"text":"Play"');
    expect(actionLabel(click)).toBe('click “Play”');
    const keys = CheckAction.parse({ do: 'keys', keys: ['KeyW', 'ShiftLeft'], holdSeconds: 3 });
    expect(actionScript(keys).script).toContain('"ms":3000');
    expect(actionScript(keys).script).toContain('"key":"Shift"');
    expect(actionScript(CheckAction.parse({ do: 'wait', seconds: 2 }))).toEqual({ script: null, settleMs: 2000 });
    expect(actionScript(CheckAction.parse({ do: 'measure', expression: 'window.game.player.mph' })).script).toContain('await (window.game.player.mph)');
    // Text typed by the model cannot break out of the script.
    expect(actionScript(CheckAction.parse({ do: 'type', text: '"); alert(1); ("' })).script).toContain('\\"); alert(1); (\\"');
    expect(CheckAction.safeParse({ do: 'keys', keys: ['W; evil()'] }).success).toBe(false);
    expect(CheckAction.safeParse({ do: 'launch', what: 'x' }).success).toBe(false);
  });

  it('a game that only loads is not called working; an action that finds nothing is reported as a problem', async () => {
    const root = tempDir('keo-builds-');
    const projects = new BuildProjects({ root: () => root, modules: () => path.join(__dirname, '..', 'node_modules'), log: { info: () => undefined } });
    const m = projects.create({ title: 'Tap Racer', kind: 'game', libraries: [] });
    let steps: string[] = [];
    const seen: unknown[] = [];
    const host = {
      check: async (_id: string, page: string, o: { actions?: unknown[] }) => {
        seen.push(o.actions);
        return { page: page || 'index.html', title: 'Tap Racer', errors: [], warnings: [], missing: [], text: 'Play', screenshot: null, steps };
      },
    };
    const check = buildCapabilities({ projects, host: host as never }).find((c) => c.id === 'build.check')!;
    const ctx = { signal: new AbortController().signal } as never;
    const run = async (input: Record<string, unknown>) => (await check.execute(check.input.parse({ build: m.id, ...input }) as never, ctx)) as { ok: boolean; used: boolean; steps: string[]; next: string };

    const loaded = await run({});
    expect(loaded).toMatchObject({ ok: true, used: false });
    expect(loaded.next).toContain('nothing was tried yet');

    steps = ['click “Play”: clicked play', 'hold KeyW for 3s: held', 'measure window.game.speed → 41'];
    const played = await run({ actions: [{ do: 'click', text: 'Play' }, { do: 'keys', keys: ['KeyW'], holdSeconds: 3 }, { do: 'measure', expression: 'window.game.speed' }] });
    expect(played).toMatchObject({ ok: true, used: true });
    expect(played.steps).toHaveLength(3);
    expect(seen[1]).toHaveLength(3);

    steps = ['click “Start”: not found: nothing on the page says "Start"', 'measure window.game.speed → error: Cannot read properties of undefined'];
    const stuck = await run({ actions: [{ do: 'click', text: 'Start' }, { do: 'measure', expression: 'window.game.speed' }] });
    expect(stuck.ok).toBe(false);
    expect(stuck.next).toContain('Some actions did not work');
  });
});
