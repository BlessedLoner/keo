import { useCallback, useEffect, useRef, useState } from 'react';
import { FORMATS, clipEnd, findClip, isAV, projectDuration, type ExportOptions, type Asset, type Clip, type EditOp, type FormatId, type MediaClip, type Project, type TextClip } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { Preview } from '../studio/Preview';
import { Timeline } from '../studio/Timeline';
import { Autopilot } from '../studio/Autopilot';
import { ReadAloud } from '../studio/VoiceTools';
import { MediaBin } from '../studio/Bin';
import { ExportDialog } from '../studio/ExportDialog';
import { StudioKeo } from '../studio/StudioKeo';
import { FacelessCreator } from '../studio/FacelessCreator';
import { Color, Num, Section } from '../studio/fields';
import { CounterFields, ElementsPanel, FrameFields, MotionFields, PositionFields, ShapeFields, TransitionFields } from '../studio/MotionFields';
import '../styles/studio.css';

/**
 * Keo Studio: a video editor inside Keo. The user edits here by hand; Keo edits the same project
 * with its Studio tools, and both see every change (each one can be undone).
 */

type Progress = { stage: 'sound' | 'video' | 'saving' | 'done' | 'failed'; done?: number; total?: number; file?: string; error?: string };
type Step = { label: string; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; note?: string };

const fmtTime = (s: number, fps = 30) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * fps);
  return `${m}:${String(sec).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
};
const fmtDur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s` : `${s.toFixed(1)}s`);

export function StudioView() {
  const ui = useUi();
  const [list, setList] = useState<Awaited<ReturnType<typeof listProjects>>>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  // The selected clips (Shift or Ctrl + click adds more); the last one is the one the inspector shows.
  const [selection, setSelection] = useState<string[]>([]);
  const selected = selection.at(-1) ?? null;
  const setSelected = useCallback((id: string | null) => setSelection(id ? [id] : []), []);
  const pick = useCallback((id: string | null, add?: boolean) => {
    if (!id) return setSelection([]);
    setSelection((s) => (add ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : s.includes(id) && s.length > 1 ? [...s.filter((x) => x !== id), id] : [id]));
  }, []);
  const selectionRef = useRef<string[]>([]);
  selectionRef.current = selection;
  const [zoom, setZoom] = useState(60);
  const [history, setHistory] = useState({ undo: false, redo: false });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [captioning, setCaptioning] = useState(false);
  const [faceless, setFaceless] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [tlHeight, setTlHeight] = useState(() => {
    try {
      return Number(localStorage.getItem('keo.studio.timelineHeight')) || 250;
    } catch {
      return 250;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('keo.studio.timelineHeight', String(Math.round(tlHeight)));
    } catch {
      /* a per-viewer convenience only */
    }
  }, [tlHeight]);
  const clipboard = useRef<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const timeRef = useRef(0);
  timeRef.current = time;
  const [sideTab, setSideTab] = useState<'keo' | 'tools' | 'inspect'>('keo');
  // Picking a clip opens its settings.
  useEffect(() => {
    if (selected) setSideTab('inspect');
  }, [selected]);
  // Keo knows where the user is: the playhead and the selection (a moment after they settle).
  const focusId = project?.id ?? null;
  useEffect(() => {
    if (!focusId || playing) return;
    const t = setTimeout(() => void invoke('studio:focus', { id: focusId, time: Math.max(0, time), selected: selection }).catch(() => undefined), 400);
    return () => clearTimeout(t);
  }, [focusId, time, selection, playing]);
  const projectRef = useRef<Project | null>(null);
  projectRef.current = project;

  const refreshList = useCallback(() => void listProjects().then(setList).catch(() => undefined), []);
  const refreshHistory = useCallback((id: string) => void invoke('studio:history', { id }).then(setHistory).catch(() => undefined), []);
  const show = useCallback(
    (p: Project) => {
      setProject(p);
      refreshHistory(p.id);
    },
    [refreshHistory],
  );

  // Open the project Keo or the user last had open (or the newest one).
  useEffect(() => {
    void (async () => {
      try {
        const [cur, all] = await Promise.all([invoke('studio:current', {}), listProjects()]);
        setList(all);
        const id = cur.id ?? all[0]?.id;
        if (id) show(await invoke('studio:open', { id }));
      } catch (e) {
        ui.error(errText(e));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Changes from Keo (or another window) show up live.
  useEffect(
    () =>
      subscribe('studio:changed', (p) => {
        refreshList();
        if (projectRef.current?.id === p.id || !projectRef.current) show(p);
      }),
    [refreshList, show],
  );
  useEffect(
    () =>
      subscribe('studio:progress', (m) => {
        if (m.projectId !== projectRef.current?.id) return;
        if (m.stage === 'checklist') setSteps(m.steps ?? null);
        else setProgress({ stage: m.stage, done: m.done, total: m.total, file: m.file, error: m.error });
      }),
    [],
  );

  const edit = useCallback(
    async (ops: EditOp[]) => {
      const p = projectRef.current;
      if (!p) return;
      try {
        const r = await invoke('studio:edit', { id: p.id, ops });
        show(r.project);
      } catch (e) {
        ui.error(errText(e));
      }
    },
    [show, ui],
  );
  const undo = useCallback(async () => {
    const p = projectRef.current;
    if (p) show(await invoke('studio:undo', { id: p.id }).catch(() => p));
  }, [show]);
  const redo = useCallback(async () => {
    const p = projectRef.current;
    if (p) show(await invoke('studio:redo', { id: p.id }).catch(() => p));
  }, [show]);

  const importMedia = async () => {
    if (!project) return;
    try {
      const r = await invoke('studio:import', { id: project.id });
      show(r.project);
      if (r.skipped.length) ui.toast(`Not added: ${r.skipped.slice(0, 3).join('; ')}`, 'error');
      // The first media of an empty project goes straight onto the timeline.
      if (r.added.length && projectDuration(project) === 0) {
        const ops: EditOp[] = r.added.map((a) => (a.kind === 'audio' ? { op: 'add_audio', assetId: a.id, start: 'end' } : { op: 'add_media', assetId: a.id, start: 'end' }));
        await edit(ops);
      }
    } catch (e) {
      ui.error(errText(e));
    }
  };

  /** Files dropped from File Explorer: into the project, and onto the timeline at the playhead (or in order when it is empty). */
  const dropFiles = async (paths: string[], where: 'bin' | 'timeline') => {
    const p = projectRef.current;
    if (!p || !paths.length) return;
    try {
      const r = await invoke('studio:import', { id: p.id, paths });
      show(r.project);
      if (r.skipped.length) ui.toast(`Not added: ${r.skipped.slice(0, 3).join('; ')}`, 'error');
      if (where === 'bin' || !r.added.length) return;
      const empty = projectDuration(p) === 0;
      let at = timeRef.current;
      const ops: EditOp[] = r.added.map((a) => {
        const op: EditOp = a.kind === 'audio' ? { op: 'add_audio', assetId: a.id, start: empty ? 'end' : at } : { op: 'add_media', assetId: a.id, start: empty ? 'end' : at };
        if (!empty) at += a.kind === 'image' ? 3 : a.duration;
        return op;
      });
      await edit(ops);
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const addAsset = (a: Asset) => void edit([a.kind === 'audio' ? { op: 'add_audio', assetId: a.id, start: time } : { op: 'add_media', assetId: a.id, start: time }]);
  const autoCaptions = async () => {
    if (!project) return;
    try {
      const src = await invoke('studio:captionSource', {});
      if (!src.destination) return ui.error(src.reason ?? 'Captions are not available.');
      const ok = await ui.confirm({
        title: 'Add captions?',
        body: `Keo sends this video’s sound to ${src.destination} to turn the speech into text, then adds word-by-word captions on a Captions track.${src.exact ? '' : ' Word timing is close but not exact.'} You can undo it.`,
        confirmLabel: 'Add captions',
      });
      if (!ok) return;
      setPlaying(false);
      setCaptioning(true);
      const r = await invoke('studio:captions', { id: project.id, maxWords: 3 });
      ui.toast(`Added ${r.lines} caption lines (${r.words} words).`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setCaptioning(false);
    }
  };
  const addMusic = async () => {
    if (!project) return;
    try {
      const r = await invoke('studio:import', { id: project.id });
      const songs = r.added.filter((a) => a.kind === 'audio');
      if (!songs.length) {
        if (r.added.length || r.skipped.length) ui.toast('Choose a music file (MP3, M4A, WAV…).', 'error');
        return;
      }
      // Music goes under everything, quieter, and ducks while someone speaks.
      await edit(songs.map((a) => ({ op: 'add_audio', assetId: a.id, trackName: 'Music', start: 0, volume: 0.3, duck: -14, ...(duration > 0 ? { duration: Math.min(a.duration, duration) } : {}) })));
    } catch (e) {
      ui.error(errText(e));
    }
  };

  const splitAtPlayhead = useCallback(() => {
    const p = projectRef.current;
    if (!p) return;
    // The selected clip, or every clip under the playhead.
    const targets = selected ? [selected] : p.tracks.flatMap((t) => t.clips.filter((c) => time > c.start + 0.04 && time < clipEnd(c) - 0.04).map((c) => c.id));
    const ops: EditOp[] = targets.filter((id) => {
      const c = findClip(p, id)?.clip;
      return c && time > c.start + 0.04 && time < clipEnd(c) - 0.04;
    }).map((id) => ({ op: 'split', clip: id, at: time }));
    if (ops.length) void edit(ops);
  }, [edit, selected, time]);

  const deleteSelected = useCallback(
    (ripple: boolean) => {
      const ids = selectionRef.current;
      if (!ids.length) return;
      setSelected(null);
      void edit(ids.map((clip) => ({ op: 'delete' as const, clip, ripple })));
    },
    [edit, setSelected],
  );

  // Keyboard: Space play, S split, Delete, Ctrl+Z / Ctrl+Y, arrows a frame, Home/End.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const p = projectRef.current;
      if (!p) return;
      const frame = 1 / p.fps;
      if (e.key === ' ') {
        e.preventDefault();
        setPlaying((v) => !v);
      } else if (e.ctrlKey && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
        e.preventDefault();
        void undo();
      } else if (e.ctrlKey && (e.key === 'y' || ((e.key === 'z' || e.key === 'Z') && e.shiftKey))) {
        e.preventDefault();
        void redo();
      } else if (!e.ctrlKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        splitAtPlayhead();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected(e.shiftKey);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setPlaying(false);
        const step = (e.shiftKey ? 1 : frame) * (e.key === 'ArrowLeft' ? -1 : 1);
        setTime((t) => Math.max(0, Math.min(projectDuration(p), t + step)));
      } else if (e.key === 'Home') setTime(0);
      else if (e.key === 'End') setTime(projectDuration(p));
      else if (e.key === 'Escape') setSelected(null);
      else if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && selectedRef.current) {
        e.preventDefault();
        void edit(selectionRef.current.map((clip) => ({ op: 'duplicate' as const, clip })));
      } else if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        setSelection(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      } else if (e.ctrlKey && (e.key === 'c' || e.key === 'C') && selectedRef.current) {
        e.preventDefault();
        clipboard.current = selectedRef.current;
        ui.toast('Copied. Ctrl+V puts it at the playhead.', 'info');
      } else if (e.ctrlKey && (e.key === 'v' || e.key === 'V') && clipboard.current) {
        e.preventDefault();
        if (findClip(p, clipboard.current)) void edit([{ op: 'duplicate', clip: clipboard.current, start: timeRef.current }]);
      } else if (!e.ctrlKey && (e.key === 'k' || e.key === 'K')) setPlaying(false);
      else if (!e.ctrlKey && (e.key === 'l' || e.key === 'L')) setPlaying(true);
      else if (!e.ctrlKey && (e.key === 'j' || e.key === 'J')) {
        setPlaying(false);
        setTime((t) => Math.max(0, t - 2));
      } else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(400, Math.round(z * 1.25)));
      else if (e.key === '-' || e.key === '_') setZoom((z) => Math.max(4, Math.round(z / 1.25)));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, splitAtPlayhead, deleteSelected, edit, ui, setSelected]);

  const exportVideo = async (options: Partial<ExportOptions>) => {
    if (!project) return;
    if (projectDuration(project) === 0) return ui.error('Add something to the timeline first.');
    setExporting(false);
    setPlaying(false);
    setProgress({ stage: 'sound' });
    try {
      await invoke('studio:export', { id: project.id, options });
    } catch (e) {
      setProgress({ stage: 'failed', error: errText(e) });
    }
  };

  const create = async (name: string, format: FormatId) => {
    try {
      const p = await invoke('studio:create', { name, format });
      setCreating(false);
      setTime(0);
      setSelected(null);
      setSteps(null);
      setProgress(null);
      show(p);
      refreshList();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const openProject = async (id: string) => {
    setPlaying(false);
    try {
      const p = await invoke('studio:open', { id });
      setTime(0);
      setSelected(null);
      setSteps(null);
      setProgress(null);
      show(p);
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const removeProject = async () => {
    if (!project) return;
    const ok = await ui.confirm({ title: 'Delete this project?', body: `“${project.name}” and its timeline are deleted. Your original media files and exported videos stay where they are.`, confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await invoke('studio:delete', { id: project.id });
      const rest = await listProjects();
      setList(rest);
      setProject(null);
      if (rest[0]) await openProject(rest[0].id);
    } catch (e) {
      ui.error(errText(e));
    }
  };

  if (loading) {
    return (
      <div className="view studio">
        <div className="studio-empty">
          <span className="spinner" />
        </div>
      </div>
    );
  }
  if (faceless) {
    return (
      <div className="view studio">
        <FacelessCreator
          onCancel={() => setFaceless(false)}
          onDone={(id) => {
            setFaceless(false);
            setCreating(false);
            refreshList();
            void openProject(id);
          }}
        />
      </div>
    );
  }
  if (!project || creating) {
    return (
      <div className="view studio">
        <NewProject onCreate={create} onFaceless={() => setFaceless(true)} onCancel={project ? () => setCreating(false) : undefined} />
      </div>
    );
  }

  const sel = selected ? findClip(project, selected) : null;
  const duration = projectDuration(project);

  return (
    <div
      className={`view studio ${dropping ? 'dropping' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDropping(false);
        const paths = [...e.dataTransfer.files].map((f) => window.keo.pathForFile(f)).filter((x): x is string => !!x);
        const target = e.target as HTMLElement;
        void dropFiles(paths, target.closest('.studio-bin') ? 'bin' : 'timeline');
      }}
    >
      {dropping && (
        <div className="studio-drop" aria-hidden>
          <Icon name="download" size={28} />
          <span>Drop videos, pictures or music — on the media list to keep them there, anywhere else to put them on the timeline</span>
        </div>
      )}
      <header className="studio-bar">
        <Icon name="film" size={18} />
        <select className="select studio-picker" value={project.id} onChange={(e) => void openProject(e.target.value)} aria-label="Project">
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {!list.some((p) => p.id === project.id) && <option value={project.id}>{project.name}</option>}
        </select>
        <button className="btn sm" onClick={() => setCreating(true)} title="New project">
          <Icon name="plus" size={14} /> New
        </button>
        <span className="studio-meta">
          {project.width}×{project.height} · {project.fps} fps · {fmtDur(duration)}
        </span>
        <div className="spacer" />
        <button className="btn icon sm ghost" disabled={!history.undo} onClick={() => void undo()} title="Undo (Ctrl+Z)">
          <Icon name="undo" size={15} />
        </button>
        <button className="btn icon sm ghost" disabled={!history.redo} onClick={() => void redo()} title="Redo (Ctrl+Y)">
          <Icon name="redo" size={15} />
        </button>
        <button className="btn icon sm ghost" onClick={() => void removeProject()} title="Delete this project">
          <Icon name="trash" size={15} />
        </button>
        <button className="btn primary sm" disabled={progress?.stage === 'sound' || progress?.stage === 'video' || progress?.stage === 'saving'} onClick={() => (projectDuration(project) === 0 ? ui.error('Add something to the timeline first.') : setExporting(true))}>
          <Icon name="download" size={14} /> Export
        </button>
      </header>
      <div className="studio-main">
        <MediaBin project={project} time={time} onImport={() => void importMedia()} onAddAsset={addAsset} onEdit={edit} onMusic={() => void addMusic()} onCaptions={() => void autoCaptions()} captioning={captioning} />
        <section className="studio-stage">
          <Preview project={project} time={Math.min(time, Math.max(duration, 0))} playing={playing} onTime={setTime} onEnd={() => setPlaying(false)} selected={selected} onSelect={setSelected} onEdit={(ops) => void edit(ops)} />
          <div className="studio-transport">
            <button className="btn icon sm ghost" onClick={() => setTime(0)} title="To the start (Home)">
              <Icon name="skipback" size={15} />
            </button>
            <button
              className="btn icon play"
              onClick={() => {
                if (!playing && time >= duration - 0.01) setTime(0);
                setPlaying((v) => !v);
              }}
              title="Play / pause (Space)"
              disabled={duration === 0}
            >
              <Icon name={playing ? 'pause' : 'play'} size={17} />
            </button>
            <button className="btn icon sm ghost" onClick={() => setTime(duration)} title="To the end (End)">
              <Icon name="skipfwd" size={15} />
            </button>
            <span className="studio-time">
              {fmtTime(time, project.fps)} <span className="muted">/ {fmtTime(duration, project.fps)}</span>
            </span>
          </div>
        </section>
        <aside className={`studio-side tab-${sideTab}`}>
          <div className="side-tabs" role="tablist" aria-label="Side panel">
            {(
              [
                ['keo', 'Keo'],
                ['tools', 'Tools'],
                ['inspect', sel ? 'Inspector' : 'Project'],
              ] as const
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={sideTab === id} className={sideTab === id ? 'on' : ''} onClick={() => setSideTab(id)}>
                {id === 'keo' && <span className="keo-dot" />}
                {label}
              </button>
            ))}
          </div>
          {steps && <Checklist steps={steps} onClose={() => setSteps(null)} />}
          {progress && <ExportCard progress={progress} onClose={() => setProgress(null)} onStop={() => project && void invoke('studio:exportCancel', { id: project.id }).catch(() => undefined)} />}
          {sideTab === 'keo' && <StudioKeo project={project} />}
          {sideTab === 'tools' && (
            <>
              <Autopilot project={project} time={time} onEdit={edit} onBusy={(b) => b && setPlaying(false)} />
              <ElementsPanel project={project} time={time} onEdit={edit} />
            </>
          )}
          {sideTab === 'inspect' && (sel ? <Inspector key={sel.clip.id} project={project} clip={sel.clip} time={time} onEdit={edit} /> : <ProjectSettings project={project} onEdit={edit} />)}
        </aside>
      </div>
      <div
        className="tl-resize"
        title="Drag to make the timeline taller or shorter"
        onPointerDown={(e) => {
          const y0 = e.clientY;
          const h0 = tlHeight;
          const move = (ev: PointerEvent) => setTlHeight(Math.max(140, Math.min(window.innerHeight * 0.65, h0 + (y0 - ev.clientY))));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      />
      <div className="studio-tools">
        <button className="btn sm ghost" onClick={splitAtPlayhead} title="Split at the playhead (S)">
          <Icon name="scissors" size={14} /> Split
        </button>
        <button className="btn sm ghost" disabled={!selected} onClick={() => deleteSelected(false)} title="Delete (Delete)">
          <Icon name="trash" size={14} /> Delete
        </button>
        <button className="btn sm ghost" disabled={!selected} onClick={() => deleteSelected(true)} title="Delete and close the gap (Shift+Delete)">
          Ripple delete
        </button>
        <button className="btn sm ghost" disabled={!selection.length} onClick={() => void edit(selection.map((clip) => ({ op: 'duplicate' as const, clip })))} title="Duplicate (Ctrl+D)">
          Duplicate
        </button>
        {sel?.clip.type === 'media' && project.assets.find((a) => a.id === (sel.clip as { assetId: string }).assetId)?.kind === 'video' && (
          <>
            <button className="btn sm ghost" disabled={time < sel.clip.start || time > sel.clip.start + sel.clip.duration} onClick={() => void edit([{ op: 'freeze', clip: sel.clip.id, at: time, duration: 2 }])} title="Hold the frame at the playhead for 2 seconds">
              Freeze frame
            </button>
            <button className="btn sm ghost" disabled={sel.clip.volume === 0} onClick={() => void edit([{ op: 'detach_audio', clip: sel.clip.id }])} title="Put this video's sound on its own track">
              Detach audio
            </button>
          </>
        )}
        {selection.length > 1 && <span className="chip">{selection.length} selected</span>}
        <div className="spacer" />
        <span className="small muted">Zoom</span>
        <input type="range" min={8} max={240} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" />
      </div>
      <Timeline
        project={project}
        time={time}
        selected={selected}
        selectedIds={selection}
        onSelect={pick}
        onTime={(t) => {
          setPlaying(false);
          setTime(t);
        }}
        onEdit={(ops) => void edit(ops)}
        zoom={zoom}
        onZoom={setZoom}
        height={tlHeight}
      />
      {exporting && <ExportDialog project={project} onClose={() => setExporting(false)} onExport={(o) => void exportVideo(o)} />}
    </div>
  );
}

function listProjects() {
  return invoke('studio:list', {});
}

function NewProject({ onCreate, onFaceless, onCancel }: { onCreate: (name: string, f: FormatId) => void; onFaceless: () => void; onCancel?: () => void }) {
  const [name, setName] = useState('My video');
  const [format, setFormat] = useState<FormatId>('vertical');
  return (
    <div className="studio-empty">
      <div className="studio-new">
        <Icon name="film" size={30} />
        <h2>New video</h2>
        <p className="muted">Edit it yourself here, or ask Keo in the chat to edit it for you: cut silences, add captions, music and more.</p>
        <div className="field">
          <label htmlFor="studio-name">Name</label>
          <input id="studio-name" className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="format-grid" role="radiogroup" aria-label="Format">
          {(Object.keys(FORMATS) as FormatId[]).map((f) => {
            const d = FORMATS[f];
            return (
              <button key={f} role="radio" aria-checked={format === f} className={`format ${format === f ? 'on' : ''}`} onClick={() => setFormat(f)}>
                <span className="format-shape" style={{ aspectRatio: `${d.width} / ${d.height}` }} />
                <span className="small">{d.label}</span>
              </button>
            );
          })}
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          {onCancel && (
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button className="btn primary" disabled={!name.trim()} onClick={() => onCreate(name.trim(), format)}>
            Create
          </button>
        </div>
        <div className="faceless-offer">
          <span className="muted small">No footage? Make a video from a script:</span>
          <button className="btn sm" onClick={onFaceless}>
            <Icon name="text" size={13} /> Faceless video from a script
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportCard({ progress, onClose, onStop }: { progress: Progress; onClose: () => void; onStop: () => void }) {
  const running = progress.stage === 'sound' || progress.stage === 'video' || progress.stage === 'saving';
  const pct = progress.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : 0;
  return (
    <div className={`studio-card ${progress.stage === 'failed' ? 'bad' : progress.stage === 'done' ? 'good' : ''}`}>
      <div className="studio-pane-head">
        <span>Export</span>
        {!running && (
          <button className="btn icon sm ghost" onClick={onClose} title="Close">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      {running && (
        <>
          <p className="small">{progress.stage === 'sound' ? 'Mixing the sound…' : progress.stage === 'saving' ? 'Saving the video…' : `Making the video… ${pct}%`}</p>
          <div className="studio-bar-track">
            <div className="studio-bar-fill" style={{ width: `${progress.stage === 'video' ? pct : progress.stage === 'saving' ? 100 : 4}%` }} />
          </div>
          <button className="btn sm ghost" onClick={onStop}>
            <Icon name="stop" size={12} /> Stop
          </button>
        </>
      )}
      {progress.stage === 'done' && (
        <>
          <p className="small">Saved{progress.file ? `: ${progress.file.split(/[\\/]/).pop()}` : ''}</p>
          <button className="btn sm" onClick={() => void invoke('video:openFolder', {})}>
            <Icon name="folder" size={13} /> Open the folder
          </button>
        </>
      )}
      {progress.stage === 'failed' && <p className="small">{progress.error ?? 'The export failed.'}</p>}
    </div>
  );
}

function Checklist({ steps, onClose }: { steps: Step[]; onClose: () => void }) {
  const running = steps.some((s) => s.status === 'running' || s.status === 'pending');
  return (
    <div className="studio-card">
      <div className="studio-pane-head">
        <span>Keo's steps</span>
        {!running && (
          <button className="btn icon sm ghost" onClick={onClose} title="Close">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <ol className="checklist">
        {steps.map((s, i) => (
          <li key={i} className={s.status}>
            <span className="check-mark">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'skipped' ? '–' : s.status === 'running' ? <span className="spinner tiny" /> : ''}</span>
            <span>
              {s.label}
              {s.note && <span className="small muted"> — {s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------- inspector

function Inspector({ project, clip, time, onEdit }: { project: Project; clip: Clip; time: number; onEdit: (ops: EditOp[]) => void }) {
  const set = (patch: Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>) => onEdit([{ op: 'set', clip: clip.id, ...patch }]);
  const asset = isAV(clip) ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  return (
    <div className="inspector">
      <div className="studio-pane-head">
        <span>{clip.type === 'text' ? 'Text' : clip.type === 'audio' ? 'Sound' : clip.type === 'shape' ? 'Element' : asset?.kind === 'image' ? 'Picture' : 'Video'}</span>
      </div>
      {asset && <p className="small muted insp-name">{asset.name}</p>}
      <Section title="Timing">
        <div className="insp-grid">
          <Num label="Start" value={clip.start} min={0} suffix="s" onCommit={(v) => onEdit([{ op: 'move', clip: clip.id, start: v }])} />
          <Num label="Length" value={clip.duration} min={0.04} suffix="s" onCommit={(v) => onEdit([{ op: 'trim', clip: clip.id, duration: v }])} />
          {clip.type === 'media' && asset?.kind === 'video' && <Num label="Speed" value={clip.speed} min={0.1} max={8} step={0.05} suffix="×" onCommit={(v) => set({ speed: v })} />}
          {isAV(clip) && (
            <>
              <Num label="Fade in" value={clip.fadeIn} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeIn: v })} />
              <Num label="Fade out" value={clip.fadeOut} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeOut: v })} />
            </>
          )}
        </div>
      </Section>
      {(clip.type === 'audio' || (clip.type === 'media' && asset?.hasAudio)) && (
        <Section title="Sound">
          <label className="insp-range">
            <span>Volume</span>
            <input type="range" min={0} max={200} defaultValue={Math.round(clip.volume * 100)} onPointerUp={(e) => set({ volume: Number((e.target as HTMLInputElement).value) / 100 })} onKeyUp={(e) => set({ volume: Number((e.target as HTMLInputElement).value) / 100 })} />
            <em>{Math.round(clip.volume * 100)}%</em>
          </label>
          <label className="insp-check">
            <input type="checkbox" checked={clip.voice} onChange={(e) => set({ voice: e.target.checked })} /> Enhance voice
          </label>
          {clip.type === 'audio' && (
            <label className="insp-check">
              <input type="checkbox" checked={clip.duck !== null} onChange={(e) => set({ duck: e.target.checked ? -14 : null })} /> Quieter while someone speaks (music)
            </label>
          )}
        </Section>
      )}
      {clip.type === 'media' && <ColorFields clip={clip} set={set} />}
      {clip.type === 'text' && <TextFields clip={clip} set={set} />}
      {clip.type === 'text' && (
        <Section title="Voice">
          <ReadAloud projectId={project.id} clipId={clip.id} />
        </Section>
      )}
      {clip.type !== 'audio' && (
        <Section title="Position">
          {clip.type === 'media' && (
            <div className="insp-seg" role="radiogroup" aria-label="Fit">
              {(['cover', 'contain'] as const).map((f) => (
                <button key={f} role="radio" aria-checked={clip.fit === f} className={clip.fit === f ? 'on' : ''} onClick={() => set({ fit: f })}>
                  {f === 'cover' ? 'Fill frame' : 'Show all'}
                </button>
              ))}
            </div>
          )}
          <PositionFields clip={clip} time={time} fps={project.fps} set={set} />
          <p className="small muted insp-tip-inline">◆ animates a value: move the playhead, change the value, and Keo makes the in-between.</p>
        </Section>
      )}
      {clip.type === 'shape' && <ShapeFields clip={clip} set={set} />}
      {clip.type === 'media' && <TransitionFields clip={clip} hasBefore={project.tracks.some((t) => t.clips.some((o) => o.type === 'media' && o.id !== clip.id && Math.abs(o.start + o.duration - clip.start) < 0.05 && t.clips.includes(clip)))} set={set} />}
      {clip.type === 'media' && <FrameFields clip={clip} projectId={project.id} set={set} />}
      {clip.type === 'text' && <CounterFields clip={clip} set={set} />}
      {clip.type !== 'audio' && <MotionFields clip={clip} set={set} />}
    </div>
  );
}

function ColorFields({ clip, set }: { clip: MediaClip; set: (patch: Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>) => void }) {
  const g = clip.color ?? { exposure: 0, contrast: 0, saturation: 0, temperature: 0, vignette: 0 };
  const field = (k: keyof typeof g, label: string, min = -1) => (
    <label className="insp-range" key={`${clip.id}-${k}-${g[k]}`}>
      <span>{label}</span>
      <input
        type="range"
        min={min * 100}
        max={100}
        defaultValue={Math.round(g[k] * 100)}
        onPointerUp={(e) => set({ color: { [k]: Number((e.target as HTMLInputElement).value) / 100 } })}
        onKeyUp={(e) => set({ color: { [k]: Number((e.target as HTMLInputElement).value) / 100 } })}
      />
      <em>{Math.round(g[k] * 100)}</em>
    </label>
  );
  return (
    <Section title="Colour">
      {field('exposure', 'Exposure')}
      {field('contrast', 'Contrast')}
      {field('saturation', 'Saturation')}
      {field('temperature', 'Warmth')}
      {field('vignette', 'Vignette', 0)}
      {clip.color && (
        <button className="btn sm ghost" onClick={() => set({ color: null })}>
          Reset colour
        </button>
      )}
      {!!clip.zooms?.length && (
        <button className="btn sm ghost" onClick={() => set({ zooms: null })}>
          Remove zooms ({clip.zooms.length})
        </button>
      )}
    </Section>
  );
}

function TextFields({ clip, set }: { clip: TextClip; set: (patch: Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>) => void }) {
  const [text, setText] = useState(clip.text);
  useEffect(() => setText(clip.text), [clip.text]);
  const st = clip.style;
  return (
    <>
      <Section title="Text">
        <textarea className="textarea insp-text" rows={3} value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== clip.text && set({ text })} />
        <div className="insp-grid">
          <label className="insp-num wide">
            <span>Font</span>
            <select className="select" value={st.font} onChange={(e) => set({ style: { font: e.target.value } })}>
              {['Segoe UI', 'Segoe UI Black', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Consolas', 'Comic Sans MS', 'Bahnschrift'].map((f) => (
                <option key={f}>{f}</option>
              ))}
              {!['Segoe UI', 'Segoe UI Black', 'Arial', 'Arial Black', 'Impact', 'Georgia', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Consolas', 'Comic Sans MS', 'Bahnschrift'].includes(st.font) && <option>{st.font}</option>}
            </select>
          </label>
          <Num label="Size" value={st.sizePct} min={1} max={40} step={0.5} suffix="%" onCommit={(v) => set({ style: { sizePct: v } })} />
          <label className="insp-num">
            <span>Weight</span>
            <select className="select" value={st.weight} onChange={(e) => set({ style: { weight: e.target.value as TextClip['style']['weight'] } })}>
              <option value="normal">Regular</option>
              <option value="bold">Bold</option>
              <option value="black">Black</option>
            </select>
          </label>
          <Num label="Spacing" value={st.letterSpacing} min={-5} max={40} step={0.5} onCommit={(v) => set({ style: { letterSpacing: v } })} />
        </div>
        <div className="insp-seg" role="radiogroup" aria-label="Align">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button key={a} role="radio" aria-checked={st.align === a} className={st.align === a ? 'on' : ''} onClick={() => set({ style: { align: a } })}>
              {a[0]!.toUpperCase() + a.slice(1)}
            </button>
          ))}
        </div>
        <label className="insp-check">
          <input type="checkbox" checked={st.uppercase} onChange={(e) => set({ style: { uppercase: e.target.checked } })} /> Capitals
        </label>
      </Section>
      <Section title="Look">
        <div className="insp-grid">
          <Color label="Colour" value={st.color} onCommit={(v) => set({ style: { color: v } })} />
          <label className="insp-color">
            <span>Gradient</span>
            <input type="checkbox" checked={!!st.color2} onChange={(e) => set({ style: { color2: e.target.checked ? '#8B6BFF' : null } })} />
            {st.color2 && <input type="color" value={st.color2.slice(0, 7)} onChange={(e) => set({ style: { color2: e.target.value.toUpperCase() } })} />}
          </label>
          <Num label="Outline" value={st.outline} min={0} max={20} step={1} onCommit={(v) => set({ style: { outline: v } })} />
          <Color label="Outline colour" value={st.outlineColor} onCommit={(v) => set({ style: { outlineColor: v } })} />
          <Num label="Glow" value={st.glow} min={0} max={80} step={2} onCommit={(v) => set({ style: { glow: v } })} />
          <Color label="Glow colour" value={st.glowColor} onCommit={(v) => set({ style: { glowColor: v } })} />
          <Num label="Shadow" value={st.shadow} min={0} max={60} step={2} onCommit={(v) => set({ style: { shadow: v } })} />
          <label className="insp-color">
            <span>Box</span>
            <input type="checkbox" checked={st.box} onChange={(e) => set({ style: { box: e.target.checked } })} />
            {st.box && <input type="color" value={st.boxColor.slice(0, 7)} onChange={(e) => set({ style: { boxColor: `${e.target.value.toUpperCase()}B3` } })} />}
          </label>
          <label className="insp-color">
            <span>Highlight</span>
            <input type="checkbox" checked={!!clip.highlight} onChange={(e) => set({ highlight: e.target.checked ? '#FFD400' : null })} />
            {clip.highlight && <input type="color" value={clip.highlight.slice(0, 7)} onChange={(e) => set({ highlight: e.target.value.toUpperCase() })} />}
          </label>
        </div>
      </Section>
      <Section title="Animation">
        <div className="insp-grid">
          <label className="insp-num">
            <span>In</span>
            <select className="select" value={clip.animIn} onChange={(e) => set({ animIn: e.target.value as TextClip['animIn'] })}>
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="pop">Pop</option>
              <option value="slide-up">Slide up</option>
              <option value="blur-in">Blur in</option>
              <option value="typewriter">Typewriter</option>
              <option value="words">Word by word</option>
              <option value="letters">Letter by letter</option>
              <option value="drop">Drop (bounce)</option>
              <option value="wave">Wave</option>
              <option value="zoom">Zoom</option>
              <option value="wipe">Wipe</option>
              <option value="glitch">Glitch</option>
            </select>
          </label>
          <label className="insp-num">
            <span>Out</span>
            <select className="select" value={clip.animOut} onChange={(e) => set({ animOut: e.target.value as TextClip['animOut'] })}>
              <option value="none">None</option>
              <option value="fade">Fade</option>
              <option value="pop">Pop</option>
              <option value="slide-down">Slide down</option>
              <option value="blur-out">Blur out</option>
              <option value="zoom">Zoom</option>
              <option value="wipe">Wipe</option>
            </select>
          </label>
          <Num label="Seconds" value={clip.animSeconds} min={0} max={5} step={0.05} suffix="s" onCommit={(v) => set({ animSeconds: v })} />
        </div>
      </Section>
    </>
  );
}

function ProjectSettings({ project, onEdit }: { project: Project; onEdit: (ops: EditOp[]) => void }) {
  const [name, setName] = useState(project.name);
  useEffect(() => setName(project.name), [project.name]);
  const fmt = (Object.keys(FORMATS) as FormatId[]).find((f) => FORMATS[f].width === project.width && FORMATS[f].height === project.height) ?? 'custom';
  return (
    <div className="inspector">
      <div className="studio-pane-head">
        <span>Project</span>
      </div>
      <Section title="Video">
        <label className="insp-num wide">
          <span>Name</span>
          <input className="input" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== project.name && onEdit([{ op: 'set_project', name: name.trim() }])} />
        </label>
        <label className="insp-num wide">
          <span>Format</span>
          <select
            className="select"
            value={fmt}
            onChange={(e) => {
              const f = FORMATS[e.target.value as FormatId];
              if (f) onEdit([{ op: 'set_project', width: f.width, height: f.height }]);
            }}
          >
            {(Object.keys(FORMATS) as FormatId[]).map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
            {fmt === 'custom' && (
              <option value="custom">
                {project.width}×{project.height}
              </option>
            )}
          </select>
        </label>
        <div className="insp-grid">
          <label className="insp-num">
            <span>Frame rate</span>
            <select className="select" value={project.fps} onChange={(e) => onEdit([{ op: 'set_project', fps: Number(e.target.value) }])}>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
              {![24, 25, 30, 50, 60].includes(project.fps) && <option value={project.fps}>{project.fps} fps</option>}
            </select>
          </label>
          <Color label="Background" value={project.background} onCommit={(v) => onEdit([{ op: 'set_project', background: v }])} />
        </div>
      </Section>
      <p className="small muted insp-tip">Click a clip on the timeline to change it. Space plays, S splits at the playhead, Delete removes the selected clip, Ctrl+Z undoes.</p>
      <p className="small muted insp-tip">Or ask Keo in the chat, for example: “Cut the silences, add captions and soft background music.”</p>
    </div>
  );
}
