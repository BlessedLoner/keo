import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Admission } from '../src/main/capabilities/registry';
import { CapabilityError, defineCapability } from '../src/main/capabilities/types';
import { assertStepTransition, assertTaskTransition, deriveTaskState } from '../src/main/tasks/stateMachine';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** Configurable test capability. `behaviour` decides what each execution does. */
function testCap(id: string, opts: { consequential: boolean; idempotent?: boolean; maxAttempts?: number; timeoutMs?: number }) {
  const state = { runs: 0, behaviour: (_n: number): Promise<unknown> => Promise.resolve({ ok: true }) };
  const cap = defineCapability({
    id,
    version: '1.0.0',
    title: id,
    description: 'test',
    input: z.object({ value: z.string() }).strict(),
    output: z.unknown(),
    risk: opts.consequential ? 'high' : 'read',
    approval: opts.consequential ? 'always' : 'never',
    permissions: [],
    consequential: opts.consequential,
    idempotent: opts.idempotent ?? !opts.consequential,
    timeoutMs: opts.timeoutMs ?? 2000,
    maxAttempts: opts.maxAttempts ?? 1,
    modelVisible: true,
    verificationPolicy: 'test',
    preview: (i) => ({ summary: `${id}(${i.value})`, target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    execute: async () => state.behaviour(++state.runs),
  });
  return { cap, state };
}

function admit(h: Harness, id: string, value = 'x'): Extract<Admission, { ok: true }> {
  const a = h.services.registry.admit({ capabilityId: id, input: { value }, origin: 'model', correlationId: 'c_test' });
  if (!a.ok) throw new Error(a.reason);
  return a;
}

function single(h: Harness, id: string, value = 'x') {
  const t = h.services.tasks.create({ title: 't', rationale: '', origin: 'model', conversationId: null, correlationId: 'c_test', steps: [{ admission: admit(h, id, value), title: 's', dependsOnIndexes: [] }] });
  return h.services.tasks.submit(t.id);
}

const stateOf = (h: Harness, id: string) => h.services.tasks.get(id)!.state;

describe('state machine', () => {
  it('rejects invalid transitions', () => {
    expect(() => assertStepTransition('succeeded', 'running')).toThrow();
    expect(() => assertStepTransition('pending', 'running')).toThrow();
    expect(() => assertStepTransition('awaiting_authorization', 'running')).toThrow();
    expect(() => assertTaskTransition('completed', 'running')).toThrow();
    expect(() => assertTaskTransition('cancelled', 'ready')).toThrow();
    expect(() => assertStepTransition('ready', 'running')).not.toThrow();
  });
  it('derives task state from steps conservatively', () => {
    expect(deriveTaskState('running', [{ state: 'succeeded' }, { state: 'outcome_uncertain' }])).toBe('outcome_uncertain');
    expect(deriveTaskState('running', [{ state: 'succeeded' }, { state: 'failed' }])).toBe('failed');
    expect(deriveTaskState('running', [{ state: 'succeeded' }, { state: 'succeeded' }])).toBe('completed');
    expect(deriveTaskState('cancelling', [{ state: 'running' }])).toBe('cancelling');
  });
});

describe('authorization', () => {
  it('does not run a consequential step without approval bound to its exact input', async () => {
    h = makeHarness();
    const { cap, state } = testCap('test.effect', { consequential: true });
    h.services.registry.register(cap);
    const t = single(h, 'test.effect', 'hello');
    h.services.tasks.pump();
    await new Promise((r) => setTimeout(r, 30));
    expect(state.runs).toBe(0);
    expect(stateOf(h, t.id)).toBe('awaiting_authorization');
    const step = h.services.tasks.get(t.id)!.steps[0]!;
    expect(() => h.services.tasks.approveStep(step.id, 'f'.repeat(64))).toThrow(/no longer matches/);
    expect(state.runs).toBe(0);
    h.services.tasks.approveStep(step.id, step.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'completed');
    expect(state.runs).toBe(1);
  });

  it('denial cancels the task and skips dependents', () => {
    h = makeHarness();
    h.services.registry.register(testCap('test.effect', { consequential: true }).cap);
    h.services.registry.register(testCap('test.read', { consequential: false }).cap);
    const t = h.services.tasks.create({
      title: 'plan',
      rationale: '',
      origin: 'plan',
      conversationId: null,
      correlationId: 'c',
      steps: [
        { admission: admit(h, 'test.effect'), title: 'a', dependsOnIndexes: [] },
        { admission: admit(h, 'test.read'), title: 'b', dependsOnIndexes: [0] },
      ],
    });
    h.services.tasks.submit(t.id);
    const first = h.services.tasks.get(t.id)!.steps[0]!;
    const after = h.services.tasks.denyStep(first.id);
    expect(after.steps.map((s) => s.state)).toEqual(['denied', 'skipped']);
    expect(after.state).toBe('cancelled');
  });

  it('plan approval requires every reviewed hash', () => {
    h = makeHarness();
    h.services.registry.register(testCap('test.effect', { consequential: true }).cap);
    const t = h.services.tasks.create({
      title: 'plan',
      rationale: '',
      origin: 'plan',
      conversationId: null,
      correlationId: 'c',
      steps: [
        { admission: admit(h, 'test.effect', 'a'), title: 'a', dependsOnIndexes: [] },
        { admission: admit(h, 'test.effect', 'b'), title: 'b', dependsOnIndexes: [0] },
      ],
    });
    const s0 = t.steps[0]!;
    expect(() => h.services.tasks.approvePlan(t.id, { [s0.id]: s0.inputHash })).toThrow(/not reviewed/);
    expect(h.services.tasks.get(t.id)!.steps.every((s) => s.approval === null)).toBe(true);
  });
});

describe('execution', () => {
  it('propagates dependency failure', async () => {
    h = makeHarness();
    const a = testCap('test.first', { consequential: false });
    a.state.behaviour = async () => {
      throw new CapabilityError('boom', 'failed hard', { dispatched: 'no' });
    };
    h.services.registry.register(a.cap);
    const b = testCap('test.second', { consequential: false });
    h.services.registry.register(b.cap);
    const t = h.services.tasks.create({
      title: 'chain',
      rationale: '',
      origin: 'plan',
      conversationId: null,
      correlationId: 'c',
      steps: [
        { admission: admit(h, 'test.first'), title: 'a', dependsOnIndexes: [] },
        { admission: admit(h, 'test.second'), title: 'b', dependsOnIndexes: [0] },
      ],
    });
    h.services.tasks.submit(t.id);
    h.services.tasks.pump();
    await waitFor(() => stateOf(h, t.id) === 'failed');
    expect(h.services.tasks.get(t.id)!.steps.map((s) => s.state)).toEqual(['failed', 'skipped']);
    expect(b.state.runs).toBe(0);
  });

  it('enforces bounded retries for safe, retryable failures', async () => {
    h = makeHarness();
    const c = testCap('test.flaky', { consequential: false, maxAttempts: 3 });
    c.state.behaviour = async () => {
      throw new CapabilityError('transient', 'try again', { retryable: true, dispatched: 'no' });
    };
    h.services.registry.register(c.cap);
    const t = single(h, 'test.flaky');
    h.services.tasks.pump();
    await waitFor(() => stateOf(h, t.id) === 'failed', 6000);
    expect(c.state.runs).toBe(3);
  });

  it('never auto-retries a consequential action whose outcome is unknown', async () => {
    h = makeHarness();
    const c = testCap('test.send', { consequential: true, maxAttempts: 3, timeoutMs: 50 });
    c.state.behaviour = () => new Promise(() => undefined); // hangs -> timeout (dispatch unknown)
    h.services.registry.register(c.cap);
    const t = single(h, 'test.send');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'outcome_uncertain');
    await new Promise((r) => setTimeout(r, 300));
    expect(c.state.runs).toBe(1);
    expect(h.services.tasks.get(t.id)!.state).not.toBe('completed');
  });

  it('cancelling a running consequential step leaves an honest uncertain outcome', async () => {
    h = makeHarness();
    const c = testCap('test.long', { consequential: true, timeoutMs: 5000 });
    c.state.behaviour = () => new Promise(() => undefined);
    h.services.registry.register(c.cap);
    const t = single(h, 'test.long');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'running');
    h.services.tasks.cancel(t.id);
    await waitFor(() => !['running', 'cancelling'].includes(stateOf(h, t.id)));
    expect(stateOf(h, t.id)).toBe('outcome_uncertain');
  });

  it('cancelling a running safe step and its pending dependents ends cancelled', async () => {
    h = makeHarness();
    const c = testCap('test.slow', { consequential: false, timeoutMs: 5000 });
    c.state.behaviour = () => new Promise(() => undefined);
    h.services.registry.register(c.cap);
    const t = h.services.tasks.create({
      title: 'two',
      rationale: '',
      origin: 'plan',
      conversationId: null,
      correlationId: 'c',
      steps: [
        { admission: admit(h, 'test.slow'), title: 'a', dependsOnIndexes: [] },
        { admission: admit(h, 'test.slow', 'y'), title: 'b', dependsOnIndexes: [0] },
      ],
    });
    h.services.tasks.submit(t.id);
    h.services.tasks.pump();
    await waitFor(() => stateOf(h, t.id) === 'running');
    h.services.tasks.cancel(t.id);
    await waitFor(() => stateOf(h, t.id) === 'cancelled');
    expect(h.services.tasks.get(t.id)!.steps.map((s) => s.state)).toEqual(['cancelled', 'cancelled']);
    expect(c.state.runs).toBe(1);
  });

  it('prevents duplicate execution using execution receipts', async () => {
    h = makeHarness();
    const c = testCap('test.once', { consequential: true });
    h.services.registry.register(c.cap);
    const t = single(h, 'test.once');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    // Simulate a crash after dispatch: a "started" receipt exists but no completion.
    h.services.db.run("INSERT INTO execution_receipts (idempotency_key, step_id, capability_id, status, started_at) VALUES (?, ?, ?, 'started', ?)", [
      st.idempotencyKey,
      st.id,
      'test.once',
      new Date().toISOString(),
    ]);
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'outcome_uncertain');
    expect(c.state.runs).toBe(0);
    expect(h.services.tasks.get(t.id)!.steps[0]!.errorCode).toBe('duplicate_prevented');
  });

  it('reuses a finished receipt instead of re-dispatching', async () => {
    h = makeHarness();
    const c = testCap('test.once', { consequential: true });
    h.services.registry.register(c.cap);
    const t = single(h, 'test.once');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.db.run("INSERT INTO execution_receipts (idempotency_key, step_id, capability_id, status, started_at, finished_at, result) VALUES (?, ?, ?, 'finished', ?, ?, ?)", [
      st.idempotencyKey,
      st.id,
      'test.once',
      new Date().toISOString(),
      new Date().toISOString(),
      JSON.stringify({ ok: 'earlier' }),
    ]);
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'completed');
    expect(c.state.runs).toBe(0);
    expect(h.services.tasks.get(t.id)!.steps[0]!.result).toEqual({ ok: 'earlier' });
  });

  it('reconciliation lets the user settle an uncertain outcome', async () => {
    h = makeHarness();
    const c = testCap('test.send', { consequential: true, timeoutMs: 30 });
    c.state.behaviour = () => new Promise(() => undefined);
    h.services.registry.register(c.cap);
    const t = single(h, 'test.send');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'outcome_uncertain');
    const done = h.services.tasks.reconcile(st.id, 'mark_succeeded');
    expect(done.state).toBe('completed');
    expect(done.steps[0]!.verification).toBe('unverified');
  });

  it('a retry after uncertainty needs fresh approval', async () => {
    h = makeHarness();
    const c = testCap('test.send', { consequential: true, timeoutMs: 30 });
    c.state.behaviour = () => new Promise(() => undefined);
    h.services.registry.register(c.cap);
    const t = single(h, 'test.send');
    const st = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.tasks.approveStep(st.id, st.inputHash);
    await waitFor(() => stateOf(h, t.id) === 'outcome_uncertain');
    const r = h.services.tasks.reconcile(st.id, 'retry');
    expect(r.steps[0]!.state).toBe('awaiting_authorization');
    expect(r.steps[0]!.approval).toBeNull();
    expect(c.state.runs).toBe(1);
  });
});

describe('restart recovery', () => {
  it('never replays interrupted consequential actions and re-requests stale approvals', async () => {
    const dir = tempDir();
    h = makeHarness({ dir });
    const effect = testCap('test.effect', { consequential: true });
    const read = testCap('test.read', { consequential: false });
    h.services.registry.register(effect.cap);
    h.services.registry.register(read.cap);
    const running = single(h, 'test.effect', 'running');
    const approvedNotStarted = single(h, 'test.effect', 'queued');
    const readRunning = single(h, 'test.read', 'r');
    const repo = h.services.taskRepo;
    // Forge the persisted state left behind by a crash.
    const s1 = repo.get(running.id)!.steps[0]!;
    repo.updateStep(s1.id, { state: 'ready', approval: { decision: 'approved', decidedAt: new Date().toISOString(), inputHash: s1.inputHash } });
    repo.beginExecution(repo.stepById(s1.id)!, 1);
    const s2 = repo.get(approvedNotStarted.id)!.steps[0]!;
    repo.updateStep(s2.id, { state: 'ready', approval: { decision: 'approved', decidedAt: new Date().toISOString(), inputHash: s2.inputHash } });
    const s3 = repo.get(readRunning.id)!.steps[0]!;
    repo.beginExecution(repo.stepById(s3.id)!, 1);
    await h.close();

    h = makeHarness({ dir });
    h.services.registry.register(effect.cap);
    h.services.registry.register(read.cap);
    const r = h.services.tasks.recover();
    expect(r).toEqual({ requeued: 1, uncertain: 1, reauthorize: 1 });
    expect(h.services.tasks.get(running.id)!.state).toBe('outcome_uncertain');
    expect(h.services.tasks.get(approvedNotStarted.id)!.steps[0]!.state).toBe('awaiting_authorization');
    h.services.tasks.pump();
    await waitFor(() => h.services.tasks.get(readRunning.id)!.state === 'completed');
    expect(effect.state.runs).toBe(0);
  });
});
