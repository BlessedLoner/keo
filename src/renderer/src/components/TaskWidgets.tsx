import { useState } from 'react';
import type { StepState, Task, TaskState, TaskStep } from '@shared/domain';
import { errText, invoke } from '../lib/api';
import { exact, humanize, timeAgo } from '../lib/format';
import { Icon } from './Icon';
import { useUi } from './ui';

export const TASK_TONE: Record<TaskState, string> = {
  proposed: 'violet',
  awaiting_clarification: 'warn',
  awaiting_authorization: 'warn',
  ready: 'info',
  running: 'accent',
  waiting_dependency: 'info',
  cancelling: 'warn',
  completed: 'ok',
  failed: 'danger',
  cancelled: '',
  outcome_uncertain: 'warn',
};

export const STEP_TONE: Record<StepState, string> = {
  pending: '',
  awaiting_authorization: 'warn',
  ready: 'info',
  running: 'accent',
  succeeded: 'ok',
  failed: 'danger',
  denied: 'danger',
  skipped: '',
  cancelled: '',
  outcome_uncertain: 'warn',
};

/** Inline approval: shows exactly what will run and binds the approval to that input's hash. */
export function ApprovalCard({ task, step }: { task: Task; step: TaskStep }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval" role="group" aria-label="Approval required">
      <h4>
        <Icon name="shield" size={16} /> Approval required
        <span className="chip warn" style={{ marginLeft: 'auto' }}>
          {step.capabilityId}
        </span>
      </h4>
      <div>{step.preview.summary}</div>
      <dl>
        {step.preview.target && (
          <>
            <dt>Target</dt>
            <dd>{step.preview.target}</dd>
          </>
        )}
        <dt>Requested by</dt>
        <dd>{task.origin === 'model' ? 'Keo’s model (a proposal — not your instruction)' : task.origin === 'plan' ? 'A proposed plan' : 'You'}</dd>
        {step.preview.dataExport && (
          <>
            <dt>Data leaves PC</dt>
            <dd className="export">{step.preview.dataExport}</dd>
          </>
        )}
        {step.preview.alwaysAskReason && (
          <>
            <dt>Always asks</dt>
            <dd>{step.preview.alwaysAskReason}</dd>
          </>
        )}
      </dl>
      {step.preview.consequences.length > 0 && (
        <ul>
          {step.preview.consequences.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="btn warn" disabled={busy} onClick={() => void act(() => invoke('tasks:approveStep', { stepId: step.id, inputHash: step.inputHash }))}>
          <Icon name="check" size={15} /> Approve once
        </button>
        {step.preview.grantable && (
          <button
            className="btn"
            disabled={busy}
            title="Approve this, and let Keo look around and navigate (no sending, deleting, submitting or paying) in this window for 10 minutes. Revoke any time."
            onClick={() => void act(() => invoke('grants:approveAndGrant', { stepId: step.id, inputHash: step.inputHash, minutes: 10 }))}
          >
            <Icon name="shield" size={15} /> Approve + allow navigation (10 min)
          </button>
        )}
        <button className="btn ghost" disabled={busy} onClick={() => void act(() => invoke('tasks:denyStep', { stepId: step.id }))}>
          <Icon name="x" size={15} /> Deny
        </button>
        <span className="muted small" style={{ marginLeft: 'auto' }} title={step.inputHash}>
          Bound to input #{step.inputHash.slice(0, 8)}
        </span>
      </div>
    </div>
  );
}

export function TaskCard({ task, defaultOpen }: { task: Task; defaultOpen?: boolean }) {
  const ui = useUi();
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [busy, setBusy] = useState(false);
  const done = task.steps.filter((s) => s.state === 'succeeded').length;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const terminal = task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled';
  const approvePlan = async () => {
    const needs = task.steps.filter((s) => s.requiresApproval);
    const ok = await ui.confirm({
      title: `Approve plan “${task.title}”?`,
      body: (
        <div className="stack">
          <div>
            This authorizes {needs.length} step{needs.length === 1 ? '' : 's'} that require approval, exactly as listed. Steps still run one at a time and you can cancel at any point.
          </div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {task.steps.map((s) => (
              <li key={s.id}>
                {s.preview.summary}
                {s.preview.dataExport && <div className="small" style={{ color: '#ffd38a' }}>{s.preview.dataExport}</div>}
              </li>
            ))}
          </ol>
        </div>
      ),
      confirmLabel: 'Approve and run',
    });
    if (!ok) return;
    await act(() => invoke('tasks:approvePlan', { taskId: task.id, inputHashes: Object.fromEntries(task.steps.map((s) => [s.id, s.inputHash])) }));
  };

  return (
    <article className="task" aria-label={task.title}>
      <div className="task-head">
        <button className="btn ghost icon sm" aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'} onClick={() => setOpen(!open)}>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
        </button>
        <div className="title" title={task.title}>
          {task.title}
        </div>
        <span className="muted small">
          {done}/{task.steps.length} steps · {timeAgo(task.createdAt)}
        </span>
        <span className={`chip ${TASK_TONE[task.state]}`}>
          {task.state === 'running' && <span className="spinner" style={{ width: 10, height: 10 }} />}
          {humanize(task.state)}
        </span>
      </div>
      {(open || task.state === 'proposed' || task.state === 'outcome_uncertain' || task.state === 'awaiting_authorization') && (
        <div className="task-body">
          {task.rationale && <div className="muted small">{task.rationale}</div>}
          {task.state === 'proposed' && (
            <div className="banner info">
              <Icon name="info" size={16} />
              <div className="grow">This plan was proposed and has not run. Review each step below.</div>
              <button className="btn primary sm" disabled={busy} onClick={() => void approvePlan()}>
                Review & approve
              </button>
              <button className="btn sm" disabled={busy} onClick={() => void act(() => invoke('tasks:cancel', { id: task.id }))}>
                Reject
              </button>
            </div>
          )}
          {task.steps.map((s) => (
            <StepRow key={s.id} task={task} step={s} />
          ))}
          <div className="row small muted">
            <span>Origin: {task.origin}</span>
            <span>Created {exact(task.createdAt)}</span>
            {task.finishedAt && <span>Finished {exact(task.finishedAt)}</span>}
            <span className="mono" title="Correlation id">
              {task.correlationId}
            </span>
            {task.state === 'completed' && task.steps.length > 0 && (
              <button
                className="btn ghost sm"
                style={{ marginLeft: 'auto' }}
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const name = window.prompt('Name this workflow (you can ask Keo to run it again later):', task.title.slice(0, 60));
                    if (name?.trim()) await invoke('workflows:saveFromTask', { taskId: task.id, name: name.trim() });
                  })
                }
              >
                Save as workflow
              </button>
            )}
            {!terminal && task.state !== 'cancelling' && (
              <button className="btn danger sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void act(() => invoke('tasks:cancel', { id: task.id }))}>
                Cancel task
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function StepRow({ task, step }: { task: Task; step: TaskStep }) {
  const ui = useUi();
  const [showIo, setShowIo] = useState(false);
  const reconcile = async (resolution: 'mark_succeeded' | 'mark_failed' | 'retry') => {
    if (resolution !== 'mark_failed') {
      const ok = await ui.confirm({
        title: resolution === 'retry' ? 'Run this step again?' : 'Mark as completed?',
        body:
          resolution === 'retry'
            ? 'If the earlier attempt actually took effect, running it again may repeat the action (for example, typing text twice). Retrying requires a new approval.'
            : 'Only do this if you checked that the action really happened.',
        confirmLabel: resolution === 'retry' ? 'Retry' : 'Mark completed',
        danger: resolution === 'retry',
      });
      if (!ok) return;
    }
    await invoke('tasks:reconcileStep', { stepId: step.id, resolution }).catch((e) => ui.error(errText(e)));
  };
  return (
    <div className="step">
      <span className="step-idx">{step.index + 1}</span>
      <div style={{ minWidth: 0 }}>
        <div>{step.preview.summary}</div>
        <div className="muted small mono">
          {step.capabilityId}@{step.capabilityVersion}
          {step.attempts > 0 && ` · attempt ${step.attempts}/${step.maxAttempts}`}
          {step.dependsOn.length > 0 && ` · after step ${step.dependsOn.map((d) => (task.steps.find((x) => x.id === d)?.index ?? 0) + 1).join(', ')}`}
        </div>
        {step.preview.dataExport && <div className="small" style={{ color: '#ffd38a' }}>{step.preview.dataExport}</div>}
        {step.error && <div className="err">{step.error}</div>}
        {step.state === 'succeeded' && (
          <div className="small" style={{ color: step.verification === 'verified' ? 'var(--ok)' : 'var(--text-2)' }}>
            {step.verification === 'verified' ? '✓ Verified' : step.verification === 'unverified' ? 'Completed — not independently verified' : 'Completed'}
            {step.verificationDetail ? `: ${step.verificationDetail}` : ''}
          </div>
        )}
        {step.state === 'awaiting_authorization' && <ApprovalCard task={task} step={step} />}
        {step.state === 'outcome_uncertain' && (
          <div className="row wrap" style={{ marginTop: 6 }}>
            <span className="small">Check whether this happened, then:</span>
            <button className="btn sm" onClick={() => void reconcile('mark_succeeded')}>
              It happened
            </button>
            <button className="btn sm" onClick={() => void reconcile('mark_failed')}>
              It did not happen
            </button>
            <button className="btn sm danger" onClick={() => void reconcile('retry')}>
              Retry…
            </button>
          </div>
        )}
        {step.state === 'failed' && task.state !== 'completed' && task.state !== 'cancelled' && (
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => void reconcile('retry')}>
            <Icon name="retry" size={13} /> Retry step…
          </button>
        )}
        <button className="btn ghost sm" style={{ marginTop: 4, paddingLeft: 0 }} onClick={() => setShowIo(!showIo)} aria-expanded={showIo}>
          {showIo ? 'Hide' : 'Show'} input & result
        </button>
        {showIo && (
          <>
            <pre>{JSON.stringify(step.input, null, 2)}</pre>
            {step.result != null && <pre>{JSON.stringify(step.result, null, 2)}</pre>}
          </>
        )}
      </div>
      <span className={`chip ${STEP_TONE[step.state]}`}>
        {step.state === 'running' && <span className="spinner" style={{ width: 10, height: 10 }} />}
        {humanize(step.state)}
      </span>
    </div>
  );
}
