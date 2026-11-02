import { useCallback, useEffect, useRef, useState } from 'react';
import { FORMATS, SPEED_PRESETS, clipEnd, curveAt, findClip, isAV, projectDuration, type SpeedPoint, type ExportOptions, type Asset, type Clip, type EditOp, type FormatId, type MediaClip, type Project, type TextClip, type AdjustClip, BLENDS, EQ_PRESETS, VOICE_FX, VOICE_FX_LABEL, type AudioClip, type Blend, type VoiceFx, KEO_FONTS, SYSTEM_FONTS } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { Preview, type Guides } from '../studio/Preview';
import { Timeline } from '../studio/Timeline';
import { ProjectGrid } from '../studio/ProjectGrid';
import { ReadAloud } from '../studio/VoiceTools';
import { Library } from '../studio/Library';
import { ExportDialog } from '../studio/ExportDialog';
import { StudioKeo } from '../studio/StudioKeo';
import { BrandKit } from '../studio/BrandKit';
import { Versions } from '../studio/Versions';
import { FacelessCreator } from '../studio/FacelessCreator';
import { Color, Num, Section } from '../studio/fields';
import { ChromaFields, CounterFields, EffectsFields, FrameFields, MotionFields, PositionFields, ShapeFields, TransitionFields, VolumeField } from '../studio/MotionFields';
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
  const [history, setHistory] = useState<{ undo: boolean; redo: boolean; undoLabels: string[]; redoLabels: string[] }>({ undo: false, redo: false, undoLabels: [], redoLabels: [] });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [full, setFull] = useState(false);
  const [reversing, setReversing] = useState(false);
  // Motion tracking: the clip that will follow what the user boxes on the preview.
  const [follow, setFollow] = useState<string | null>(null);
  const onPickBox = async (box: { x: number; y: number; w: number; h: number } | null) => {
    const clip = follow;
    setFollow(null);
    if (!box || !clip || !project) return;
    try {
      ui.toast('Following it through the video…', 'info');
      const r = await invoke('studio:track', { id: project.id, clip, box });
      ui.toast(r.lost > r.points / 3 ? `Followed it, but it was hard to see in ${r.lost} of ${r.points} moments: check the result.` : `The clip now follows it (${r.points} points).`, r.lost > r.points / 3 ? 'info' : 'success');
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const reverseClip = async (clip: string) => {
    setReversing(true);
    try {
      const r = await invoke('studio:reverse', { id: project!.id, clip });
      ui.toast(`Reversed ${r.seconds.toFixed(1)} s of video.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setReversing(false);
    }
  };
  const [quality, setQuality] = useState(1);
  const [guideMode, setGuideMode] = useState<Guides>('none');
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
  const [sideTab, setSideTab] = useState<'keo' | 'inspect'>('keo');
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
  // Watching Keo edit: Keo's steps play on the timeline while this project is on screen.
  const [keoStep, setKeoStep] = useState<{ at: number; end?: number | undefined; label: string; kind: string; index: number; total: number } | null>(null);
  useEffect(() => {
    if (!project?.id) return;
    const id = project.id;
    const tell = () => void invoke('studio:watch', { id, on: !document.hidden }).catch(() => undefined);
    tell();
    document.addEventListener('visibilitychange', tell);
    return () => {
      document.removeEventListener('visibilitychange', tell);
      void invoke('studio:watch', { id, on: false }).catch(() => undefined);
      setKeoStep(null);
    };
  }, [project?.id]);
  useEffect(
    () =>
      subscribe('studio:keoAction', (a) => {
        if (a.projectId !== projectRef.current?.id) return;
        if (a.kind === 'done') return setKeoStep(null);
        setPlaying(false);
        setTime(a.at ?? 0);
        setSelection(a.clips ?? []);
        setKeoStep({ at: a.at ?? 0, end: a.end, label: a.label ?? 'Editing', kind: a.kind, index: a.index, total: a.total });
      }),
    [],
  );
  // Keo is about to work on another project (a short it made): it comes on screen, and the Keo
  // panel stays on the same chat so the conversation carries on.
  const [keoChat, setKeoChat] = useState<string | null>(null);
  useEffect(
    () =>
      subscribe('studio:show', (m) => {
        if (m.projectId === projectRef.current?.id) return;
        const chat = keoConversation.current;
        void invoke('studio:open', { id: m.projectId })
          .then((p) => {
            if (chat) setKeoChat(chat);
            setPlaying(false);
            setTime(0);
            setSelection([]);
            show(p);
            refreshList();
            ui.toast(`Keo is working on “${p.name}” now.`, 'info');
          })
          .catch(() => undefined);
      }),
    [show, refreshList, ui],
  );
  // When Keo's turn in this project's conversation ends, steps it did not finish stop spinning.
  const keoConversation = useRef<string | null>(null);
  useEffect(() => {
    keoConversation.current = null;
    if (!project?.id) return;
    if (keoChat) {
      keoConversation.current = keoChat;
      return;
    }
    void invoke('studio:conversation', { id: project.id })
      .then((r) => (keoConversation.current = r.conversationId))
      .catch(() => undefined);
  }, [project?.id, keoChat]);
  useEffect(
    () =>
      subscribe('agent:event', (e) => {
        if (e.type !== 'turn_finished' || e.conversationId !== keoConversation.current) return;
        setSteps((list) => list?.map((s) => (s.status === 'running' || s.status === 'pending' ? { ...s, status: 'skipped', note: 'not done: Keo stopped before this step' } : s)) ?? null);
      }),
    [],
  );
  // An AI shot fal.ai finished (or failed) after Keo stopped waiting: said wherever the user is in Studio.
  useEffect(() => subscribe('studio:aiShot', (m) => ui.toast(m.message, m.ok ? 'success' : 'error')), [ui]);
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
      if (r.added.length) ui.toast(`Imported ${r.added.length} file${r.added.length === 1 ? '' : 's'}: drag ${r.added.length === 1 ? 'it' : 'them'} onto the timeline, or click +.`, 'success');
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
      const p = projectRef.current;
      // A group goes with any one of its clips: one delete per group.
      const groups = new Set<string>();
      const ids = selectionRef.current.filter((id) => {
        const g = p ? findClip(p, id)?.clip.group : undefined;
        if (!g) return true;
        if (groups.has(g)) return false;
        groups.add(g);
        return true;
      });
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
      else if (e.key === 'Escape') {
        setSelected(null);
        setFull(false);
      } else if (!e.ctrlKey && (e.key === 'f' || e.key === 'F')) setFull((v) => !v);
      else if (!e.ctrlKey && (e.key === 'm' || e.key === 'M')) void edit([{ op: 'marker', at: timeRef.current }]);
      else if (e.key === '?') setHelpOpen((v) => !v);
      else if (e.ctrlKey && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault();
        const sel = selectionRef.current;
        const g = sel.length ? findClip(p, sel.at(-1)!)?.clip.group : undefined;
        if (e.shiftKey && g) void edit([{ op: 'ungroup', clip: sel.at(-1)! }]);
        else if (!e.shiftKey && sel.length >= 2) void edit([{ op: 'group', clips: sel }]);
      } else if (e.ctrlKey && (e.key === 'd' || e.key === 'D') && selectedRef.current) {
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
    setKeoChat(null);
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
        <div className="studio-home">
          <NewProject onCreate={create} onFaceless={() => setFaceless(true)} onCancel={project ? () => setCreating(false) : undefined} />
          <ProjectGrid
            projects={list}
            current={project?.id ?? null}
            onOpen={(id) => {
              setCreating(false);
              void openProject(id);
            }}
            onChanged={async () => {
              const all = await listProjects().catch(() => list);
              setList(all);
              if (project && !all.some((x) => x.id === project.id)) setProject(null);
            }}
          />
        </div>
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
        <button className="btn sm" onClick={() => setCreating(true)} title="Your projects, or a new one">
          <Icon name="plus" size={14} /> New / Projects
        </button>
        <span className="studio-meta">
          {project.width}×{project.height} · {project.fps} fps · {fmtDur(duration)}
        </span>
        <div className="spacer" />
        <button className="btn icon sm ghost" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)">
          ?
        </button>
        <button className="btn icon sm ghost" disabled={!history.undo} onClick={() => void undo()} title={history.undoLabels[0] ? `Undo: ${history.undoLabels[0]} (Ctrl+Z)` : 'Undo (Ctrl+Z)'}>
          <Icon name="undo" size={15} />
        </button>
        <span className="history-wrap">
          <button className="btn sm ghost" onClick={() => setHistoryOpen((v) => !v)} title="Saved versions, and every change newest first: go back to any of them">
            History
          </button>
          {historyOpen && (
            <div className="history-menu" onMouseLeave={(e) => !(e.currentTarget as HTMLElement).contains(document.activeElement) && setHistoryOpen(false)}>
              <Versions projectId={project.id} onDone={() => setHistoryOpen(false)} />
              {history.undoLabels.map((l, i) => (
                <button
                  key={i}
                  onClick={() =>
                    void (async () => {
                      setHistoryOpen(false);
                      // Back to just before this change.
                      for (let k = 0; k <= i; k++) await undo();
                    })()
                  }
                  title="Undo back to before this change"
                >
                  <span className="hist-n">{i + 1}</span> {l}
                </button>
              ))}
              {!history.undoLabels.length && <span className="small muted">Nothing to undo.</span>}
            </div>
          )}
        </span>
        <button className="btn icon sm ghost" disabled={!history.redo} onClick={() => void redo()} title={history.redoLabels[0] ? `Redo: ${history.redoLabels[0]} (Ctrl+Y)` : 'Redo (Ctrl+Y)'}>
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
        <Library
          project={project}
          time={time}
          selected={selected}
          onImport={() => void importMedia()}
          onAddAsset={addAsset}
          onEdit={edit}
          onCaptions={() => void autoCaptions()}
          captioning={captioning}
          onAskKeo={(text) => {
            setSideTab('keo');
            // The Keo panel sends it once it is on screen.
            setTimeout(() => window.dispatchEvent(new CustomEvent('keo:ask', { detail: text })), 50);
          }}
        />
        <section className={`studio-stage ${full ? 'fullscreen' : ''}`}>
          <Preview project={project} time={Math.min(time, Math.max(duration, 0))} playing={playing} onTime={setTime} onEnd={() => setPlaying(false)} selected={selected} onSelect={setSelected} onEdit={(ops) => void edit(ops)} quality={quality} guides={guideMode} {...(follow ? { pickBox: (b: { x: number; y: number; w: number; h: number } | null) => void onPickBox(b) } : {})} />
          <div className="studio-transport">
            <span className="studio-time tp-left">
              {fmtTime(time, project.fps)} <span className="muted">/ {fmtTime(duration, project.fps)}</span>
            </span>
            <div className="tp-center">
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
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={duration === 0}
            >
              <Icon name={playing ? 'pause' : 'play'} size={17} />
            </button>
            <button className="btn icon sm ghost" onClick={() => setTime(duration)} title="To the end (End)">
              <Icon name="skipfwd" size={15} />
            </button>
            </div>
            <div className="tp-right">
            <select className="select preview-opt" value={quality} onChange={(e) => setQuality(Number(e.target.value))} title="Preview quality: lower is smoother on slower PCs (the export is always full quality)">
              <option value={1}>Full</option>
              <option value={0.5}>Half</option>
              <option value={0.25}>Quarter</option>
            </select>
            <select className="select preview-opt" value={guideMode} onChange={(e) => setGuideMode(e.target.value as Guides)} title="Show where TikTok, Reels or Shorts put their buttons and captions">
              <option value="none">No guides</option>
              <option value="tiktok">TikTok safe zone</option>
              <option value="reels">Reels safe zone</option>
              <option value="shorts">Shorts safe zone</option>
              <option value="thirds">Thirds</option>
            </select>
            <button className="btn icon sm ghost" onClick={() => setFull((v) => !v)} title={full ? 'Leave full screen (F or Esc)' : 'Full screen preview (F)'}>
              <Icon name={full ? 'x' : 'vision'} size={14} />
            </button>
            </div>
          </div>
        </section>
        <aside className={`studio-side tab-${sideTab}`}>
          <div className="side-tabs" role="tablist" aria-label="Side panel">
            {(
              [
                ['keo', 'Keo'],
                ['inspect', sel ? 'Edit' : 'Details'],
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
          {sideTab === 'keo' && <StudioKeo project={project} conversation={keoChat} />}
          {sideTab === 'inspect' && (sel ? <Inspector key={sel.clip.id} project={project} clip={sel.clip} time={time} onEdit={edit} onFollow={() => {
                setPlaying(false);
                setFollow(sel.clip.id);
                ui.toast('Drag a box on the preview around what this clip should follow.', 'info');
              }} /> : <ProjectSettings project={project} onEdit={edit} />)}
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
        {selection.length >= 2 && (
          <button className="btn sm ghost" onClick={() => void edit([{ op: 'group', clips: selection }])} title="Group these clips: they move and are deleted together (Ctrl+G)">
            Group
          </button>
        )}
        {sel?.clip.group && (
          <button className="btn sm ghost" onClick={() => void edit([{ op: 'ungroup', clip: sel.clip.id }])} title="Take the group apart (Ctrl+Shift+G)">
            Ungroup
          </button>
        )}
        <button className="btn sm ghost" disabled={duration === 0} onClick={() => void edit([{ op: 'add_adjust', start: Math.min(time, Math.max(0, duration - 0.5)), duration: Math.max(0.5, Math.min(3, duration - Math.min(time, Math.max(0, duration - 0.5)))), color: { contrast: 0.15, saturation: 0.1 } }])} title="An adjustment layer at the playhead: one colour grade, blur or effect over everything under it">
          Adjust layer
        </button>
        {sel?.clip.type === 'media' && project.assets.find((a) => a.id === (sel.clip as { assetId: string }).assetId)?.kind === 'video' && (
          <>
            <button className="btn sm ghost" disabled={time < sel.clip.start || time > sel.clip.start + sel.clip.duration} onClick={() => void edit([{ op: 'freeze', clip: sel.clip.id, at: time, duration: 2 }])} title="Hold the frame at the playhead for 2 seconds">
              Freeze frame
            </button>
            <button className="btn sm ghost" disabled={reversing} onClick={() => void reverseClip(sel.clip.id)} title="Play this clip backwards (Keo makes a reversed copy on this PC; do it again to play forwards)">
              {reversing ? <span className="spinner tiny" /> : null} {reversing ? 'Reversing…' : 'Reverse'}
            </button>
            <button className="btn sm ghost" disabled={sel.clip.volume === 0} onClick={() => void edit([{ op: 'detach_audio', clip: sel.clip.id }])} title="Put this video's sound on its own track">
              Detach audio
            </button>
          </>
        )}
        <button
          className="btn sm ghost"
          disabled={duration === 0}
          title="Save the picture at the playhead (full size) as a cover or thumbnail, next to your exports"
          onClick={() =>
            void invoke('studio:saveFrame', { id: project.id, time })
              .then((r) => ui.toast(`Saved ${r.file.split(/[\\/]/).pop()} in Videos\\Keo.`, 'success'))
              .catch((e) => ui.error(errText(e)))
          }
        >
          Save frame
        </button>
        {selection.length > 1 && <span className="chip">{selection.length} selected</span>}
        <div className="spacer" />
        <span className="small muted">Zoom</span>
        <input type="range" min={4} max={240} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} aria-label="Timeline zoom" />
        <button
          className="btn sm ghost"
          title="Show the whole video on the timeline"
          onClick={() => {
            const el = document.querySelector<HTMLElement>('.studio-timeline');
            // The timeline is always at least 10 seconds long.
            const d = Math.max(10, projectDuration(project));
            if (!el || d <= 0) return;
            // The whole length in the visible width (track labels and a little room at the end left out).
            setZoom(Math.max(4, Math.min(240, Math.floor((el.clientWidth - 132 - 260) / d))));
            el.scrollLeft = 0;
          }}
        >
          Fit
        </button>
      </div>
      {keoStep && (
        <div className="keo-live-bar" role="status" aria-live="polite">
          <span className="dot" />
          <strong>Keo is editing</strong>
          <span className="grow">
            Step {keoStep.index} of {keoStep.total} · {keoStep.label}
          </span>
          <button className="btn sm ghost" onClick={() => void invoke('studio:skipShow', { id: project.id }).catch(() => undefined)} title="Show the rest of Keo's edit at once">
            Skip to the end
          </button>
        </div>
      )}
      <Timeline
        project={project}
        time={time}
        selected={selected}
        selectedIds={selection}
        onSelect={pick}
        onSelectMany={setSelection}
        keo={keoStep}
        onTime={(t) => {
          setPlaying(false);
          setTime(t);
        }}
        onEdit={(ops) => void edit(ops)}
        zoom={zoom}
        onZoom={setZoom}
        height={tlHeight}
      />
      {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)} />}
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

type InspTab = 'video' | 'audio' | 'speed' | 'animation' | 'adjust' | 'text' | 'element';
let lastInspTab: InspTab = 'video';

function Inspector({ project, clip, time, onEdit, onFollow }: { project: Project; clip: Clip; time: number; onEdit: (ops: EditOp[]) => void; onFollow: () => void }) {
  const set = (patch: Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>) => onEdit([{ op: 'set', clip: clip.id, ...patch }]);
  const asset = isAV(clip) ? project.assets.find((a) => a.id === clip.assetId) : undefined;
  // CapCut-style tabs for what is selected (the last one used stays chosen).
  const tabs: Array<[InspTab, string]> =
    clip.type === 'media'
      ? [['video', asset?.kind === 'image' ? 'Picture' : 'Video'], ...(asset?.hasAudio ? ([['audio', 'Audio']] as Array<[InspTab, string]>) : []), ...(asset?.kind === 'video' ? ([['speed', 'Speed']] as Array<[InspTab, string]>) : []), ['animation', 'Animation'], ['adjust', 'Adjust']]
      : clip.type === 'audio'
        ? [['audio', 'Audio']]
        : clip.type === 'text'
          ? [['text', 'Text'], ['animation', 'Animation']]
          : clip.type === 'shape'
            ? [['element', 'Element'], ['animation', 'Animation']]
            : [['adjust', 'Adjust']];
  const [tab, setTab] = useState<InspTab>(() => (tabs.some(([t]) => t === lastInspTab) ? lastInspTab : tabs[0]![0]));
  const at = (t: InspTab) => tab === t;
  const first = tab === tabs[0]![0];
  return (
    <div className="inspector">
      <div className="insp-tabs" role="tablist" aria-label="Edit the selected clip">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'on' : ''}
            onClick={() => {
              lastInspTab = t;
              setTab(t);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {first && asset && <p className="small muted insp-name">{asset.name}</p>}
      {first && asset?.kind === 'video' && (asset.proxy ? <p className="small muted insp-name">Smooth preview: plays a light copy (the export uses the original).</p> : Math.max(asset.width, asset.height) > 1920 && <PreviewCopyButton projectId={project.id} assetId={asset.id} />)}
      {first && isAV(clip) && (
        <label className="insp-num wide insp-replace">
          <span>Replace with</span>
          <select
            className="select"
            value=""
            onChange={(e) => {
              if (e.target.value) onEdit([{ op: 'replace_media', clip: clip.id, assetId: e.target.value }]);
            }}
          >
            <option value="">Another file of this project…</option>
            {project.assets
              .filter((a) => a.id !== clip.assetId && (clip.type === 'audio' ? a.hasAudio : a.kind !== 'audio'))
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
      )}
      {first && (
      <Section title="Timing">
        <div className="insp-grid">
          <Num label="Start" value={clip.start} min={0} suffix="s" onCommit={(v) => onEdit([{ op: 'move', clip: clip.id, start: v }])} />
          <Num label="Length" value={clip.duration} min={0.04} suffix="s" onCommit={(v) => onEdit([{ op: 'trim', clip: clip.id, duration: v }])} />
          {isAV(clip) && (
            <>
              <Num label="Fade in" value={clip.fadeIn} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeIn: v })} />
              <Num label="Fade out" value={clip.fadeOut} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeOut: v })} />
            </>
          )}
        </div>
      </Section>
      )}
      {at('speed') && (
      <Section title="Speed">
        <div className="insp-grid">
          {clip.type === 'media' && asset?.kind === 'video' && !clip.speedCurve && <Num label="Speed" value={clip.speed} min={0.1} max={8} step={0.05} suffix="×" onCommit={(v) => set({ speed: v })} />}
          {clip.type === 'media' && asset?.kind === 'video' && (
            <label className="insp-num">
              <span>Speed curve</span>
              <select className="select" value={clip.speedCurve ? (Object.entries(SPEED_PRESETS).find(([, pts]) => JSON.stringify(pts) === JSON.stringify(clip.speedCurve))?.[0] ?? 'custom') : 'none'} onChange={(e) => set({ speedCurve: e.target.value === 'none' ? null : (e.target.value as keyof typeof SPEED_PRESETS) })}>
                <option value="none">None (steady)</option>
                <option value="montage">Montage</option>
                <option value="hero">Hero (slow moment)</option>
                <option value="bullet">Bullet time</option>
                <option value="flash-in">Flash in</option>
                <option value="flash-out">Flash out</option>
                <option value="jump-cut">Jump cut</option>
                {clip.speedCurve && !Object.values(SPEED_PRESETS).some((pts) => JSON.stringify(pts) === JSON.stringify(clip.speedCurve)) && <option value="custom">Custom</option>}
              </select>
            </label>
          )}
          {clip.type === 'media' && clip.speedCurve && <CurveGraph points={clip.speedCurve} />}
        </div>
      </Section>
      )}
      {at('audio') && (clip.type === 'audio' || (clip.type === 'media' && asset?.hasAudio)) && (
        <Section title="Sound">
          <VolumeField clip={clip} time={time} fps={project.fps} set={set} />
          {clip.volumeKeys?.length ? <p className="small muted insp-tip-inline">◆ The volume changes over the clip: move the playhead and change it to add a point.</p> : null}
          <label className="insp-check">
            <input type="checkbox" checked={clip.voice} onChange={(e) => set({ voice: e.target.checked })} /> Enhance voice
          </label>
          <label className="insp-row">
            <span>Equalizer</span>
            <select className="select" value={clip.eq ? (Object.entries(EQ_PRESETS).find(([, v]) => v.low === clip.eq!.low && v.mid === clip.eq!.mid && v.high === clip.eq!.high)?.[0] ?? 'custom') : ''} onChange={(e) => e.target.value !== 'custom' && set({ eq: (e.target.value || null) as keyof typeof EQ_PRESETS | null })}>
              <option value="">Flat</option>
              <option value="voice">Clear voice</option>
              <option value="warm">Warm</option>
              <option value="bass">Bass boost</option>
              <option value="bright">Bright</option>
              <option value="phone">Phone call</option>
              {clip.eq && !Object.values(EQ_PRESETS).some((v) => v.low === clip.eq!.low && v.mid === clip.eq!.mid && v.high === clip.eq!.high) && <option value="custom">Custom</option>}
            </select>
          </label>
          <div className="insp-grid" style={{ marginTop: 6 }}>
            <Num label="Bass" value={clip.eq?.low ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { low: v } })} />
            <Num label="Mids" value={clip.eq?.mid ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { mid: v } })} />
            <Num label="Treble" value={clip.eq?.high ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { high: v } })} />
          </div>
          {!asset?.cleanOf && <CleanSoundButton projectId={project.id} clip={clip} />}
          <label className="insp-row">
            <span>Voice changer</span>
            <select className="select" value={clip.voiceFx ?? ''} onChange={(e) => set({ voiceFx: (e.target.value || null) as VoiceFx | null })}>
              <option value="">None</option>
              {VOICE_FX.map((v) => (
                <option key={v} value={v}>
                  {VOICE_FX_LABEL[v]}
                </option>
              ))}
            </select>
          </label>
          {clip.type === 'audio' && (
            <label className="insp-check">
              <input type="checkbox" checked={clip.duck !== null} onChange={(e) => set({ duck: e.target.checked ? -14 : null })} /> Quieter while someone speaks (music)
            </label>
          )}
        </Section>
      )}
      {at('adjust') && clip.type === 'adjust' && (
        <Section title="Adjustment">
          <p className="small muted">Changes everything under it (videos, pictures, elements) while it is on the timeline; titles and captions above it stay as they are.</p>
          <div className="insp-grid">
            <Num label="Strength" value={Math.round(clip.strength * 100)} min={0} max={100} step={5} suffix="%" onCommit={(v) => set({ strength: v / 100 })} />
            <Num label="Blur" value={clip.blur} min={0} max={20} step={0.5} suffix="%" onCommit={(v) => set({ blur: v })} />
            <Num label="Fade in" value={clip.fadeIn} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeIn: v })} />
            <Num label="Fade out" value={clip.fadeOut} min={0} max={30} suffix="s" onCommit={(v) => set({ fadeOut: v })} />
          </div>
        </Section>
      )}
      {at('adjust') && (clip.type === 'media' || clip.type === 'adjust') && <ColorFields clip={clip} set={set} />}
      {at('text') && clip.type === 'text' && <TextFields clip={clip} set={set} />}
      {at('text') && clip.type === 'text' && (
        <Section title="Voice">
          <ReadAloud projectId={project.id} clipId={clip.id} />
        </Section>
      )}
      {(at('video') || at('text') || at('element')) && clip.type !== 'audio' && clip.type !== 'adjust' && (
        <Section title="Position">
          {clip.type === 'media' && (
            <div className="insp-seg" role="radiogroup" aria-label="Fit">
              {(['cover', 'contain', 'blur'] as const).map((f) => {
                const on = f === 'blur' ? clip.fit === 'contain' && clip.backdrop === 'blur' : clip.fit === f && !(f === 'contain' && clip.backdrop === 'blur');
                return (
                  <button key={f} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => set(f === 'blur' ? { fit: 'contain', backdrop: 'blur' } : { fit: f, backdrop: null })}>
                    {f === 'cover' ? 'Fill frame' : f === 'contain' ? 'Show all' : 'Show all + blur'}
                  </button>
                );
              })}
            </div>
          )}
          {clip.type === 'media' && (
            <div className="insp-row">
              <span>Mirror</span>
              <div className="insp-seg">
                <button className={clip.flipX ? 'on' : ''} aria-pressed={!!clip.flipX} onClick={() => set({ flipX: !clip.flipX })} title="Mirror left-right">
                  ⇋ Flip
                </button>
                <button className={clip.flipY ? 'on' : ''} aria-pressed={!!clip.flipY} onClick={() => set({ flipY: !clip.flipY })} title="Turn upside down">
                  ⇅ Flip
                </button>
              </div>
            </div>
          )}
          {clip.type === 'media' && (
            <label className="insp-row">
              <span>Blend</span>
              <select className="select" value={clip.blend ?? 'normal'} onChange={(e) => set({ blend: e.target.value as Blend })} title="How this layer mixes with the ones under it (Screen for light leaks and smoke, Multiply for paper and shadows)">
                {BLENDS.map((b) => (
                  <option key={b} value={b}>
                    {b[0]!.toUpperCase() + b.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <PositionFields clip={clip} time={time} fps={project.fps} set={set} />
          <p className="small muted insp-tip-inline">◆ animates a value: move the playhead, change the value, and Keo makes the in-between.</p>
        </Section>
      )}
      {(at('video') || at('text') || at('element')) && clip.type !== 'audio' && clip.type !== 'adjust' && (
        <Section title="Motion tracking">
          <button className="btn sm" onClick={onFollow} title="Text, a sticker or an element moves with something in the video (a face, a car, a ball)">
            <Icon name="vision" size={13} /> Follow something in the video
          </button>
          {clip.type === 'media' && asset?.kind === 'video' && <SteadyButton projectId={project.id} clipId={clip.id} />}
        </Section>
      )}
      {at('element') && clip.type === 'shape' && <ShapeFields clip={clip} set={set} />}
      {at('animation') && clip.type === 'media' && <TransitionFields clip={clip} hasBefore={project.tracks.some((t) => t.clips.some((o) => o.type === 'media' && o.id !== clip.id && Math.abs(o.start + o.duration - clip.start) < 0.05 && t.clips.includes(clip)))} set={set} />}
      {at('video') && clip.type === 'media' && <FrameFields clip={clip} projectId={project.id} set={set} />}
      {at('video') && clip.type === 'media' && (
        <Section title="Remove background">
          <label className="insp-check" title="Keo finds the people in the picture on this PC and removes everything else, no green screen needed. Put a new background on a track below.">
            <input type="checkbox" checked={!!clip.cutout} onChange={(e) => set({ cutout: e.target.checked, ...(e.target.checked ? { chroma: null } : {}) })} /> Remove background (AI, keeps people)
          </label>
        </Section>
      )}
      {at('video') && clip.type === 'media' && <ChromaFields clip={clip} set={set} />}
      {at('adjust') && (clip.type === 'media' || clip.type === 'adjust') && <EffectsFields clip={clip} set={set} />}
      {at('text') && clip.type === 'text' && <CounterFields clip={clip} set={set} />}
      {at('animation') && clip.type !== 'audio' && clip.type !== 'adjust' && <MotionFields clip={clip} set={set} />}
    </div>
  );
}

/** Steadies a shaky video clip (measured on this PC). */
function SteadyButton({ projectId, clipId }: { projectId: string; clipId: string }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await invoke('studio:stabilize', { id: projectId, clip: clipId, strength: 0.7 });
      ui.toast(`Steadied (zoomed in ${Math.round((r.zoom - 1) * 100)}% so no edge shows).`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sm" style={{ marginTop: 6 }} disabled={busy} onClick={() => void go()} title="Smooths handheld shake (side to side and up and down)">
      {busy ? <span className="spinner tiny" /> : <Icon name="film" size={13} />} {busy ? 'Steadying…' : 'Steady shaky video'}
    </button>
  );
}

/** A light copy of a big video so the preview plays smoothly (the export keeps the original). */
function PreviewCopyButton({ projectId, assetId }: { projectId: string; assetId: string }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await invoke('studio:previewCopies', { id: projectId, assets: [assetId] });
      ui.toast('The preview now plays a light copy; the export still uses the full-quality video.', 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sm insp-replace" style={{ margin: '0 12px 8px' }} disabled={busy} onClick={() => void go()} title="A big video (2K or 4K) can stutter in the preview: Keo makes a light 540p copy for editing">
      {busy ? <span className="spinner tiny" /> : <Icon name="film" size={13} />} {busy ? 'Making a preview copy…' : 'Smooth preview (big video)'}
    </button>
  );
}

/** Takes the background noise out of a clip's sound (a cleaned copy, made on this PC). */
function CleanSoundButton({ projectId, clip }: { projectId: string; clip: MediaClip | AudioClip }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await invoke('studio:cleanSound', { id: projectId, clip: clip.id, strength: 0.8 });
      ui.toast(clip.type === 'media' ? 'Background noise removed: the clean sound is on the Voice (clean) track.' : 'Background noise removed.', 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn sm" style={{ marginTop: 8 }} disabled={busy} onClick={() => void go()} title="Hum, hiss, fans and room tone taken out (made on this PC; undo puts it back)">
      {busy ? <span className="spinner tiny" /> : <Icon name="mic" size={13} />} {busy ? 'Cleaning the sound…' : 'Remove background noise'}
    </button>
  );
}

function ColorFields({ clip, set }: { clip: MediaClip | AdjustClip; set: (patch: Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>) => void }) {
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
      {clip.type === 'media' && !!clip.zooms?.length && (
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
              <optgroup label="Keo fonts">
                {KEO_FONTS.map((f) => (
                  <option key={f} style={{ fontFamily: `"${f}"` }}>
                    {f}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Windows fonts">
                {SYSTEM_FONTS.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </optgroup>
              {![...KEO_FONTS, ...SYSTEM_FONTS].includes(st.font as never) && <option>{st.font}</option>}
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
          <Num label="Curve" value={st.curve} min={-200} max={200} step={5} onCommit={(v) => set({ style: { curve: v } })} />
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
              <option value="slide-left">Slide in from the right</option>
              <option value="slide-right">Slide in from the left</option>
              <option value="slide-down">Drop in from above</option>
              <option value="spin">Spin in</option>
              <option value="bounce">Bounce in</option>
              <option value="words-left">Words fly in from the left</option>
              <option value="words-right">Words fly in from the right</option>
              <option value="words-up">Words rise in</option>
              <option value="words-pop">Words pop in</option>
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
              <option value="slide-left">Slide out to the left</option>
              <option value="slide-right">Slide out to the right</option>
              <option value="slide-up">Slide out upwards</option>
            </select>
          </label>
          <Num label="Seconds" value={clip.animSeconds} min={0} max={5} step={0.05} suffix="s" onCommit={(v) => set({ animSeconds: v })} />
        </div>
      </Section>
    </>
  );
}

/** A small picture of a speed curve (faster up, slower down; the line is normal speed). */
function CurveGraph({ points }: { points: SpeedPoint[] }) {
  const W = 220;
  const H = 46;
  const max = Math.max(2, ...points.map((p) => p.speed));
  // A log scale, so slow and fast look as big as each other.
  const y = (s: number) => H / 2 - (Math.log(s) / Math.log(max)) * (H / 2 - 3);
  const path = Array.from({ length: 61 }, (_, i) => `${i ? 'L' : 'M'}${((i / 60) * W).toFixed(1)},${y(curveAt(points, i / 60)).toFixed(1)}`).join(' ');
  return (
    <svg className="curve-graph" viewBox={`0 0 ${W} ${H}`} aria-label="Speed curve">
      <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="mid" />
      <path d={path} />
    </svg>
  );
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space', 'Play / pause'],
  ['J / K / L', 'Back 2 s / pause / play'],
  ['← / →', 'One frame back / forward (Shift: one second)'],
  ['Home / End', 'To the start / end'],
  ['S', 'Split at the playhead'],
  ['Delete', 'Delete the selected clips (Shift: and close the gap)'],
  ['Ctrl + D', 'Duplicate'],
  ['Ctrl + C / V', 'Copy / paste at the playhead'],
  ['Ctrl + A', 'Select every clip'],
  ['Shift / Ctrl + click', 'Select more clips'],
  ['Ctrl + Z / Y', 'Undo / redo'],
  ['+ / −, Ctrl + wheel', 'Zoom the timeline'],
  ['Esc', 'Select nothing'],
  ['F', 'Full screen preview'],
  ['M', 'Add a marker at the playhead'],
  ['Ctrl+G / Ctrl+Shift+G', 'Group the selected clips / ungroup'],
  ['?', 'This list'],
];

function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export-dialog">
        <h3>Keyboard shortcuts</h3>
        <dl className="shortcuts">
          {SHORTCUTS.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
        <p className="small muted">On the picture: click a layer to pick it, drag to move, drag the corner to resize, drag the round handle to rotate (Shift: 15° steps).</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
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
      <BrandKit />
      <p className="small muted insp-tip">Click a clip on the timeline to change it. Space plays, S splits at the playhead, Delete removes the selected clip, Ctrl+Z undoes.</p>
      <p className="small muted insp-tip">Or ask Keo in the chat, for example: “Cut the silences, add captions and soft background music.”</p>
    </div>
  );
}
