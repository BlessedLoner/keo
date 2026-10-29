import { useEffect, useRef, useState } from 'react';
import { cubicBezier, EASES, type Clip, type EditOp, type Ease, type Key, type KeyProp } from '@shared/studio';

/**
 * How the animation moves into a keyframe: a named ease, or a curve with two handles to drag
 * (like CapCut's graph). Changes every property keyed at that moment of the clip.
 */

type Curve = [number, number, number, number];
const NAMED: Array<[Ease, string]> = [
  ['linear', 'Linear'],
  ['in', 'Ease in'],
  ['out', 'Ease out'],
  ['in-out', 'Ease in-out'],
  ['back', 'Overshoot'],
  ['elastic', 'Elastic'],
  ['bounce', 'Bounce'],
  ['hold', 'Hold (jump)'],
];
const SIZE = 132;
const PAD = 14;

export function EaseEditor({ clip, at, x, y, onEdit, onClose }: { clip: Exclude<Clip, { type: 'audio' | 'adjust' }>; at: number; x: number; y: number; onEdit: (ops: EditOp[]) => void; onClose: () => void }) {
  const keyed = (Object.entries(clip.keys ?? {}) as Array<[KeyProp, Key[] | undefined]>).filter(([, list]) => list?.some((k) => Math.abs(k.at - at) < 1e-3));
  const first = keyed[0]?.[1]?.find((k) => Math.abs(k.at - at) < 1e-3);
  const [curve, setCurve] = useState<Curve>(first?.curve ?? [0.42, 0, 0.58, 1]);
  const [drag, setDrag] = useState<0 | 1 | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose();
    };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [onClose]);
  const apply = (ease: Ease, c?: Curve) => {
    const keys: Partial<Record<KeyProp, Key[]>> = {};
    for (const [prop, list] of keyed) keys[prop] = list!.map((k) => (Math.abs(k.at - at) < 1e-3 ? { at: k.at, value: k.value, ease, ...(c ? { curve: c } : {}) } : k));
    onEdit([{ op: 'set', clip: clip.id, keys }]);
  };
  // Graph coordinates: x 0..1 across, y -0.5..1.5 up (so overshoot shows).
  const gx = (v: number) => PAD + v * (SIZE - PAD * 2);
  const gy = (v: number) => SIZE - PAD - ((v + 0.5) / 2) * (SIZE - PAD * 2);
  const path = Array.from({ length: 41 }, (_, i) => {
    const p = i / 40;
    return `${i ? 'L' : 'M'}${gx(p).toFixed(1)},${gy(cubicBezier(curve, p)).toFixed(1)}`;
  }).join(' ');
  const move = (e: React.PointerEvent) => {
    if (drag === null || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const vx = Math.max(0, Math.min(1, (e.clientX - r.left - PAD) / (r.width - PAD * 2)));
    const vy = Math.max(-0.5, Math.min(1.5, ((r.bottom - e.clientY - PAD) / (r.height - PAD * 2)) * 2 - 0.5));
    const next: Curve = [...curve];
    next[drag * 2] = Math.round(vx * 100) / 100;
    next[drag * 2 + 1] = Math.round(vy * 100) / 100;
    setCurve(next);
  };
  if (!keyed.length) return null;
  return (
    <div ref={box} className="ease-editor" style={{ left: Math.min(x, window.innerWidth - 300), top: Math.max(8, y - 260) }} role="dialog" aria-label="Keyframe ease">
      <div className="ease-head">
        Ease into this keyframe <span className="muted">({keyed.map(([k]) => k).join(', ')})</span>
      </div>
      <div className="ease-body">
        <div className="ease-names">
          {NAMED.map(([e, label]) => (
            <button key={e} className={`btn sm ${first?.ease === e && !first.curve ? 'on' : ''}`} onClick={() => apply(e)}>
              <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden>
                <path d={Array.from({ length: 13 }, (_, i) => `${i ? 'L' : 'M'}${(1 + (i / 12) * 16).toFixed(1)},${(12 - EASES[e](i / 12) * 10).toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              {label}
            </button>
          ))}
        </div>
        <div>
          <svg ref={svg} className="ease-graph" width={SIZE} height={SIZE} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
            <rect x={gx(0)} y={gy(1)} width={gx(1) - gx(0)} height={gy(0) - gy(1)} className="ease-frame" />
            <line x1={gx(0)} y1={gy(0)} x2={gx(curve[0])} y2={gy(curve[1])} className="ease-arm" />
            <line x1={gx(1)} y1={gy(1)} x2={gx(curve[2])} y2={gy(curve[3])} className="ease-arm" />
            <path d={path} className="ease-line" />
            {[0, 1].map((h) => (
              <circle key={h} cx={gx(curve[h * 2]!)} cy={gy(curve[h * 2 + 1]!)} r={6} className="ease-handle" onPointerDown={(e) => {
                e.stopPropagation();
                (e.target as Element).setPointerCapture?.(e.pointerId);
                setDrag(h as 0 | 1);
              }} />
            ))}
          </svg>
          <button className={`btn sm primary ${first?.curve ? 'on' : ''}`} style={{ width: '100%', marginTop: 6 }} onClick={() => apply('in-out', curve)}>
            Use this curve
          </button>
        </div>
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Drag the two dots: steep means fast, flat means slow. Above the box overshoots.
      </p>
    </div>
  );
}

