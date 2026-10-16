import { EventEmitter } from 'node:events';
import type { Task, TaskOrigin, TaskStep } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import type { Admission, CapabilityRegistry } from '../capabilities/registry';
import { CapabilityError } from '../capabilities/types';
import type { Logger } from '../logging/logger';
import type { AuditRepo } from '../repos/audit';
import type { TaskRepo } from '../repos/tasks';
import { errorCode, errorMessage, KeoError, nowIso } from '../util/errors';
import { hashInput } from '../util/hash';
import { deriveTaskState, TERMINAL_STEP, TERMINAL_TASK } from './stateMachine';

export interface PlannedStep {
  admission: Extract<Admission, { ok: true }>;
  title: string;
  dependsOnIndexes: number[];
}

const MAX_CONCURRENT = 2;

/**
 * Runs tasks through their validated lifecycle. Invariants:
 *  - A step requiring approval runs only with an approval bound to its exact input hash.
 *  - Execution is recorded (receipt + `running`) before dispatch, atomically.
 *  - A started-but-unfinished receipt is never re-executed automatically.
 *  - Consequential failures with unknown dispatch become `outcome_uncertain`.
 *  - Restart recovery never replays consequential actions.
 */
export class TaskOrchestrator {
  private readonly events = new EventEmitter();
  private readonly running = new Map<string, AbortController>();
  private pumping = false;
  private pumpAgain = false;
  private disposed = false;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly repo: TaskRepo,
    private readonly registry: CapabilityRegistry,
    private readonly audit: AuditRepo,
    private readonly log: Logger,
    private readonly getSettings: () => Settings,
  ) {
    this.events.setMaxListeners(100);
  }

  onChange(fn: (taskId: string) => void): () => void {
    this.events.on('change', fn);
    return () => this.events.off('change', fn);
  }

  private emit(taskId: string): void {
    this.events.emit('change', taskId);
  }

  // -- creation ---------------------------------------------------------------

  create(opts: { title: string; rationale: string; origin: TaskOrigin; conversationId: string | null; correlationId: string; steps: PlannedStep[] }): Task {
    const task = this.repo.create({
      title: opts.title.slice(0, 200),
      rationale: opts.rationale.slice(0, 2000),
      origin: opts.origin,
      conversationId: opts.conversationId,
      correlationId: opts.correlationId,
      steps: opts.steps.map((s) => ({
        capabilityId: s.admission.capability.id,
        capabilityVersion: s.admission.capability.version,
        title: s.title.slice(0, 200),
        input: s.admission.input,
        inputHash: s.admission.inputHash,
        dependsOnIndexes: s.dependsOnIndexes,
        requiresApproval: s.admission.requiresApproval,
        preview: s.admission.preview,
        maxAttempts: s.admission.capability.maxAttempts,
      })),
    });
    this.audit.record({ kind: 'task.transition', decision: 'proposed', taskId: task.id, detail: { origin: opts.origin, steps: task.steps.length }, correlationId: opts.correlationId });
    this.log.info('task.created', { taskId: task.id, origin: opts.origin, steps: task.steps.length }, opts.correlationId);
    this.emit(task.id);
    return task;
  }

  /** Moves a proposed task into execution: steps needing approval wait for it, others become ready. */
  submit(taskId: string): Task {
    const task = this.repo.require(taskId);
    if (task.state !== 'proposed') throw new KeoError('invalid_state', `Task is ${task.state}, not proposed.`);
    for (const s of task.steps) {
      this.repo.updateStep(s.id, { state: s.requiresApproval ? 'awaiting_authorization' : 'ready' });
    }
    return this.refresh(taskId, 'submitted');
  }

  // -- user decisions -----------------------------------------------------------

  approveStep(stepId: string, inputHash: string): Task {
    const step = this.requireStep(stepId);
    if (step.state !== 'awaiting_authorization') throw new KeoError('invalid_state', `Step is ${step.state}; nothing to approve.`);
    if (inputHash !== step.inputHash) {
      this.audit.record({ kind: 'permission.decision', decision: 'rejected:hash_mismatch', capabilityId: step.capabilityId, taskId: step.taskId });
      throw new KeoError('approval_mismatch', 'The approved action no longer matches what was displayed. Review it again.');
    }
    this.repo.updateStep(stepId, { state: 'ready', approval: { decision: 'approved', decidedAt: nowIso(), inputHash } });
    this.audit.record({ kind: 'permission.decision', decision: 'approved', capabilityId: step.capabilityId, taskId: step.taskId });
    this.log.info('permission.approved', { stepId, capabilityId: step.capabilityId });
    const t = this.refresh(step.taskId, 'approved');
    this.pump();
    return t;
  }

  denyStep(stepId: string): Task {
    const step = this.requireStep(stepId);
    if (step.state !== 'awaiting_authorization') throw new KeoError('invalid_state', `Step is ${step.state}; nothing to deny.`);
    this.repo.updateStep(stepId, {
      state: 'denied',
      approval: { decision: 'denied', decidedAt: nowIso(), inputHash: step.inputHash },
      finishedAt: nowIso(),
      error: 'Denied by the user.',
      errorCode: 'denied',
    });
    this.audit.record({ kind: 'permission.decision', decision: 'denied', capabilityId: step.capabilityId, taskId: step.taskId });
    this.log.info('permission.denied', { stepId, capabilityId: step.capabilityId });
    this.skipDependents(step.taskId);
    return this.refresh(step.taskId, 'denied');
  }

  approvePlan(taskId: string, inputHashes: Record<string, string>): Task {
    let task = this.repo.require(taskId);
    if (task.state === 'proposed') task = this.submit(taskId);
    const pending = task.steps.filter((s) => s.state === 'awaiting_authorization');
    for (const s of pending) {
      if (inputHashes[s.id] !== s.inputHash) {
        throw new KeoError('approval_mismatch', `Step ${s.index + 1} changed or was not reviewed; nothing was approved.`);
      }
    }
    for (const s of pending) this.approveStep(s.id, s.inputHash);
    this.pump();
    return this.repo.require(taskId);
  }

  cancel(taskId: string): Task {
    const task = this.repo.require(taskId);
    if (TERMINAL_TASK.has(task.state)) throw new KeoError('invalid_state', `Task already ${task.state}.`);
    this.repo.setTaskState(taskId, 'cancelling');
    this.audit.record({ kind: 'task.transition', decision: 'cancelling', taskId, correlationId: task.correlationId });
    for (const s of task.steps) {
      if (s.state === 'running') this.running.get(s.id)?.abort();
      else if (!TERMINAL_STEP.has(s.state) && s.state !== 'outcome_uncertain') {
        this.repo.updateStep(s.id, { state: 'cancelled', finishedAt: nowIso() });
      }
    }
    this.log.info('task.cancel_requested', { taskId }, task.correlationId);
    return this.refresh(taskId, 'cancel');
  }

  reconcile(stepId: string, resolution: 'mark_succeeded' | 'mark_failed' | 'retry'): Task {
    const step = this.requireStep(stepId);
    const task = this.repo.require(step.taskId);
    if (task.state === 'cancelled' || task.state === 'completed') throw new KeoError('invalid_state', `Task already ${task.state}.`);
    if (resolution === 'retry') {
      if (step.state !== 'outcome_uncertain' && step.state !== 'failed') throw new KeoError('invalid_state', 'Only failed or uncertain steps can be retried.');
      this.repo.clearReceipt(step.idempotencyKey);
      this.repo.updateStep(stepId, {
        state: step.requiresApproval ? 'awaiting_authorization' : 'ready',
        approval: null,
        error: null,
        errorCode: null,
        finishedAt: null,
        attempts: 0,
      });
    } else {
      if (step.state !== 'outcome_uncertain') throw new KeoError('invalid_state', 'Only steps with an uncertain outcome can be reconciled.');
      if (resolution === 'mark_succeeded') {
        this.repo.finishReceipt(step.idempotencyKey, 'finished', { reconciledByUser: true });
        this.repo.updateStep(stepId, { state: 'succeeded', verification: 'unverified', verificationDetail: 'Outcome confirmed by the user after an uncertain execution.', finishedAt: nowIso() });
      } else {
        this.repo.finishReceipt(step.idempotencyKey, 'not_dispatched', { reconciledByUser: true });
        this.repo.updateStep(stepId, { state: 'failed', errorCode: 'reconciled_failed', error: 'Marked as not completed by the user.', finishedAt: nowIso() });
        this.skipDependents(step.taskId);
      }
    }
    this.audit.record({ kind: 'task.reconciliation', decision: resolution, capabilityId: step.capabilityId, taskId: step.taskId });
    this.log.info('task.reconciled', { stepId, resolution });
    const t = this.refresh(step.taskId, `reconcile:${resolution}`);
    this.pump();
    return t;
  }

  // -- recovery -------------------------------------------------------------------

  /**
   * Called once at startup before any execution. Never replays consequential
   * work: interrupted consequential steps become outcome_uncertain, and
   * authorized-but-unstarted consequential steps need fresh approval.
   */
  recover(): { requeued: number; uncertain: number; reauthorize: number } {
    let requeued = 0;
    let uncertain = 0;
    let reauthorize = 0;
    for (const step of this.repo.stepsInState('running')) {
      const cap = this.registry.get(step.capabilityId);
      if (cap && !cap.consequential && cap.idempotent) {
        this.repo.clearReceipt(step.idempotencyKey);
        this.repo.updateStep(step.id, { state: 'ready' });
        requeued++;
      } else {
        this.repo.updateStep(step.id, {
          state: 'outcome_uncertain',
          errorCode: 'interrupted',
          error: 'Keo stopped while this action was running. It may or may not have taken effect; please check and reconcile.',
        });
        uncertain++;
      }
    }
    for (const step of this.repo.stepsInState('ready')) {
      const cap = this.registry.get(step.capabilityId);
      if (step.requiresApproval && (!cap || cap.consequential)) {
        this.repo.updateStep(step.id, { state: 'awaiting_authorization', approval: null });
        reauthorize++;
      }
    }
    for (const t of this.repo.listByStates(['cancelling'])) {
      for (const s of t.steps) if (!TERMINAL_STEP.has(s.state) && s.state !== 'outcome_uncertain') this.repo.updateStep(s.id, { state: 'cancelled', finishedAt: nowIso() });
    }
    for (const t of this.repo.listByStates(['proposed', 'awaiting_clarification', 'awaiting_authorization', 'ready', 'running', 'waiting_dependency', 'cancelling', 'outcome_uncertain'])) {
      this.refresh(t.id, 'recovery');
    }
    this.log.info('task.recovery', { requeued, uncertain, reauthorize });
    this.audit.record({ kind: 'task.recovery', decision: 'completed', detail: { requeued, uncertain, reauthorize } });
    return { requeued, uncertain, reauthorize };
  }

  // -- scheduling -----------------------------------------------------------------

  /** Starts any runnable steps (dependency-aware, bounded concurrency). */
  pump(): void {
    if (this.disposed) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const active = this.repo.listByStates(['ready', 'running', 'waiting_dependency', 'awaiting_authorization', 'outcome_uncertain']);
        for (const task of active) {
          if (this.running.size >= MAX_CONCURRENT) break;
          if (task.steps.some((s) => s.state === 'running')) continue; // one step at a time per task
          const runnable = task.steps.find(
            (s) => s.state === 'ready' && s.dependsOn.every((d) => task.steps.find((x) => x.id === d)?.state === 'succeeded'),
          );
          if (runnable) void this.runStep(runnable, task);
        }
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
  }

  private async runStep(step: TaskStep, task: Task): Promise<void> {
    const cap = this.registry.get(step.capabilityId);
    const fail = (code: string, message: string) => {
      this.repo.updateStep(step.id, { state: 'running', startedAt: nowIso() });
      this.repo.updateStep(step.id, { state: 'failed', errorCode: code, error: message, finishedAt: nowIso() });
      this.skipDependents(task.id);
      this.refresh(task.id, code);
    };
    if (!cap || cap.version !== step.capabilityVersion) return fail('capability_changed', 'The capability changed or is no longer registered; the step was not run.');
    const parsed = cap.input.safeParse(step.input);
    if (!parsed.success || hashInput(cap.id, cap.version, parsed.data) !== step.inputHash) {
      return fail('input_integrity', 'Stored input failed validation or no longer matches its hash; the step was not run.');
    }
    if (step.requiresApproval && !(step.approval?.decision === 'approved' && step.approval.inputHash === step.inputHash)) {
      this.repo.updateStep(step.id, { state: 'awaiting_authorization', approval: null });
      this.refresh(task.id, 'approval_missing');
      return;
    }
    const settings = this.getSettings();
    const avail = this.registry.availability(cap, settings);
    if (!avail.available) return fail('permission_disabled', avail.reason ?? 'Permission disabled.');
    const pre = cap.precheck?.(parsed.data, settings);
    if (pre) return fail('precondition_failed', pre);

    const receipt = this.repo.receipt(step.idempotencyKey);
    if (receipt?.status === 'finished') {
      // Already executed (e.g. completion record lost): reuse, never re-dispatch.
      this.repo.updateStep(step.id, { state: 'running', startedAt: nowIso() });
      this.repo.updateStep(step.id, { state: 'succeeded', result: receipt.result, verification: 'unverified', verificationDetail: 'Result recovered from execution receipt.', finishedAt: nowIso() });
      this.refresh(task.id, 'receipt_reused');
      return;
    }
    if (receipt?.status === 'started') {
      this.repo.updateStep(step.id, { state: 'running', startedAt: nowIso() });
      this.repo.updateStep(step.id, { state: 'outcome_uncertain', errorCode: 'duplicate_prevented', error: 'A previous execution of this exact step started but never reported completion. Not re-running automatically.' });
      this.refresh(task.id, 'duplicate_prevented');
      return;
    }

    const attempt = step.attempts + 1;
    this.repo.beginExecution(step, attempt);
    const controller = new AbortController();
    this.running.set(step.id, controller);
    this.refresh(task.id, 'running');
    this.log.info('task.step_started', { taskId: task.id, stepId: step.id, capabilityId: cap.id, attempt }, task.correlationId);

    const ctx = {
      signal: controller.signal,
      idempotencyKey: step.idempotencyKey,
      correlationId: task.correlationId,
      conversationId: task.conversationId,
      sourceMessageId: null,
      taskId: task.id,
      settings,
    };
    try {
      const out = await this.registry.execute(cap, parsed.data, ctx);
      this.repo.finishReceipt(step.idempotencyKey, 'finished', out);
      let verification: TaskStep['verification'] = 'not_applicable';
      let detail: string | null = null;
      if (cap.verify) {
        try {
          const v = await cap.verify(parsed.data, out, ctx);
          verification = v.verified === true ? 'verified' : v.verified === false ? 'verification_failed' : 'unverified';
          detail = v.detail;
        } catch (e) {
          verification = 'unverified';
          detail = `Verification could not run: ${errorMessage(e)}`;
        }
      }
      if (verification === 'verification_failed') {
        this.repo.updateStep(step.id, { state: 'failed', result: out, verification, verificationDetail: detail, errorCode: 'verification_failed', error: detail, finishedAt: nowIso() });
        this.skipDependents(task.id);
      } else {
        this.repo.updateStep(step.id, { state: 'succeeded', result: out, verification, verificationDetail: detail, finishedAt: nowIso() });
      }
      this.audit.record({ kind: 'capability.execution', decision: verification === 'verification_failed' ? 'verification_failed' : 'succeeded', capabilityId: cap.id, taskId: task.id, detail: { verification }, correlationId: task.correlationId });
    } catch (err) {
      const ce = err instanceof CapabilityError ? err : new CapabilityError(errorCode(err), errorMessage(err), { dispatched: 'unknown' });
      const cancelRequested = controller.signal.aborted;
      const mayHaveHappened = ce.dispatched !== 'no' && cap.consequential;
      if (mayHaveHappened) {
        // Receipt stays "started": the action may have taken effect. Never auto-retry.
        this.repo.updateStep(step.id, { state: 'outcome_uncertain', errorCode: ce.code, error: `${ce.message} The action may have taken effect; check and reconcile.` });
      } else {
        this.repo.finishReceipt(step.idempotencyKey, 'not_dispatched', { error: ce.code });
        if (cancelRequested) {
          this.repo.updateStep(step.id, { state: 'cancelled', errorCode: 'cancelled', error: 'Cancelled.', finishedAt: nowIso() });
        } else if (ce.retryable && attempt < cap.maxAttempts) {
          this.repo.clearReceipt(step.idempotencyKey);
          this.repo.updateStep(step.id, { state: 'ready', errorCode: ce.code, error: `${ce.message} (retrying, attempt ${attempt}/${cap.maxAttempts})` });
          this.schedule(250 * 2 ** attempt);
        } else {
          this.repo.updateStep(step.id, { state: 'failed', errorCode: ce.code, error: ce.message, finishedAt: nowIso() });
          this.skipDependents(task.id);
        }
      }
      this.audit.record({ kind: 'capability.execution', decision: `error:${ce.code}`, capabilityId: cap.id, taskId: task.id, detail: { dispatched: ce.dispatched, attempt }, correlationId: task.correlationId });
      this.log.warn('task.step_error', { taskId: task.id, stepId: step.id, code: ce.code, dispatched: ce.dispatched, attempt }, task.correlationId);
    } finally {
      this.running.delete(step.id);
      this.refresh(task.id, 'step_finished');
      this.pump();
    }
  }

  private schedule(ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.pump();
    }, ms);
    this.timers.add(t);
  }

  /** Propagates failure: pending/approval-waiting/ready dependents of non-succeeded steps are skipped. */
  private skipDependents(taskId: string): void {
    let changed = true;
    while (changed) {
      changed = false;
      const task = this.repo.require(taskId);
      for (const s of task.steps) {
        if (!['pending', 'awaiting_authorization', 'ready'].includes(s.state)) continue;
        const blocker = s.dependsOn
          .map((d) => task.steps.find((x) => x.id === d))
          .find((d) => d && ['failed', 'denied', 'skipped', 'cancelled'].includes(d.state));
        if (blocker) {
          this.repo.updateStep(s.id, { state: 'skipped', errorCode: 'dependency_failed', error: `Skipped because step ${blocker.index + 1} did not succeed.`, finishedAt: nowIso() });
          changed = true;
        }
      }
    }
  }

  private refresh(taskId: string, reason: string): Task {
    const task = this.repo.require(taskId);
    let next = deriveTaskState(task.state, task.steps);
    if (next === 'ready') {
      const runnable = task.steps.some((s) => s.state === 'ready' && s.dependsOn.every((d) => task.steps.find((x) => x.id === d)?.state === 'succeeded'));
      if (!runnable) next = 'waiting_dependency';
    }
    if (next !== task.state) {
      this.repo.setTaskState(taskId, next);
      this.audit.record({ kind: 'task.transition', decision: next, taskId, detail: { from: task.state, reason }, correlationId: task.correlationId });
      this.log.info('task.transition', { taskId, from: task.state, to: next, reason }, task.correlationId);
    }
    this.emit(taskId);
    return this.repo.require(taskId);
  }

  private requireStep(stepId: string): TaskStep {
    const s = this.repo.stepById(stepId);
    if (!s) throw new KeoError('not_found', 'Step not found.');
    return s;
  }

  get(taskId: string): Task | null {
    return this.repo.get(taskId);
  }

  list(limit: number): Task[] {
    return this.repo.list(limit);
  }

  /**
   * Resolves when the task settles (terminal, uncertain) or still awaits the
   * user's authorization after `timeoutMs`. Never resolves as "succeeded" unless
   * the stored state says so.
   */
  waitForSettle(taskId: string, timeoutMs: number, signal?: AbortSignal): Promise<Task> {
    return new Promise((resolve) => {
      const settled = (t: Task) => TERMINAL_TASK.has(t.state) || t.state === 'outcome_uncertain';
      const now = this.repo.require(taskId);
      if (settled(now)) return resolve(now);
      let timer: NodeJS.Timeout | null = null;
      const finish = () => {
        off();
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve(this.repo.require(taskId));
      };
      const off = this.onChange((id) => {
        if (id !== taskId) return;
        if (settled(this.repo.require(taskId))) finish();
      });
      timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    for (const c of this.running.values()) c.abort();
  }

  hasRunning(): boolean {
    return this.running.size > 0;
  }
}
