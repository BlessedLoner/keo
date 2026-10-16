import { useState } from 'react';
import type { Task } from '@shared/domain';
import { TaskCard } from '../components/TaskWidgets';
import { Empty, ErrorBanner, ViewHeader } from '../components/ui';
import { useApp } from '../state/AppState';
import { Icon } from '../components/Icon';
import { invoke } from '../lib/api';
import { useInvoke } from '../lib/hooks';

/** Active navigation permissions, with revoke controls. */
function GrantsBanner() {
  const grants = useInvoke('grants:list', {}, { refreshOn: ['grants:changed'], pollMs: 30000 });
  const list = grants.data ?? [];
  if (!list.length) return null;
  return (
    <div className="banner warn" style={{ marginBottom: 12 }}>
      <Icon name="shield" size={16} />
      <div className="grow">
        {list.map((g) => (
          <div key={g.id} className="row" style={{ gap: 8 }}>
            <span>
              Keo may navigate in <strong>{g.target.processName}</strong> without asking — until {new Date(g.expiresAt).toLocaleTimeString()} ({g.used}/{g.maxActions} actions used). Sending, deleting, submitting and paying still ask.
            </span>
            <button className="btn sm" onClick={() => void invoke('grants:revoke', { id: g.id })}>
              Revoke
            </button>
          </div>
        ))}
      </div>
      {list.length > 1 && (
        <button className="btn sm danger" onClick={() => void invoke('grants:revokeAll')}>
          Revoke all
        </button>
      )}
    </div>
  );
}

type Filter = 'attention' | 'active' | 'done' | 'all';

const ATTENTION = new Set(['proposed', 'awaiting_authorization', 'awaiting_clarification', 'outcome_uncertain']);
const ACTIVE = new Set(['ready', 'running', 'waiting_dependency', 'cancelling']);

export function TasksView() {
  const app = useApp();
  const [filter, setFilter] = useState<Filter>('attention');
  const tasks = app.tasks.data ?? [];
  const pick = (f: Filter) => (t: Task) =>
    f === 'all' ? true : f === 'attention' ? ATTENTION.has(t.state) : f === 'active' ? ACTIVE.has(t.state) : !ATTENTION.has(t.state) && !ACTIVE.has(t.state);
  const shown = tasks.filter(pick(filter));
  const count = (f: Filter) => tasks.filter(pick(f)).length;

  return (
    <div className="view">
      <ViewHeader title="Task Activity" subtitle="Every action Keo takes on your computer runs here as a task with an explicit state. Nothing consequential runs without your approval.">
        <div className="tabs" role="tablist" aria-label="Task filter">
          {(
            [
              ['attention', 'Needs you'],
              ['active', 'Active'],
              ['done', 'Finished'],
              ['all', 'All'],
            ] as Array<[Filter, string]>
          ).map(([f, l]) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {l} <span className="muted">{count(f)}</span>
            </button>
          ))}
        </div>
      </ViewHeader>
      <div className="view-body">
        <ErrorBanner error={app.tasks.error} onRetry={() => void app.tasks.refresh()} />
        <GrantsBanner />
        {shown.length === 0 ? (
          <Empty icon="tasks" title={filter === 'attention' ? 'Nothing needs your attention' : 'No tasks here'}>
            {filter === 'attention'
              ? 'Approvals, proposed plans and actions with uncertain outcomes will appear here.'
              : 'Tasks are created when Keo proposes an action or a plan in conversation.'}
          </Empty>
        ) : (
          shown.map((t) => <TaskCard key={t.id} task={t} defaultOpen={ATTENTION.has(t.state)} />)
        )}
      </div>
    </div>
  );
}
