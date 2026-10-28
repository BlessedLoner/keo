import { useEffect, useState, type ReactNode } from 'react';

/** Small inspector fields shared by the Studio panels. */

/** A number field that saves on Enter or when it loses focus. */
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
  const [draft, setDraft] = useState(String(round(value)));
  useEffect(() => setDraft(String(round(value))), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) return setDraft(String(round(value)));
    const v = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    if (Math.abs(v - value) > 1e-6) onCommit(v);
    else setDraft(String(round(value)));
  };
  return (
    <label className={`insp-num ${keyframe?.on ? 'keyed' : ''}`}>
      <span>
        {label}
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
      </span>
      <input className="input" type="number" value={draft} min={min} max={max} step={step} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
      {suffix && <em>{suffix}</em>}
    </label>
  );
}
const round = (v: number) => Math.round(v * 1000) / 1000;

export function Color({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <label className="insp-color">
      <span>{label}</span>
      <input type="color" value={value.slice(0, 7)} onChange={(e) => onCommit(e.target.value.toUpperCase())} />
    </label>
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
