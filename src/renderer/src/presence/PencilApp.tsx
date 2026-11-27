import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { invoke, subscribe } from '../lib/api';

/**
 * Keo's pencil: a drawing layer over the screen. The user circles or marks what they mean and
 * says (or types) what they want; Keo receives a close-up of the marks and the whole screen with
 * them. The screen picture was taken by Keo just before this layer opened.
 */
type Pt = { x: number; y: number; p: number };
type Tool = 'pen' | 'marker' | 'arrow' | 'rect' | 'ellipse';
type Stroke = { pts: Pt[]; tool: Tool; color: string; bold?: boolean };

const COLORS = ['#ff3b5c', '#ffb020', '#3dd6ff', '#7cff6b', '#ffffff'];
const TOOLS: Array<{ id: Tool; label: string }> = [
  { id: 'pen', label: 'Pen' },
  { id: 'marker', label: 'Highlighter' },
  { id: 'arrow', label: 'Arrow' },
  { id: 'rect', label: 'Box' },
  { id: 'ellipse', label: 'Circle' },
];

/** The tool's little picture (drawn, so every tool reads at a glance). */
function ToolIcon({ tool }: { tool: Tool }) {
  if (tool === 'pen') return <Icon name="edit" size={14} />;
  if (tool === 'marker') return <span className="pencil-hl" />;
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {tool === 'arrow' && <path d="M5 19L19 5M10 5h9v9" />}
      {tool === 'rect' && <rect x="4" y="6" width="16" height="12" rx="2.5" />}
      {tool === 'ellipse' && <ellipse cx="12" cy="12" rx="8.5" ry="6.5" />}
    </svg>
  );
}

interface Ctx {
  image: string;
  width: number;
  height: number;
  provider: string;
  consentNeeded: boolean;
  visionModel: boolean;
  listening: boolean;
  heard: string | null;
  /** Where the Keo bar is (the pencil opens out of it), or null. */
  bar: { dock: 'top' | 'bottom' | 'left' | 'right'; x: number; y: number; width: number; height: number } | null;
}

export function PencilApp() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawing = useRef<Stroke | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [bold, setBold] = useState(false);
  const [color, setColor] = useState(COLORS[0]!);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [listenNote, setListenNote] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastStrokeAt = useRef(0);
  const shot = useRef<HTMLImageElement | null>(null);
  // The screen picture is large: Send waits until it is loaded and decoded (never a blank picture).
  const [ready, setReady] = useState(false);

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
      void img
        .decode()
        .catch(() => undefined)
        .then(() => setReady(img.naturalWidth > 0));
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
    if ((e.target as HTMLElement).closest('.kb-pencil, .pencil-consent')) return;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* some pens/touch screens do not allow capture; drawing still works */
    }
    drawing.current = { pts: [{ x: e.clientX, y: e.clientY, p: e.pressure || 0.5 }], tool, color, bold };
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
    const a = s?.pts[0];
    const z = s?.pts[s.pts.length - 1];
    const dragged = !!a && !!z && Math.hypot(z.x - a.x, z.y - a.y) > 6;
    if (s && s.pts.length > 1 && (s.tool === 'pen' || s.tool === 'marker' || dragged)) {
      setStrokes((all) => [...all, s]);
      lastStrokeAt.current = Date.now();
    } else redraw();
  };

  const send = useCallback(async () => {
    if (busy || !ctx || ctx.consentNeeded || !strokes.length || !shot.current || !ready) return;
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
  }, [busy, ctx, strokes, typed, ready]);

  // Send by itself once the user has both marked something and said what they want.
  useEffect(() => {
    if (!heard || !strokes.length || typed || busy || drawing.current) return;
    const wait = Math.max(500, 1100 - (Date.now() - lastStrokeAt.current));
    const t = setTimeout(() => void send(), wait);
    return () => clearTimeout(t);
  }, [heard, strokes, typed, busy, send]);

  // The bar opens where the Keo bar is, grown out of it (the Keo bar itself is hidden meanwhile).
  const BAR_W = Math.min(440, window.innerWidth - 24);
  const bar = ctx?.bar ?? null;
  const dock = bar?.dock ?? 'top';
  const fromW = Math.max(120, Math.min(BAR_W, bar && (dock === 'top' || dock === 'bottom') ? bar.width - 24 : 140));
  const clampX = (x: number) => Math.max(12, Math.min(window.innerWidth - BAR_W - 12, x));
  const place: React.CSSProperties = !bar
    ? { left: clampX((window.innerWidth - BAR_W) / 2), top: 14, width: BAR_W }
    : dock === 'top'
      ? { left: clampX(bar.x + bar.width / 2 - BAR_W / 2), top: Math.max(8, bar.y + 4), width: BAR_W }
      : dock === 'bottom'
        ? { left: clampX(bar.x + bar.width / 2 - BAR_W / 2), bottom: Math.max(8, window.innerHeight - (bar.y + bar.height) + 4), width: BAR_W }
        : { left: dock === 'left' ? 12 : window.innerWidth - BAR_W - 12, top: Math.max(8, Math.min(window.innerHeight - 120, bar.y + bar.height / 2 - 26)), width: BAR_W };

  const hint = !strokes.length ? 'Circle or mark what you mean' : heard ? 'Sending…' : listening ? 'Now tell Keo what you want' : 'Type or tap the mic, then Send';

  return (
    <div className="pencil-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      {/* The screen as it was when the pencil opened: a still frame, so videos neither go blank nor move. */}
      {ctx && <img className="pencil-shot" src={ctx.image} alt="" draggable={false} />}
      <div className="pencil-tint" aria-hidden="true" />
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
      <div className={`kb-pencil dock-${dock}`} style={place} onPointerDown={(e) => e.stopPropagation()}>
        <div className="pencil-bar" role="toolbar" aria-label="Keo pencil" style={{ ['--from' as string]: `${fromW}px` }}>
          <div className="kp-head">
            <span className="kb-mark" aria-hidden="true">
              <i />
              <i />
            </span>
            <div className="kp-what">
              <strong>Keo pencil</strong>
              <span className={`kp-hint ${heard ? 'said' : ''}`} key={heard ?? listenNote ?? hint}>
                {heard ? `“${heard}”` : listenNote ?? hint}
              </span>
            </div>
            <span className="pd-progress" aria-hidden="true">
              <i className={strokes.length ? 'done' : 'now'} />
              <i className={heard || typed ? 'done' : strokes.length ? 'now' : ''} />
              <i className={busy ? 'now' : ''} />
            </span>
            <button className="pencil-x" title="Close (Esc)" aria-label="Close" onClick={() => void invoke('pencil:cancel', {})}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="kp-tools">
            <div className="pd-group" aria-label="Tool">
              {TOOLS.map((t) => (
                <button key={t.id} className={tool === t.id ? 'on' : ''} title={t.label} aria-label={t.label} onClick={() => setTool(t.id)}>
                  <ToolIcon tool={t.id} />
                </button>
              ))}
            </div>
            <div className="pd-group" aria-label="Thickness">
              <button className={`pd-size ${bold ? '' : 'on'}`} title="Fine line" aria-label="Fine line" onClick={() => setBold(false)}>
                <i style={{ height: 2 }} />
              </button>
              <button className={`pd-size ${bold ? 'on' : ''}`} title="Bold line" aria-label="Bold line" onClick={() => setBold(true)}>
                <i style={{ height: 5 }} />
              </button>
            </div>
            <div className="pd-group" aria-label="Edit">
              <button title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!strokes.length} onClick={() => setStrokes((st) => st.slice(0, -1))}>
                <Icon name="undo" size={14} />
              </button>
              <button title="Clear" aria-label="Clear" disabled={!strokes.length} onClick={() => setStrokes([])}>
                <Icon name="trash" size={13} />
              </button>
            </div>
          </div>
          <div className="kp-colors" aria-label="Colour">
            {COLORS.map((c) => (
              <button key={c} className={`swatch ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
            ))}
          </div>
          <div className="kp-ask">
            <button className={`pencil-mic ${listening ? 'live' : ''}`} title={listening ? 'Listening…' : 'Speak'} aria-label={listening ? 'Listening' : 'Speak'} onClick={() => !listening && void invoke('pencil:listen', {})}>
              <Icon name="mic" size={15} />
            </button>
            <input
              className="pencil-input"
              placeholder={listening ? 'Listening… say what you want' : strokes.length ? 'Say or type what you want' : 'Circle what you mean…'}
              aria-label="What do you want?"
              value={typed}
              maxLength={2000}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void send();
              }}
            />
            <button className="pencil-send" disabled={busy || !ready || !strokes.length || !!ctx?.consentNeeded} onClick={() => void send()} title={!strokes.length ? 'Mark something first' : 'Send to Keo'} aria-label={busy ? 'Sending' : 'Send'}>
              {busy || !ready ? <span className="spinner" /> : <Icon name="send" size={14} />}
            </button>
          </div>
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
    g.lineWidth = (s.bold ? 30 : 20) * scale;
  } else {
    g.lineWidth = (s.bold ? 7 : 4) * scale;
    g.shadowColor = 'rgba(0,0,0,0.35)';
    g.shadowBlur = 2 * scale;
  }
  if (s.tool === 'arrow' || s.tool === 'rect' || s.tool === 'ellipse') {
    const a = s.pts[0]!;
    const b = s.pts[s.pts.length - 1]!;
    const [ax, ay, bx, by] = [a.x * scale, a.y * scale, b.x * scale, b.y * scale];
    g.beginPath();
    if (s.tool === 'rect') {
      const r = Math.min(14 * scale, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2);
      g.roundRect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay), Math.max(0, r));
    } else if (s.tool === 'ellipse') {
      g.ellipse((ax + bx) / 2, (ay + by) / 2, Math.abs(bx - ax) / 2, Math.abs(by - ay) / 2, 0, 0, Math.PI * 2);
    } else {
      // The arrow: a line and a head at the end the user dragged to.
      const ang = Math.atan2(by - ay, bx - ax);
      const head = (s.bold ? 22 : 16) * scale;
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.moveTo(bx - head * Math.cos(ang - 0.45), by - head * Math.sin(ang - 0.45));
      g.lineTo(bx, by);
      g.lineTo(bx - head * Math.cos(ang + 0.45), by - head * Math.sin(ang + 0.45));
    }
    g.stroke();
    g.restore();
    return;
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
