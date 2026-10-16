import type { StepState, TaskState, TaskStep } from '../../shared/domain';
import { KeoError } from '../util/errors';

/**
 * Explicit, validated lifecycles for tasks and steps.
 *
 * Step lifecycle
 *   pending ─► awaiting_authorization ─► ready ─► running ─► succeeded
 *                     │                   │         ├─► failed
 *                     └─► denied          │         ├─► ready            (bounded retry; safe, non-consequential only)
 *                                         │         ├─► outcome_uncertain (consequential action interrupted / timed out)
 *                                         │         └─► cancelled        (only when known not dispatched)
 *   any non-terminal ─► cancelled | skipped (dependency did not succeed)
 *   outcome_uncertain ─► succeeded | failed      (user reconciliation)
 *   outcome_uncertain | failed ─► awaiting_authorization | ready   (explicit user retry)
 *
 * Task state is *derived* from its steps (see deriveTaskState) and every
 * change is checked against TASK_TRANSITIONS.
 */
export const STEP_TRANSITIONS: Record<StepState, readonly StepState[]> = {
  pending: ['awaiting_authorization', 'ready', 'cancelled', 'skipped'],
  awaiting_authorization: ['ready', 'denied', 'cancelled', 'skipped'],
  ready: ['running', 'cancelled', 'skipped', 'awaiting_authorization'],
  running: ['succeeded', 'failed', 'ready', 'outcome_uncertain', 'cancelled'],
  outcome_uncertain: ['succeeded', 'failed', 'awaiting_authorization', 'ready', 'cancelled'],
  failed: ['awaiting_authorization', 'ready'],
  succeeded: [],
  denied: [],
  skipped: [],
  cancelled: [],
};

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  proposed: ['awaiting_clarification', 'awaiting_authorization', 'ready', 'running', 'waiting_dependency', 'cancelled', 'cancelling', 'failed', 'completed'],
  awaiting_clarification: ['proposed', 'awaiting_authorization', 'ready', 'cancelled', 'cancelling'],
  awaiting_authorization: ['ready', 'running', 'waiting_dependency', 'cancelling', 'cancelled', 'completed', 'failed', 'outcome_uncertain'],
  ready: ['running', 'awaiting_authorization', 'waiting_dependency', 'cancelling', 'cancelled', 'completed', 'failed', 'outcome_uncertain'],
  running: ['ready', 'awaiting_authorization', 'waiting_dependency', 'cancelling', 'completed', 'failed', 'cancelled', 'outcome_uncertain'],
  waiting_dependency: ['ready', 'running', 'awaiting_authorization', 'cancelling', 'cancelled', 'completed', 'failed', 'outcome_uncertain'],
  cancelling: ['cancelled', 'outcome_uncertain'],
  outcome_uncertain: ['completed', 'failed', 'ready', 'running', 'awaiting_authorization', 'waiting_dependency', 'cancelling', 'cancelled'],
  failed: ['ready', 'running', 'awaiting_authorization', 'waiting_dependency'],
  completed: [],
  cancelled: [],
};

export const TERMINAL_STEP: ReadonlySet<StepState> = new Set(['succeeded', 'failed', 'denied', 'skipped', 'cancelled']);
export const TERMINAL_TASK: ReadonlySet<TaskState> = new Set(['completed', 'failed', 'cancelled']);

export function assertStepTransition(from: StepState, to: StepState): void {
  if (from === to) return;
  if (!STEP_TRANSITIONS[from].includes(to)) {
    throw new KeoError('invalid_transition', `Step cannot move from ${from} to ${to}.`);
  }
}

export function assertTaskTransition(from: TaskState, to: TaskState): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new KeoError('invalid_transition', `Task cannot move from ${from} to ${to}.`);
  }
}

/** Computes the task state implied by its steps. */
export function deriveTaskState(current: TaskState, steps: Pick<TaskStep, 'state'>[]): TaskState {
  const has = (s: StepState) => steps.some((x) => x.state === s);
  if (current === 'cancelling') {
    if (has('running')) return 'cancelling';
    return has('outcome_uncertain') ? 'outcome_uncertain' : 'cancelled';
  }
  if (current === 'proposed' && steps.every((s) => s.state === 'pending')) return 'proposed';
  if (has('running')) return 'running';
  if (has('outcome_uncertain')) return 'outcome_uncertain';
  if (has('awaiting_authorization')) return 'awaiting_authorization';
  if (has('ready')) return 'ready';
  if (has('pending')) return 'waiting_dependency';
  // All steps terminal.
  if (steps.length === 0) return 'cancelled';
  if (has('failed')) return 'failed';
  if (steps.every((s) => s.state === 'succeeded')) return 'completed';
  if (has('denied') || has('cancelled')) return 'cancelled';
  return 'failed';
}
