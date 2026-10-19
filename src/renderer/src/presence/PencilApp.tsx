import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { invoke, subscribe } from '../lib/api';

/**
 * Keo's pencil: a drawing layer over the screen. The user circles or marks what they mean and
 * says (or types) what they want; Keo receives a close-up of the marks and the whole screen with
 * them. The screen picture was taken by Keo just before this layer opened.
 */
type Pt = { x: number; y: number; p: number };
type Stroke = { pts: Pt[]; tool: 'pen' | 'marker'; color: string };

const COLORS = ['#ff3b5c', '#ffb020', '#3dd6ff', '#7cff6b'];

interface Ctx {
  image: string;
  width: number;
  height: number;
  provider: string;
  consentNeeded: boolean;
  visionModel: boolean;
  listening: boolean;
  heard: string | null;
}

export function PencilApp() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<'pen' | 'marker'>('pen');
  const [color, setColor] = useState(COLORS[0]!);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [listenNote, setListenNote] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastStrokeAt = useRef(0);
  const shot = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    document.documentElement.classList.add('pencil-root');
    void invoke('pencil:context', {}).then((c) => {
      if (!c) return void invoke('pencil:cancel', {});
      setCtx(c);
      setListening(c.listening);
      setHeard(c.heard);
      const img = new Image();
      img.src = c.image;
      shot.current = img;
    });
    const off = subscribe('presence:command', (c) => {
      if (c.type !== 'pencil_heard') return;
      setListening(c.listening);
      if (c.text) setHeard(c.text);
      if (!c.listening && !c.text) setListenNote(c.reason === 'cancelled' ? null : 'I didn’t catch that — tap the mic or type below.');
      else setListenNote(null);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('pencil:cancel', {});
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') setStrokes((s) => s.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => {
      off();
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Draw the marks.
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(window.innerWidth * dpr);
    c.height = Math.round(window.innerHeight * dpr);
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    for (const s of drawing.current ? [...strokes, drawing.current] : strokes) paint(g, s, 1);
  });

  const redraw = useCallback(() => setStrokes((s) => [...s]), []);

  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.pencil-bar, .pencil-consent')) return;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* some pens/touch screens do not allow capture; drawing still works */
    }
    drawing.current = { pts: [{ x: e.clientX, y: e.clientY, p: e.pressure || 0.5 }], tool, color };
    redraw();
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drawing.current) return;
    drawing.current.pts.push({ x: e.clientX, y: e.clientY, p: e.pressure || 0.5 });
    redraw();
  };
  const onUp = () => {
    const s = drawing.current;
    drawing.current = null;
    if (s && s.pts.length > 1) {
      setStrokes((all) => [...all, s]);
      lastStrokeAt.current = Date.now();
    } else redraw();
  };

  const send = useCallback(async () => {
    if (busy || !ctx || ctx.consentNeeded || !strokes.length || !shot.current) return;
    setBusy(true);
    setError(null);
    try {
      const { crop, full, box } = compose(shot.current, strokes);
      const r = await invoke('pencil:submit', { text: typed, crop, full, box });
      if (!r.ok) {
        setError(r.error ?? 'Could not send.');
        setBusy(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [busy, ctx, strokes, typed]);

  // Send by itself once the user has both marked something and said what they want.
  useEffect(() => {
    if (!heard || !strokes.length || typed || busy || drawing.current) return;
    const wait = Math.max(500, 1100 - (Date.now() - lastStrokeAt.current));
    const t = setTimeout(() => void send(), wait);
    return () => clearTimeout(t);
  }, [heard, strokes, typed, busy, send]);

  const hint = !strokes.length ? 'Circle or mark what you mean' : heard ? 'Sending…' : listening ? 'Now tell Keo what you want' : 'Type or tap the mic, then Send';

  return (
    <div className="pencil-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <canvas ref={canvas} className="pencil-canvas" />
      <div className="pencil-frame" aria-hidden="true" />
      {ctx?.consentNeeded && (
        <div className="pencil-consent" role="dialog" aria-label="Allow sending the marked area">
          <strong>Show Keo what you mark?</strong>
          <p>
            The area you mark and a small picture of this screen are sent to {ctx.provider} so Keo can answer. Nothing is sent until you press Send or finish speaking.
          </p>
          <div className="row">
            <button className="btn ghost" onClick={() => void invoke('pencil:cancel', {})}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void invoke('pencil:allowExport', {}).then(() => setCtx((c) => (c ? { ...c, consentNeeded: false } : c)))}>
              Allow
            </button>
          </div>
        </div>
      )}
      <div className="pencil-bar" role="toolbar" aria-label="Keo pencil">
        <div className="pd-head">
          <span className="pd-brand">
            <span className="pencil-orb" aria-hidden="true" /> Keo pencil
          </span>
          <ol className="pd-steps" aria-label="Steps">
            <li className={strokes.length ? 'done' : 'now'}>
              <b>1</b> Mark
            </li>
            <li className={heard || typed ? 'done' : strokes.length ? 'now' : ''}>
              <b>2</b> Ask
            </li>
            <li className={busy ? 'now' : ''}>
              <b>3</b> Send
            </li>
          </ol>
          <button className="pencil-x" title="Close (Esc)" aria-label="Close" onClick={() => void invoke('pencil:cancel', {})}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="pd-row pd-tools">
          <div className="pd-group" aria-label="Tool">
            <button className={tool === 'pen' ? 'on' : ''} title="Pen" aria-label="Pen" onClick={() => setTool('pen')}>
              <Icon name="edit" size={15} />
            </button>
            <button className={tool === 'marker' ? 'on' : ''} title="Highlighter" aria-label="Highlighter" onClick={() => setTool('marker')}>
              <span className="pencil-hl" />
            </button>
          </div>
          <span className="pd-sep" aria-hidden="true" />
          <div className="pd-group" aria-label="Colour">
            {COLORS.map((c) => (
              <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
            ))}
          </div>
          <span className="pd-sep" aria-hidden="true" />
          <div className="pd-group">
            <button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!strokes.length} onClick={() => setStrokes((st) => st.slice(0, -1))}>
              <Icon name="retry" size={14} />
            </button>
            <button title="Clear" aria-label="Clear" disabled={!strokes.length} onClick={() => setStrokes([])}>
              <Icon name="trash" size={14} />
            </button>
          </div>
          <span className="pd-hint">{hint}</span>
        </div>
        <div className="pd-row pd-ask">
          <button className={`pencil-mic ${listening ? 'live' : ''}`} title={listening ? 'Listening…' : 'Speak'} aria-label={listening ? 'Listening' : 'Speak'} onClick={() => !listening && void invoke('pencil:listen', {})}>
            <Icon name="mic" size={16} />
          </button>
          <div className="pencil-talk">
            {heard ? <span className="heard">“{heard}”</span> : <span className="hint">{listenNote ?? (listening ? 'Listening… say what you want' : 'Say or type what you want')}</span>}
            <input
              className="pencil-input"
              placeholder="…or type it here"
              value={typed}
              maxLength={2000}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
          </div>
          <button className="btn primary pencil-send" disabled={busy || !strokes.length || !!ctx?.consentNeeded} onClick={() => void send()}>
            <Icon name="send" size={14} /> {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
      {(error || (ctx && !ctx.visionModel)) && <div className="pencil-error">{error ?? 'The current AI model cannot see pictures. Choose a model with vision in Settings → Providers.'}</div>}
    </div>
  );
}

function paint(g: CanvasRenderingContext2D, s: Stroke, scale: number): void {
  if (s.pts.length < 2) return;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.strokeStyle = s.color;
  if (s.tool === 'marker') {
    g.globalAlpha = 0.32;
    g.lineWidth = 20 * scale;
  } else {
    g.lineWidth = 4 * scale;
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 2 * scale;
  }
  g.beginPath();
  g.moveTo(s.pts[0]!.x * scale, s.pts[0]!.y * scale);
  for (let i = 1; i < s.pts.length; i++) {
    const a = s.pts[i - 1]!;
    const b = s.pts[i]!;
    g.quadraticCurveTo(a.x * scale, a.y * scale, ((a.x + b.x) / 2) * scale, ((a.y + b.y) / 2) * scale);
  }
  g.stroke();
  g.restore();
}

/** The screen picture with the marks: a close-up of the marked area and the whole screen (both ≤ 1600 px). */
function compose(img: HTMLImageElement, strokes: Stroke[]): { crop: string; full: string; box: { x: number; y: number; w: number; h: number } } {
  const scale = img.naturalWidth / window.innerWidth;
  const all = document.createElement('canvas');
  all.width = img.naturalWidth;
  all.height = img.naturalHeight;
  const g = all.getContext('2d')!;
  g.drawImage(img, 0, 0);
  for (const s of strokes) paint(g, s, scale);
  // Marked area (screen DIPs), with room around it.
  const xs = strokes.flatMap((s) => s.pts.map((p) => p.x));
  const ys = strokes.flatMap((s) => s.pts.map((p) => p.y));
  const W = window.innerWidth;
  const H = window.innerHeight;
  let x0 = Math.min(...xs) - 80;
  let y0 = Math.min(...ys) - 80;
  let x1 = Math.max(...xs) + 80;
  let y1 = Math.max(...ys) + 80;
  if (x1 - x0 < 360) [x0, x1] = [(x0 + x1) / 2 - 180, (x0 + x1) / 2 + 180];
  if (y1 - y0 < 240) [y0, y1] = [(y0 + y1) / 2 - 120, (y0 + y1) / 2 + 120];
  x0 = Math.max(0, Math.round(x0));
  y0 = Math.max(0, Math.round(y0));
  x1 = Math.min(W, Math.round(x1));
  y1 = Math.min(H, Math.round(y1));
  const box = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  const out = (sx: number, sy: number, sw: number, sh: number) => {
    const k = Math.min(1, 1600 / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d')!.drawImage(all, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/png').split(',')[1]!;
  };
  return { crop: out(box.x * scale, box.y * scale, box.w * scale, box.h * scale), full: out(0, 0, all.width, all.height), box };
}
