import { useEffect, useRef, useState } from 'react';
import { clipEnd, projectDuration, type Clip, type EditOp, type Project, type Track } from '@shared/studio';
import { Icon } from '../components/Icon';

/**
 * The Studio timeline: tracks of clips over time. Drag a clip to move it (also onto another track
 * of the same kind), drag its edges to trim, click to select, click the ruler to move the
 * playhead, drop media from the bin onto a track.
 */

const LABEL_W = 132;
const ROW_H: Record<Track['kind'], number> = { video: 54, text: 36, audio: 40 };
const SNAP_PX = 8;

type Drag =
  | { kind: 'move'; clip: Clip; track: Track; dx: number; startX: number; startY: number; targetTrack: string }
  | { kind: 'trim-start' | 'trim-end'; clip: Clip; track: Track; startX: number; dx: number }
  | { kind: 'scrub' };

export function Timeline({
  project,
  time,
  selected,
  onSelect,
  onTime,
  onEdit,
  zoom,
}: {
  project: Project;
  time: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onTime: (t: number) => void;
  onEdit: (ops: EditOp[]) => void;
  zoom: number;
}) {
  const area = useRef<HTMLDivElement>(null);
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

  // Tracks top to bottom: the highest layer first.
  const rows = [...project.tracks].reverse();

  return (
    <div className="studio-timeline" ref={area}>
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
            style={{ height: ROW_H[t.kind] }}
            data-track={t.id}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-keo-asset')) e.preventDefault();
            }}
            onDrop={(e) => {
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
            {t.clips.map((c) => {
              const w = where(c, t);
              return (
                <div
                  key={c.id}
                  className={`tl-clip ${c.type} ${selected === c.id ? 'sel' : ''} ${w.ghost ? 'ghost' : ''} ${t.hidden ? 'hidden' : ''}`}
                  style={{ left: LABEL_W + w.left, width: w.width }}
                  title={`${label(c)} · ${c.start.toFixed(2)}s–${clipEnd(c).toFixed(2)}s`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onSelect(c.id);
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    const edge = e.clientX - r.left < 7 ? 'trim-start' : r.right - e.clientX < 7 ? 'trim-end' : 'move';
                    if (edge === 'move') setDrag({ kind: 'move', clip: c, track: t, dx: 0, startX: e.clientX, startY: e.clientY, targetTrack: t.id });
                    else setDrag({ kind: edge, clip: c, track: t, dx: 0, startX: e.clientX });
                  }}
                >
                  <span className="tl-clip-label">{label(c)}</span>
                </div>
              );
            })}
          </div>
        ))}
        <div className="tl-playhead" style={{ left: LABEL_W + time * pps }} />
      </div>
    </div>
  );
}
