import { useEffect, useState } from 'react';
import type { Project, ProjectItem, ProjectItemType } from '@shared/domain';
import { Icon } from '../components/Icon';
import { Empty, ErrorBanner, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { humanize, timeAgo } from '../lib/format';
import { useInvoke } from '../lib/hooks';
import { useApp } from '../state/AppState';

const TYPES: ProjectItemType[] = ['objective', 'decision', 'blocker', 'question', 'progress'];
const TYPE_LABEL: Record<ProjectItemType, string> = { objective: 'Objectives', decision: 'Decisions', blocker: 'Blockers', question: 'Open questions', progress: 'Progress' };

export function ProjectsView() {
  const ui = useUi();
  const projects = useInvoke('projects:list', {}, { refreshOn: ['projects:changed'] });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (!selected && projects.data?.length) setSelected(projects.data[0]!.id);
  }, [projects.data, selected]);
  const create = async () => {
    const name = await ui.prompt({ title: 'New project', label: 'Project name', confirmLabel: 'Create' });
    if (!name) return;
    try {
      const p = await invoke('projects:create', { name, description: '' });
      setSelected(p.id);
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const current = projects.data?.find((p) => p.id === selected) ?? null;
  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h1>Projects</h1>
          <p>Goals Keo keeps track of: objectives, decisions, blockers, open questions and progress — each marked with who stated it.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => void create()}>
            <Icon name="plus" size={15} /> New project
          </button>
        </div>
      </header>
      <ErrorBanner error={projects.error} onRetry={() => void projects.refresh()} />
      {projects.data && projects.data.length === 0 ? (
        <Empty icon="projects" title="No projects yet">
          Create a project, then link conversations to it from the chat header so Keo keeps its context in mind.
        </Empty>
      ) : (
        <div className="split">
          <div className="list" role="list">
            {(projects.data ?? []).map((p) => (
              <button key={p.id} role="listitem" className="list-item" aria-current={p.id === selected} onClick={() => setSelected(p.id)}>
                <strong style={{ fontWeight: 600 }}>{p.name}</strong>
                <span className="small muted">
                  {p.status} · {p.openItemCount} open · {timeAgo(p.updatedAt)}
                </span>
              </button>
            ))}
          </div>
          <div className="detail">{current && <ProjectDetail key={current.id} project={current} onDeleted={() => setSelected(null)} />}</div>
        </div>
      )}
    </div>
  );
}

/** The project's workspace folder: Keo reads files there, edits them with your approval, and runs its scripts with your approval. */
function WorkspaceCard({ projectId }: { projectId: string }) {
  const ui = useUi();
  const app = useApp();
  const folder = app.settings.data?.projectWorkspaces[projectId] ?? null;
  const [scripts, setScripts] = useState<string[] | null>(null);
  const choose = async () => {
    try {
      const r = await invoke('projects:pickWorkspace', { projectId });
      if (r.path) setScripts(r.scripts);
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <section className="card" aria-label="Workspace folder">
      <div className="row">
        <h3 style={{ margin: 0, fontSize: 14 }}>Workspace folder</h3>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => void choose()}>
          <Icon name="folder" size={13} /> {folder ? 'Change…' : 'Choose…'}
        </button>
        {folder && (
          <button className="btn ghost sm" onClick={() => void invoke('projects:clearWorkspace', { projectId }).catch((e) => ui.error(errText(e)))}>
            Remove
          </button>
        )}
      </div>
      {folder ? (
        <p className="small" style={{ marginBottom: 0 }}>
          <span className="mono">{folder}</span>
          <br />
          <span className="muted">
            Keo can list and read files here. Every edit shows a diff and needs your OK (a backup is kept in .keo-backups); running a script{scripts && scripts.length ? ` (${scripts.join(', ')})` : ''} needs a click each time.
          </span>
        </p>
      ) : (
        <p className="muted small" style={{ marginBottom: 0 }}>Choose a folder to let Keo work on this project’s files (code, websites, documents). Keo never touches files outside it.</p>
      )}
    </section>
  );
}

function ProjectDetail({ project, onDeleted }: { project: Project; onDeleted: () => void }) {
  const ui = useUi();
  const app = useApp();
  const items = useInvoke('projects:items', { projectId: project.id }, { refreshOn: ['projects:changed'] });
  const convs = useInvoke('conversations:list', { projectId: project.id }, { refreshOn: ['conversations:changed'] });
  const [desc, setDesc] = useState(project.description);
  const [newType, setNewType] = useState<ProjectItemType>('objective');
  const [newText, setNewText] = useState('');
  const run = (p: Promise<unknown>) => p.catch((e) => ui.error(errText(e)));

  const add = async () => {
    if (!newText.trim()) return;
    await run(invoke('projects:addItem', { projectId: project.id, type: newType, content: newText }));
    setNewText('');
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row">
        <h2 style={{ margin: 0, fontSize: 18 }}>{project.name}</h2>
        <select className="select" style={{ width: 130 }} aria-label="Project status" value={project.status} onChange={(e) => void run(invoke('projects:update', { id: project.id, status: e.target.value as Project['status'] }))}>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="done">Done</option>
          <option value="archived">Archived</option>
        </select>
        <div style={{ flex: 1 }} />
        <button
          className="btn ghost sm"
          onClick={async () => {
            const n = await ui.prompt({ title: 'Rename project', label: 'Name', initial: project.name });
            if (n) await run(invoke('projects:update', { id: project.id, name: n }));
          }}
        >
          <Icon name="edit" size={13} /> Rename
        </button>
        <button
          className="btn danger sm"
          onClick={async () => {
            if (await ui.confirm({ title: `Delete “${project.name}”?`, body: 'Its items are deleted. Linked conversations are kept but unlinked.', confirmLabel: 'Delete', danger: true })) {
              await run(invoke('projects:delete', { id: project.id }));
              onDeleted();
            }
          }}
        >
          Delete
        </button>
      </div>
      <WorkspaceCard projectId={project.id} />
      <div className="field">
        <label htmlFor="proj-desc">Description</label>
        <textarea id="proj-desc" className="textarea" value={desc} maxLength={2000} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== project.description && void run(invoke('projects:update', { id: project.id, description: desc }))} />
      </div>
      <div className="card">
        <div className="row">
          <select className="select" style={{ width: 150 }} aria-label="Item type" value={newType} onChange={(e) => setNewType(e.target.value as ProjectItemType)}>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {humanize(t)}
              </option>
            ))}
          </select>
          <input className="input" placeholder="Add an item…" aria-label="New item" value={newText} onChange={(e) => setNewText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
          <button className="btn primary" onClick={() => void add()} disabled={!newText.trim()}>
            Add
          </button>
        </div>
      </div>
      <ErrorBanner error={items.error} />
      {TYPES.map((t) => {
        const list = (items.data ?? []).filter((i) => i.type === t);
        if (!list.length) return null;
        return (
          <section key={t}>
            <div className="section-title">{TYPE_LABEL[t]}</div>
            {list.map((i) => (
              <ItemRow key={i.id} item={i} />
            ))}
          </section>
        );
      })}
      {items.data && items.data.length === 0 && <p className="muted">No items yet.</p>}
      <section>
        <div className="section-title">Linked conversations</div>
        {(convs.data ?? []).length === 0 ? (
          <p className="muted small">None. Link a conversation from its header in Chat.</p>
        ) : (
          (convs.data ?? []).map((c) => (
            <button
              key={c.id}
              className="list-item"
              onClick={() => {
                app.setConversationId(c.id);
                app.setView('chat');
              }}
            >
              {c.title} <span className="small muted">{timeAgo(c.updatedAt)}</span>
            </button>
          ))
        )}
      </section>
    </div>
  );
}

function ItemRow({ item }: { item: ProjectItem }) {
  const ui = useUi();
  const run = (p: Promise<unknown>) => p.catch((e) => ui.error(errText(e)));
  return (
    <div className={`mem ${item.status === 'proposed' ? 'proposed' : item.status === 'rejected' ? 'rejected' : ''}`} style={{ marginBottom: 8 }}>
      <div className="row">
        <div className="content" style={{ flex: 1, textDecoration: item.status === 'resolved' ? 'line-through' : undefined }}>
          {item.content}
        </div>
        <span className={`chip ${item.status === 'proposed' ? 'violet' : item.status === 'open' ? 'info' : ''}`}>{item.status}</span>
      </div>
      <div className="prov">
        <span>{item.provenance === 'model_inferred' ? 'Proposed by Keo' : item.provenance === 'user_confirmed' ? 'Proposed by Keo · accepted by you' : 'Added by you'}</span>
        <span>{timeAgo(item.createdAt)}</span>
        <span style={{ flex: 1 }} />
        {item.status === 'proposed' && (
          <>
            <button className="btn primary sm" onClick={() => void run(invoke('projects:setItemStatus', { id: item.id, status: 'open' }))}>
              Accept
            </button>
            <button className="btn sm" onClick={() => void run(invoke('projects:setItemStatus', { id: item.id, status: 'rejected' }))}>
              Reject
            </button>
          </>
        )}
        {item.status === 'open' && (
          <button className="btn sm" onClick={() => void run(invoke('projects:setItemStatus', { id: item.id, status: 'resolved' }))}>
            <Icon name="check" size={13} /> Resolve
          </button>
        )}
        {item.status === 'resolved' && (
          <button className="btn ghost sm" onClick={() => void run(invoke('projects:setItemStatus', { id: item.id, status: 'open' }))}>
            Reopen
          </button>
        )}
        <button className="btn ghost icon sm" aria-label="Delete item" onClick={() => void run(invoke('projects:deleteItem', { id: item.id }))}>
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  );
}
