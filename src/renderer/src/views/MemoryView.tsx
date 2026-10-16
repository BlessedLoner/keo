import { useState } from 'react';
import type { MemoryItem, MemoryKind, MemoryRevision } from '@shared/domain';
import { Icon } from '../components/Icon';
import { Empty, ErrorBanner, ViewHeader, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { exact, timeAgo } from '../lib/format';
import { useInvoke } from '../lib/hooks';
import { useApp } from '../state/AppState';

type Tab = 'confirmed' | 'proposed' | 'superseded' | 'rejected';

const PROVENANCE: Record<MemoryItem['provenance'], string> = {
  user_authored: 'Written by you',
  user_confirmed: 'Proposed by Keo · confirmed by you',
  model_inferred: 'Inferred by Keo · not confirmed',
};

export function MemoryView() {
  const ui = useUi();
  const app = useApp();
  const [tab, setTab] = useState<Tab>('confirmed');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const list = useInvoke('memory:list', { status: tab, query: query || undefined }, { refreshOn: ['memory:changed'] });
  const conflicts = (list.data ?? []).filter((m) => m.conflictsWith.length > 0).length;

  return (
    <div className="view">
      <ViewHeader title="Memory" subtitle="What Keo is allowed to treat as known about you. Only confirmed items are used as context; each one shows where it came from.">
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> Add memory
        </button>
      </ViewHeader>
      <div className="view-body narrow">
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <div className="tabs" role="tablist" aria-label="Memory status">
            {(['confirmed', 'proposed', 'superseded', 'rejected'] as Tab[]).map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
                {t[0]!.toUpperCase() + t.slice(1)}
                {t === 'proposed' && app.proposedMemories > 0 && <span className="badge info">{app.proposedMemories}</span>}
              </button>
            ))}
          </div>
          <input className="input" style={{ maxWidth: 300 }} placeholder="Search memory" aria-label="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {adding && <AddMemory onDone={() => setAdding(false)} />}
        <ErrorBanner error={list.error} onRetry={() => void list.refresh()} />
        {tab === 'confirmed' && conflicts > 0 && (
          <div className="banner warn" style={{ marginBottom: 12 }}>
            <Icon name="warn" size={16} />
            <div className="grow">{conflicts} memories share a subject with another confirmed memory. Keo reports these as conflicts instead of choosing one. Resolve them below.</div>
          </div>
        )}
        {list.data && list.data.length === 0 && (
          <Empty icon="memory" title={tab === 'proposed' ? 'No proposals waiting' : 'Nothing here yet'}>
            {tab === 'confirmed'
              ? 'Add something yourself, use “Remember” on one of your messages, or confirm a proposal from Keo.'
              : tab === 'proposed'
                ? 'When Keo thinks something is worth remembering it will appear here for you to accept or reject.'
                : null}
          </Empty>
        )}
        {(list.data ?? []).map((m) => (
          <MemoryCard key={m.id} m={m} all={list.data ?? []} onError={ui.error} />
        ))}
      </div>
    </div>
  );
}

function AddMemory({ onDone }: { onDone: () => void }) {
  const ui = useUi();
  const [kind, setKind] = useState<MemoryKind>('fact');
  const [subject, setSubject] = useState('');
  const [content, setContent] = useState('');
  const save = async () => {
    try {
      await invoke('memory:create', { kind, subject: subject.trim() || null, content });
      ui.toast('Memory saved', 'success');
      onDone();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <h3>New memory (written by you)</h3>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="mem-kind">Kind</label>
          <select id="mem-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as MemoryKind)}>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="instruction">Standing instruction</option>
            <option value="person">Person</option>
            <option value="context">Context</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="mem-subject">Subject key (optional)</label>
          <input id="mem-subject" className="input" placeholder="e.g. user.timezone" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <span className="hint">Memories with the same subject are flagged as conflicting.</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="mem-content">Content</label>
        <textarea id="mem-content" className="textarea" value={content} maxLength={2000} onChange={(e) => setContent(e.target.value)} />
        <span className="hint">Don’t store passwords or secrets — Keo will refuse them.</span>
      </div>
      <div className="row">
        <button className="btn primary" disabled={!content.trim()} onClick={() => void save()}>
          Save
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function MemoryCard({ m, all, onError }: { m: MemoryItem; all: MemoryItem[]; onError: (s: string) => void }) {
  const ui = useUi();
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [revisions, setRevisions] = useState<MemoryRevision[] | null>(null);
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => ok && ui.toast(ok, 'success'), (e) => onError(errText(e)));
  const conflictItems = m.conflictsWith.map((id) => all.find((x) => x.id === id)).filter(Boolean) as MemoryItem[];

  return (
    <article className={`mem ${m.status}`}>
      {editing ? (
        <div className="stack">
          <textarea className="textarea" aria-label="Edit memory" value={draft} maxLength={2000} onChange={(e) => setDraft(e.target.value)} />
          <div className="row">
            <button
              className="btn primary sm"
              onClick={() =>
                void run(invoke('memory:update', { id: m.id, content: draft }), 'Memory updated').then(() => {
                  setEditing(false);
                })
              }
            >
              Save
            </button>
            <button className="btn ghost sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="content">{m.content}</div>
      )}
      <div className="prov">
        <span className="chip">{m.kind}</span>
        {m.subject && <span className="chip mono">{m.subject}</span>}
        <span className={`chip ${m.provenance === 'model_inferred' ? 'violet' : 'ok'}`}>{PROVENANCE[m.provenance]}</span>
        <span title={exact(m.createdAt)}>created {timeAgo(m.createdAt)}</span>
        {m.confirmedAt && <span title={exact(m.confirmedAt)}>confirmed {timeAgo(m.confirmedAt)}</span>}
        {m.version > 1 && (
          <button className="btn ghost sm" onClick={() => void invoke('memory:revisions', { id: m.id }).then(setRevisions, (e) => onError(errText(e)))}>
            v{m.version} · history
          </button>
        )}
        {m.sourceConversationId && (
          <button
            className="btn ghost sm"
            onClick={() => {
              app.setConversationId(m.sourceConversationId);
              app.setView('chat');
            }}
          >
            <Icon name="link" size={13} /> Source conversation
          </button>
        )}
      </div>
      {m.sourceExcerpt && <div className="excerpt">Evidence: “{m.sourceExcerpt}”</div>}
      {revisions && (
        <div className="small muted">
          {revisions.map((r) => (
            <div key={r.id}>
              v{r.version} ({exact(r.changedAt)}): {r.content}
            </div>
          ))}
        </div>
      )}
      {conflictItems.length > 0 && (
        <div className="banner warn small">
          <Icon name="warn" size={15} />
          <div className="grow">
            Conflicts with: {conflictItems.map((c) => `“${c.content.slice(0, 80)}”`).join(', ')}
          </div>
          <button className="btn sm" onClick={() => void run(Promise.all(conflictItems.map((c) => invoke('memory:supersede', { keepId: m.id, supersededId: c.id }))), 'Conflict resolved')}>
            Keep this one
          </button>
        </div>
      )}
      <div className="row">
        {m.status === 'proposed' && (
          <>
            <button className="btn primary sm" onClick={() => void run(invoke('memory:confirm', { id: m.id }), 'Memory confirmed')}>
              <Icon name="check" size={14} /> Confirm
            </button>
            <button className="btn sm" onClick={() => void run(invoke('memory:reject', { id: m.id }))}>
              Reject
            </button>
          </>
        )}
        {!editing && m.status !== 'superseded' && m.status !== 'rejected' && (
          <button className="btn ghost sm" onClick={() => setEditing(true)}>
            <Icon name="edit" size={13} /> Correct
          </button>
        )}
        <button
          className="btn ghost sm"
          style={{ marginLeft: 'auto' }}
          onClick={async () => {
            if (await ui.confirm({ title: 'Delete this memory?', body: 'It is permanently removed, including its revision history.', confirmLabel: 'Delete', danger: true })) {
              void run(invoke('memory:delete', { id: m.id }), 'Memory deleted');
            }
          }}
        >
          <Icon name="trash" size={13} /> Delete
        </button>
      </div>
    </article>
  );
}
