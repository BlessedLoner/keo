import type { ApprovalPreview, StepState, Task, TaskOrigin, TaskState, TaskStep, Verification } from '../../shared/domain';
import { parseJson, type Database } from '../db/database';
import { assertStepTransition, assertTaskTransition } from '../tasks/stateMachine';
import { KeoError, nowIso } from '../util/errors';
import { newId } from '../util/ids';

interface TaskRow {
  id: string;
  title: string;
  rationale: string;
  origin: TaskOrigin;
  conversation_id: string | null;
  state: TaskState;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  note: string | null;
  correlation_id: string;
}

interface StepRow {
  id: string;
  task_id: string;
  idx: number;
  capability_id: string;
  capability_version: string;
  title: string;
  input: string;
  input_hash: string;
  depends_on: string;
  state: StepState;
  requires_approval: number;
  approval: string | null;
  preview: string;
  attempts: number;
  max_attempts: number;
  idempotency_key: string;
  result: string | null;
  error: string | null;
  error_code: string | null;
  verification: Verification;
  verification_detail: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const toStep = (r: StepRow): TaskStep => ({
  id: r.id,
  taskId: r.task_id,
  index: r.idx,
  capabilityId: r.capability_id,
  capabilityVersion: r.capability_version,
  title: r.title,
  input: parseJson<unknown>(r.input, null),
  inputHash: r.input_hash,
  dependsOn: parseJson<string[]>(r.depends_on, []),
  state: r.state,
  requiresApproval: r.requires_approval === 1,
  approval: parseJson<TaskStep['approval']>(r.approval, null),
  preview: parseJson<ApprovalPreview>(r.preview, { summary: r.title, target: null, consequences: [], dataExport: null }),
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  idempotencyKey: r.idempotency_key,
  result: parseJson<unknown>(r.result, null),
  error: r.error,
  errorCode: r.error_code,
  verification: r.verification,
  verificationDetail: r.verification_detail,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface NewStep {
  capabilityId: string;
  capabilityVersion: string;
  title: string;
  input: unknown;
  inputHash: string;
  dependsOnIndexes: number[];
  requiresApproval: boolean;
  preview: ApprovalPreview;
  maxAttempts: number;
}

export type ReceiptStatus = 'started' | 'finished' | 'not_dispatched';

export class TaskRepo {
  constructor(private readonly db: Database) {}

  private load(r: TaskRow): Task {
    const steps = this.db.all<StepRow>('SELECT * FROM task_steps WHERE task_id = ? ORDER BY idx', [r.id]).map(toStep);
    return {
      id: r.id,
      title: r.title,
      rationale: r.rationale,
      origin: r.origin,
      conversationId: r.conversation_id,
      state: r.state,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      finishedAt: r.finished_at,
      steps,
      note: r.note,
      correlationId: r.correlation_id,
    };
  }

  get(id: string): Task | null {
    const r = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', [id]);
    return r ? this.load(r) : null;
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new KeoError('not_found', 'Task not found.');
    return t;
  }

  list(limit = 100): Task[] {
    return this.db.all<TaskRow>('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?', [limit]).map((r) => this.load(r));
  }

  listByStates(states: TaskState[]): Task[] {
    if (!states.length) return [];
    return this.db
      .all<TaskRow>(`SELECT * FROM tasks WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at ASC`, states)
      .map((r) => this.load(r));
  }

  stepById(stepId: string): TaskStep | null {
    const r = this.db.get<StepRow>('SELECT * FROM task_steps WHERE id = ?', [stepId]);
    return r ? toStep(r) : null;
  }

  stepsInState(state: StepState): TaskStep[] {
    return this.db.all<StepRow>('SELECT * FROM task_steps WHERE state = ?', [state]).map(toStep);
  }

  create(t: { title: string; rationale: string; origin: TaskOrigin; conversationId: string | null; correlationId: string; steps: NewStep[] }): Task {
    if (!t.steps.length) throw new KeoError('invalid_input', 'A task needs at least one step.');
    const id = newId();
    const now = nowIso();
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO tasks (id, title, rationale, origin, conversation_id, state, created_at, updated_at, correlation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, t.title, t.rationale, t.origin, t.conversationId, 'proposed', now, now, t.correlationId],
      );
      const stepIds = t.steps.map(() => newId());
      t.steps.forEach((s, i) => {
        for (const d of s.dependsOnIndexes) {
          if (d < 0 || d >= i) throw new KeoError('invalid_input', `Step ${i + 1} has an invalid dependency on step ${d + 1}.`);
        }
        this.db.run(
          `INSERT INTO task_steps (id, task_id, idx, capability_id, capability_version, title, input, input_hash, depends_on, state,
            requires_approval, preview, max_attempts, idempotency_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            stepIds[i] as string,
            id,
            i,
            s.capabilityId,
            s.capabilityVersion,
            s.title,
            JSON.stringify(s.input),
            s.inputHash,
            JSON.stringify(s.dependsOnIndexes.map((d) => stepIds[d])),
            s.requiresApproval ? 1 : 0,
            JSON.stringify(s.preview),
            s.maxAttempts,
            `idem_${stepIds[i]}`,
          ],
        );
      });
    });
    return this.require(id);
  }

  setTaskState(id: string, to: TaskState, note?: string | null): void {
    const cur = this.require(id);
    assertTaskTransition(cur.state, to);
    const terminal = to === 'completed' || to === 'failed' || to === 'cancelled';
    this.db.run('UPDATE tasks SET state = ?, updated_at = ?, finished_at = ?, note = COALESCE(?, note) WHERE id = ?', [
      to,
      nowIso(),
      terminal ? nowIso() : null,
      note ?? null,
      id,
    ]);
  }

  setNote(id: string, note: string): void {
    this.db.run('UPDATE tasks SET note = ?, updated_at = ? WHERE id = ?', [note, nowIso(), id]);
  }

  updateStep(
    stepId: string,
    patch: Partial<{
      state: StepState;
      approval: TaskStep['approval'];
      attempts: number;
      result: unknown;
      error: string | null;
      errorCode: string | null;
      verification: Verification;
      verificationDetail: string | null;
      startedAt: string | null;
      finishedAt: string | null;
    }>,
  ): TaskStep {
    const cur = this.stepById(stepId);
    if (!cur) throw new KeoError('not_found', 'Step not found.');
    if (patch.state) assertStepTransition(cur.state, patch.state);
    const next = { ...cur, ...patch };
    this.db.run(
      `UPDATE task_steps SET state = ?, approval = ?, attempts = ?, result = ?, error = ?, error_code = ?, verification = ?,
        verification_detail = ?, started_at = ?, finished_at = ? WHERE id = ?`,
      [
        next.state,
        next.approval ? JSON.stringify(next.approval) : null,
        next.attempts,
        next.result === undefined || next.result === null ? null : JSON.stringify(next.result),
        next.error,
        next.errorCode,
        next.verification,
        next.verificationDetail,
        next.startedAt,
        next.finishedAt,
        stepId,
      ],
    );
    this.db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', [nowIso(), cur.taskId]);
    return this.stepById(stepId) as TaskStep;
  }

  // -- execution receipts (duplicate-execution protection) -------------------

  receipt(key: string): { status: ReceiptStatus; result: unknown } | null {
    const r = this.db.get<{ status: ReceiptStatus; result: string | null }>(
      'SELECT status, result FROM execution_receipts WHERE idempotency_key = ?',
      [key],
    );
    return r ? { status: r.status, result: parseJson<unknown>(r.result, null) } : null;
  }

  /** Records that dispatch is about to happen, atomically with the step entering `running`. */
  beginExecution(step: TaskStep, attempts: number): void {
    this.db.tx(() => {
      this.updateStep(step.id, { state: 'running', attempts, startedAt: nowIso(), error: null, errorCode: null });
      this.db.run(
        `INSERT INTO execution_receipts (idempotency_key, step_id, capability_id, status, started_at) VALUES (?, ?, ?, 'started', ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET status = 'started', started_at = excluded.started_at, finished_at = NULL, result = NULL`,
        [step.idempotencyKey, step.id, step.capabilityId, nowIso()],
      );
    });
  }

  finishReceipt(key: string, status: Exclude<ReceiptStatus, 'started'>, result: unknown): void {
    this.db.run('UPDATE execution_receipts SET status = ?, finished_at = ?, result = ? WHERE idempotency_key = ?', [
      status,
      nowIso(),
      result === undefined ? null : JSON.stringify(result),
      key,
    ]);
  }

  clearReceipt(key: string): void {
    this.db.run('DELETE FROM execution_receipts WHERE idempotency_key = ?', [key]);
  }
}
