import { useEffect, useState } from 'react';
import type { Series } from '@shared/studioSeries';
import type { ProjectSummary } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useFilmstrip } from './thumbs';

/** Your Studio projects: a thumbnail, name, length and when it was last changed; open, rename, copy or delete. */
export function ProjectGrid({ projects, current, onOpen, onChanged }: { projects: ProjectSummary[]; current: string | null; onOpen: (id: string) => void; onChanged: () => void | Promise<void> }) {
  const ui = useUi();
  const [series, setSeries] = useState<Series[]>([]);
  const [making, setMaking] = useState<string | null>(null);
  useEffect(() => {
    void invoke('studio:seriesList', {}).then(setSeries, () => undefined);
  }, [projects]);
  if (!projects.length) return null;
  const byId = new Map(projects.map((p) => [p.id, p] as const));
  const loose = projects.filter((p) => !p.series);
  const changed = async () => {
    await onChanged();
    setSeries(await invoke('studio:seriesList', {}).catch(() => series));
  };
  const newEpisode = async (se: Series) => {
    const title = await ui.prompt({ title: `Episode ${se.projects.length + 1} of ${se.name}`, label: 'Its title (optional)', confirmLabel: 'Pick the clips' });
    if (title === null) return;
    setMaking(se.id);
    try {
      const r = await invoke('studio:newEpisode', { seriesId: se.id, ...(title.trim() ? { title: title.trim() } : {}) });
      if (!r) return;
      ui.toast(r.slots ? `Episode ${r.episode} made with the last episode’s edit: ${r.filled} of ${r.slots} clips filled.` : `Episode ${r.episode} is ready for your edit.`, 'success');
      await changed();
      onOpen(r.project.id);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setMaking(null);
    }
  };
  const tile = (p: ProjectSummary) => <ProjectTile key={p.id} p={p} series={series} current={p.id === current} onOpen={() => onOpen(p.id)} onChanged={changed} onOpenId={onOpen} />;
  return (
    <div className="project-grid-wrap">
      {series.filter((se) => se.projects.length).map((se) => (
        <section key={se.id} className="series-block">
          <div className="series-head">
            <h3>{se.name}</h3>
            <span className="small muted">{se.projects.length} episode{se.projects.length === 1 ? '' : 's'}</span>
            <button className="btn sm primary" disabled={making === se.id} onClick={() => void newEpisode(se)} title="The last episode’s edit (look, captions, cards, timing) made again with your new clips">
              {making === se.id ? <span className="spinner tiny" /> : <Icon name="plus" size={12} />} New episode
            </button>
          </div>
          <div className="project-grid">{se.projects.map((pid) => byId.get(pid)).filter((p): p is ProjectSummary => !!p).map(tile)}</div>
        </section>
      ))}
      {loose.length > 0 && (
        <>
          <h3>Your projects</h3>
          <div className="project-grid">{loose.map(tile)}</div>
        </>
      )}
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

function ProjectTile({ p, series, current, onOpen, onChanged, onOpenId }: { p: ProjectSummary; series: Series[]; current: boolean; onOpen: () => void; onChanged: () => void | Promise<void>; onOpenId: (id: string) => void }) {
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
        {p.series && <span className="tile-ep">Ep {p.series.episode}</span>}
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
          <button
            className="btn icon sm ghost"
            title={p.series ? `Episode ${p.series.episode} of ${p.series.name}: take it out of the series` : 'Add to a series (a show with numbered episodes)'}
            onClick={() =>
              void (async () => {
                if (p.series) {
                  const ok = await ui.confirm({ title: 'Take it out of the series?', body: `“${p.name}” stays as a project; the other episodes are numbered again.`, confirmLabel: 'Take it out' });
                  if (ok) await act(() => invoke('studio:seriesRemove', { projectId: p.id }));
                  return;
                }
                const name = await ui.prompt({ title: 'Add to a series', label: series.length ? `A series name (yours: ${series.map((x) => x.name).join(', ')}), or a new one` : 'The series’ name (a new one)', confirmLabel: 'Add' });
                if (!name?.trim()) return;
                const have = series.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
                await act(() => (have ? invoke('studio:seriesAdd', { seriesId: have.id, projectId: p.id }) : invoke('studio:seriesCreate', { name: name.trim(), projects: [p.id] })));
              })()
            }
          >
            <Icon name="tasks" size={12} />
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
