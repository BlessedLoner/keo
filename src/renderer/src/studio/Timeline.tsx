import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EaseEditor } from './EaseEditor';
import { clipEnd, findClip, projectDuration, TRANSITIONS, volumeAt, type Asset, type Clip, type EditOp, type Project, type Track, type Transition } from '@shared/studio';
import { magneticMove, magneticTrimEnd, magneticTrimStart, mainTrack } from '@shared/studioTimeline';
import { Icon } from '../components/Icon';
import { playhead } from './playhead';
import { useFilmstrip, useWaveform } from './thumbs';

/**
 * The Studio timeline: tracks of clips over time. Drag a clip to move it (also onto another track
 * of the same kind), drag its edges to trim, click to select, click the ruler or drag the playhead
 * to move it, drop media from the bin onto a track. With the magnetic main track on, the main
 * video track stays packed (moves reorder it, trims and deletes pull the rest along).
 *
 * Built to stay smooth: the playhead follows the preview's clock directly (no re-render while
 * playing), each track redraws only when it changes, and frames, sound shapes and ruler ticks
 * are drawn only for the part of the timeline on screen.
 */

const LABEL_W = 132;
const ROW_H: Record<Track['kind'], number> = { video: 64, text: 36, audio: 46 };
const SNAP_PX = 8;
/** The part of the timeline drawn around what is on screen (pixels, in steps so scrolling rarely redraws). */
const VIEW_STEP = 800;

export const TRANSITION_LABEL: Record<Transition['kind'], string> = {
  crossfade: 'Crossfade',
  slide: 'Slide in',
  push: 'Push',
  zoom: 'Zoom through',
  whip: 'Whip',
  wipe: 'Wipe',
  blur: 'Blur',
  flash: 'Flash (white)',
  dip: 'Dip to black',
  iris: 'Iris (circle)',
  'slide-up': 'Slide up',
  'wipe-down': 'Wipe down',
  spin: 'Spin',
  'zoom-out': 'Zoom out',
  flip: 'Flip',
  glitch: 'Glitch',
  stretch: 'Stretch',
  'push-up': 'Push up',
  shrink: 'Shrink',
  'slide-down': 'Slide down',
  'wipe-left': 'Wipe left',
  'wipe-up': 'Wipe up',
};

type ClipDrag = {
  clip: Clip;
  track: Track;
  startX: number;
  /** Where the timeline was scrolled when the drag began (it may scroll by itself near the edges). */
  scroll0: number;
  /** Pointer movement in pixels, scrolling included. */
  dx: number;
  /** The snapped result: the new start (move, trim-start) or end (trim-end), in seconds. */
  value: number;
  /** Where it snapped (a guide line), or null. */
  snapAt: number | null;
  /** The pointer, for the tip. */
  px: number;
  py: number;
};
type Drag =
  | ({ kind: 'move'; targetTrack: string } & ClipDrag)
  | ({ kind: 'trim-start' | 'trim-end' } & ClipDrag)
  | { kind: 'scrub' }
  /** A box dragged over empty space selects every clip it touches. */
  | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean };

/** A right-click menu: on a clip, on a track's name, or on empty space of a track. */
type Menu = { x: number; y: number; at: number; clip?: string; track?: string };
type View = { x0: number; x1: number };

/** What the tracks call back into (kept in one stable object, so tracks do not redraw for new functions). */
interface RowApi {
  pps: number;
  project: Project;
  selected: string | null;
  selectedIds: string[];
  onSelect: (id: string | null, add?: boolean) => void;
  onSelectMany?: (ids: string[]) => void;
  onTime: (t: number) => void;
  onEdit: (ops: EditOp[]) => void;
  startDrag: (d: Drag) => void;
  timeAt: (clientX: number) => number;
  snap: (sec: number, except: string) => number;
  setMenu: (m: Menu | null) => void;
  setCutMenu: (m: { clip: string; x: number; y: number } | null) => void;
  setEaseMenu: (m: { clip: string; at: number; x: number; y: number } | null) => void;
  setRenaming: (id: string | null) => void;
  magnetic: boolean;
}

const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor((s % 1) * 100)).padStart(2, '0')}`;

export function Timeline({
  project,
  time,
  playing = false,
  selected,
  selectedIds,
  onSelect,
  onSelectMany,
  keo,
  issues = [],
  onTime,
  onEdit,
  zoom,
  onZoom,
  height,
  snapping = true,
  magnetic = false,
}: {
  project: Project;
  time: number;
  /** While playing, the playhead follows the preview's clock and the timeline scrolls with it. */
  playing?: boolean;
  selected: string | null;
  /** All selected clips (several with Shift or Ctrl + click). */
  selectedIds?: string[];
  onSelect: (id: string | null, add?: boolean) => void;
  /** Selects exactly these clips (the last one is shown in the inspector). */
  onSelectMany?: (ids: string[]) => void;
  /** Keo's step being shown: its place (and range) on the timeline and what it does. */
  keo?: { at: number; end?: number | undefined; label: string; kind: string } | null;
  /** What Keo's edit check found: a red tick on the ruler at each (click to go there). */
  issues?: Array<{ key: string; at: number; detail: string }>;
  onTime: (t: number) => void;
  onEdit: (ops: EditOp[]) => void;
  zoom: number;
  onZoom?: (z: number) => void;
  height?: number;
  /** Clips stick to edges, the playhead, markers and music beats (N turns it off). */
  snapping?: boolean;
  /** The main video track stays packed: moves reorder it, trims and deletes close the gaps. */
  magnetic?: boolean;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [cutMenu, setCutMenu] = useState<{ clip: string; x: number; y: number } | null>(null);
  const [easeMenu, setEaseMenu] = useState<{ clip: string; at: number; x: number; y: number } | null>(null);
  const easeClip = easeMenu ? findClip(project, easeMenu.clip)?.clip : undefined;
  useEffect(() => {
    if (!cutMenu) return;
    const close = () => setCutMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [cutMenu]);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const pps = zoom; // pixels per second
  const timeRef = useRef(time);
  timeRef.current = time;

  // The part of the timeline on screen (in steps), for drawing only what can be seen.
  const [view, setView] = useState<View>({ x0: -VIEW_STEP, x1: VIEW_STEP * 4 });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const x0 = Math.floor((el.scrollLeft - VIEW_STEP) / VIEW_STEP) * VIEW_STEP;
      const x1 = Math.ceil((el.scrollLeft + el.clientWidth + VIEW_STEP) / VIEW_STEP) * VIEW_STEP;
      setView((v) => (v.x0 === x0 && v.x1 === x1 ? v : { x0, x1 }));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  // Keo's step comes into view (the timeline scrolls to it).
  useEffect(() => {
    const el = area.current;
    if (!keo || !el) return;
    const x = LABEL_W + keo.at * pps;
    if (x < el.scrollLeft + LABEL_W + 40 || x > el.scrollLeft + el.clientWidth - 80) el.scrollTo({ left: Math.max(0, x - LABEL_W - el.clientWidth / 3), behavior: 'smooth' });
  }, [keo, pps]);
  const duration = Math.max(projectDuration(project), 10);
  // Room after the end to drop clips there (the same on screen at any zoom).
  const width = Math.ceil(duration * pps + Math.max(240, pps * 2));

  // Snapping: clip edges, the playhead, markers and the beats of the music on the timeline.
  const edges = (except: string) => {
    const out = [timeRef.current, 0, ...project.markers.map((m) => m.t)];
    for (const t of project.tracks)
      for (const c of t.clips) {
        if (c.id === except) continue;
        out.push(c.start, clipEnd(c));
        if (c.type === 'audio') {
          const beats = project.assets.find((a) => a.id === c.assetId)?.beats;
          for (const b of beats ?? []) if (b >= c.in && b <= c.in + c.duration) out.push(c.start + (b - c.in));
        }
      }
    return out;
  };
  const edgeCache = useRef<{ id: string; list: number[] } | null>(null);
  /** The nearest snap point within a few pixels (and where it is), else the time itself. */
  const snapWith = (sec: number, except: string): { t: number; at: number | null } => {
    if (!snapping) return { t: Math.max(0, sec), at: null };
    if (!edgeCache.current || edgeCache.current.id !== except) edgeCache.current = { id: except, list: edges(except) };
    let best = sec;
    let bestPx = SNAP_PX;
    let at: number | null = null;
    for (const e of edgeCache.current.list) {
      const d = Math.abs(e - sec) * pps;
      if (d < bestPx) {
        bestPx = d;
        best = e;
        at = e;
      }
    }
    return { t: Math.max(0, best), at };
  };
  const snap = (sec: number, except: string) => snapWith(sec, except).t;

  const timeAt = (clientX: number) => {
    const el = area.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left - LABEL_W + el.scrollLeft) / pps);
  };
  const trackAt = (clientY: number): string | null => {
    const rows = area.current?.querySelectorAll<HTMLElement>('[data-track]');
    for (const row of rows ?? []) {
      const r = row.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return row.dataset.track ?? null;
    }
    return null;
  };

  /** A clip drag's new place from the pointer: snapped live (both edges of a moved clip can snap). */
  const follow = (d: Extract<Drag, { clip: Clip }>, clientX: number, clientY: number): Drag => {
    const el = area.current;
    const dx = clientX - d.startX + (el ? el.scrollLeft - d.scroll0 : 0);
    const sec = dx / pps;
    const c = d.clip;
    if (d.kind === 'move') {
      const raw = Math.max(0, c.start + sec);
      const a = snapWith(raw, c.id);
      const b = snapWith(raw + c.duration, c.id);
      const useEnd = b.at !== null && (a.at === null || Math.abs(b.t - c.duration - raw) < Math.abs(a.t - raw));
      const over = trackAt(clientY);
      const target = over && project.tracks.find((t) => t.id === over)?.kind === d.track.kind ? over : d.targetTrack;
      return { ...d, dx, targetTrack: target, value: Math.max(0, useEnd ? b.t - c.duration : a.t), snapAt: useEnd ? b.at : a.at, px: clientX, py: clientY };
    }
    if (d.kind === 'trim-start') {
      const s = snapWith(Math.min(c.start + sec, clipEnd(c) - 0.1), c.id);
      return { ...d, dx, value: Math.min(s.t, clipEnd(c) - 0.1), snapAt: s.at, px: clientX, py: clientY };
    }
    const e = snapWith(Math.max(c.start + 0.1, clipEnd(c) + sec), c.id);
    return { ...d, dx, value: Math.max(c.start + 0.1, e.t), snapAt: e.at, px: clientX, py: clientY };
  };

  // Dragging: live follow, the timeline scrolls by itself near its edges, the result on release.
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!drag) return;
    let scrubRaf = 0;
    const update = () => {
      const d = dragRef.current;
      if (!d) return;
      const { x, y } = pointer.current;
      if (d.kind === 'scrub') {
        if (!scrubRaf)
          scrubRaf = requestAnimationFrame(() => {
            scrubRaf = 0;
            const t = timeAt(pointer.current.x);
            playhead.set(t, false);
            onTime(t);
          });
      } else if (d.kind === 'box') setDrag({ ...d, x1: x, y1: y });
      else setDrag(follow(d, x, y));
    };
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
      update();
    };
    // Near the left or right edge the timeline scrolls on its own (faster the closer to the edge).
    let edgeRaf = 0;
    const edge = () => {
      const el = area.current;
      const d = dragRef.current;
      if (el && d) {
        const r = el.getBoundingClientRect();
        const x = pointer.current.x;
        const left = r.left + LABEL_W + 36;
        const right = r.right - 36;
        const v = x < left ? -Math.min(24, (left - x) / 2 + 4) : x > right ? Math.min(24, (x - right) / 2 + 4) : 0;
        if (v) {
          const before = el.scrollLeft;
          el.scrollLeft = Math.max(0, before + v);
          if (el.scrollLeft !== before) update();
        }
      }
      edgeRaf = requestAnimationFrame(edge);
    };
    edgeRaf = requestAnimationFrame(edge);
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      edgeCache.current = null;
      if (!d || d.kind === 'scrub') return;
      if (d.kind === 'box') {
        if (Math.abs(d.x1 - d.x0) < 5 && Math.abs(d.y1 - d.y0) < 5) {
          // Just a click on empty space: nothing selected, the playhead goes there.
          if (!d.add) onSelect(null);
          const t = timeAt(d.x0);
          playhead.set(t, false);
          onTime(t);
          return;
        }
        const box = { l: Math.min(d.x0, d.x1), r: Math.max(d.x0, d.x1), t: Math.min(d.y0, d.y1), b: Math.max(d.y0, d.y1) };
        const hit: string[] = [];
        for (const el of area.current?.querySelectorAll<HTMLElement>('.tl-clip[data-clip]') ?? []) {
          const r = el.getBoundingClientRect();
          if (r.right >= box.l && r.left <= box.r && r.bottom >= box.t && r.top <= box.b) hit.push(el.dataset.clip!);
        }
        const ids = d.add ? [...new Set([...(selectedIds ?? []), ...hit])] : hit;
        if (onSelectMany) onSelectMany(ids);
        else onSelect(ids.at(-1) ?? null);
        return;
      }
      const main = magnetic ? mainTrack(project) : null;
      if (d.kind === 'move') {
        if (Math.abs(d.dx) < 3 && d.targetTrack === d.track.id) return;
        const start = d.value;
        const group = (selectedIds ?? []).filter((id) => id !== d.clip.id);
        if (group.length && selectedIds?.includes(d.clip.id) && d.targetTrack === d.track.id) {
          // The selected clips move together, by the same amount.
          const delta = start - d.clip.start;
          const all = project.tracks.flatMap((t) => t.clips);
          const minStart = Math.min(...all.filter((c) => selectedIds.includes(c.id)).map((c) => c.start));
          const shift = Math.max(delta, -minStart);
          onEdit(all.filter((c) => selectedIds.includes(c.id)).map((c) => ({ op: 'move' as const, clip: c.id, start: Math.max(0, c.start + shift) })));
          return;
        }
        // The magnetic main track: dropped on it (or taken off it), it reorders and closes up.
        if (main && (d.targetTrack === main.id || d.track.id === main.id)) {
          const ops = magneticMove(project, d.clip.id, start, d.targetTrack, timeAt(d.px));
          if (ops.length) onEdit(ops);
          return;
        }
        onEdit([{ op: 'move', clip: d.clip.id, start, ...(d.targetTrack !== d.track.id ? { track: d.targetTrack } : {}) }]);
      } else if (d.kind === 'trim-start') {
        const delta = Math.min(d.value - d.clip.start, d.clip.duration - 0.1);
        if (Math.abs(delta) <= 0.01) return;
        if (main && d.track.id === main.id) onEdit(magneticTrimStart(project, d.clip.id, delta));
        else onEdit([{ op: 'trim', clip: d.clip.id, trimStart: delta }]);
      } else {
        const dur = Math.max(0.1, d.value - d.clip.start);
        if (Math.abs(dur - d.clip.duration) <= 0.01) return;
        if (main && d.track.id === main.id) onEdit(magneticTrimEnd(project, d.clip.id, dur));
        else onEdit([{ op: 'trim', clip: d.clip.id, duration: dur }]);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      cancelAnimationFrame(edgeRaf);
      if (scrubRaf) cancelAnimationFrame(scrubRaf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, project, pps, magnetic, snapping]);

  // One stable object for the tracks (its fields are refreshed every render).
  const api = useRef<RowApi>(null as unknown as RowApi);
  api.current = {
    pps,
    project,
    selected,
    selectedIds: selectedIds ?? [],
    onSelect,
    ...(onSelectMany ? { onSelectMany } : {}),
    onTime: (t) => {
      playhead.set(t, false);
      onTime(t);
    },
    onEdit,
    startDrag: (d) => {
      edgeCache.current = null;
      setDrag(d);
    },
    timeAt,
    snap,
    setMenu,
    setCutMenu,
    setEaseMenu,
    setRenaming,
    magnetic,
  };

  /** Clips that overlap on a track go on separate lanes, so each one can be seen and grabbed. */
  const lanes = useMemo(() => {
    const out = new Map<string, { lane: Map<string, number>; count: number }>();
    for (const t of project.tracks) {
      const lane = new Map<string, number>();
      const ends: number[] = [];
      for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
        let i = ends.findIndex((e) => e <= c.start + 1e-6);
        if (i < 0) i = ends.push(0) - 1;
        ends[i] = clipEnd(c);
        lane.set(c.id, i);
      }
      out.set(t.id, { lane, count: ends.length });
    }
    return out;
  }, [project.tracks]);

  // Tracks top to bottom: the highest layer first.
  const rows = [...project.tracks].reverse();
  const mainId = magnetic ? mainTrack(project)?.id ?? null : null;
  const sel = new Set(selectedIds ?? []);
  if (selected) sel.add(selected);
  const clipDrag = drag && drag.kind !== 'scrub' && drag.kind !== 'box' ? drag : null;

  return (
    <div
      className="studio-timeline"
      ref={area}
      style={height ? { height } : undefined}
      onWheel={(e) => {
        const el = area.current!;
        if (!e.ctrlKey) {
          // The wheel moves through time (sideways) when the tracks all fit; with more tracks it moves
          // through them, and Shift + wheel (the browser's own) moves through time.
          const tall = el.scrollHeight > el.clientHeight + 2;
          if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey || tall) return;
          el.scrollLeft += e.deltaY;
          return;
        }
        // Ctrl + wheel (or a trackpad pinch) zooms around the mouse, like other editors.
        if (!onZoom) return;
        const r = el.getBoundingClientRect();
        const at = (e.clientX - r.left - LABEL_W + el.scrollLeft) / pps;
        const factor = Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.006);
        const next = Math.max(4, Math.min(400, Math.round(pps * factor * 10) / 10));
        if (next === pps) return;
        onZoom(next);
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, at * next - (e.clientX - r.left - LABEL_W));
        });
      }}
    >
      <div className="tl-inner" style={{ width: width + LABEL_W }}>
        <Ruler
          pps={pps}
          duration={duration}
          view={view}
          markers={project.markers}
          issues={issues}
          onDown={(e) => {
            const t = timeAt(e.clientX);
            playhead.set(t, false);
            onTime(t);
            pointer.current = { x: e.clientX, y: e.clientY };
            setDrag({ kind: 'scrub' });
          }}
          onGo={(t) => {
            playhead.set(t, false);
            onTime(t);
          }}
          onRemoveMarker={(t) => onEdit([{ op: 'marker', at: t, remove: true }])}
        />
        {rows.map((t) => (
          <TrackRow
            key={t.id}
            track={t}
            api={api}
            pps={pps}
            view={view}
            lanes={lanes.get(t.id)!}
            assets={project.assets}
            selectedKey={t.clips.filter((c) => sel.has(c.id)).map((c) => c.id).join(',')}
            primary={selected && t.clips.some((c) => c.id === selected) ? selected : null}
            drag={clipDrag && (clipDrag.track.id === t.id || (clipDrag.kind === 'move' && clipDrag.targetTrack === t.id)) ? clipDrag : null}
            renaming={renaming === t.id}
            main={mainId === t.id}
          />
        ))}
        <Playhead area={area} pps={pps} time={time} playing={playing} onGrab={(e) => {
          pointer.current = { x: e.clientX, y: e.clientY };
          setDrag({ kind: 'scrub' });
        }} />
        {clipDrag?.snapAt !== null && clipDrag?.snapAt !== undefined && <div className="tl-snapline" style={{ left: LABEL_W + clipDrag.snapAt * pps }} />}
        {clipDrag && Math.abs(clipDrag.dx) > 2 && (
          <div className="tl-tip" style={{ left: clipDrag.px - (area.current?.getBoundingClientRect().left ?? 0) + (area.current?.scrollLeft ?? 0) + 14, top: clipDrag.py - (area.current?.getBoundingClientRect().top ?? 0) + (area.current?.scrollTop ?? 0) - 30 }}>
            {clipDrag.kind === 'move' ? `${fmtClock(clipDrag.value)}` : clipDrag.kind === 'trim-start' ? `${fmtClock(clipDrag.value)} · ${(clipEnd(clipDrag.clip) - clipDrag.value).toFixed(2)} s` : `${(clipDrag.value - clipDrag.clip.start).toFixed(2)} s`}
          </div>
        )}
        {drag?.kind === 'box' && (Math.abs(drag.x1 - drag.x0) > 4 || Math.abs(drag.y1 - drag.y0) > 4) && (() => {
          const r = area.current!.getBoundingClientRect();
          const el = area.current!;
          return (
            <div
              className="tl-box"
              style={{ left: Math.min(drag.x0, drag.x1) - r.left + el.scrollLeft, top: Math.min(drag.y0, drag.y1) - r.top + el.scrollTop, width: Math.abs(drag.x1 - drag.x0), height: Math.abs(drag.y1 - drag.y0) }}
            />
          );
        })()}
        {menu && <TimelineMenu menu={menu} project={project} selectedIds={selectedIds ?? []} time={time} magnetic={magnetic} onEdit={onEdit} onRename={setRenaming} onClose={() => setMenu(null)} />}
        {keo && (
          <>
            {keo.end !== undefined && keo.end > keo.at && <div className={`tl-keo-range ${keo.kind}`} style={{ left: LABEL_W + keo.at * pps, width: Math.max(2, (keo.end - keo.at) * pps) }} />}
            <div className="tl-keo" style={{ left: LABEL_W + keo.at * pps }}>
              <span className="tl-keo-tag">Keo · {keo.label}</span>
            </div>
          </>
        )}
        {easeMenu && easeClip && easeClip.type !== 'audio' && easeClip.type !== 'adjust' && <EaseEditor clip={easeClip} at={easeMenu.at} x={easeMenu.x} y={easeMenu.y} onEdit={onEdit} onClose={() => setEaseMenu(null)} />}
        {cutMenu && (
          <div className="tl-menu" style={{ left: cutMenu.x, top: cutMenu.y }} onPointerDown={(e) => e.stopPropagation()}>
            {TRANSITIONS.map((k) => (
              <button
                key={k}
                onClick={() => {
                  onEdit([{ op: 'set', clip: cutMenu.clip, transition: { kind: k, seconds: k === 'whip' || k === 'flash' ? 0.35 : 0.6 } }]);
                  setCutMenu(null);
                }}
              >
                {TRANSITION_LABEL[k]}
              </button>
            ))}
            <button
              className="none"
              onClick={() => {
                onEdit([{ op: 'set', clip: cutMenu.clip, transition: null }]);
                setCutMenu(null);
              }}
            >
              No transition
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The playhead: follows the preview's clock every frame (no re-render), scrolls the timeline with it while playing, and can be dragged by its head. */
function Playhead({ area, pps, time, playing, onGrab }: { area: React.RefObject<HTMLDivElement | null>; pps: number; time: number; playing: boolean; onGrab: (e: React.PointerEvent) => void }) {
  const line = useRef<HTMLDivElement>(null);
  const live = useRef({ pps, playing });
  live.current = { pps, playing };
  // The timeline's scroll and width, kept up to date by events (reading them every frame would make
  // the browser lay the whole timeline out again each frame).
  const box = useRef({ left: 0, width: 0 });
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const read = () => {
      box.current = { left: el.scrollLeft, width: el.clientWidth };
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      ro.disconnect();
    };
  }, [area]);
  useLayoutEffect(() => {
    const place = (t: number) => {
      const x = LABEL_W + t * live.current.pps;
      if (line.current) line.current.style.transform = `translateX(${x}px)`;
      // While playing, the timeline pages along so the playhead stays in view.
      const el = area.current;
      const b = box.current;
      if (el && live.current.playing && b.width) {
        if (x > b.left + b.width - 48 || x < b.left + LABEL_W) {
          const left = Math.max(0, x - LABEL_W - 60);
          el.scrollLeft = left;
          box.current = { ...b, left };
        }
      }
    };
    place(playhead.get());
    return playhead.subscribe(place);
  }, [area, pps]);
  // Stopped: the playhead is wherever Studio's time is (clicks, keys, Keo's steps).
  useEffect(() => {
    if (!playing) playhead.set(time, false);
  }, [time, playing]);
  return (
    <div ref={line} className="tl-playhead">
      <span className="tl-playhead-head" title="Drag to move through the video" onPointerDown={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onGrab(e);
      }} />
    </div>
  );
}

/** The ruler: only the ticks on screen, spaced to stay readable at any zoom. */
const Ruler = memo(function Ruler({
  pps,
  duration,
  view,
  markers,
  issues,
  onDown,
  onGo,
  onRemoveMarker,
}: {
  pps: number;
  duration: number;
  view: View;
  markers: Project['markers'];
  issues: Array<{ key: string; at: number; detail: string }>;
  onDown: (e: React.PointerEvent) => void;
  onGo: (t: number) => void;
  onRemoveMarker: (t: number) => void;
}) {
  const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => s * pps >= 64) ?? 600;
  const from = Math.max(0, Math.floor(view.x0 / pps / step) * step);
  const to = Math.min(duration + 8, view.x1 / pps);
  const ticks: number[] = [];
  for (let s = from; s <= to && ticks.length < 2000; s += step) ticks.push(Math.round(s * 1000) / 1000);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${step < 1 ? `.${String(Math.round((s % 1) * 100)).padStart(2, '0').slice(0, step < 0.25 ? 2 : 1)}` : ''}`;
  return (
    <div className="tl-ruler" onPointerDown={onDown}>
      <div className="tl-label-gap" />
      {issues.map((x) => (
        <span
          key={x.key}
          className="tl-issue"
          style={{ left: LABEL_W + x.at * pps }}
          title={`${x.detail} (${x.at.toFixed(1)} s) — click to go there`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onGo(x.at + 0.15);
          }}
        />
      ))}
      {markers.map((m, i) => (
        <span
          key={`m${i}-${m.t}`}
          className="tl-marker"
          style={{ left: LABEL_W + m.t * pps }}
          title={`${i + 1}. ${m.label} (${m.t.toFixed(2)} s) — click to go there, double-click to remove`}
          onPointerDown={(e) => {
            e.stopPropagation();
            onGo(m.t);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRemoveMarker(m.t);
          }}
        >
          {i + 1}
        </span>
      ))}
      {ticks.map((s) => (
        <span key={s} className="tl-tick" style={{ left: LABEL_W + s * pps }}>
          {fmt(s)}
        </span>
      ))}
    </div>
  );
});

/** One track: redrawn only when its clips, the zoom, the part on screen, its selection or a drag on it change. */
const TrackRow = memo(function TrackRow({
  track: t,
  api,
  pps,
  view,
  lanes,
  assets,
  selectedKey,
  primary,
  drag,
  renaming,
  main,
}: {
  track: Track;
  api: React.RefObject<RowApi>;
  pps: number;
  view: View;
  lanes: { lane: Map<string, number>; count: number };
  assets: Asset[];
  selectedKey: string;
  primary: string | null;
  drag: Extract<Drag, { clip: Clip }> | null;
  renaming: boolean;
  main: boolean;
}) {
  const a = () => api.current!;
  const sel = new Set(selectedKey ? selectedKey.split(',') : []);
  const rowH = ROW_H[t.kind];
  // The magnetic main track while a clip is dragged over it: the others slide aside live, leaving a
  // slot exactly where it will land (as it will be once dropped).
  const slide = useMemo(() => {
    if (!main || !drag || drag.kind !== 'move' || drag.targetTrack !== t.id) return null;
    const others = t.clips.filter((c) => c.id !== drag.clip.id).sort((p, q) => p.start - q.start);
    // Where the pointer is, like other editors.
    const mid = api.current!.timeAt(drag.px);
    const at = others.filter((c) => c.start + c.duration / 2 < mid).length;
    const place = new Map<string, number>();
    let x = 0;
    others.forEach((c, i) => {
      if (i === at) x += drag.clip.duration;
      place.set(c.id, x);
      x += c.duration;
    });
    const slot = others.slice(0, at).reduce((n, c) => n + c.duration, 0);
    return { place, slot };
  }, [main, drag, t, api]);
  // Dragged off the main track: the clips after it close up live.
  const close = useMemo(() => {
    if (!main || !drag || drag.kind !== 'move' || drag.track.id !== t.id || drag.targetTrack === t.id) return null;
    const place = new Map<string, number>();
    let x = 0;
    for (const c of t.clips.filter((c) => c.id !== drag.clip.id).sort((p, q) => p.start - q.start)) {
      place.set(c.id, x);
      x += c.duration;
    }
    return place;
  }, [main, drag, t]);
  const where = (c: Clip) => {
    let start = slide?.place.get(c.id) ?? close?.get(c.id) ?? c.start;
    let dur = c.duration;
    if (drag && drag.clip.id === c.id) {
      if (drag.kind === 'move') start = drag.value;
      else if (drag.kind === 'trim-start') {
        start = drag.value;
        dur = clipEnd(c) - drag.value;
      } else dur = Math.max(0.1, drag.value - c.start);
    }
    return { left: start * pps, width: Math.max(4, dur * pps), ghost: drag?.kind === 'move' && drag.clip.id === c.id && drag.targetTrack !== t.id };
  };
  const label = (c: Clip) => {
    if (c.type === 'text') return c.counter ? `${c.counter.prefix}${c.counter.to}${c.counter.suffix}` : c.text;
    if (c.type === 'shape') return c.shape[0]!.toUpperCase() + c.shape.slice(1);
    if (c.type === 'adjust') return 'Adjustment';
    if (c.type === 'motion') return `✦ ${c.text}`;
    return assets.find((x) => x.id === c.assetId)?.name ?? 'Media';
  };
  const target = drag?.kind === 'move' && drag.targetTrack === t.id && drag.track.id !== t.id;
  return (
    <div
      className={`tl-row ${t.kind} ${target ? 'drop' : ''} ${main ? 'main' : ''} ${slide || close ? 'sliding' : ''}`}
      style={{ height: rowH * Math.max(1, lanes.count) }}
      data-track={t.id}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-keo-asset') || e.dataTransfer.types.includes('application/x-keo-text')) e.preventDefault();
      }}
      onDrop={(e) => {
        const x = a();
        if (e.dataTransfer.types.includes('application/x-keo-text')) {
          e.preventDefault();
          x.onEdit([{ op: 'add_text', text: 'Your text', start: x.snap(x.timeAt(e.clientX), ''), duration: 3, ...(t.kind === 'text' ? { track: t.id } : {}) }]);
          return;
        }
        const assetId = e.dataTransfer.getData('application/x-keo-asset');
        const asset = x.project.assets.find((y) => y.id === assetId);
        if (!asset) return;
        e.preventDefault();
        const at = x.timeAt(e.clientX);
        if (asset.kind === 'audio' || (t.kind === 'audio' && asset.hasAudio)) {
          x.onEdit([{ op: 'add_audio', assetId, start: x.snap(at, ''), ...(t.kind === 'audio' ? { track: t.id } : {}) }]);
          return;
        }
        if (t.kind === 'video' && main) {
          // The magnetic main track: the new clip goes in at the nearest cut, the rest moves along.
          const clips = [...t.clips].sort((p, q) => p.start - q.start);
          const len = asset.kind === 'image' ? 3 : Math.max(0.1, asset.duration);
          const cuts = [0, ...clips.map((c) => clipEnd(c))];
          const cut = cuts.reduce((best, c) => (Math.abs(c - at) < Math.abs(best - at) ? c : best), cuts.at(-1)!);
          const shift = clips.filter((c) => c.start >= cut - 1e-3).map((c) => ({ op: 'move' as const, clip: c.id, start: Math.round((c.start + len) * 1000) / 1000 }));
          x.onEdit([...shift, { op: 'add_media', assetId, start: cut, track: t.id, ...(asset.kind === 'image' ? { duration: len } : {}) }]);
          return;
        }
        const start = x.snap(at, '');
        if (t.kind === 'video') x.onEdit([{ op: 'add_media', assetId, start, track: t.id }]);
        else x.onEdit([{ op: 'add_media', assetId, start }]);
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.tl-clip, .tl-head')) return;
        a().startDrag({ kind: 'box', x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: e.shiftKey || e.ctrlKey });
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.tl-clip')) return;
        e.preventDefault();
        a().setMenu({ x: e.clientX, y: e.clientY, at: a().timeAt(e.clientX), track: t.id });
      }}
    >
      <div
        className="tl-head"
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          a().setMenu({ x: e.clientX, y: e.clientY, at: playhead.get(), track: t.id });
        }}
      >
        <Icon name={t.kind === 'video' ? 'film' : t.kind === 'text' ? 'text' : 'music'} size={14} />
        {renaming ? (
          <input
            className="tl-rename"
            autoFocus
            defaultValue={t.name}
            maxLength={60}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') a().setRenaming(null);
              e.stopPropagation();
            }}
            onBlur={(e) => {
              const name = e.target.value.trim();
              a().setRenaming(null);
              if (name && name !== t.name) a().onEdit([{ op: 'set_track', track: t.id, name }]);
            }}
          />
        ) : (
          <span className="grow" onDoubleClick={() => a().setRenaming(t.id)} title={main ? 'The main track (magnetic: clips stay end to end). Double-click to rename; right-click for more' : 'Double-click to rename; right-click for more'}>
            {t.name}
          </span>
        )}
        {main && <span className="tl-main-tag" title="Magnetic main track">⚲</span>}
        {t.kind !== 'audio' && (
          <button className="tl-btn" title={t.hidden ? 'Show this track' : 'Hide this track'} onClick={() => a().onEdit([{ op: 'set_track', track: t.id, hidden: !t.hidden }])}>
            <Icon name={t.hidden ? 'eyeoff' : 'eye'} size={13} />
          </button>
        )}
        {t.kind !== 'text' && (
          <button className="tl-btn" title={t.muted ? 'Unmute' : 'Mute'} onClick={() => a().onEdit([{ op: 'set_track', track: t.id, muted: !t.muted }])}>
            <Icon name={t.muted ? 'mute' : 'speaker'} size={13} />
          </button>
        )}
        <button className={`tl-btn ${t.locked ? 'on' : ''}`} title={t.locked ? 'Unlock this track' : 'Lock this track (its clips cannot be moved or changed)'} onClick={() => a().onEdit([{ op: 'set_track', track: t.id, locked: !t.locked }])}>
          <Icon name={t.locked ? 'lock' : 'unlock'} size={13} />
        </button>
      </div>
      {slide && drag && <div className="tl-slot" style={{ left: LABEL_W + slide.slot * pps, width: Math.max(4, drag.clip.duration * pps), top: 4, height: rowH - 8 }} />}
      {t.kind === 'video' &&
        !slide &&
        t.clips.map((c) => {
          if (c.type !== 'media') return null;
          const prev = t.clips.find((o) => o.type === 'media' && o.id !== c.id && Math.abs(clipEnd(o) - c.start) < 0.05);
          if (!prev) return null;
          const x = c.start * pps;
          if (x < view.x0 || x > view.x1) return null;
          const lane = lanes.lane.get(c.id) ?? 0;
          return (
            <button
              key={`cut-${c.id}`}
              className={`tl-cut ${c.transition ? 'on' : ''}`}
              style={{ left: LABEL_W + x, top: 4 + lane * rowH + 2 }}
              title={c.transition ? `Transition: ${TRANSITION_LABEL[c.transition.kind]} (${c.transition.seconds}s) — click to change` : 'Add a transition here'}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                a().setCutMenu({ clip: c.id, x: e.clientX, y: e.clientY });
              }}
            >
              {c.transition ? '⧓' : '+'}
            </button>
          );
        })}
      {t.clips.map((c) => {
        const w = where(c);
        // Off screen (and not being dragged): not drawn at all.
        if ((w.left + w.width < view.x0 || w.left > view.x1) && drag?.clip.id !== c.id) return null;
        const lane = lanes.lane.get(c.id) ?? 0;
        const isSel = sel.has(c.id);
        return (
          <div
            key={c.id}
            data-clip={c.id}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (!a().selectedIds.includes(c.id)) a().onSelect(c.id);
              a().setMenu({ x: e.clientX, y: e.clientY, at: a().timeAt(e.clientX), clip: c.id, track: t.id });
            }}
            className={`tl-clip ${c.type} ${isSel ? 'sel' : ''} ${w.ghost ? 'ghost' : ''} ${drag?.clip.id === c.id ? 'dragging' : ''} ${t.hidden ? 'hidden' : ''} ${t.locked ? 'locked' : ''} ${c.group ? 'grouped' : ''}`}
            style={{ left: LABEL_W + w.left, width: w.width, top: 4 + lane * rowH, height: rowH - 8, bottom: 'auto' }}
            title={`${label(c)} · ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s`}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (e.button !== 0) return;
              const x = a();
              if (e.shiftKey || e.ctrlKey) {
                x.onSelect(c.id, true);
                return;
              }
              if (c.group && x.onSelectMany) {
                // A grouped clip selects its whole group (the clicked clip last, for the inspector).
                const members = x.project.tracks.flatMap((tr) => tr.clips.filter((o) => o.group === c.group && o.id !== c.id).map((o) => o.id));
                x.onSelectMany([...members, c.id]);
              } else if (!x.selectedIds.includes(c.id) || x.selectedIds.length < 2) x.onSelect(c.id);
              if (t.locked) return;
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const edge = e.clientX - r.left < 8 ? 'trim-start' : r.right - e.clientX < 8 ? 'trim-end' : 'move';
              const scroll0 = (e.currentTarget as HTMLElement).closest('.studio-timeline')?.scrollLeft ?? 0;
              const base = { clip: c, track: t, startX: e.clientX, scroll0, dx: 0, snapAt: null, px: e.clientX, py: e.clientY };
              if (edge === 'move') x.startDrag({ kind: 'move', targetTrack: t.id, value: c.start, ...base });
              else x.startDrag({ kind: edge, value: edge === 'trim-start' ? c.start : clipEnd(c), ...base });
            }}
          >
            {(c.type === 'media' || c.type === 'audio') && <ClipBody projectId={a().project.id} clip={c} asset={assets.find((x) => x.id === c.assetId)} left={w.left} width={w.width} view={view} pps={pps} height={rowH - 8} />}
            {(c.type === 'media' || c.type === 'audio') && primary === c.id && <FadeHandles clip={c} pps={pps} onEdit={(ops) => a().onEdit(ops)} />}
            {c.type !== 'audio' &&
              c.type !== 'adjust' &&
              !!c.keys &&
              [...new Set(Object.values(c.keys).flatMap((list) => (list ?? []).map((k) => k.at)))]
                .filter((at) => at <= c.duration + 1e-6)
                .slice(0, 200)
                .map((at) => (
                  <span
                    key={at}
                    className="tl-key"
                    style={{ left: at * pps }}
                    title={`Keyframe at ${(c.start + at).toFixed(2)} s — click to go there, double-click to change how it eases in`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      a().onSelect(c.id);
                      a().onTime(c.start + at);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      a().setEaseMenu({ clip: c.id, at, x: e.clientX, y: e.clientY });
                    }}
                  />
                ))}
            <span className="tl-clip-label">{label(c)}</span>
          </div>
        );
      })}
    </div>
  );
});

/** What a video or sound clip looks like on the timeline: its frames and the shape of its sound, drawn only for the part on screen. */
const ClipBody = memo(function ClipBody({ projectId, clip, asset, left, width, view, pps, height }: { projectId: string; clip: Extract<Clip, { type: 'media' | 'audio' }>; asset: Asset | undefined; left: number; width: number; view: View; pps: number; height: number }) {
  const strip = useFilmstrip(projectId, asset);
  const wave = useWaveform(projectId, asset);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rate = clip.type === 'media' ? clip.speed : 1;
  const waveH = clip.type === 'audio' ? height : Math.round(height * 0.32);
  // The part of the clip on screen (in the clip's own pixels).
  const from = Math.max(0, Math.floor(view.x0 - left));
  const to = Math.min(Math.round(width), Math.ceil(view.x1 - left));
  const w = Math.max(1, to - from);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !wave || to <= from) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(waveH * dpr);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = clip.type === 'audio' ? 'rgba(190, 255, 220, 0.75)' : 'rgba(170, 220, 255, 0.7)';
    const mid = clip.type === 'audio' ? c.height / 2 : c.height;
    for (let x = 0; x < c.width; x++) {
      const t = clip.in + ((from + x / dpr) / pps) * rate;
      const v = wave[Math.floor(t * 50)] ?? 0;
      const hh = Math.max(dpr, v * (clip.type === 'audio' ? c.height / 2 : c.height));
      ctx.fillRect(x, mid - hh, 1, clip.type === 'audio' ? hh * 2 : hh);
    }
  }, [wave, w, from, to, waveH, pps, rate, clip.in, clip.type]);
  const tiles: Array<{ x: number; src: string }> = [];
  if (strip && clip.type === 'media' && to > from) {
    const tileW = Math.max(16, height * strip.aspect);
    for (let x = Math.floor(from / tileW) * tileW; x < to; x += tileW) {
      const t = clip.in + (x / pps) * rate;
      const i = strip.step === Infinity ? 0 : Math.max(0, Math.min(strip.frames.length - 1, Math.floor(t / strip.step)));
      tiles.push({ x, src: strip.frames[i]! });
    }
  }
  return (
    <div className="tl-body" aria-hidden>
      {tiles.map((tile) => (
        <img key={tile.x} src={tile.src} alt="" draggable={false} style={{ left: tile.x, height }} />
      ))}
      {wave && to > from && <canvas ref={canvas} className={clip.type === 'audio' ? 'tl-wave full' : 'tl-wave'} style={{ left: from, width: w, height: waveH }} />}
      {clip.volumeKeys?.length && to > from ? (
        // The volume over the clip: 100% halfway up, 200% and more at the top.
        <svg className="tl-vol" width={w} height={height} style={{ left: from }}>
          <polyline
            points={Array.from({ length: Math.ceil(w / 4) + 1 }, (_, i) => {
              const x = Math.min(w, i * 4);
              return `${x},${(height - 2 - (Math.min(2, volumeAt(clip, (from + x) / pps)) / 2) * (height - 4)).toFixed(1)}`;
            }).join(' ')}
          />
        </svg>
      ) : null}
      {clip.type === 'audio' &&
        asset?.beats
          ?.filter((b) => b >= clip.in && b <= clip.in + clip.duration)
          .map((b) => (b - clip.in) * pps)
          .filter((x) => x >= from && x <= to)
          .slice(0, 2000)
          .map((x) => <span key={x} className="tl-beat" style={{ left: x }} />)}
    </div>
  );
});

/** Fade in / fade out: drag the dots at the clip's top corners; the shaded part fades. */
function FadeHandles({ clip, pps, onEdit }: { clip: Extract<Clip, { type: 'media' | 'audio' }>; pps: number; onEdit: (ops: EditOp[]) => void }) {
  const [live, setLive] = useState<{ fadeIn: number; fadeOut: number } | null>(null);
  const fi = live?.fadeIn ?? clip.fadeIn;
  const fo = live?.fadeOut ?? clip.fadeOut;
  const max = Math.max(0, clip.duration / 2);
  const drag = (which: 'fadeIn' | 'fadeOut', e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const x0 = e.clientX;
    const v0 = clip[which];
    let v = v0;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / pps;
      v = Math.round(Math.max(0, Math.min(max, v0 + (which === 'fadeIn' ? dx : -dx))) * 100) / 100;
      setLive({ fadeIn: which === 'fadeIn' ? v : clip.fadeIn, fadeOut: which === 'fadeOut' ? v : clip.fadeOut });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (Math.abs(v - v0) > 0.01) onEdit([{ op: 'set', clip: clip.id, [which]: v }]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <>
      {fi > 0 && <span className="tl-fade-area in" style={{ width: fi * pps }} />}
      {fo > 0 && <span className="tl-fade-area out" style={{ width: fo * pps }} />}
      <span className="tl-fade-dot" style={{ left: Math.max(2, fi * pps - 5) }} title={`Fade in: ${fi.toFixed(2)} s (drag)`} onPointerDown={(e) => drag('fadeIn', e)} />
      <span className="tl-fade-dot" style={{ right: Math.max(2, fo * pps - 5) }} title={`Fade out: ${fo.toFixed(2)} s (drag)`} onPointerDown={(e) => drag('fadeOut', e)} />
    </>
  );
}

/** The right-click menu of the timeline: what can be done to this clip, this track or at this moment. */
function TimelineMenu({ menu, project, selectedIds, time, magnetic, onEdit, onRename, onClose }: { menu: Menu; project: Project; selectedIds: string[]; time: number; magnetic: boolean; onEdit: (ops: EditOp[]) => void; onRename: (track: string) => void; onClose: () => void }) {
  const found = menu.clip ? findClip(project, menu.clip) : undefined;
  const c = found?.clip;
  const track = project.tracks.find((t) => t.id === menu.track);
  const ids = c && selectedIds.includes(c.id) ? selectedIds : c ? [c.id] : [];
  const at = Math.max(0, menu.at);
  const items: Array<{ label: string; key?: string; run: () => void; off?: boolean } | 'sep'> = [];
  if (c) {
    const inside = (t: number) => t > c.start + 0.04 && t < clipEnd(c) - 0.04;
    const splitAt = inside(time) ? time : at;
    items.push({ label: 'Split here', key: 'S', off: !inside(splitAt), run: () => onEdit([{ op: 'split', clip: c.id, at: splitAt }]) });
    items.push({ label: 'Trim start to playhead', key: 'Q', off: !inside(time), run: () => onEdit([{ op: 'trim', clip: c.id, trimStart: time - c.start }]) });
    items.push({ label: 'Trim end to playhead', key: 'W', off: !inside(time), run: () => onEdit([{ op: 'trim', clip: c.id, duration: time - c.start }]) });
    items.push('sep');
    items.push({ label: ids.length > 1 ? `Duplicate ${ids.length} clips` : 'Duplicate', key: 'Ctrl+D', run: () => onEdit(ids.map((id) => ({ op: 'duplicate' as const, clip: id }))) });
    if (ids.length >= 2) items.push({ label: 'Group', key: 'Ctrl+G', run: () => onEdit([{ op: 'group', clips: ids }]) });
    if (c.group) items.push({ label: 'Ungroup', key: 'Ctrl+Shift+G', run: () => onEdit([{ op: 'ungroup', clip: c.id }]) });
    if (c.type === 'media') {
      items.push('sep');
      for (const sp of [0.5, 1, 1.5, 2]) items.push({ label: `Speed ${sp}×${c.speed === sp ? '  ✓' : ''}`, run: () => onEdit([{ op: 'set', clip: c.id, speed: sp }]) });
      if (c.volume > 0 && project.assets.find((a) => a.id === c.assetId)?.hasAudio) items.push({ label: 'Detach audio', run: () => onEdit([{ op: 'detach_audio', clip: c.id }]) });
    }
    if (c.type === 'media' || c.type === 'audio') items.push({ label: c.volume === 0 ? 'Unmute clip' : 'Mute clip', run: () => onEdit([{ op: 'set', clip: c.id, volume: c.volume === 0 ? 1 : 0 }]) });
    items.push('sep');
    // On the magnetic main track a delete closes the gap (like the rest of its edits).
    const onMain = magnetic && ids.every((id) => mainTrack(project)?.clips.some((x) => x.id === id));
    items.push({ label: ids.length > 1 ? `Delete ${ids.length} clips` : 'Delete', key: 'Del', run: () => onEdit(ids.map((id) => ({ op: 'delete' as const, clip: id, ...(onMain ? { ripple: true } : {}) }))) });
    items.push({ label: 'Delete and close the gap', key: 'Shift+Del', run: () => onEdit(ids.map((id) => ({ op: 'delete' as const, clip: id, ripple: true }))) });
  } else if (track) {
    const i = project.tracks.indexOf(track);
    items.push({ label: 'Add a marker here', key: 'M', run: () => onEdit([{ op: 'marker', at }]) });
    if (track.kind === 'text') items.push({ label: 'Add text here', run: () => onEdit([{ op: 'add_text', text: 'Your text', start: at, duration: 3, track: track.id }]) });
    items.push('sep');
    items.push({ label: 'Rename track', run: () => onRename(track.id) });
    items.push({ label: 'Move track up (in front)', off: i >= project.tracks.length - 1, run: () => onEdit([{ op: 'set_track', track: track.id, position: 'up' }]) });
    items.push({ label: 'Move track down (behind)', off: i <= 0, run: () => onEdit([{ op: 'set_track', track: track.id, position: 'down' }]) });
    if (track.kind !== 'audio') items.push({ label: track.hidden ? 'Show track' : 'Hide track', run: () => onEdit([{ op: 'set_track', track: track.id, hidden: !track.hidden }]) });
    if (track.kind !== 'text') items.push({ label: track.muted ? 'Unmute track' : 'Mute track', run: () => onEdit([{ op: 'set_track', track: track.id, muted: !track.muted }]) });
    items.push({ label: track.locked ? 'Unlock track' : 'Lock track', run: () => onEdit([{ op: 'set_track', track: track.id, locked: !track.locked }]) });
    items.push('sep');
    items.push({ label: 'New video / overlay track', run: () => onEdit([{ op: 'add_track', kind: 'video' }]) });
    items.push({ label: 'New text track', run: () => onEdit([{ op: 'add_track', kind: 'text' }]) });
    items.push({ label: 'New audio track', run: () => onEdit([{ op: 'add_track', kind: 'audio' }]) });
    items.push('sep');
    items.push({ label: track.clips.length ? `Delete track and its ${track.clips.length} clip${track.clips.length === 1 ? '' : 's'}` : 'Delete track', run: () => onEdit([{ op: 'delete_track', track: track.id }]) });
  }
  // Kept on screen near the edges.
  const x = Math.min(menu.x, window.innerWidth - 250);
  const y = Math.min(menu.y, window.innerHeight - 24 * items.length - 20);
  return (
    <div className="tl-ctx" role="menu" style={{ left: x, top: Math.max(8, y) }} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((it, n) =>
        it === 'sep' ? (
          <hr key={n} />
        ) : (
          <button
            key={n}
            role="menuitem"
            disabled={it.off}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            <span className="grow">{it.label}</span>
            {it.key && <kbd>{it.key}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
