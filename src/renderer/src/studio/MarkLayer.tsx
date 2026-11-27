import { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '@shared/studio';
import { layerLabel } from '@shared/studioMarkLabel';
import { Icon } from '../components/Icon';
import type { LayerBox } from './engine';

/** What the user marked on the preview, for Keo: their words, where, what is under it and the picture. */
export interface MarkResult {
  text: string;
  /** Seconds on the timeline (the frame that was marked). */
  time: number;
  /** The marked area, as fractions of the frame. */
  box: { x: number; y: number; w: number; h: number };
  /** The layers under the marks, top one first. */
  clips: Array<{ id: string; label: string }>;
  /** The frame with the marks on it (JPEG, base64). */
  picture: string;
}

type Pt = { x: number; y: number };
const INK = '#ff3b5c';

/**
 * Marking on Studio's preview: the user circles what is wrong in the frame (a caption, a pop, a
 * picture), sees which layers that is, says what to change, and Keo gets the frame with the marks,
 * the time and those layers' ids, so it changes exactly them.
 */
export function MarkLayer({ project, time, preview, boxes, k, width, height, onSend, onCancel }: { project: Project; time: number; preview: HTMLCanvasElement | null; boxes: LayerBox[]; k: number; width: number; height: number; onSend: (r: MarkResult) => void; onCancel: () => void }) {
  const ink = useRef<HTMLCanvasElement>(null);
  const [strokes, setStrokes] = useState<Pt[][]>([]);
  const drawing = useRef<Pt[] | null>(null);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const [, redraw] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') setStrokes((s) => s.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // The marks, drawn over the frame.
  useEffect(() => {
    const c = ink.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    for (const s of drawing.current ? [...strokes, drawing.current] : strokes) paint(g, s, 1);
  });

  // The marked area (preview pixels) and the layers under it, top one first.
  const area = useMemo(() => {
    const pts = strokes.flat();
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x0: Math.max(0, Math.min(...xs)), y0: Math.max(0, Math.min(...ys)), x1: Math.min(width, Math.max(...xs)), y1: Math.min(height, Math.max(...ys)) };
  }, [strokes, width, height]);
  const under = useMemo(() => {
    if (!area) return [];
    const hits: Array<{ id: string; label: string; score: number }> = [];
    for (const b of [...boxes].reverse()) {
      const bx0 = (b.cx - b.w / 2) / k;
      const by0 = (b.cy - b.h / 2) / k;
      const bx1 = (b.cx + b.w / 2) / k;
      const by1 = (b.cy + b.h / 2) / k;
      const ix = Math.max(0, Math.min(area.x1, bx1) - Math.max(area.x0, bx0));
      const iy = Math.max(0, Math.min(area.y1, by1) - Math.max(area.y0, by0));
      const overlap = ix * iy;
      if (overlap <= 0) continue;
      // A full-frame layer (the main video) counts only when nothing smaller is marked.
      const full = (bx1 - bx0) * (by1 - by0) > width * height * 0.8;
      const markArea = Math.max(1, (area.x1 - area.x0) * (area.y1 - area.y0));
      hits.push({ id: b.id, label: layerLabel(project, b.id), score: overlap / markArea - (full ? 1 : 0) });
    }
    const sorted = hits.sort((a, b) => b.score - a.score);
    const small = sorted.filter((h) => h.score > -0.5);
    return (small.length ? small : sorted).slice(0, 4);
  }, [area, boxes, k, project, width, height]);

  const send = () => {
    if (!area || !text.trim() || !preview) return;
    // The frame as shown, with the marks, at the preview's own size.
    const out = document.createElement('canvas');
    out.width = preview.width;
    out.height = preview.height;
    const g = out.getContext('2d')!;
    g.drawImage(preview, 0, 0);
    for (const s of strokes) paint(g, s, preview.width / Math.max(1, width));
    const picture = out.toDataURL('image/jpeg', 0.85).split(',')[1]!;
    const f = (n: number, of: number) => Math.round((n / Math.max(1, of)) * 1000) / 1000;
    onSend({ text: text.trim(), time, box: { x: f(area.x0, width), y: f(area.y0, height), w: f(area.x1 - area.x0, width), h: f(area.y1 - area.y0, height) }, clips: under.map(({ id, label }) => ({ id, label })), picture });
  };

  return (
    <div className="mark-layer" onPointerDown={(e) => e.stopPropagation()}>
      <canvas
        ref={ink}
        className="mark-ink"
        style={{ width, height }}
        onPointerDown={(e) => {
          try {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          } catch {
            /* drawing works without capture */
          }
          const r = e.currentTarget.getBoundingClientRect();
          drawing.current = [{ x: e.clientX - r.left, y: e.clientY - r.top }];
          redraw((n) => n + 1);
        }}
        onPointerMove={(e) => {
          if (!drawing.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          drawing.current.push({ x: e.clientX - r.left, y: e.clientY - r.top });
          redraw((n) => n + 1);
        }}
        onPointerUp={() => {
          const s = drawing.current;
          drawing.current = null;
          if (s && s.length > 2) {
            setStrokes((all) => [...all, s]);
            setTimeout(() => input.current?.focus(), 0);
          } else redraw((n) => n + 1);
        }}
      />
      {area && <div className="mark-area" style={{ left: area.x0 - 6, top: area.y0 - 6, width: area.x1 - area.x0 + 12, height: area.y1 - area.y0 + 12 }} aria-hidden />}
      <div className="mark-bar" role="toolbar" aria-label="Mark what to change">
        <div className="mark-head">
          <Icon name="edit" size={14} />
          <span className="grow">{!strokes.length ? 'Circle what should change' : under.length ? 'Under your marks:' : 'Nothing is under your marks — Keo will look at the area.'}</span>
          <button className="mark-icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!strokes.length} onClick={() => setStrokes((s) => s.slice(0, -1))}>
            <Icon name="undo" size={13} />
          </button>
          <button className="mark-icon" title="Close (Esc)" aria-label="Close" onClick={onCancel}>
            <Icon name="x" size={13} />
          </button>
        </div>
        {under.length > 0 && (
          <div className="mark-chips">
            {under.map((u) => (
              <span key={u.id} className="mark-chip" title={u.id}>
                {u.label}
              </span>
            ))}
          </div>
        )}
        <div className="mark-ask">
          <input
            ref={input}
            className="mark-input"
            placeholder={strokes.length ? 'What should Keo change? e.g. “move this lower”' : 'Circle it first…'}
            value={text}
            maxLength={1000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') send();
            }}
          />
          <button className="mark-send" disabled={!area || !text.trim()} onClick={send} title="Send to Keo">
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function paint(g: CanvasRenderingContext2D, s: Pt[], scale: number): void {
  if (s.length < 2) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = INK;
  g.lineWidth = 4 * scale;
  g.shadowColor = 'rgba(0,0,0,0.45)';
  g.shadowBlur = 3 * scale;
  g.beginPath();
  g.moveTo(s[0]!.x * scale, s[0]!.y * scale);
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1]!;
    const b = s[i]!;
    g.quadraticCurveTo(a.x * scale, a.y * scale, ((a.x + b.x) / 2) * scale, ((a.y + b.y) / 2) * scale);
  }
  g.stroke();
  g.restore();
}
