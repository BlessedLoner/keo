import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KEO_FONTS, SYSTEM_FONTS } from '@shared/studio';

/**
 * Keo Studio's inspector controls: sliding scrubbers instead of number boxes, a round colour swatch
 * that opens Keo's own dark colour picker, a font picker that shows every font in its own lettering,
 * and segmented choices. Every change is sent once, when the user lets go (one undo step).
 */

const round = (v: number) => Math.round(v * 1000) / 1000;
const decimals = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);

/**
 * A value as a slider: drag along it (or, without limits, drag left and right to scrub), click the
 * number to type one, arrows to nudge, double-click the track to go back to where it started.
 */
export function Num({
  label,
  value,
  min,
  max,
  step = 0.1,
  onCommit,
  suffix,
  keyframe,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
  suffix?: string;
  /** A keyframe button: on = this property is animated (editing sets a keyframe at the playhead). */
  keyframe?: { on: boolean; here: boolean; onToggle: () => void };
}) {
  const [live, setLive] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const track = useRef<HTMLDivElement>(null);
  const bounded = min !== undefined && max !== undefined && max > min;
  const shown = live ?? value;
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const snap = (v: number) => clamp(Math.round(v / step) * step);
  const commit = (v: number) => {
    const n = round(clamp(v));
    if (Math.abs(n - value) > 1e-9) onCommit(n);
  };
  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = track.current!.getBoundingClientRect();
    const x0 = e.clientX;
    const v0 = value;
    let moved = false;
    let v = v0;
    const at = (cx: number) => (bounded ? snap(min! + ((cx - r.left) / r.width) * (max! - min!)) : snap(v0 + (cx - x0) * step * (e.shiftKey ? 0.2 : 1)));
    if (bounded) {
      v = at(e.clientX);
      setLive(v);
      moved = true;
    }
    const move = (ev: PointerEvent) => {
      if (!bounded && Math.abs(ev.clientX - x0) < 3 && !moved) return;
      moved = true;
      v = at(ev.clientX);
      setLive(v);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(null);
      if (moved) commit(v);
      else {
        setDraft(String(round(value)));
        setTyping(true);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const pct = bounded ? Math.max(0, Math.min(1, (shown - min!) / (max! - min!))) : 0.5;
  // A range that runs both sides of zero fills from zero (–50 … 50 fills left or right of the middle).
  const zero = bounded && min! < 0 && max! > 0 ? (0 - min!) / (max! - min!) : 0;
  return (
    <div className={`scrub ${keyframe?.on ? 'keyed' : ''} ${live !== null ? 'active' : ''}`}>
      <div className="scrub-head">
        <span className="scrub-label">{label}</span>
        {keyframe && (
          <button
            type="button"
            className={`key-btn ${keyframe.on ? 'on' : ''} ${keyframe.here ? 'here' : ''}`}
            title={keyframe.on ? 'Animated: changes set a keyframe at the playhead. Click to stop animating.' : 'Animate this: keyframe it at the playhead'}
            onClick={(e) => {
              e.preventDefault();
              keyframe.onToggle();
            }}
          >
            ◆
          </button>
        )}
        {typing ? (
          <input
            className="scrub-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setTyping(false);
              const n = Number(draft);
              if (Number.isFinite(n)) commit(n);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setTyping(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="scrub-val"
            onClick={() => {
              setDraft(String(round(value)));
              setTyping(true);
            }}
            title="Click to type a value"
          >
            {shown.toFixed(decimals(step))}
            {suffix && <em>{suffix}</em>}
          </button>
        )}
      </div>
      <div
        ref={track}
        className={`scrub-track ${bounded ? '' : 'free'}`}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuenow={round(shown)}
        {...(bounded ? { 'aria-valuemin': min, 'aria-valuemax': max } : {})}
        onPointerDown={down}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          commit(snap(value + (e.key === 'ArrowRight' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)));
        }}
        title={bounded ? 'Drag, or click a point' : 'Drag left or right (Shift: finer)'}
      >
        {bounded ? (
          <>
            <span className="scrub-fill" style={{ left: `${Math.min(zero, pct) * 100}%`, width: `${Math.abs(pct - zero) * 100}%` }} />
            <span className="scrub-knob" style={{ left: `${pct * 100}%` }} />
          </>
        ) : (
          <span className="scrub-ticks" style={{ backgroundPositionX: `${(-shown / step) % 12}px` }} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- colour

/** The colours offered first: Keo's palette, then the user's recent ones. */
const PALETTE = ['#FFFFFF', '#F4F1EA', '#9AA3B2', '#111111', '#E53935', '#FF4D8D', '#FF7A18', '#FFD400', '#3FCF8E', '#14B8A6', '#36E2FF', '#3E63DD', '#8B6BFF', '#C9A227', '#8D5B3A', '#000000'];
const RECENT_KEY = 'keo.studio.recentColours';

function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, mx === 0 ? 0 : d / mx, mx];
}
function hsvToHex(h: number, s: number, v: number): string {
  const f = (k: number) => {
    const kk = (k + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1));
  };
  return `#${[f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const remember = (c: string) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, 8)));
  } catch {
    /* a convenience only */
  }
};

/** Keo's own colour picker: a saturation and brightness field, a hue strip, swatches, hex and an eyedropper. */
function ColorPopover({ value, anchor, onPick, onClose }: { value: string; anchor: DOMRect; onPick: (c: string) => void; onClose: () => void }) {
  const [hsv, setHsv] = useState<[number, number, number]>(() => hexToHsv(/^#[0-9a-f]{6}/i.test(value) ? value : '#FFFFFF'));
  const [hex, setHex] = useState(value.slice(0, 7).toUpperCase());
  const box = useRef<HTMLDivElement>(null);
  const cur = hsvToHex(...hsv);
  useEffect(() => setHex(cur), [cur]);
  useEffect(() => {
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  const pick = (c: string) => {
    remember(c);
    onPick(c);
  };
  const drag = (el: HTMLElement, e: React.PointerEvent, f: (x: number, y: number) => [number, number, number]) => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    let next = hsv;
    const at = (cx: number, cy: number) => {
      next = f(Math.max(0, Math.min(1, (cx - r.left) / r.width)), Math.max(0, Math.min(1, (cy - r.top) / r.height)));
      setHsv(next);
    };
    at(e.clientX, e.clientY);
    const move = (ev: PointerEvent) => at(ev.clientX, ev.clientY);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      pick(hsvToHex(...next));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 330);
  const left = Math.min(Math.max(8, anchor.left - 100), window.innerWidth - 248);
  const dropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  return createPortal(
    <div className="cpop" ref={box} style={{ top, left }} role="dialog" aria-label="Colour">
      <div className="cpop-sv" style={{ background: `hsl(${hsv[0]}, 100%, 50%)` }} onPointerDown={(e) => drag(e.currentTarget, e, (x, y) => [hsv[0], x, 1 - y])}>
        <span className="cpop-sv-white" />
        <span className="cpop-sv-black" />
        <span className="cpop-dot" style={{ left: `${hsv[1] * 100}%`, top: `${(1 - hsv[2]) * 100}%`, background: cur }} />
      </div>
      <div className="cpop-hue" onPointerDown={(e) => drag(e.currentTarget, e, (x) => [x * 359.9, hsv[1], hsv[2]])}>
        <span className="cpop-hue-knob" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="cpop-row">
        <span className="cpop-now" style={{ background: cur }} />
        <input
          className="cpop-hex"
          value={hex}
          maxLength={7}
          onChange={(e) => setHex(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && /^#[0-9A-F]{6}$/.test(hex)) {
              setHsv(hexToHsv(hex));
              pick(hex);
            }
          }}
          aria-label="Hex colour"
        />
        {dropper && (
          <button
            type="button"
            className="cpop-drop"
            title="Pick a colour from anywhere on the screen"
            onClick={() =>
              void new dropper()
                .open()
                .then((r) => {
                  const c = r.sRGBHex.toUpperCase();
                  setHsv(hexToHsv(c));
                  pick(c);
                })
                .catch(() => undefined)
            }
          >
            ⌖
          </button>
        )}
      </div>
      <div className="cpop-swatches">
        {[...new Set([...recent(), ...PALETTE])].slice(0, 24).map((c) => (
          <button
            key={c}
            type="button"
            className={`cpop-sw ${c === cur ? 'on' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => {
              setHsv(hexToHsv(c));
              pick(c);
            }}
          />
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** A round swatch of the colour; clicking it opens the picker. */
export function Swatch({ value, onCommit, title }: { value: string; onCommit: (v: string) => void; title?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<DOMRect | null>(null);
  return (
    <>
      <button type="button" ref={btn} className="cdot" style={{ ['--c' as string]: value.slice(0, 7) }} title={title ?? value} onClick={() => setOpen(btn.current!.getBoundingClientRect())} />
      {open && <ColorPopover value={value} anchor={open} onPick={(c) => onCommit(c)} onClose={() => setOpen(null)} />}
    </>
  );
}

export function Color({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <div className="ccell">
      <span className="scrub-label">{label}</span>
      <div className="ccell-row">
        <Swatch value={value} onCommit={onCommit} title={`${label}: ${value.slice(0, 7)}`} />
        <span className="ccell-hex">{value.slice(0, 7).toUpperCase()}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- fonts

/** The font, shown in its own lettering; clicking opens every font as a card. */
export function FontPicker({ value, onPick, label = 'Font', allowDefault }: { value: string | undefined; onPick: (f: string | null) => void; label?: string; allowDefault?: string }) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<DOMRect | null>(null);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [open]);
  const fonts = [...KEO_FONTS.map((f) => [f, 'Keo'] as const), ...SYSTEM_FONTS.map((f) => [f, 'Windows'] as const)].filter(([f]) => f.toLowerCase().includes(q.toLowerCase()));
  const top = open ? Math.min(open.bottom + 6, window.innerHeight - 380) : 0;
  const left = open ? Math.min(Math.max(8, open.left), window.innerWidth - 300) : 0;
  return (
    <div className="fpick">
      <span className="scrub-label">{label}</span>
      <button type="button" ref={btn} className="fpick-btn" style={value ? { fontFamily: `"${value}"` } : undefined} onClick={() => setOpen(open ? null : btn.current!.getBoundingClientRect())}>
        <span className="fpick-aa">Aa</span>
        <span className="fpick-name">{value ?? allowDefault ?? 'Choose'}</span>
        <span className="fpick-caret">▾</span>
      </button>
      {open &&
        createPortal(
          <div className="fpop" ref={box} style={{ top, left }}>
            <input className="input" autoFocus placeholder="Search fonts" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="fpop-grid">
              {allowDefault && (
                <button
                  type="button"
                  className={`font-card ${!value ? 'on' : ''}`}
                  onClick={() => {
                    onPick(null);
                    setOpen(null);
                  }}
                >
                  <span className="font-aa">✦</span>
                  <span className="font-name">{allowDefault}</span>
                </button>
              )}
              {fonts.map(([f, from]) => (
                <button
                  key={f}
                  type="button"
                  className={`font-card ${value === f ? 'on' : ''}`}
                  title={`${f} (${from})`}
                  onClick={() => {
                    onPick(f);
                    setOpen(null);
                  }}
                >
                  <span className="font-aa" style={{ fontFamily: `"${f}"` }}>
                    Aa
                  </span>
                  <span className="font-name" style={{ fontFamily: `"${f}"` }}>
                    {f}
                  </span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------- choices and sections

/** A choice of a few options as a row of segments (instead of a drop-down). */
export function Seg<T extends string>({ label, value, options, onPick }: { label?: string; value: T; options: Array<[T, string]>; onPick: (v: T) => void }) {
  const row = useRef<HTMLDivElement>(null);
  const [ind, setInd] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const el = row.current?.querySelector<HTMLElement>('button.on');
    setInd(el ? { left: el.offsetLeft, width: el.offsetWidth } : null);
  }, [value, options.length]);
  return (
    <div className="seg-wrap">
      {label && <span className="scrub-label">{label}</span>}
      <div className="seg" ref={row} role="radiogroup" aria-label={label}>
        {ind && <span className="seg-ind" style={{ left: ind.left, width: ind.width }} />}
        {options.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onPick(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="insp-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}
