import { useEffect, useRef, useState } from 'react';
import { HSL_RANGES, type ColorGrade } from '@shared/studio';
import { curveTable } from '@shared/studioLut';
import { errText, invoke } from '../lib/api';
import { useUi } from '../components/ui';
import { forgetLut } from './grade';
import { Num, Section } from './fields';

type Patch = { color: Partial<ColorGrade> | null };

/** The swatch of each HSL range. */
const RANGE_COLOUR: Record<(typeof HSL_RANGES)[number], string> = { red: '#e5484d', orange: '#f76b15', yellow: '#ffc53d', green: '#46a758', aqua: '#12a594', blue: '#3e63dd', purple: '#8e4ec6', magenta: '#d6409f' };

/** A slider for one grade value, -100…100 (or 0…100), sent when let go. */
function Slider({ label, value, min = -1, onCommit }: { id: string; label: string; value: number; min?: number; onCommit: (v: number) => void }) {
  return <Num label={label} value={Math.round(value * 100)} min={min * 100} max={100} step={1} onCommit={(v) => onCommit(v / 100)} />;
}

/**
 * Pro colour: light (highlights, shadows, whites, blacks), colour (tint, fade, sharpen), HSL for each
 * colour range, a tone curve and an imported LUT. Every change is one undo step.
 */
export function ProColor({ clipId, grade, set }: { clipId: string; grade: ColorGrade | undefined; set: (p: Patch) => void }) {
  const g = grade;
  const put = (patch: Partial<ColorGrade>) => set({ color: patch });
  const [range, setRange] = useState<(typeof HSL_RANGES)[number]>('orange');
  const band = g?.hsl?.[range] ?? { hue: 0, sat: 0, lum: 0 };
  const setBand = (k: 'hue' | 'sat' | 'lum', v: number) => put({ hsl: { ...(g?.hsl ?? {}), [range]: { ...band, [k]: v } } });
  return (
    <>
      <Section title="Light">
        <Slider id={`${clipId}-hl`} label="Highlights" value={g?.highlights ?? 0} onCommit={(v) => put({ highlights: v })} />
        <Slider id={`${clipId}-sh`} label="Shadows" value={g?.shadows ?? 0} onCommit={(v) => put({ shadows: v })} />
        <Slider id={`${clipId}-wh`} label="Whites" value={g?.whites ?? 0} onCommit={(v) => put({ whites: v })} />
        <Slider id={`${clipId}-bl`} label="Blacks" value={g?.blacks ?? 0} onCommit={(v) => put({ blacks: v })} />
      </Section>
      <Section title="Tone">
        <Slider id={`${clipId}-ti`} label="Tint" value={g?.tint ?? 0} onCommit={(v) => put({ tint: v })} />
        <Slider id={`${clipId}-fa`} label="Fade (film)" value={g?.fade ?? 0} min={0} onCommit={(v) => put({ fade: v })} />
        <Slider id={`${clipId}-sp`} label="Sharpen" value={g?.sharpen ?? 0} min={0} onCommit={(v) => put({ sharpen: v })} />
      </Section>
      <Section title="HSL">
        <div className="hsl-chips" role="radiogroup" aria-label="Colour range">
          {HSL_RANGES.map((r) => {
            const b = g?.hsl?.[r];
            const changed = !!b && (b.hue || b.sat || b.lum);
            return (
              <button key={r} role="radio" aria-checked={range === r} className={`${range === r ? 'on' : ''} ${changed ? 'changed' : ''}`} style={{ background: RANGE_COLOUR[r] }} title={r[0]!.toUpperCase() + r.slice(1)} onClick={() => setRange(r)} />
            );
          })}
        </div>
        <Slider id={`${clipId}-${range}-h`} label="Hue" value={band.hue} onCommit={(v) => setBand('hue', v)} />
        <Slider id={`${clipId}-${range}-s`} label="Saturation" value={band.sat} onCommit={(v) => setBand('sat', v)} />
        <Slider id={`${clipId}-${range}-l`} label="Lightness" value={band.lum} onCommit={(v) => setBand('lum', v)} />
      </Section>
      <Section title="Curve">
        <CurveEditor points={g?.curve} onCommit={(curve) => put({ curve })} />
      </Section>
      <Section title="LUT">
        <LutPicker lut={g?.lut} onCommit={(lut) => put({ lut })} />
      </Section>
    </>
  );
}

const SIZE = 168;

/** The tone curve: drag a point; click the line to add one; double-click a point to remove it. */
function CurveEditor({ points, onCommit }: { points: Array<[number, number]> | undefined; onCommit: (p: Array<[number, number]> | undefined) => void }) {
  const base: Array<[number, number]> = points ?? [
    [0, 0],
    [1, 1],
  ];
  const [live, setLive] = useState<Array<[number, number]> | null>(null);
  const pts = live ?? base;
  const svg = useRef<SVGSVGElement>(null);
  useEffect(() => setLive(null), [points]);
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height))];
  };
  const drag = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    let next = pts;
    const move = (ev: PointerEvent) => {
      const [x, y] = at(ev);
      const lo = i === 0 ? 0 : next[i - 1]![0] + 0.02;
      const hi = i === next.length - 1 ? 1 : next[i + 1]![0] - 0.02;
      next = next.map((p, k) => (k === i ? [i === 0 ? 0 : i === next.length - 1 ? 1 : Math.max(lo, Math.min(hi, x)), y] : p));
      setLive(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit(next.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const table = curveTable(pts);
  const path = Array.from({ length: 65 }, (_, i) => `${(i / 64) * SIZE},${(1 - table[Math.round((i / 64) * 255)]!) * SIZE}`).join(' ');
  return (
    <div className="curve-box">
      <svg
        ref={svg}
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={(e) => {
          if (pts.length >= 12) return;
          const [x, y] = at(e);
          const next = [...pts, [x, y] as [number, number]].sort((a, b) => a[0] - b[0]);
          onCommit(next);
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * SIZE} y1={0} x2={f * SIZE} y2={SIZE} className="curve-grid" />
            <line x1={0} y1={f * SIZE} x2={SIZE} y2={f * SIZE} className="curve-grid" />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className="curve-grid diag" />
        <polyline points={path} className="curve-line" />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={x * SIZE}
            cy={(1 - y) * SIZE}
            r={5}
            className="curve-pt"
            onPointerDown={(e) => drag(i, e)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (i === 0 || i === pts.length - 1) return;
              onCommit(pts.filter((_, k) => k !== i));
            }}
          />
        ))}
      </svg>
      <div className="curve-presets">
        <button className="btn sm ghost" onClick={() => onCommit([[0, 0], [0.25, 0.2], [0.75, 0.8], [1, 1]])} title="More contrast">
          S-curve
        </button>
        <button className="btn sm ghost" onClick={() => onCommit([[0, 0.08], [0.5, 0.52], [1, 0.94]])} title="Soft, faded film">
          Matte
        </button>
        {points && (
          <button className="btn sm ghost" onClick={() => onCommit(undefined)}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/** A LUT the user imported (.cube), and how strongly it is applied. */
function LutPicker({ lut, onCommit }: { lut: ColorGrade['lut']; onCommit: (l: ColorGrade['lut'] | undefined) => void }) {
  const ui = useUi();
  const [names, setNames] = useState<string[]>([]);
  const load = () => void invoke('studio:luts', {}).then((n) => setNames(Array.isArray(n) ? n : []), () => setNames([]));
  useEffect(load, []);
  const importOne = async () => {
    try {
      const r = await invoke('studio:importLut', {});
      if (!r) return;
      forgetLut(r.name);
      load();
      onCommit({ name: r.name, amount: lut?.amount ?? 1 });
      ui.toast(`Imported the LUT “${r.name}” (${r.size}³). It is kept for all your projects.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <div className="lut-pick">
      <div className="row" style={{ gap: 6 }}>
        <select className="select" value={lut?.name ?? ''} onChange={(e) => onCommit(e.target.value ? { name: e.target.value, amount: lut?.amount ?? 1 } : undefined)} aria-label="LUT">
          <option value="">No LUT</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
          {lut && !names.includes(lut.name) && <option value={lut.name}>{lut.name} (missing)</option>}
        </select>
        <button className="btn sm" onClick={() => void importOne()} title="Import a .cube LUT from your PC">
          Import .cube
        </button>
      </div>
      {lut && <Slider id={`lut-${lut.name}`} label="Strength" value={lut.amount} min={0} onCommit={(v) => onCommit({ name: lut.name, amount: v })} />}
    </div>
  );
}
