import { useState } from 'react';
import type { ProjectSummary } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useFilmstrip } from './thumbs';

/** Your Studio projects: a thumbnail, name, length and when it was last changed; open, rename, copy or delete. */
export function ProjectGrid({ projects, current, onOpen, onChanged }: { projects: ProjectSummary[]; current: string | null; onOpen: (id: string) => void; onChanged: () => void | Promise<void> }) {
  if (!projects.length) return null;
  return (
    <div className="project-grid-wrap">
      <h3>Your projects</h3>
      <div className="project-grid">
        {projects.map((p) => (
          <ProjectTile key={p.id} p={p} current={p.id === current} onOpen={() => onOpen(p.id)} onChanged={onChanged} onOpenId={onOpen} />
        ))}
      </div>
    </div>
  );
}

const ago = (iso: string) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
};
const len = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);

function ProjectTile({ p, current, onOpen, onChanged, onOpenId }: { p: ProjectSummary; current: boolean; onOpen: () => void; onChanged: () => void | Promise<void>; onOpenId: (id: string) => void }) {
  const ui = useUi();
  const strip = useFilmstrip(p.id, p.cover ?? undefined);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const act = async (f: () => Promise<unknown>) => {
    try {
      await f();
      onChanged();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const rename = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== p.name) void act(() => invoke('studio:edit', { id: p.id, ops: [{ op: 'set_project', name: name.trim() }] }));
  };
  return (
    <div className={`project-tile ${current ? 'current' : ''}`}>
      <button className="project-thumb" style={{ aspectRatio: `${p.width} / ${p.height}` }} onClick={onOpen} title={`Open “${p.name}”`}>
        {strip?.frames[0] ? <img src={strip.frames[0]} alt="" /> : <Icon name="film" size={22} />}
        {p.duration > 0 && <span className="tile-dur">{len(p.duration)}</span>}
      </button>
      {renaming ? (
        <input className="input project-name-edit" value={name} autoFocus maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => (e.key === 'Enter' ? rename() : e.key === 'Escape' && setRenaming(false))} />
      ) : (
        <button className="project-name" onDoubleClick={() => setRenaming(true)} onClick={onOpen} title="Double-click to rename">
          {p.name}
        </button>
      )}
      <div className="project-meta">
        <span className="small muted">
          {p.width}×{p.height} · {ago(p.updatedAt)}
        </span>
        <span className="project-actions">
          <button className="btn icon sm ghost" title="Rename" onClick={() => setRenaming(true)}>
            <Icon name="text" size={12} />
          </button>
          <button
            className="btn icon sm ghost"
            title="Use as a template: pick your clips, and Keo makes the same edit with them"
            disabled={!p.cover}
            onClick={() =>
              void (async () => {
                try {
                  const r = await invoke('studio:useTemplate', { id: p.id });
                  if (!r) return;
                  ui.toast(`Made “${r.project.name}”: ${r.filled} of ${r.slots} slots filled with your clips.`, 'success');
                  await onChanged();
                  onOpenId(r.project.id);
                } catch (e) {
                  ui.error(errText(e));
                }
              })()
            }
          >
            <Icon name="film" size={12} />
          </button>
          <button className="btn icon sm ghost" title="Make a copy" onClick={() => void act(() => invoke('studio:duplicate', { id: p.id }))}>
            <Icon name="plus" size={12} />
          </button>
          <button
            className="btn icon sm ghost"
            title="Delete"
            onClick={() =>
              void (async () => {
                const ok = await ui.confirm({ title: 'Delete this project?', body: `“${p.name}” and its timeline are deleted. Your media files and exported videos stay where they are.`, confirmLabel: 'Delete', danger: true });
                if (ok) await act(() => invoke('studio:delete', { id: p.id }));
              })()
            }
          >
            <Icon name="trash" size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}
