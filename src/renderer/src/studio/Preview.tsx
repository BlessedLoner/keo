import { useEffect, useRef, useState } from 'react';
import { playhead } from './playhead';
import { findClip, projectDuration, type EditOp, type Project } from '@shared/studio';
import { baseOf, placeOps, type Base } from '@shared/studioPlacing';
import { drawFrame, fontsReady, layerBoxes, type LayerBox } from './engine';
import { PreviewSources } from './media';

/**
 * The Studio's live preview: the project drawn by Keo's picture engine at the playhead, with the
 * clips' media playing in step while it plays. When paused, layers can be picked, moved, resized
 * and rotated right on the picture (with guides that snap to the middle, the thirds, a safe margin
 * and the other layers' edges and centres).
 */

/** Drag a box on the preview (for choosing what to follow). */
function BoxPicker({ onDone }: { onDone: (box: { x: number; y: number; w: number; h: number } | null) => void }) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const at = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) };
  };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onDone(null);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onDone]);
  const b = drag && { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) };
  return (
    <div
      className="box-picker"
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const p = at(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = at(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={() => {
        if (b && b.w > 0.02 && b.h > 0.02) onDone(b);
        setDrag(null);
      }}
    >
      {!b && <span className="box-picker-tip">Drag a box around what to follow · Esc to cancel</span>}
      {b && <span className="box-picker-box" style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }} />}
    </div>
  );
}

export type Guides = 'none' | 'tiktok' | 'reels' | 'shorts' | 'thirds';

/** Areas covered by each app's buttons and captions on a phone (fractions of a 9:16 frame). */
const ZONES: Record<'tiktok' | 'reels' | 'shorts', Array<{ x: number; y: number; w: number; h: number; label: string }>> = {
  tiktok: [
    { x: 0, y: 0, w: 1, h: 0.08, label: 'Tabs' },
    { x: 0.86, y: 0.33, w: 0.14, h: 0.52, label: 'Buttons' },
    { x: 0, y: 0.8, w: 0.84, h: 0.2, label: 'Caption & name' },
  ],
  reels: [
    { x: 0.86, y: 0.5, w: 0.14, h: 0.4, label: 'Buttons' },
    { x: 0, y: 0.82, w: 0.84, h: 0.18, label: 'Caption & name' },
  ],
  shorts: [
    { x: 0, y: 0, w: 1, h: 0.07, label: 'Top bar' },
    { x: 0.85, y: 0.45, w: 0.15, h: 0.43, label: 'Buttons' },
    { x: 0, y: 0.83, w: 0.83, h: 0.17, label: 'Title & channel' },
  ],
};

/** Where a social app will cover the video (vertical videos), or the rule of thirds. */
function SafeZones({ kind, vertical }: { kind: Exclude<Guides, 'none'>; vertical: boolean }) {
  if (kind === 'thirds' || !vertical)
    return (
      <div className="safe-zones thirds" aria-hidden>
        <span style={{ left: '33.33%' }} className="v" />
        <span style={{ left: '66.66%' }} className="v" />
        <span style={{ top: '33.33%' }} className="h" />
        <span style={{ top: '66.66%' }} className="h" />
      </div>
    );
  return (
    <div className="safe-zones" aria-hidden>
      {ZONES[kind].map((z) => (
        <span key={z.label} className="zone" style={{ left: `${z.x * 100}%`, top: `${z.y * 100}%`, width: `${z.w * 100}%`, height: `${z.h * 100}%` }}>
          {z.label}
        </span>
      ))}
    </div>
  );
}

/** How the preview is keeping up (frames drawn, frames that waited for video, players in use): read by Keo's own checks. */
const stats = { drawn: 0, held: 0, longestHoldMs: 0, elements: 0 };
(window as unknown as { __keoPreview?: typeof stats }).__keoPreview = stats;

type Gesture = { id: string; kind: 'move' | 'scale' | 'rotate' | 'width'; startX: number; startY: number; box: LayerBox; base: Base };
type Patch = { id: string; x?: number; y?: number; scale?: number; rotation?: number; maxWidth?: number };

function inside(b: LayerBox, x: number, y: number): boolean {
  const a = (-b.rotation * Math.PI) / 180;
  const dx = x - b.cx;
  const dy = y - b.cy;
  const rx = dx * Math.cos(a) - dy * Math.sin(a);
  const ry = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(rx) <= b.w / 2 && Math.abs(ry) <= b.h / 2;
}

export function Preview({
  project,
  time,
  playing,
  onTime,
  onEnd,
  selected,
  onSelect,
  onEdit,
  quality = 1,
  guides = 'none',
  pickBox,
  flagged = [],
}: {
  /** Clips Keo's edit check flagged: outlined in red while they are on screen. */
  flagged?: string[];
  /** While set, dragging on the preview draws a box (fractions of the frame), handed over when let go (null: cancelled). */
  pickBox?: (box: { x: number; y: number; w: number; h: number } | null) => void;
  /** Fewer pixels for smooth playback on slower PCs (1 = full). */
  quality?: number;
  /** Where social apps put their buttons and captions, or the rule of thirds. */
  guides?: Guides;
  project: Project;
  time: number;
  playing: boolean;
  onTime: (t: number) => void;
  onEnd: () => void;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
  onEdit?: (ops: EditOp[]) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const sources = useRef<PreviewSources | null>(null);
  const live = useRef({ project, time, playing });
  live.current = { project, time, playing };
  const redraw = useRef<() => void>(() => undefined);
  /** Something has been drawn already (until then a missing frame is drawn as it is). */
  const drawn = useRef(false);
  const waiting = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0, scale: 1 });
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;
  const [patch, setPatch] = useState<Patch | null>(null);
  // After a drag, the layer is drawn where it was put until the project comes back changed.
  const holding = useRef<number | null>(null);
  useEffect(() => {
    if (gestureRef.current) return;
    if (holding.current) window.clearTimeout(holding.current);
    holding.current = null;
    setPatch(null);
  }, [project]);
  /** Guide lines shown while dragging (canvas pixels), where the layer snapped. */
  const [snap, setGuides] = useState<{ v: number | null; h: number | null }>({ v: null, h: null });
  const guideMode = guides;

  // While a layer is being moved, the preview draws it where the mouse is.
  const shown = (() => {
    if (!patch) return project;
    const p = structuredClone(project);
    const f = findClip(p, patch.id);
    if (f && f.clip.type !== 'audio' && f.clip.type !== 'adjust') {
      const c = f.clip;
      for (const k of ['x', 'y', 'scale', 'rotation'] as const) {
        if (patch[k] === undefined) continue;
        c.transform[k] = patch[k]!;
        if (c.keys?.[k]) delete c.keys[k];
      }
      if (patch.maxWidth !== undefined && c.type === 'text') c.style.maxWidth = patch.maxWidth;
    }
    return p;
  })();
  live.current.project = shown;

  // The fonts its text uses: drawn again once they are loaded.
  useEffect(() => {
    void fontsReady(project).then(() => redraw.current());
  }, [project]);

  // Media for this project (made again when another project opens).
  useEffect(() => {
    const s = new PreviewSources(project.id, () => redraw.current());
    sources.current = s;
    return () => {
      s.dispose();
      if (sources.current === s) sources.current = null;
    };
  }, [project.id]);

  // The canvas keeps the project's shape and fits its box.
  useEffect(() => {
    const el = box.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      const ar = project.width / project.height;
      let w = width - 28;
      let h = w / ar;
      if (h > height - 28) {
        h = height - 28;
        w = h * ar;
      }
      w = Math.max(16, w);
      h = Math.max(16, h);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.style.width = `${Math.floor(w)}px`;
      c.style.height = `${Math.floor(h)}px`;
      // Never more pixels than the export itself.
      const scale = Math.max(0.15, Math.min(dpr, project.width / Math.max(1, w)) * quality);
      c.width = Math.max(16, Math.round(w * scale));
      c.height = Math.max(16, Math.round(h * scale));
      setSize({ w: Math.floor(w), h: Math.floor(h), scale: c.width / Math.max(1, Math.floor(w)) });
      redraw.current();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height, quality]);

  redraw.current = () => {
    const c = canvas.current;
    const s = sources.current;
    if (!c || !s) return;
    const ctx = c.getContext('2d');
    // A video frame still on its way: keep the last picture rather than flash an empty frame
    // (it is drawn as soon as the frame arrives).
    if (drawn.current && s.missing(live.current.project, live.current.time)) {
      stats.held++;
      if (waiting.current === null) {
        waiting.current = performance.now();
        // Paused, nothing else may ask again: look once more when the moment is over.
        setTimeout(() => redraw.current(), 450);
      }
      // Never longer than a moment (a video that cannot play at all is drawn without its picture).
      if (performance.now() - waiting.current < 400) return;
    }
    if (waiting.current !== null) stats.longestHoldMs = Math.max(stats.longestHoldMs, performance.now() - waiting.current);
    waiting.current = null;
    stats.drawn++;
    stats.elements = s.elementCount();
    if (ctx) {
      drawFrame(ctx, live.current.project, live.current.time, s);
      drawn.current = true;
    }
  };

  // Paused: show the playhead's frame (and put the media there).
  useEffect(() => {
    if (playing) return;
    sources.current?.prune(project);
    sources.current?.sync(shown, time, false);
    redraw.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, time, playing, patch]);

  // Playing: a clock from where play started, the media in step, a frame per screen refresh.
  useEffect(() => {
    if (!playing) {
      sources.current?.pauseAll();
      playhead.set(live.current.time, false);
      return;
    }
    const startAt = performance.now();
    const from = live.current.time;
    const end = projectDuration(live.current.project);
    let raf = 0;
    let lastReport = performance.now();
    // The last time told to Studio, and the clock's own time (Studio is told only a few times a
    // second while playing: the playhead and readout follow the clock itself).
    let told = from;
    let clock = from;
    const tick = () => {
      const t = from + (performance.now() - startAt) / 1000;
      if (t >= end) {
        onTime(end);
        onEnd();
        return;
      }
      live.current.time = t;
      clock = t;
      // The timeline's playhead and the time readout follow every frame.
      playhead.set(t, true);
      sources.current?.sync(live.current.project, t, true);
      redraw.current();
      if (performance.now() - lastReport > 400) {
        lastReport = performance.now();
        told = t;
        onTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Stopped: Studio gets the exact time — unless something else (a click on the timeline) has
      // just set a new one.
      if (Math.abs(live.current.time - told) < 1e-6 || live.current.time === clock) {
        if (Math.abs(clock - told) > 1e-6) onTime(clock);
      }
    };
    // Restart the clock only when play starts or stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  // Where the layers are on screen (canvas pixels), for picking and handles.
  const boxes = (() => {
    const c = canvas.current;
    if (!c || playing || (!onSelect && !flagged.length)) return [];
    const ctx = c.getContext('2d');
    return ctx ? layerBoxes(ctx, shown, time, c.width, c.height) : [];
  })();
  const k = size.scale || 1;
  const sel = boxes.find((b) => b.id === selected) ?? null;

  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * canvas.current!.width, y: ((e.clientY - r.top) / r.height) * canvas.current!.height };
  };

  useEffect(() => {
    if (!gesture) return;
    const c = canvas.current!;
    const W = c.width;
    const H = c.height;
    const snapPx = 8 * k;
    const move = (e: PointerEvent) => {
      const p = toCanvas(e);
      const g = gesture;
      if (g.kind === 'move') {
        const raw = { x: g.box.cx + (p.x - g.startX), y: g.box.cy + (p.y - g.startY) };
        // Shift: straight along one axis.
        if (e.shiftKey) {
          if (Math.abs(p.x - g.startX) > Math.abs(p.y - g.startY)) raw.y = g.box.cy;
          else raw.x = g.box.cx;
        }
        // Alt: no snapping. Else the nearest line within reach: the middle, thirds, a safe margin, other layers.
        const others = boxes.filter((b) => b.id !== g.id);
        const lines = (size: number, pick: (b: LayerBox) => number[]) => [size / 2, size / 3, (size * 2) / 3, size * 0.06, size * 0.94, ...others.flatMap(pick)];
        const snapAxis = (c: number, half: number, ls: number[]) => {
          let best: { d: number; line: number; c: number } | null = null;
          if (!e.altKey)
            for (const line of ls)
              for (const off of [-half, 0, half]) {
                const d = Math.abs(c + off - line);
                if (d < snapPx && (!best || d < best.d)) best = { d, line, c: line - off };
              }
          return best;
        };
        const hw = g.box.w / 2;
        const hh = g.box.h / 2;
        const sx = snapAxis(raw.x, hw, lines(W, (b) => [b.cx - b.w / 2, b.cx, b.cx + b.w / 2]));
        const sy = snapAxis(raw.y, hh, lines(H, (b) => [b.cy - b.h / 2, b.cy, b.cy + b.h / 2]));
        setGuides({ v: sx ? sx.line : null, h: sy ? sy.line : null });
        // The layer's own position moves by as much as its box did (its box's middle is not always
        // its anchor: aligned text, captions, a clip mid-animation).
        const cx = sx ? sx.c : raw.x;
        const cy = sy ? sy.c : raw.y;
        setPatch({ id: g.id, x: g.base.x + (cx - g.box.cx) / W, y: g.base.y + (cy - g.box.cy) / H });
      } else if (g.kind === 'scale') {
        const d0 = Math.hypot(g.startX - g.box.cx, g.startY - g.box.cy);
        const d1 = Math.hypot(p.x - g.box.cx, p.y - g.box.cy);
        setPatch({ id: g.id, scale: Math.round(Math.max(0.02, Math.min(20, g.base.scale * (d1 / Math.max(1, d0)))) * 1000) / 1000 });
      } else if (g.kind === 'width') {
        // How wide a line of text may be: the pointer's distance from the middle, along the text.
        const a = (-g.box.rotation * Math.PI) / 180;
        const along = Math.abs((p.x - g.box.cx) * Math.cos(a) - (p.y - g.box.cy) * Math.sin(a));
        const startAlong = Math.max(4, Math.abs((g.startX - g.box.cx) * Math.cos(a) - (g.startY - g.box.cy) * Math.sin(a)));
        setPatch({ id: g.id, maxWidth: Math.round(Math.max(0.1, Math.min(6, g.base.maxWidth * (along / startAlong))) * 1000) / 1000 });
      } else {
        const a0 = Math.atan2(g.startY - g.box.cy, g.startX - g.box.cx);
        const a1 = Math.atan2(p.y - g.box.cy, p.x - g.box.cx);
        let deg = g.base.rotation + ((a1 - a0) * 180) / Math.PI;
        // Snaps to straight (0, 90, 180…) within 4 degrees; Shift: 15-degree steps.
        const r = ((deg % 90) + 90) % 90;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        else if (r < 4 || r > 86) deg = Math.round(deg / 90) * 90;
        setPatch({ id: g.id, rotation: Math.round(deg * 10) / 10 });
      }
    };
    const up = () => {
      setGuides({ v: null, h: null });
      setGesture(null);
      // The layer stays where it was put until the edit comes back (no flash of the old place).
      setPatch((pt) => {
        if (pt && onEdit) {
          const f = findClip(project, pt.id);
          if (f) {
            const { id: _id, maxWidth, ...v } = pt;
            const ops = placeOps(f.clip, time - f.clip.start, project.fps, v, gesture.base, maxWidth);
            if (ops.length) {
              onEdit(ops);
              holding.current = window.setTimeout(() => setPatch(null), 2500);
              return pt;
            }
          }
        }
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture]);

  const start = (kind: Gesture['kind'], b: LayerBox, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const f = findClip(project, b.id);
    if (!f || f.clip.type === 'audio' || f.clip.type === 'adjust') return;
    if (holding.current) window.clearTimeout(holding.current);
    setPatch(null);
    const p = toCanvas(e);
    setGesture({ id: b.id, kind, startX: p.x, startY: p.y, box: b, base: baseOf(f.clip, time - f.clip.start) });
  };

  return (
    <div className="studio-preview" ref={box}>
      <div className="preview-frame" style={{ width: size.w || undefined, height: size.h || undefined }}>
        <canvas ref={canvas} aria-label="Video preview" />
        {guideMode !== 'none' && <SafeZones kind={guideMode} vertical={project.height > project.width} />}
        {pickBox && <BoxPicker onDone={pickBox} />}
        {!playing &&
          boxes
            .filter((b) => flagged.includes(b.id) && b.id !== selected)
            .map((b) => <div key={`flag-${b.id}`} className="flag-box" aria-hidden style={{ left: b.cx / k, top: b.cy / k, width: b.w / k, height: b.h / k, transform: `translate(-50%, -50%) rotate(${b.rotation}deg)` }} />)}
        {onSelect && !playing && (
          <div
            className="preview-overlay"
            onPointerDown={(e) => {
              const p = toCanvas(e);
              const hit = [...boxes].reverse().find((b) => inside(b, p.x, p.y));
              onSelect(hit?.id ?? null);
              if (hit) start('move', hit, e);
            }}
          >
            {snap.v !== null && <div className="guide v" style={{ left: snap.v / k }} />}
            {snap.h !== null && <div className="guide h" style={{ top: snap.h / k }} />}
            {sel && (
              <div className="sel-box" style={{ left: sel.cx / k, top: sel.cy / k, width: sel.w / k, height: sel.h / k, transform: `translate(-50%, -50%) rotate(${sel.rotation}deg)` }}>
                <span className="handle rotate" title="Drag to rotate (Shift: 15° steps)" onPointerDown={(e) => start('rotate', sel, e)} />
                {(['tl', 'tr', 'bl', 'br'] as const).map((corner) => (
                  <span key={corner} className={`handle scale ${corner}`} title="Drag to resize" onPointerDown={(e) => start('scale', sel, e)} />
                ))}
                {findClip(project, sel.id)?.clip.type === 'text' &&
                  (['l', 'r'] as const).map((side) => <span key={side} className={`handle side ${side}`} title="Drag to set how wide a line can be before it wraps" onPointerDown={(e) => start('width', sel, e)} />)}
                {gesture && patch && (
                  <span className="sel-readout" style={{ transform: `rotate(${-sel.rotation}deg)` }}>
                    {gesture.kind === 'move' && patch.x !== undefined && patch.y !== undefined
                      ? `X ${Math.round(patch.x * 100)}%  Y ${Math.round(patch.y * 100)}%`
                      : gesture.kind === 'scale' && patch.scale !== undefined
                        ? `${Math.round(patch.scale * 100)}%`
                        : gesture.kind === 'rotate' && patch.rotation !== undefined
                          ? `${patch.rotation}°`
                          : gesture.kind === 'width' && patch.maxWidth !== undefined
                            ? `Line width ${Math.round(patch.maxWidth * 100)}%`
                            : ''}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
