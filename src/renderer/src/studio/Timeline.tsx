import { memo, useEffect, useRef, useState } from 'react';
import { clipEnd, projectDuration, TRANSITIONS, type Asset, type Clip, type EditOp, type Project, type Track, type Transition } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useFilmstrip, useWaveform } from './thumbs';

/**
 * The Studio timeline: tracks of clips over time. Drag a clip to move it (also onto another track
 * of the same kind), drag its edges to trim, click to select, click the ruler to move the
 * playhead, drop media from the bin onto a track.
 */

const LABEL_W = 132;
const ROW_H: Record<Track['kind'], number> = { video: 64, text: 36, audio: 46 };
const SNAP_PX = 8;

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
};

type Drag =
  | { kind: 'move'; clip: Clip; track: Track; dx: number; startX: number; startY: number; targetTrack: string }
  | { kind: 'trim-start' | 'trim-end'; clip: Clip; track: Track; startX: number; dx: number }
  | { kind: 'scrub' };

export function Timeline({
  project,
  time,
  selected,
  selectedIds,
  onSelect,
  onTime,
  onEdit,
  zoom,
  onZoom,
  height,
}: {
  project: Project;
  time: number;
  selected: string | null;
  /** All selected clips (several with Shift or Ctrl + click). */
  selectedIds?: string[];
  onSelect: (id: string | null, add?: boolean) => void;
  onTime: (t: number) => void;
  onEdit: (ops: EditOp[]) => void;
  zoom: number;
  onZoom?: (z: number) => void;
  height?: number;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [cutMenu, setCutMenu] = useState<{ clip: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!cutMenu) return;
    const close = () => setCutMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [cutMenu]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const pps = zoom; // pixels per second
  const duration = Math.max(projectDuration(project), 10);
  const width = Math.ceil((duration + 8) * pps);

  // Snapping: clip edges and the playhead.
  const edges = (except: string) => {
    const out = [time, 0];
    for (const t of project.tracks) for (const c of t.clips) if (c.id !== except) out.push(c.start, clipEnd(c));
    return out;
  };
  const snap = (sec: number, except: string) => {
    let best = sec;
    let bestPx = SNAP_PX;
    for (const e of edges(except)) {
      const d = Math.abs(e - sec) * pps;
      if (d < bestPx) {
        bestPx = d;
        best = e;
      }
    }
    return Math.max(0, best);
  };

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

  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'scrub') onTime(timeAt(e.clientX));
      else if (d.kind === 'move') {
        const over = trackAt(e.clientY);
        const target = over && project.tracks.find((t) => t.id === over)?.kind === d.track.kind ? over : d.targetTrack;
        setDrag({ ...d, dx: e.clientX - d.startX, targetTrack: target });
      } else setDrag({ ...d, dx: e.clientX - d.startX });
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || d.kind === 'scrub') return;
      const sec = d.dx / pps;
      if (d.kind === 'move') {
        if (Math.abs(d.dx) < 2 && d.targetTrack === d.track.id) return;
        const start = snap(d.clip.start + sec, d.clip.id);
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
        onEdit([{ op: 'move', clip: d.clip.id, start, ...(d.targetTrack !== d.track.id ? { track: d.targetTrack } : {}) }]);
      } else if (d.kind === 'trim-start') {
        const start = snap(d.clip.start + sec, d.clip.id);
        const delta = Math.min(start - d.clip.start, d.clip.duration - 0.1);
        if (Math.abs(delta) > 0.01) onEdit([{ op: 'trim', clip: d.clip.id, trimStart: delta }]);
      } else {
        const end = snap(clipEnd(d.clip) + sec, d.clip.id);
        const dur = Math.max(0.1, end - d.clip.start);
        if (Math.abs(dur - d.clip.duration) > 0.01) onEdit([{ op: 'trim', clip: d.clip.id, duration: dur }]);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, project, pps, time]);

  const where = (c: Clip, t: Track) => {
    let start = c.start;
    let dur = c.duration;
    if (drag && drag.kind !== 'scrub' && drag.clip.id === c.id) {
      const sec = drag.dx / pps;
      if (drag.kind === 'move') start = Math.max(0, c.start + sec);
      else if (drag.kind === 'trim-start') {
        const d = Math.min(sec, c.duration - 0.1);
        start = c.start + d;
        dur = c.duration - d;
      } else dur = Math.max(0.1, c.duration + sec);
    }
    return { left: start * pps, width: Math.max(4, dur * pps), ghost: drag?.kind === 'move' && drag.clip.id === c.id && drag.targetTrack !== t.id };
  };

  const label = (c: Clip) => {
    if (c.type === 'text') return c.counter ? `${c.counter.prefix}${c.counter.to}${c.counter.suffix}` : c.text;
    if (c.type === 'shape') return c.shape[0]!.toUpperCase() + c.shape.slice(1);
    return project.assets.find((a) => a.id === c.assetId)?.name ?? 'Media';
  };

  const ticks: number[] = [];
  const step = pps >= 120 ? 0.5 : pps >= 50 ? 1 : pps >= 20 ? 5 : 10;
  for (let s = 0; s <= duration + 8; s += step) ticks.push(s);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}${step < 1 ? `.${Math.round((s % 1) * 10)}` : ''}`;

  /** Clips that overlap on a track go on separate lanes, so each one can be seen and grabbed. */
  const laneCache = new Map<string, { lane: Map<string, number>; count: number }>();
  const lanesOf = (t: Track) => {
    let r = laneCache.get(t.id);
    if (r) return r;
    const lane = new Map<string, number>();
    const ends: number[] = [];
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      let i = ends.findIndex((e) => e <= c.start + 1e-6);
      if (i < 0) i = ends.push(0) - 1;
      ends[i] = clipEnd(c);
      lane.set(c.id, i);
    }
    r = { lane, count: ends.length };
    laneCache.set(t.id, r);
    return r;
  };

  // Tracks top to bottom: the highest layer first.
  const rows = [...project.tracks].reverse();

  return (
    <div
      className="studio-timeline"
      ref={area}
      style={height ? { height } : undefined}
      onWheel={(e) => {
        // Ctrl + wheel zooms around the mouse, like other editors.
        if (!e.ctrlKey || !onZoom) return;
        const el = area.current!;
        const r = el.getBoundingClientRect();
        const at = (e.clientX - r.left - LABEL_W + el.scrollLeft) / pps;
        const next = Math.max(4, Math.min(400, Math.round(pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2))));
        onZoom(next);
        requestAnimationFrame(() => {
          el.scrollLeft = Math.max(0, at * next - (e.clientX - r.left - LABEL_W));
        });
      }}
    >
      <div className="tl-inner" style={{ width: width + LABEL_W }}>
        <div
          className="tl-ruler"
          onPointerDown={(e) => {
            onTime(timeAt(e.clientX));
            setDrag({ kind: 'scrub' });
          }}
        >
          <div className="tl-label-gap" />
          {ticks.map((s) => (
            <span key={s} className="tl-tick" style={{ left: LABEL_W + s * pps }}>
              {fmt(s)}
            </span>
          ))}
        </div>
        {rows.map((t) => (
          <div
            key={t.id}
            className={`tl-row ${t.kind} ${drag?.kind === 'move' && drag.targetTrack === t.id && drag.track.id !== t.id ? 'drop' : ''}`}
            style={{ height: ROW_H[t.kind] * Math.max(1, lanesOf(t).count) }}
            data-track={t.id}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-keo-asset') || e.dataTransfer.types.includes('application/x-keo-text')) e.preventDefault();
            }}
            onDrop={(e) => {
              if (e.dataTransfer.types.includes('application/x-keo-text')) {
                e.preventDefault();
                onEdit([{ op: 'add_text', text: 'Your text', start: snap(timeAt(e.clientX), ''), duration: 3, ...(t.kind === 'text' ? { track: t.id } : {}) }]);
                return;
              }
              const assetId = e.dataTransfer.getData('application/x-keo-asset');
              const asset = project.assets.find((a) => a.id === assetId);
              if (!asset) return;
              e.preventDefault();
              const start = snap(timeAt(e.clientX), '');
              if (asset.kind === 'audio' || (t.kind === 'audio' && asset.hasAudio)) onEdit([{ op: 'add_audio', assetId, start, ...(t.kind === 'audio' ? { track: t.id } : {}) }]);
              else if (t.kind === 'video') onEdit([{ op: 'add_media', assetId, start, track: t.id }]);
              else onEdit([{ op: 'add_media', assetId, start }]);
            }}
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('.tl-clip, .tl-head')) return;
              onSelect(null);
              onTime(timeAt(e.clientX));
            }}
          >
            <div className="tl-head">
              <Icon name={t.kind === 'video' ? 'film' : t.kind === 'text' ? 'text' : 'music'} size={14} />
              <span className="grow">{t.name}</span>
              {t.kind !== 'audio' && (
                <button className="tl-btn" title={t.hidden ? 'Show this track' : 'Hide this track'} onClick={() => onEdit([{ op: 'set_track', track: t.id, hidden: !t.hidden }])}>
                  <Icon name={t.hidden ? 'eyeoff' : 'eye'} size={13} />
                </button>
              )}
              {t.kind !== 'text' && (
                <button className="tl-btn" title={t.muted ? 'Unmute' : 'Mute'} onClick={() => onEdit([{ op: 'set_track', track: t.id, muted: !t.muted }])}>
                  <Icon name={t.muted ? 'mute' : 'speaker'} size={13} />
                </button>
              )}
            </div>
            {t.kind === 'video' &&
              t.clips.map((c) => {
                if (c.type !== 'media') return null;
                const prev = t.clips.find((o) => o.type === 'media' && o.id !== c.id && Math.abs(clipEnd(o) - c.start) < 0.05);
                if (!prev) return null;
                const lane = lanesOf(t).lane.get(c.id) ?? 0;
                return (
                  <button
                    key={`cut-${c.id}`}
                    className={`tl-cut ${c.transition ? 'on' : ''}`}
                    style={{ left: LABEL_W + c.start * pps, top: 4 + lane * ROW_H[t.kind] + (ROW_H[t.kind] - 8) / 2 }}
                    title={c.transition ? `Transition: ${TRANSITION_LABEL[c.transition.kind]} (${c.transition.seconds}s) — click to change` : 'Add a transition here'}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      setCutMenu({ clip: c.id, x: e.clientX, y: e.clientY });
                    }}
                  >
                    {c.transition ? '⧓' : '+'}
                  </button>
                );
              })}
            {t.clips.map((c) => {
              const w = where(c, t);
              const lane = lanesOf(t).lane.get(c.id) ?? 0;
              return (
                <div
                  key={c.id}
                  className={`tl-clip ${c.type} ${selected === c.id || selectedIds?.includes(c.id) ? 'sel' : ''} ${w.ghost ? 'ghost' : ''} ${t.hidden ? 'hidden' : ''}`}
                  style={{ left: LABEL_W + w.left, width: w.width, top: 4 + lane * ROW_H[t.kind], height: ROW_H[t.kind] - 8, bottom: 'auto' }}
                  title={`${label(c)} · ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    if (e.shiftKey || e.ctrlKey) {
                      onSelect(c.id, true);
                      return;
                    }
                    onSelect(c.id);
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const edge = e.clientX - r.left < 7 ? 'trim-start' : r.right - e.clientX < 7 ? 'trim-end' : 'move';
                    if (edge === 'move') setDrag({ kind: 'move', clip: c, track: t, dx: 0, startX: e.clientX, startY: e.clientY, targetTrack: t.id });
                    else setDrag({ kind: edge, clip: c, track: t, dx: 0, startX: e.clientX });
                  }}
                >
                  {c.type !== 'text' && c.type !== 'shape' && <ClipBody projectId={project.id} clip={c} asset={project.assets.find((a) => a.id === c.assetId)} width={w.width} pps={pps} height={ROW_H[t.kind] - 8} />}
                  <span className="tl-clip-label">{label(c)}</span>
                </div>
              );
            })}
          </div>
        ))}
        <div className="tl-playhead" style={{ left: LABEL_W + time * pps }} />
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

/** What a video or sound clip looks like on the timeline: its frames and the shape of its sound. */
const ClipBody = memo(function ClipBody({ projectId, clip, asset, width, pps, height }: { projectId: string; clip: Extract<Clip, { type: 'media' | 'audio' }>; asset: Asset | undefined; width: number; pps: number; height: number }) {
  const strip = useFilmstrip(projectId, asset);
  const wave = useWaveform(projectId, asset);
  const canvas = useRef<HTMLCanvasElement>(null);
  const rate = clip.type === 'media' ? clip.speed : 1;
  const waveH = clip.type === 'audio' ? height : Math.round(height * 0.32);
  const w = Math.max(4, Math.min(8000, Math.round(width)));
  useEffect(() => {
    const c = canvas.current;
    if (!c || !wave) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.round(w * dpr);
    c.height = Math.round(waveH * dpr);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = clip.type === 'audio' ? 'rgba(190, 255, 220, 0.75)' : 'rgba(170, 220, 255, 0.7)';
    const mid = clip.type === 'audio' ? c.height / 2 : c.height;
    for (let x = 0; x < c.width; x++) {
      const t = clip.in + (x / dpr / pps) * rate;
      const v = wave[Math.floor(t * 50)] ?? 0;
      const hh = Math.max(dpr, v * (clip.type === 'audio' ? c.height / 2 : c.height));
      ctx.fillRect(x, mid - hh, 1, clip.type === 'audio' ? hh * 2 : hh);
    }
  }, [wave, w, waveH, pps, rate, clip.in, clip.type]);
  const tiles: Array<{ x: number; src: string }> = [];
  if (strip && clip.type === 'media') {
    const tileW = Math.max(16, height * strip.aspect);
    for (let x = 0; x < w; x += tileW) {
      const t = clip.in + (x / pps) * rate;
      const i = strip.step === Infinity ? 0 : Math.min(strip.frames.length - 1, Math.floor(t / strip.step));
      tiles.push({ x, src: strip.frames[i]! });
    }
  }
  return (
    <div className="tl-body" aria-hidden>
      {tiles.map((tile, i) => (
        <img key={i} src={tile.src} alt="" draggable={false} style={{ left: tile.x, height }} />
      ))}
      {wave && <canvas ref={canvas} className={clip.type === 'audio' ? 'tl-wave full' : 'tl-wave'} style={{ width: w, height: waveH }} />}
    </div>
  );
});
