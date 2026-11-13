import { ProColor } from '../studio/ColorPanel';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FORMATS, SPEED_PRESETS, clipEnd, proGrade, curveAt, findClip, isAV, projectDuration, type SpeedPoint, type ExportOptions, type Asset, type Clip, type EditOp, type FormatId, type MediaClip, type Project, type TextClip, type AdjustClip, BLENDS, EQ_PRESETS, VOICE_FX, VOICE_FX_LABEL, type AudioClip, type Blend, type VoiceFx } from '@shared/studio';
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
import { CloneVideo } from '../studio/CloneVideo';
import { TalkingCharacter } from '../studio/TalkingCharacter';
import { ShotAgain } from '../studio/ShotAgain';
import { AiVideoCreator } from '../studio/AiVideoCreator';
import { Color, FontPicker, Num, Section, Seg, Swatch } from '../studio/fields';
import { ChromaFields, CounterFields, EffectsFields, FrameFields, MotionFields, PositionFields, ShapeFields, TransitionFields, VolumeField } from '../studio/MotionFields';
import { MotionClipFields } from '../studio/MotionClipFields';
import { PlannedShots } from '../studio/PlannedShots';
import { PostDialog } from '../studio/PostDialog';
import { CheckPanel, fmtAt, kindLabel, type CheckRow, type Stage } from '../studio/CheckPanel';
import { fixIssues, issueKey, reviewTimes, timelineIssues, TIMELINE_KINDS } from '@shared/studioReview';
import type { StudioIssue } from '@shared/ipc';
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
  // The export being posted (its file), while the Post dialog is open.
  const [posting, setPosting] = useState<string | null>(null);
  // Keo's edit check. The timeline's own problems are worked out here on every change (instant,
  // nothing sent); faces and edges (frames) and misheard words (the AI model) come from Keo when asked.
  const blankCheck = { open: false, frames: 'idle' as Stage, words: 'idle' as Stage, deep: [] as StudioIssue[], misheard: [] as Array<{ heard: string; meant: string; at: number; where: 'captions' | 'transcript' }>, fixing: false, fixed: null as { labels: string[]; edits: number } | null };
  const [check, setCheck] = useState(blankCheck);
  const checkProject = project?.id;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setCheck(blankCheck), [checkProject]);
  const live = useMemo(() => (project ? timelineIssues(project) : []), [project]);
  const checkRows: CheckRow[] = (() => {
    if (!project) return [];
    const exists = (clip: string) => !clip || !!findClip(project, clip);
    const rows: CheckRow[] = [
      ...live.map((i) => ({ key: issueKey(i), kind: i.kind, clip: i.clip, at: i.at, detail: i.detail, fix: i.fix, canFix: !!i.ops?.length, source: 'live' as const })),
      // From the last look at the frames: the timeline kinds are already live above, and gone clips are gone.
      ...check.deep.filter((i) => !(TIMELINE_KINDS as readonly string[]).includes(i.kind) && exists(i.clip)).map((i) => ({ key: i.key, kind: i.kind, clip: i.clip, at: i.at, detail: i.detail, fix: i.fix, canFix: i.canFix, source: 'frames' as const })),
      ...check.misheard.map((w) => ({ key: `words/${w.heard}`, kind: 'words', clip: '', at: w.at, detail: `“${w.heard}” should be “${w.meant}”${w.where === 'transcript' ? ' (in the transcript: captions made from it would show it)' : ''}`, fix: `put “${w.meant}” everywhere it shows`, canFix: true, source: 'words' as const })),
    ];
    return rows.sort((a, b) => a.at - b.at);
  })();
  const runCheck = () => {
    if (!project) return;
    const id = project.id;
    setCheck((c) => ({ ...c, open: true, frames: 'running', words: 'running', fixed: null }));
    // Both at once; each shows as soon as it is back.
    void invoke('studio:review', { id })
      .then((r) => setCheck((c) => ({ ...c, frames: 'done', deep: r.issues })))
      .catch((e) => {
        setCheck((c) => ({ ...c, frames: 'failed' }));
        ui.error(errText(e));
      });
    void invoke('studio:wordCheck', { id })
      .then((r) => setCheck((c) => ({ ...c, words: 'done', misheard: r.words })))
      .catch(() => setCheck((c) => ({ ...c, words: 'failed' })));
  };
  /** Fixes one row, or every one Keo can: frames first (by place), then words, then the timeline (cuts last). */
  const fixRows = async (only?: CheckRow) => {
    if (!project) return;
    const todo = (only ? [only] : checkRows).filter((r) => r.canFix);
    if (!todo.length) return;
    setCheck((c) => ({ ...c, fixing: true }));
    const labels: string[] = [];
    let edits = 0;
    try {
      const frameRows = todo.filter((r) => r.source === 'frames');
      if (frameRows.length) {
        const r = await invoke('studio:fixReview', { id: project.id, keys: frameRows.map((x) => x.key) });
        if (r.fixed) edits++;
        const left = new Set(r.issues.map((i) => i.key));
        for (const x of frameRows) if (!left.has(x.key)) labels.push(`${kindLabel(x.kind)} at ${fmtAt(x.at)}`);
        setCheck((c) => ({ ...c, deep: r.issues }));
      }
      const wordRows = todo.filter((r) => r.source === 'words');
      if (wordRows.length) {
        const fixes = check.misheard.filter((w) => wordRows.some((x) => x.key === `words/${w.heard}`)).map(({ heard, meant }) => ({ heard, meant }));
        const r = await invoke('studio:proofread', { id: project.id, fixes });
        if (r.inText) edits++;
        for (const f of fixes) labels.push(`“${f.heard}” → “${f.meant}”`);
        setCheck((c) => ({ ...c, misheard: c.misheard.filter((w) => !fixes.some((f) => f.heard === w.heard)) }));
      }
      const liveRows = todo.filter((r) => r.source === 'live');
      if (liveRows.length) {
        // The latest edit (the fixes above may have changed it): worked out again here, at once.
        const now = await invoke('studio:get', { id: project.id });
        const issues = timelineIssues(now).filter((i) => liveRows.some((x) => x.kind === i.kind && x.clip === i.clip));
        const r = fixIssues(now, issues);
        const ops = r.fixed.flatMap((i) => i.ops ?? []);
        if (ops.length) {
          await edit(ops);
          edits++;
          for (const i of r.fixed) labels.push(`${kindLabel(i.kind)} at ${fmtAt(i.at)}`);
        }
      }
      setCheck((c) => ({ ...c, fixing: false, fixed: { labels, edits } }));
      if (!labels.length) ui.toast('That one could not be fixed automatically: fix it by hand.', 'info');
    } catch (e) {
      setCheck((c) => ({ ...c, fixing: false, fixed: labels.length ? { labels, edits } : c.fixed }));
      ui.error(errText(e));
    }
  };
  const undoFixes = async () => {
    const n = check.fixed?.edits ?? 0;
    for (let i = 0; i < n; i++) await undo();
    setCheck((c) => ({ ...c, fixed: null }));
  };
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
  const [faceless, setFaceless] = useState<false | 'script' | 'characters'>(false);
  const [cloning, setCloning] = useState(false);
  const [talking, setTalking] = useState(false);
  // Real AI video from a description (with the text the faceless page passed on, if any).
  const [aiVideo, setAiVideo] = useState<false | { text: string }>(false);
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
  // The workspace: column widths, Keo in its own column, snapping (kept per viewer).
  const [snapping, setSnapping] = useState(() => readPref('keo.studio.snap') !== '0');
  const [keoDock, setKeoDock] = useState(() => readPref('keo.studio.keoDock') !== '0');
  const [cols, setCols] = useState(() => ({ left: Number(readPref('keo.studio.leftW')) || 340, right: Number(readPref('keo.studio.rightW')) || 320, keo: Number(readPref('keo.studio.keoW')) || 340 }));
  useEffect(() => writePref('keo.studio.snap', snapping ? '1' : '0'), [snapping]);
  useEffect(() => writePref('keo.studio.keoDock', keoDock ? '1' : '0'), [keoDock]);
  useEffect(() => {
    writePref('keo.studio.leftW', String(Math.round(cols.left)));
    writePref('keo.studio.rightW', String(Math.round(cols.right)));
    writePref('keo.studio.keoW', String(Math.round(cols.keo)));
  }, [cols]);
  /** Drags a column edge: the column grows or shrinks (within limits) as the mouse moves. */
  const resizeCol = (which: 'left' | 'right' | 'keo', e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = cols[which];
    const limits = which === 'left' ? [240, 560] : [260, 620];
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      const w = Math.max(limits[0]!, Math.min(limits[1]!, which === 'left' ? w0 + dx : w0 - dx));
      setCols((c) => ({ ...c, [which]: w }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
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
  // AI clips still being made for the open project (AI shots, character swaps): Keo's own list,
  // so it is right after switching pages or restarting Keo. Checked again while any are left.
  const [aiJobs, setAiJobs] = useState<Array<{ about: string; submittedAt: string; kind: 'shot' | 'swap' | 'other' }>>([]);
  const projectId = project?.id ?? null;
  const loadAiJobs = useCallback(() => {
    if (!projectId) return setAiJobs([]);
    void invoke('studio:aiJobs', { id: projectId }).then(setAiJobs, () => undefined);
  }, [projectId]);
  useEffect(loadAiJobs, [loadAiJobs]);
  useEffect(() => {
    if (!aiJobs.length) return;
    const t = setInterval(loadAiJobs, 15_000);
    return () => clearInterval(t);
  }, [aiJobs.length, loadAiJobs]);
  useEffect(
    () =>
      subscribe('studio:aiShot', (m) => {
        loadAiJobs();
        if (m.state !== 'waiting') ui.toast(m.message, m.state === 'ready' ? 'success' : 'error');
      }),
    [ui, loadAiJobs],
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
      ui.toast(
        r.skipped
          ? `Added ${r.lines} caption lines (${r.words} words). ${r.skipped} short part${r.skipped === 1 ? '' : 's'} of the speech could not be heard by the speech service and ${r.skipped === 1 ? 'has' : 'have'} no captions: add ${r.skipped === 1 ? 'it' : 'them'} by hand, or run Captions again.`
          : `Added ${r.lines} caption lines (${r.words} words).`,
        r.skipped ? 'info' : 'success',
      );
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
      } else if ((!e.ctrlKey && (e.key === 's' || e.key === 'S')) || (e.ctrlKey && (e.key === 'b' || e.key === 'B'))) {
        e.preventDefault();
        splitAtPlayhead();
      } else if (!e.ctrlKey && (e.key === 'q' || e.key === 'Q' || e.key === 'w' || e.key === 'W')) {
        // Trim to the playhead: Q cuts the part before it, W the part after it (the selected clip).
        const c = selectedRef.current ? findClip(p, selectedRef.current)?.clip : undefined;
        const t = timeRef.current;
        if (!c || t <= c.start + 0.04 || t >= clipEnd(c) - 0.04) return;
        e.preventDefault();
        void edit([e.key === 'q' || e.key === 'Q' ? { op: 'trim', clip: c.id, trimStart: t - c.start } : { op: 'trim', clip: c.id, duration: t - c.start }]);
      } else if (!e.ctrlKey && (e.key === 'n' || e.key === 'N')) {
        setSnapping((v) => !v);
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
  if (aiVideo) {
    return (
      <div className="view studio">
        <AiVideoCreator
          initial={aiVideo.text}
          onCancel={() => setAiVideo(false)}
          onCharacters={() => {
            setAiVideo(false);
            setFaceless('characters');
          }}
          onDone={(id) => {
            setAiVideo(false);
            setCreating(false);
            refreshList();
            void openProject(id);
          }}
        />
      </div>
    );
  }
  if (talking) {
    return (
      <div className="view studio">
        <TalkingCharacter
          onCancel={() => setTalking(false)}
          onCharacters={() => {
            setTalking(false);
            setFaceless('characters');
          }}
          onDone={(id) => {
            setTalking(false);
            setCreating(false);
            refreshList();
            void openProject(id);
          }}
        />
      </div>
    );
  }
  if (cloning) {
    return (
      <div className="view studio">
        <CloneVideo
          onCancel={() => setCloning(false)}
          onCharacters={() => {
            setCloning(false);
            setFaceless('characters');
          }}
          onDone={(id) => {
            setCloning(false);
            setCreating(false);
            refreshList();
            void openProject(id);
          }}
        />
      </div>
    );
  }
  if (faceless) {
    return (
      <div className="view studio">
        <FacelessCreator
          startTab={faceless}
          onCancel={() => setFaceless(false)}
          onAiVideo={(text) => {
            setFaceless(false);
            setAiVideo({ text });
          }}
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
          <NewProject onCreate={create} onFaceless={() => setFaceless('script')} onClone={() => setCloning(true)} onTalk={() => setTalking(true)} onAiVideo={() => setAiVideo({ text: '' })} onCancel={project ? () => setCreating(false) : undefined} />
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
        <button className={`btn sm ghost ${keoDock ? 'on' : ''}`} onClick={() => setKeoDock((v) => !v)} title={keoDock ? 'Put Keo back in a tab beside the clip settings' : 'Keo in its own column: chat with Keo while you change clip settings'}>
          <span className="keo-dot" /> Keo panel
        </button>
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
        <button className={`btn sm ${checkRows.length ? 'check-has' : ''}`} disabled={projectDuration(project) === 0} onClick={() => (check.open ? setCheck((c) => ({ ...c, open: false })) : check.frames === 'idle' ? runCheck() : setCheck((c) => ({ ...c, open: true })))} title="Keo checks the edit like an editor: text on the face, stuck captions, misheard words, empty frames… and fixes what it can. The number updates live while you edit.">
          <Icon name="shield" size={14} /> {check.frames === 'running' || check.words === 'running' ? 'Checking…' : 'Check'}
          {checkRows.length > 0 && <span className="check-count">{checkRows.length}</span>}
        </button>
        <button
          className="btn sm"
          disabled={projectDuration(project) === 0}
          title="YouTube, TikTok or Instagram: Keo writes the post for your latest export"
          onClick={() =>
            void invoke('studio:lastExport', { id: project.id }).then((r) => {
              if (r.file) setPosting(r.file);
              else {
                ui.toast('Export the video first: then Post sends it to YouTube or opens TikTok and Instagram with your caption.', 'info');
                setExporting(true);
              }
            }, (e) => ui.error(errText(e)))
          }
        >
          <Icon name="send" size={14} /> Post
        </button>
        <button className="btn primary sm" disabled={progress?.stage === 'sound' || progress?.stage === 'video' || progress?.stage === 'saving'} onClick={() => (projectDuration(project) === 0 ? ui.error('Add something to the timeline first.') : setExporting(true))}>
          <Icon name="download" size={14} /> Export
        </button>
      </header>
      <div className="studio-main" style={{ gridTemplateColumns: `${cols.left}px 5px minmax(0, 1fr) 5px ${cols.right}px${keoDock ? ` 5px ${cols.keo}px` : ''}` }}>
        <Library
          project={project}
          time={time}
          selected={selected}
          onImport={() => void importMedia()}
          onAddAsset={addAsset}
          onEdit={edit}
          onCaptions={() => void autoCaptions()}
          captioning={captioning}
          onDnaApplied={({ clipIds, start }) => {
            setPlaying(false);
            setTime(start);
            setSelection(clipIds);
          }}
          onAskKeo={(text) => {
            setSideTab('keo');
            // The Keo panel sends it once it is on screen.
            setTimeout(() => window.dispatchEvent(new CustomEvent('keo:ask', { detail: text })), 50);
          }}
        />
        <div className="col-resize" title="Drag to make the library wider or narrower" onPointerDown={(e) => resizeCol('left', e)} />
        <section className={`studio-stage ${full ? 'fullscreen' : ''}`}>
          <Preview project={project} time={Math.min(time, Math.max(duration, 0))} playing={playing} onTime={setTime} onEnd={() => setPlaying(false)} selected={selected} onSelect={setSelected} onEdit={(ops) => void edit(ops)} quality={quality} guides={guideMode} flagged={check.open ? checkRows.map((r) => r.clip).filter(Boolean) : []} {...(follow ? { pickBox: (b: { x: number; y: number; w: number; h: number } | null) => void onPickBox(b) } : {})} />
          {check.open && (
            <CheckPanel
              rows={checkRows}
              frames={check.frames}
              frameCount={reviewTimes(project).length}
              words={check.words}
              fixing={check.fixing}
              fixed={check.fixed}
              onCheck={runCheck}
              onFix={(r) => void fixRows(r)}
              onUndo={() => void undoFixes()}
              onGo={(i) => {
                setPlaying(false);
                // A moment into it, so the problem is on screen.
                setTime(Math.min(Math.max(0, duration - 0.02), i.at + (i.kind === 'blank' ? 0.05 : 0.15)));
                if (i.clip && findClip(project, i.clip)) setSelected(i.clip);
              }}
              onClose={() => setCheck((c) => ({ ...c, open: false }))}
            />
          )}
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
        <div className="col-resize" title="Drag to make the settings wider or narrower" onPointerDown={(e) => resizeCol('right', e)} />
        <aside className={`studio-side tab-${keoDock ? 'inspect' : sideTab}`}>
          {keoDock ? (
            <div className="side-tabs single">
              <span className="on">{sel ? 'Edit' : 'Details'}</span>
            </div>
          ) : (
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
          )}
          {steps && !keoDock && <Checklist steps={steps} onClose={() => setSteps(null)} />}
          {progress && <ExportCard progress={progress} onClose={() => setProgress(null)} onStop={() => project && void invoke('studio:exportCancel', { id: project.id }).catch(() => undefined)} onPost={() => progress.file && setPosting(progress.file)} />}
          {posting && <PostDialog projectId={project.id} file={posting} aiMade={project.assets.some((a) => a.aiMade)} onClose={() => setPosting(null)} />}
          {!keoDock && sideTab === 'keo' && <StudioKeo project={project} conversation={keoChat} selected={selected} />}
          {(keoDock || sideTab === 'inspect') && (sel ? <Inspector key={sel.clip.id} project={project} clip={sel.clip} time={time} onEdit={edit} onFollow={() => {
                setPlaying(false);
                setFollow(sel.clip.id);
                ui.toast('Drag a box on the preview around what this clip should follow.', 'info');
              }} /> : <ProjectSettings project={project} onEdit={edit} />)}
        </aside>
        {keoDock && (
          <>
            <div className="col-resize" title="Drag to make Keo's column wider or narrower" onPointerDown={(e) => resizeCol('keo', e)} />
            <aside className="studio-side studio-keo-col tab-keo">
              <div className="side-tabs single">
                <span className="on">
                  <span className="keo-dot" /> Keo · Creative director
                </span>
              </div>
              {steps && <Checklist steps={steps} onClose={() => setSteps(null)} />}
              <StudioKeo project={project} conversation={keoChat} selected={selected} />
            </aside>
          </>
        )}
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
        <button className={`btn sm ghost ${snapping ? 'on' : ''}`} onClick={() => setSnapping((v) => !v)} title={snapping ? 'Snapping on: clips stick to edges, the playhead, markers and music beats (N)' : 'Snapping off (N)'}>
          <Icon name="magnet" size={14} /> Snap
        </button>
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
      {aiJobs.length > 0 && (
        <div className="keo-live-bar" role="status" aria-live="polite">
          <span className="dot" />
          <strong>{aiJobs.length === 1 ? 'AI clip being made' : `${aiJobs.length} AI clips being made`}</strong>
          <span className="grow ai-jobs">
            {aiJobs.slice(0, 4).map((j, i) => (
              <span key={i} className="small">
                {j.about.length > 110 ? `${j.about.slice(0, 110)}…` : j.about} · {minutesAgo(j.submittedAt)}
              </span>
            ))}
            <span className="small muted">Each goes on the timeline by itself when ready (usually 5 to 10 minutes; busy times longer). Keep working, or close Keo: nothing is lost or paid twice.</span>
          </span>
        </div>
      )}
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
      <PlannedShots
        project={project}
        onGo={(t) => {
          setPlaying(false);
          setTime(t + 0.05);
        }}
      />
      <Timeline
        project={project}
        time={time}
        selected={selected}
        selectedIds={selection}
        onSelect={pick}
        onSelectMany={setSelection}
        keo={keoStep}
        issues={checkRows}
        onTime={(t) => {
          setPlaying(false);
          setTime(t);
        }}
        onEdit={(ops) => void edit(ops)}
        zoom={zoom}
        onZoom={setZoom}
        height={tlHeight}
        snapping={snapping}
      />
      {helpOpen && <ShortcutsSheet onClose={() => setHelpOpen(false)} />}
      {exporting && <ExportDialog project={project} onClose={() => setExporting(false)} onExport={(o) => void exportVideo(o)} />}
    </div>
  );
}

/** A per-viewer layout preference (column widths, toggles); never needed for the edit itself. */
function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* a convenience only */
  }
}

function listProjects() {
  return invoke('studio:list', {});
}

function NewProject({ onCreate, onFaceless, onClone, onTalk, onAiVideo, onCancel }: { onCreate: (name: string, f: FormatId) => void; onFaceless: () => void; onClone: () => void; onTalk: () => void; onAiVideo: () => void; onCancel?: () => void }) {
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
          <span className="muted small">No footage? Make one with AI:</span>
          <button className="btn sm primary" onClick={onAiVideo} title="Describe a video: Keo films it with AI, with your character’s face">
            <Icon name="film" size={13} /> Real AI video from a description
          </button>
          <button className="btn sm" onClick={onFaceless} title="A voice-over with a picture per scene">
            <Icon name="text" size={13} /> Narrated video from a script
          </button>
          <button className="btn sm" onClick={onClone} title="Replace the person in a content video with your character">
            <Icon name="sparkle" size={13} /> Clone a video with your character
          </button>
          <button className="btn sm" onClick={onTalk} title="Your character says your script in their voice, with real lip-sync">
            <Icon name="mic" size={13} /> Make your character talk
          </button>
        </div>
      </div>
    </div>
  );
}

function ExportCard({ progress, onClose, onStop, onPost }: { progress: Progress; onClose: () => void; onStop: () => void; onPost: () => void }) {
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
          {progress.file && (
            <button className="btn sm primary" onClick={onPost} title="YouTube, TikTok or Instagram: Keo writes the post">
              <Icon name="send" size={13} /> Post
            </button>
          )}
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

type InspTab = 'video' | 'audio' | 'speed' | 'animation' | 'adjust' | 'text' | 'element' | 'motion';
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
            : clip.type === 'motion'
              ? [['motion', 'Motion'], ['animation', 'Animation']]
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
        {clip.type === 'media' && asset?.kind === 'video' ? (
          <>
            {!clip.speedCurve && (
              <>
                <Num label="Speed" value={clip.speed} min={0.1} max={8} step={0.05} suffix="×" onCommit={(v) => set({ speed: v })} />
                <div className="chip-row">
                  {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => (
                    <button key={v} className={`chip-btn ${Math.abs(clip.speed - v) < 1e-6 ? 'on' : ''}`} onClick={() => set({ speed: v })}>
                      {v}×
                    </button>
                  ))}
                </div>
              </>
            )}
            <h5 className="insp-sub">Speed curve</h5>
            <div className="curve-chips">
              {(
                [
                  ['none', 'Steady'],
                  ['montage', 'Montage'],
                  ['hero', 'Hero'],
                  ['bullet', 'Bullet time'],
                  ['flash-in', 'Flash in'],
                  ['flash-out', 'Flash out'],
                  ['jump-cut', 'Jump cut'],
                ] as const
              ).map(([k, label]) => {
                const pts = k === 'none' ? null : SPEED_PRESETS[k];
                const on = k === 'none' ? !clip.speedCurve : JSON.stringify(pts) === JSON.stringify(clip.speedCurve);
                return (
                  <button key={k} className={`curve-chip ${on ? 'on' : ''}`} onClick={() => set({ speedCurve: k === 'none' ? null : k })} title={label}>
                    <svg viewBox="0 0 48 24" aria-hidden>
                      <polyline points={pts ? pts.map((p) => `${p.x * 48},${(1 - (Math.log2(Math.max(0.1, p.speed)) + 3.4) / 6.8) * 22 + 1}`).join(' ') : '0,12 48,12'} />
                    </svg>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
            {clip.speedCurve && <CurveGraph points={clip.speedCurve} />}
          </>
        ) : (
          <p className="small muted">Speed changes apply to videos.</p>
        )}
      </Section>
      )}
      {at('audio') && (clip.type === 'audio' || (clip.type === 'media' && asset?.hasAudio)) && (
        <Section title="Sound">
          <VolumeField clip={clip} time={time} fps={project.fps} set={set} />
          {clip.volumeKeys?.length ? <p className="small muted insp-tip-inline">◆ The volume changes over the clip: move the playhead and change it to add a point.</p> : null}
          <label className="insp-check">
            <input type="checkbox" checked={clip.voice} onChange={(e) => set({ voice: e.target.checked })} /> Enhance voice
          </label>
          <h5 className="insp-sub">Equalizer</h5>
          <div className="chip-row">
            {(
              [
                ['', 'Flat'],
                ['voice', 'Clear voice'],
                ['warm', 'Warm'],
                ['bass', 'Bass boost'],
                ['bright', 'Bright'],
                ['phone', 'Phone call'],
              ] as const
            ).map(([k, label]) => {
              const cur = clip.eq ? (Object.entries(EQ_PRESETS).find(([, v]) => v.low === clip.eq!.low && v.mid === clip.eq!.mid && v.high === clip.eq!.high)?.[0] ?? 'custom') : '';
              return (
                <button key={k} className={`chip-btn ${cur === k ? 'on' : ''}`} onClick={() => set({ eq: (k || null) as keyof typeof EQ_PRESETS | null })}>
                  {label}
                </button>
              );
            })}
          </div>
          <div className="insp-grid" style={{ marginTop: 6 }}>
            <Num label="Bass" value={clip.eq?.low ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { low: v } })} />
            <Num label="Mids" value={clip.eq?.mid ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { mid: v } })} />
            <Num label="Treble" value={clip.eq?.high ?? 0} min={-12} max={12} step={1} suffix="dB" onCommit={(v) => set({ eq: { high: v } })} />
          </div>
          {!asset?.cleanOf && <CleanSoundButton projectId={project.id} clip={clip} />}
          <h5 className="insp-sub">Voice changer</h5>
          <div className="chip-row">
            <button className={`chip-btn ${!clip.voiceFx ? 'on' : ''}`} onClick={() => set({ voiceFx: null })}>
              None
            </button>
            {VOICE_FX.map((v) => (
              <button key={v} className={`chip-btn ${clip.voiceFx === v ? 'on' : ''}`} onClick={() => set({ voiceFx: v as VoiceFx })}>
                {VOICE_FX_LABEL[v].replace(/ \(.*\)$/, '')}
              </button>
            ))}
          </div>
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
      {at('motion') && clip.type === 'motion' && <MotionClipFields clip={clip} set={set} />}
      {(at('video') || at('text') || at('element') || at('motion')) && clip.type !== 'audio' && clip.type !== 'adjust' && (
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
            <>
              <h5 className="insp-sub" title="How this layer mixes with the ones under it (Screen for light leaks and smoke, Multiply for paper and shadows)">
                Blend
              </h5>
              <div className="blend-grid">
                {BLENDS.map((b) => (
                  <button key={b} className={`blend-chip b-${b} ${(clip.blend ?? 'normal') === b ? 'on' : ''}`} onClick={() => set({ blend: b as Blend })}>
                    <i />
                    {b[0]!.toUpperCase() + b.slice(1)}
                  </button>
                ))}
              </div>
            </>
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
      {at('video') && clip.type === 'media' && asset?.kind === 'video' && <ShotAgain key={clip.id} projectId={project.id} clip={clip} asset={asset} />}
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
  const [pro, setPro] = useState(() => proGrade(clip.color));
  const field = (k: 'exposure' | 'contrast' | 'saturation' | 'temperature' | 'vignette', label: string, min = -1) => (
    <Num key={k} label={label} value={Math.round(g[k] * 100)} min={min * 100} max={100} step={1} onCommit={(v) => set({ color: { [k]: v / 100 } })} />
  );
  return (
    <Section title="Colour">
      {field('exposure', 'Exposure')}
      {field('contrast', 'Contrast')}
      {field('saturation', 'Saturation')}
      {field('temperature', 'Warmth')}
      {field('vignette', 'Vignette', 0)}
      <button className="btn sm ghost" onClick={() => setPro((v) => !v)} aria-expanded={pro}>
        {pro ? 'Fewer colour tools' : 'Pro colour: light, HSL, curve, LUT…'}
      </button>
      {pro && <ProColor clipId={clip.id} grade={clip.color} set={(p) => set(p)} />}
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
            <FontPicker value={st.font} label="" onPick={(f) => f && set({ style: { font: f } })} />
          </label>
          <Num label="Size" value={st.sizePct} min={1} max={40} step={0.5} suffix="%" onCommit={(v) => set({ style: { sizePct: v } })} />
          <Seg label="Weight" value={st.weight} options={[['normal', 'Regular'], ['bold', 'Bold'], ['black', 'Black']]} onPick={(w) => set({ style: { weight: w } })} />
          <Num label="Spacing" value={st.letterSpacing} min={-5} max={40} step={0.5} onCommit={(v) => set({ style: { letterSpacing: v } })} />
          <Num label="Line height" value={st.lineHeight} min={0.6} max={3} step={0.05} onCommit={(v) => set({ style: { lineHeight: v } })} />
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
        <label className="insp-check">
          <input type="checkbox" checked={st.italic} onChange={(e) => set({ style: { italic: e.target.checked } })} /> Italic
        </label>
      </Section>
      <Section title="Look">
        <div className="insp-grid">
          <Color label="Colour" value={st.color} onCommit={(v) => set({ style: { color: v } })} />
          <label className="insp-color">
            <span>Gradient</span>
            <input type="checkbox" checked={!!st.color2} onChange={(e) => set({ style: { color2: e.target.checked ? '#8B6BFF' : null } })} />
            {st.color2 && <Swatch value={st.color2} onCommit={(c) => set({ style: { color2: c } })} />}
          </label>
          <Num label="Outline" value={st.outline} min={0} max={20} step={1} onCommit={(v) => set({ style: { outline: v } })} />
          <Color label="Outline colour" value={st.outlineColor} onCommit={(v) => set({ style: { outlineColor: v } })} />
          <Num label="Glow" value={st.glow} min={0} max={80} step={2} onCommit={(v) => set({ style: { glow: v } })} />
          <Color label="Glow colour" value={st.glowColor} onCommit={(v) => set({ style: { glowColor: v } })} />
          <Num label="Shadow" value={st.shadow} min={0} max={60} step={2} onCommit={(v) => set({ style: { shadow: v } })} />
          <label className="insp-color">
            <span>Box</span>
            <input type="checkbox" checked={st.box} onChange={(e) => set({ style: { box: e.target.checked } })} />
            {st.box && <Swatch value={st.boxColor} onCommit={(c) => set({ style: { boxColor: `${c}${st.boxColor.slice(7, 9) || 'B3'}` } })} />}
          </label>
          {st.box && (
            <Num
              label="Box opacity"
              value={Math.round((parseInt(st.boxColor.slice(7, 9) || 'FF', 16) / 255) * 100)}
              min={0}
              max={100}
              step={5}
              suffix="%"
              onCommit={(v) => set({ style: { boxColor: `${st.boxColor.slice(0, 7)}${Math.round((Math.max(0, Math.min(100, v)) / 100) * 255).toString(16).padStart(2, '0').toUpperCase()}` } })}
            />
          )}
          <label className="insp-color">
            <span>Highlight</span>
            <input type="checkbox" checked={!!clip.highlight} onChange={(e) => set({ highlight: e.target.checked ? '#FFD400' : null })} />
            {clip.highlight && <Swatch value={clip.highlight} onCommit={(c) => set({ highlight: c })} />}
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
        <p className="small muted">On the picture: click a layer to pick it, drag to move, drag the corner to resize, drag the round handle to rotate (Shift: 15° steps). Moving snaps to the middle, the thirds, a safe margin and other layers; hold Alt to place freely. Check (top bar) finds text on the face, stuck captions and empty frames, and fixes them.</p>
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
      <BrandKit projectId={project.id} />
      <p className="small muted insp-tip">Click a clip on the timeline to change it. Space plays, S splits at the playhead, Delete removes the selected clip, Ctrl+Z undoes.</p>
      <p className="small muted insp-tip">Or ask Keo in the chat, for example: “Cut the silences, add captions and soft background music.”</p>
    </div>
  );
}

/** "sent 4 min ago". */
function minutesAgo(iso: string): string {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return m < 1 ? 'sent just now' : `sent ${m} min ago`;
}
