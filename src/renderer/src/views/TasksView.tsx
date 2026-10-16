import { useState } from 'react';
import type { LiveChatSession, Task } from '@shared/domain';
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

const LIVE_LABEL: Record<LiveChatSession['status'], string> = { starting: 'Starting', active: 'Chatting', waiting_user: 'Needs your answer', paused: 'Paused', ended: 'Ended' };

function LiveChatCard({ s }: { s: LiveChatSession }) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(s.status === 'waiting_user');
  const live = s.status !== 'ended';
  const send = async () => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await invoke('livechat:answer', { id: s.id, text: answer.trim() });
      setAnswer('');
    } finally {
      setBusy(false);
    }
  };
  const chip = s.status === 'waiting_user' ? 'warn' : s.status === 'active' ? 'ok' : s.status === 'paused' ? 'warn' : '';
  return (
    <div className={`card livechat ${s.status}`}>
      <div className="row">
        <Icon name="chat" size={16} />
        <strong className="grow">Live chat with {s.contact}</strong>
        <span className={`chip ${chip}`}>{LIVE_LABEL[s.status]}</span>
        <span className="muted small">
          {s.replies}/{s.maxReplies} replies{live ? ` · until ${new Date(s.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </span>
      </div>
      <div className="muted small" style={{ marginTop: 4 }}>
        Goal: {s.goal}
        {s.activity && live ? ` · ${s.activity}` : ''}
        {!live && s.endedReason ? ` · ${s.endedReason}` : ''}
      </div>
      {s.question && (
        <div className="banner warn small" style={{ marginTop: 8 }}>
          {s.question}
        </div>
      )}
      {live && (s.status === 'waiting_user' || s.status === 'paused' || s.status === 'active') && (
        <div className="row" style={{ marginTop: 8 }}>
          <input
            className="input grow"
            placeholder={s.status === 'waiting_user' ? 'Your answer, e.g. “tell her it’s $50 each, I can give a discount”' : 'An instruction for this chat (optional)'}
            value={answer}
            maxLength={1500}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void send()}
          />
          <button className="btn sm primary" disabled={busy || !answer.trim()} onClick={() => void send()}>
            Send to Keo
          </button>
        </div>
      )}
      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide conversation' : 'Show conversation'}
        </button>
        <span className="grow" />
        {s.status === 'active' && (
          <button className="btn sm" onClick={() => void invoke('livechat:pause', { id: s.id })}>
            Pause
          </button>
        )}
        {s.status === 'paused' && (
          <button className="btn sm" onClick={() => void invoke('livechat:resume', { id: s.id })}>
            Resume
          </button>
        )}
        {live && (
          <button className="btn sm danger" onClick={() => void invoke('livechat:stop', { id: s.id })}>
            Stop
          </button>
        )}
      </div>
      {open && (
        <div className="livechat-transcript">
          {s.transcript.slice(-20).map((l, k) => (
            <div key={k} className={`lc-line ${l.from}`}>
              <span className="lc-who">{l.from === 'them' ? s.contact : l.from === 'keo' ? 'Keo (for you)' : l.from === 'you' ? 'You' : ''}</span>
              <span className="lc-text">{l.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LiveChats() {
  const q = useInvoke('livechat:list', {}, { refreshOn: ['livechat:changed'], pollMs: 15000 });
  const list = q.data ?? [];
  if (!list.length) return null;
  const running = list.filter((s) => s.status !== 'ended');
  const ended = list.filter((s) => s.status === 'ended').slice(0, 3);
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="row" style={{ marginBottom: 6 }}>
        <h3 className="grow" style={{ margin: 0 }}>
          Live chats
        </h3>
        {running.length > 1 && (
          <button className="btn sm danger" onClick={() => void invoke('livechat:stop', {})}>
            Stop all
          </button>
        )}
      </div>
      {[...running, ...ended].map((s) => (
        <LiveChatCard key={s.id} s={s} />
      ))}
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
        <LiveChats />
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
