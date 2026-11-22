import { Design } from '@shared/studioDesign';
import { SAMPLE_SCENE } from '@shared/scene';
import { useState } from 'react';
import { TRANSITION_LABEL } from './Timeline';
import { CUT_SHAPES, keyValue, MOTION_PIECE_INFO, MOTION_PIECES, MOTIONS, TRANSITIONS, volumeAt, type AdjustClip, type AudioClip, type EditOp, type Key, type KeyProp, type MediaClip, type MotionClip, type Project, type ShapeClip, type TextClip } from '@shared/studio';
import { PRESETS, presetOps, type PresetId } from '@shared/studioPresets';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { Color, Num, Section, Swatch } from './fields';
import { MotionEdit } from './MotionEdit';

/**
 * Studio inspector parts for motion design: position with keyframes, entrances, exits and loops,
 * shape style, masks and device mock-ups, counters; and the Elements panel (shapes and presets).
 */

type SetPatch = Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>;
type Visual = MediaClip | TextClip | ShapeClip | MotionClip;

const MOTION_LABEL: Record<(typeof MOTIONS)[number], string> = {
  fade: 'Fade',
  'slide-left': 'Slide from right',
  'slide-right': 'Slide from left',
  'slide-up': 'Slide up',
  'slide-down': 'Slide down',
  'zoom-in': 'Zoom in',
  'zoom-out': 'Zoom out',
  pop: 'Pop',
  spin: 'Spin',
  blur: 'Blur',
  whip: 'Whip',
  flash: 'Flash',
  'wipe-left': 'Wipe ←',
  'wipe-right': 'Wipe →',
  'wipe-up': 'Wipe ↑',
  'wipe-down': 'Wipe ↓',
  iris: 'Iris (circle)',
};


const CUT_LABEL: Record<'none' | (typeof CUT_SHAPES)[number], string> = { none: 'None', linear: 'Linear', mirror: 'Mirror', circle: 'Circle', rect: 'Rectangle', star: 'Star', heart: 'Heart' };
const CUT_ICON: Record<'none' | (typeof CUT_SHAPES)[number], string> = {
  none: 'M5 5L19 19M19 5L5 19',
  linear: 'M3 13h18M3 3h18v10H3z',
  mirror: 'M3 8h18v8H3z',
  circle: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16z',
  rect: 'M4 6h16v12H4z',
  star: 'M12 3l2.6 6 6.4.5-4.9 4.2 1.5 6.3L12 16.6 6.4 20l1.5-6.3L3 9.5l6.4-.5z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
};

/** Position, scale, rotation and opacity — each can be keyframed at the playhead. */
export function PositionFields({ clip, time, fps, set }: { clip: Visual; time: number; fps: number; set: (p: SetPatch) => void }) {
  const rt = Math.max(0, Math.min(clip.duration, time - clip.start));
  const inside = time >= clip.start - 1e-6 && time <= clip.start + clip.duration + 1e-6;
  const frame = 1 / fps;
  const prop = (k: KeyProp, base: number) => {
    const keys = clip.keys?.[k];
    const on = !!keys?.length;
    const value = on ? keyValue(keys!, rt) : base;
    const here = on && keys!.some((x) => Math.abs(x.at - rt) < frame / 2);
    const commit = (v: number) => {
      if (!on) {
        if (k === 'x' || k === 'y' || k === 'scale' || k === 'rotation' || k === 'opacity') set({ transform: { [k]: v } });
        else set({ keys: { [k]: [{ at: 0, value: v, ease: 'hold' }] } });
        return;
      }
      // Animated: the value at the playhead becomes (or replaces) a keyframe.
      const next: Key[] = keys!.filter((x) => Math.abs(x.at - rt) >= frame / 2);
      next.push({ at: Math.round(rt * 1000) / 1000, value: v, ease: 'in-out' });
      set({ keys: { [k]: next.sort((a, b) => a.at - b.at) } });
    };
    const onToggle = () => {
      if (on) set({ keys: { [k]: null } });
      else set({ keys: { [k]: [{ at: Math.round(rt * 1000) / 1000, value, ease: 'in-out' }] } });
    };
    return { value, commit, keyframe: inside ? { on, here, onToggle } : undefined };
  };
  const x = prop('x', clip.transform.x);
  const y = prop('y', clip.transform.y);
  const sc = prop('scale', clip.transform.scale);
  const rot = prop('rotation', clip.transform.rotation);
  const op = prop('opacity', clip.transform.opacity);
  const blur = prop('blur', 0);
  const sx = prop('scaleX', 1);
  const sy = prop('scaleY', 1);
  const tx = prop('tiltX', 0);
  const ty = prop('tiltY', 0);
  return (
    <div className="insp-grid">
      <Num label="X" value={x.value * 100} step={1} suffix="%" onCommit={(v) => x.commit(v / 100)} keyframe={x.keyframe} />
      <Num label="Y" value={y.value * 100} step={1} suffix="%" onCommit={(v) => y.commit(v / 100)} keyframe={y.keyframe} />
      <Num label="Scale" value={sc.value * 100} min={1} max={2000} step={5} suffix="%" onCommit={(v) => sc.commit(v / 100)} keyframe={sc.keyframe} />
      <Num label="Rotate" value={rot.value} step={1} suffix="°" onCommit={(v) => rot.commit(v)} keyframe={rot.keyframe} />
      <Num label="Opacity" value={op.value * 100} min={0} max={100} step={5} suffix="%" onCommit={(v) => op.commit(v / 100)} keyframe={op.keyframe} />
      <Num label="Blur" value={blur.value} min={0} max={20} step={0.5} suffix="%" onCommit={(v) => blur.commit(v)} keyframe={blur.keyframe} />
      <Num label="Stretch X" value={sx.value * 100} min={1} max={2000} step={5} suffix="%" onCommit={(v) => sx.commit(v / 100)} keyframe={sx.keyframe} />
      <Num label="Stretch Y" value={sy.value * 100} min={1} max={2000} step={5} suffix="%" onCommit={(v) => sy.commit(v / 100)} keyframe={sy.keyframe} />
      {clip.type === 'media' && (
        <>
          <Num label="3D tilt ↕" value={tx.value} min={-80} max={80} step={1} suffix="°" onCommit={(v) => tx.commit(v)} keyframe={tx.keyframe} />
          <Num label="3D turn ↔" value={ty.value} min={-80} max={80} step={1} suffix="°" onCommit={(v) => ty.commit(v)} keyframe={ty.keyframe} />
        </>
      )}
    </div>
  );
}

/** A sound clip's volume, with keyframes (◆) so it can rise and dip over the clip. */
export function VolumeField({ clip, time, fps, set }: { clip: MediaClip | AudioClip; time: number; fps: number; set: (p: SetPatch) => void }) {
  const rt = Math.max(0, Math.min(clip.duration, time - clip.start));
  const inside = time >= clip.start - 1e-6 && time <= clip.start + clip.duration + 1e-6;
  const frame = 1 / fps;
  const keys = clip.volumeKeys;
  const on = !!keys?.length;
  const value = volumeAt(clip, rt);
  const here = on && keys!.some((x) => Math.abs(x.at - rt) < frame / 2);
  const commit = (v: number) => {
    if (!on) return set({ volume: v });
    // Animated: the value at the playhead becomes (or replaces) a keyframe.
    const next: Key[] = keys!.filter((x) => Math.abs(x.at - rt) >= frame / 2);
    next.push({ at: Math.round(rt * 1000) / 1000, value: v, ease: 'in-out' });
    set({ volumeKeys: next.sort((a, b) => a.at - b.at) });
  };
  const onToggle = () => set({ volumeKeys: on ? null : [{ at: Math.round(rt * 1000) / 1000, value, ease: 'in-out' }] });
  return <Num label="Volume" value={Math.round(value * 100)} min={0} max={400} step={5} suffix="%" onCommit={(v) => commit(v / 100)} keyframe={inside ? { on, here, onToggle } : undefined} />;
}

/** Entrance, exit (videos, pictures, shapes) and a loop (everything visible). */
export function MotionFields({ clip, set }: { clip: Visual; set: (p: SetPatch) => void }) {
  const inOut = clip.type !== 'text';
  const motionSelect = (which: 'enter' | 'exit') => {
    const cur = clip.type !== 'text' ? clip[which] : undefined;
    return (
      <div className="insp-grid">
        <label className="insp-num">
          <span>{which === 'enter' ? 'In' : 'Out'}</span>
          <select className="select" value={cur?.kind ?? 'none'} onChange={(e) => set({ [which]: e.target.value === 'none' ? null : { kind: e.target.value as (typeof MOTIONS)[number], seconds: cur?.seconds ?? 0.45 } })}>
            <option value="none">None</option>
            {MOTIONS.map((m) => (
              <option key={m} value={m}>
                {MOTION_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
        {cur && <Num label="Seconds" value={cur.seconds} min={0.05} max={5} step={0.05} suffix="s" onCommit={(v) => set({ [which]: { ...cur, seconds: v } })} />}
      </div>
    );
  };
  const loop = clip.loop;
  return (
    <Section title="Motion">
      {inOut && motionSelect('enter')}
      {inOut && motionSelect('exit')}
      <div className="insp-grid">
        <label className="insp-num">
          <span>Loop</span>
          <select className="select" value={loop?.kind ?? 'none'} onChange={(e) => set({ loop: e.target.value === 'none' ? null : { kind: e.target.value as NonNullable<Visual['loop']>['kind'], amount: loop?.amount ?? 0.3, period: loop?.period ?? 2 } })}>
            <option value="none">None</option>
            <option value="float">Float</option>
            <option value="pulse">Pulse</option>
            <option value="shake">Shake</option>
            <option value="spin">Spin</option>
            <option value="sway">Sway</option>
            <option value="flicker">Flicker</option>
          </select>
        </label>
        {loop && <Num label="Amount" value={loop.amount * 100} min={0} max={100} step={5} suffix="%" onCommit={(v) => set({ loop: { ...loop, amount: v / 100 } })} />}
        {loop && <Num label="Every" value={loop.period} min={0.1} max={30} step={0.1} suffix="s" onCommit={(v) => set({ loop: { ...loop, period: v } })} />}
      </div>
    </Section>
  );
}

/** Green screen: remove a colour (green or blue) from a video or picture. */
export function ChromaFields({ clip, set }: { clip: MediaClip; set: (p: SetPatch) => void }) {
  const k = clip.chroma;
  const slider = (key: 'similarity' | 'smoothness' | 'spill', label: string) => (
    <Num key={key} label={label} value={Math.round((k?.[key] ?? 0) * 100)} min={0} max={100} step={1} onCommit={(v) => set({ chroma: { [key]: v / 100 } })} />
  );
  return (
    <Section title="Green screen">
      <div className="insp-seg" role="radiogroup" aria-label="Remove colour">
        {(
          [
            [null, 'Off'],
            ['#00FF00', 'Green'],
            ['#0047FF', 'Blue'],
          ] as const
        ).map(([color, label]) => {
          const on = color === null ? !k : k?.color.toUpperCase() === color;
          return (
            <button key={label} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => set({ chroma: color === null ? null : { color } })}>
              {label}
            </button>
          );
        })}
      </div>
      {k && (
        <>
          <Color label="Colour to remove" value={k.color} onCommit={(v) => set({ chroma: { color: v } })} />
          {slider('similarity', 'Strength')}
          {slider('smoothness', 'Edge softness')}
          {slider('spill', 'Remove green glow')}
        </>
      )}
    </Section>
  );
}

/** Effects over the picture, each with a strength. */
export function EffectsFields({ clip, set }: { clip: MediaClip | AdjustClip; set: (p: SetPatch) => void }) {
  const fx = clip.effects ?? {};
  const rows: Array<[keyof NonNullable<MediaClip['effects']>, string]> = [
    ['grain', 'Film grain'],
    ['vhs', 'VHS'],
    ['glow', 'Glow'],
    ['rgbSplit', 'RGB split'],
    ['lightLeak', 'Light leak'],
    ['letterbox', 'Cinema bars'],
    ['filmBurn', 'Film burn'],
    ['dream', 'Dreamy'],
    ['glitch', 'Glitch'],
    ['crt', 'Old TV'],
    ['sparkle', 'Sparkles'],
    ['bokeh', 'Bokeh'],
    ['prism', 'Prism flare'],
    ['strobe', 'Strobe'],
  ];
  return (
    <Section title="Effects">
      <div className="insp-grid">
        {rows.map(([k, label]) => (
          <Num key={k} label={label} value={Math.round((fx[k] ?? 0) * 100)} min={0} max={100} step={1} onCommit={(v) => set({ effects: { [k]: v / 100 || null } })} />
        ))}
      </div>
      {clip.effects && (
        <button className="btn sm ghost" onClick={() => set({ effects: null })}>
          Remove effects
        </button>
      )}
    </Section>
  );
}

/** How this clip takes over from the one before it on its track. */
export function TransitionFields({ clip, hasBefore, set }: { clip: MediaClip; hasBefore: boolean; set: (p: SetPatch) => void }) {
  const tr = clip.transition;
  return (
    <Section title="Transition in">
      {!hasBefore && <p className="small muted" style={{ margin: '0 0 6px' }}>Works when another clip ends right where this one starts on the same track.</p>}
      <div className="insp-grid">
        <label className="insp-num">
          <span>Kind</span>
          <select className="select" value={tr?.kind ?? 'none'} onChange={(e) => set({ transition: e.target.value === 'none' ? null : { kind: e.target.value as NonNullable<MediaClip['transition']>['kind'], seconds: tr?.seconds ?? 0.6 } })}>
            <option value="none">None (cut)</option>
            {TRANSITIONS.map((k) => (
              <option key={k} value={k}>
                {TRANSITION_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        {tr && <Num label="Seconds" value={tr.seconds} min={0.1} max={3} step={0.05} suffix="s" onCommit={(v) => set({ transition: { ...tr, seconds: v } })} />}
      </div>
    </Section>
  );
}

/** Masks, device mock-ups and a shadow for videos and pictures. */
export function FrameFields({ clip, projectId, set }: { clip: MediaClip; projectId: string; set: (p: SetPatch) => void }) {
  const ui = useUi();
  const [reframing, setReframing] = useState(false);
  const reframe = async () => {
    setReframing(true);
    try {
      const r = await invoke('studio:reframe', { id: projectId, clip: clip.id });
      ui.toast(`Following the subject: ${r.points} points across the clip.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setReframing(false);
    }
  };
  return (
    <Section title="Frame">
      <div className="insp-grid">
        <label className="insp-num">
          <span>Shape</span>
          <select className="select" value={clip.mask?.shape ?? 'none'} onChange={(e) => set({ mask: e.target.value === 'none' ? null : { shape: e.target.value as 'rounded' | 'circle', radius: clip.mask?.radius ?? 0.08 } })}>
            <option value="none">Full</option>
            <option value="rounded">Rounded</option>
            <option value="circle">Circle</option>
          </select>
        </label>
        <label className="insp-num">
          <span>Device</span>
          <select className="select" value={clip.frame ?? 'none'} onChange={(e) => set({ frame: e.target.value === 'none' ? null : (e.target.value as 'phone' | 'browser' | 'card') })}>
            <option value="none">None</option>
            <option value="phone">Phone</option>
            <option value="browser">Browser</option>
            <option value="card">Card</option>
          </select>
        </label>
        {clip.mask?.shape === 'rounded' && <Num label="Corners" value={clip.mask.radius * 100} min={0} max={50} step={1} suffix="%" onCommit={(v) => set({ mask: { ...clip.mask!, radius: v / 100 } })} />}
        <Num label="Shadow" value={clip.shadow} min={0} max={60} step={2} onCommit={(v) => set({ shadow: v })} />
      </div>
      <button className="btn sm" style={{ marginTop: 10 }} disabled={reframing} onClick={() => void reframe()} title="Keo looks at the clip and pans it to keep the main subject in the middle (for a wide video in a tall frame)">
        {reframing ? <span className="spinner tiny" /> : <Icon name="vision" size={13} />} {reframing ? 'Finding the subject…' : 'Auto-reframe (follow the subject)'}
      </button>
      <h4 style={{ margin: '12px 0 8px' }}>Mask</h4>
      <div className="mask-chips" role="radiogroup" aria-label="Mask shape">
        {(['none', ...CUT_SHAPES] as const).map((k) => (
          <button
            key={k}
            role="radio"
            aria-checked={(clip.cut?.shape ?? 'none') === k}
            className={(clip.cut?.shape ?? 'none') === k ? 'on' : ''}
            title={CUT_LABEL[k]}
            onClick={() => set({ cut: k === 'none' ? null : { ...(clip.cut ?? { x: 0, y: 0, w: 0.6, h: k === 'mirror' ? 0.35 : 0.6, angle: 0, feather: 0, invert: false }), shape: k } })}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d={CUT_ICON[k]} />
            </svg>
            <span>{CUT_LABEL[k]}</span>
          </button>
        ))}
      </div>
      {clip.cut && (
        <div className="insp-grid">
          <Num label="X" value={Math.round(clip.cut.x * 100)} min={-100} max={100} step={1} suffix="%" onCommit={(v) => set({ cut: { ...clip.cut!, x: v / 100 } })} />
          <Num label="Y" value={Math.round(clip.cut.y * 100)} min={-100} max={100} step={1} suffix="%" onCommit={(v) => set({ cut: { ...clip.cut!, y: v / 100 } })} />
          {clip.cut.shape !== 'linear' && clip.cut.shape !== 'mirror' && <Num label="Width" value={Math.round(clip.cut.w * 100)} min={2} max={300} step={1} suffix="%" onCommit={(v) => set({ cut: { ...clip.cut!, w: v / 100 } })} />}
          {clip.cut.shape !== 'linear' && <Num label={clip.cut.shape === 'mirror' ? 'Band' : 'Height'} value={Math.round(clip.cut.h * 100)} min={2} max={300} step={1} suffix="%" onCommit={(v) => set({ cut: { ...clip.cut!, h: v / 100 } })} />}
          <Num label="Angle" value={clip.cut.angle} min={-360} max={360} step={1} suffix="°" onCommit={(v) => set({ cut: { ...clip.cut!, angle: v } })} />
          <Num label="Feather" value={Math.round(clip.cut.feather * 100)} min={0} max={100} step={1} suffix="%" onCommit={(v) => set({ cut: { ...clip.cut!, feather: v / 100 } })} />
          <label className="insp-check">
            <input type="checkbox" checked={clip.cut.invert} onChange={(e) => set({ cut: { ...clip.cut!, invert: e.target.checked } })} /> Invert
          </label>
        </div>
      )}
      <h4 style={{ margin: '12px 0 8px' }}>Crop</h4>
      <div className="insp-grid">
        {(['left', 'right', 'top', 'bottom'] as const).map((k) => (
          <Num key={k} label={k[0]!.toUpperCase() + k.slice(1)} value={(clip.crop?.[k] ?? 0) * 100} min={0} max={45} step={1} suffix="%" onCommit={(v) => set({ crop: { [k]: v / 100 } })} />
        ))}
      </div>
      {clip.crop && (
        <button className="btn sm ghost" onClick={() => set({ crop: null })}>
          Reset crop
        </button>
      )}
    </Section>
  );
}

/** A shape's kind, size, colours, outline, glow and shadow. */
export function ShapeFields({ clip, set }: { clip: ShapeClip; set: (p: SetPatch) => void }) {
  const st = clip.style;
  const s = (patch: Partial<ShapeClip['style']>) => set({ shapeStyle: patch });
  return (
    <Section title="Shape">
      <div className="insp-grid">
        <label className="insp-num">
          <span>Kind</span>
          <select className="select" value={clip.shape} onChange={(e) => set({ shape: e.target.value as ShapeClip['shape'] })}>
            {(['rect', 'circle', 'ring', 'line', 'arrow', 'star', 'triangle'] as const).map((k) => (
              <option key={k} value={k}>
                {k === 'rect' ? 'Rectangle' : k[0]!.toUpperCase() + k.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {clip.shape === 'rect' && <Num label="Corners" value={st.radius * 100} min={0} max={50} step={1} suffix="%" onCommit={(v) => s({ radius: v / 100 })} />}
        <Num label="Width" value={st.width * 100} min={0.1} max={400} step={1} suffix="%" onCommit={(v) => s({ width: v / 100 })} />
        <Num label="Height" value={st.height * 100} min={0.1} max={400} step={1} suffix="%" onCommit={(v) => s({ height: v / 100 })} />
        <label className="insp-color">
          <span>Fill</span>
          <input type="checkbox" checked={!!st.fill} onChange={(e) => s({ fill: e.target.checked ? '#FFFFFF' : null })} />
          {st.fill && <Swatch value={st.fill} onCommit={(c) => s({ fill: c })} />}
        </label>
        <label className="insp-color">
          <span>Gradient</span>
          <input type="checkbox" checked={!!st.fill2} onChange={(e) => s({ fill2: e.target.checked ? '#8B6BFF' : null })} />
          {st.fill2 && <Swatch value={st.fill2} onCommit={(c) => s({ fill2: c })} />}
        </label>
        <label className="insp-color">
          <span>Outline</span>
          <input type="checkbox" checked={!!st.stroke} onChange={(e) => s({ stroke: e.target.checked ? '#FFFFFF' : null })} />
          {st.stroke && <Swatch value={st.stroke} onCommit={(c) => s({ stroke: c })} />}
        </label>
        <Num label="Thickness" value={st.strokeWidth} min={0} max={100} step={1} onCommit={(v) => s({ strokeWidth: v })} />
        <Num label="Glow" value={st.glow} min={0} max={80} step={2} onCommit={(v) => s({ glow: v })} />
        <Color label="Glow colour" value={st.glowColor} onCommit={(v) => s({ glowColor: v })} />
        <Num label="Shadow" value={st.shadow} min={0} max={60} step={2} onCommit={(v) => s({ shadow: v })} />
      </div>
      <label className="insp-check">
        <input type="checkbox" checked={st.draw} onChange={(e) => s({ draw: e.target.checked })} /> Outline draws itself on
      </label>
    </Section>
  );
}

/** A counting number for text clips. */
export function CounterFields({ clip, set }: { clip: TextClip; set: (p: SetPatch) => void }) {
  const c = clip.counter;
  return (
    <Section title="Counter">
      <label className="insp-check">
        <input
          type="checkbox"
          checked={!!c}
          onChange={(e) => {
            const n = Number((/-?[\d,.]+/.exec(clip.text)?.[0] ?? '100').replace(/,/g, ''));
            set({ counter: e.target.checked ? { from: 0, to: Number.isFinite(n) ? n : 100, decimals: 0, prefix: '', suffix: '', separator: true } : null });
          }}
        />{' '}
        Count up while it is on screen
      </label>
      {c && (
        <div className="insp-grid" style={{ marginTop: 8 }}>
          <Num label="From" value={c.from} step={1} onCommit={(v) => set({ counter: { ...c, from: v } })} />
          <Num label="To" value={c.to} step={1} onCommit={(v) => set({ counter: { ...c, to: v } })} />
          <Num label="Decimals" value={c.decimals} min={0} max={4} step={1} onCommit={(v) => set({ counter: { ...c, decimals: Math.round(v) } })} />
          <label className="insp-num">
            <span>Before</span>
            <input className="input" defaultValue={c.prefix} maxLength={20} onBlur={(e) => e.target.value !== c.prefix && set({ counter: { ...c, prefix: e.target.value } })} />
          </label>
          <label className="insp-num wide">
            <span>After</span>
            <input className="input" defaultValue={c.suffix} maxLength={40} onBlur={(e) => e.target.value !== c.suffix && set({ counter: { ...c, suffix: e.target.value } })} />
          </label>
        </div>
      )}
    </Section>
  );
}

const NEEDS_TEXT: PresetId[] = ['title', 'kinetic-words', 'lower-third', 'counter'];
export const NEEDS_MEDIA: PresetId[] = ['logo-reveal', 'phone', 'avatar'];
export const PRESET_LABEL: Record<PresetId, string> = {
  title: 'Kinetic title',
  'kinetic-words': 'Word by word',
  'lower-third': 'Lower third',
  subscribe: 'Subscribe button',
  'progress-bar': 'Progress bar',
  counter: 'Counter',
  underline: 'Underline',
  'neon-frame': 'Neon frame',
  'glow-orb': 'Glow orb',
  'logo-reveal': 'Logo reveal',
  phone: 'Phone mock-up',
  avatar: 'Avatar',
};

/** Shapes and motion presets, added at the playhead. */
export function ElementsPanel({ project, time, onEdit }: { project: Project; time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const ui = useUi();
  const [preset, setPreset] = useState<PresetId>('title');
  const [text, setText] = useState('');
  const visuals = project.assets.filter((a) => a.kind !== 'audio');
  const [assetId, setAssetId] = useState<string>('');
  const media = assetId || visuals.at(-1)?.id || '';
  const addShape = (shape: ShapeClip['shape']) => {
    const w = shape === 'line' || shape === 'arrow' ? 0.4 : 0.3;
    const round = shape === 'circle' || shape === 'ring' || shape === 'star';
    const side = 0.3 * Math.min(project.width, project.height);
    const style = round ? { width: side / project.width, height: side / project.height } : shape === 'line' || shape === 'arrow' ? { width: w, height: 0.05, strokeWidth: 10 } : { width: w, height: 0.12 };
    void onEdit([{ op: 'add_shape', shape, start: time, duration: 3, style, enter: { kind: 'pop', seconds: 0.4 }, exit: { kind: 'fade', seconds: 0.3 } }]);
  };
  const addPreset = async () => {
    try {
      await onEdit(presetOps(project, preset, { at: time, ...(text.trim() ? { text: text.trim() } : {}), ...(NEEDS_MEDIA.includes(preset) && media ? { assetId: media } : {}) }));
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="studio-card elements">
      <div className="studio-pane-head">
        <span>Elements</span>
      </div>
      <div className="shape-row">
        {(
          [
            ['rect', 'Rectangle', '▭'],
            ['circle', 'Circle', '●'],
            ['ring', 'Ring', '○'],
            ['line', 'Line', '─'],
            ['arrow', 'Arrow', '➜'],
            ['star', 'Star', '★'],
            ['triangle', 'Triangle', '▲'],
          ] as const
        ).map(([k, label, glyph]) => (
          <button key={k} className="btn icon sm" title={`Add a ${label.toLowerCase()} at the playhead`} onClick={() => addShape(k)}>
            {glyph}
          </button>
        ))}
      </div>
      <label className="insp-num wide auto-row">
        <span>Motion preset</span>
        <select className="select" value={preset} onChange={(e) => setPreset(e.target.value as PresetId)} title={PRESETS[preset]}>
          {(Object.keys(PRESETS) as PresetId[]).map((k) => (
            <option key={k} value={k}>
              {PRESET_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      {NEEDS_TEXT.includes(preset) && (
        <label className="insp-num wide auto-row">
          <span>Text</span>
          <input className="input" value={text} maxLength={300} placeholder={preset === 'counter' ? '10,000 followers' : preset === 'lower-third' ? 'Your Name' : 'Your title'} onChange={(e) => setText(e.target.value)} />
        </label>
      )}
      {NEEDS_MEDIA.includes(preset) && (
        <label className="insp-num wide auto-row">
          <span>Picture or video</span>
          <select className="select" value={media} onChange={(e) => setAssetId(e.target.value)}>
            {!visuals.length && <option value="">Add one to Media first</option>}
            {visuals.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="auto-row">
        <button className="btn sm primary" disabled={NEEDS_MEDIA.includes(preset) && !media} onClick={() => void addPreset()}>
          <Icon name="plus" size={13} /> Add at playhead
        </button>
      </div>
      <MotionEdit project={project} />
      <MotionGraphics time={time} onEdit={onEdit} />
    </div>
  );
}

/** Starting words for each motion piece (changed in the Motion tab after). */
export const MOTION_SAMPLE: Record<(typeof MOTION_PIECES)[number], Omit<Extract<EditOp, { op: 'add_motion' }>, 'op' | 'piece' | 'place'>> = {
  headline: { text: 'Your big idea here', sub: 'Chapter one' },
  word_pop: { text: 'Wow', icon: 'fire' },
  icon_burst: { text: 'Grow faster', items: ['rocket', 'chart', 'users', 'heart'] },
  chips: { text: 'Key points', items: ['First point', 'Second point', 'Third point'], icon: 'check' },
  stat: { text: 'more views', value: 87, unit: '%' },
  list: { text: '3 steps', items: ['Step one', 'Step two', 'Step three'] },
  lower_third: { text: 'Your Name', sub: 'Your role' },
  quote: { text: 'A line worth remembering.', sub: 'Someone' },
  card3d: { text: 'Your product', sub: 'One line about it', icon: 'sparkle' },
  highlight: { text: 'The part that matters most', items: ['matters', 'most'] },
  callout: { text: 'Look here' },
  light_sweep: { text: 'Next' },
  scene: { text: 'This changes everything', items: ['everything'], sub: 'The big idea', background: '#F4F1EA', color: '#111111' },
  backdrop: { text: 'Keo', background: '#0D0C12' },
  scene3d: { text: SAMPLE_SCENE.title, visual: SAMPLE_SCENE },
  ticker: { text: 'New collection out now', sub: 'Breaking', items: ['Free shipping this week'] },
  countdown: { text: 'Launch', value: 3 },
  location: { text: 'Lagos', sub: 'Nigeria · Golden hour' },
  subscribe: { text: 'Subscribe', sub: 'Subscribed' },
  progress: { text: 'Chapters', items: ['Intro', 'Setup', 'Result', 'Outro'], value: 2 },
  split_title: { text: 'Summer', sub: 'collection' },
  price_tag: { text: 'Today only', value: 49, unit: '$', sub: '$89' },
  social_card: { text: 'This is the best thing I bought all year. Totally worth it!', sub: '@happycustomer', value: 1280 },
  viewfinder: { text: 'REC', sub: '4K · 60 FPS' },
  glitch_title: { text: 'Level up', sub: 'New update' },
  // A design of Keo's own (layers with keyframes); Keo makes a new one for each video.
  design: {
    text: 'Kinetic title',
    design: Design.parse({
      layers: [
        { kind: 'particles', count: 60, particle: 'spark', size: 1.4, colors: ['#FF3B6B', '#FFD23F'], spreadX: 150, spreadY: 80, motion: 'burst', speed: 1.2, from: 0.3 },
        { kind: 'text', text: 'MAKE IT LOUD', font: 'Unbounded', size: 13, weight: 900, color: '#FFFFFF', color2: '#FF3B6B', tracking: -0.04, split: 'chars', stagger: 0.035, revealFor: 0.7, enter: { y: 22, rotation: 12, opacity: 1 }, y: 0.46, leaveAt: -0.6 },
        { kind: 'shape', shape: 'line', w: 60, h: 0, stroke: '#FFD23F', strokeWidth: 1, y: 0.6, draw: 0, keys: [{ t: 0.5, draw: 0 }, { t: 1.2, draw: 1, ease: 'expo' }, { t: -0.5, opacity: 1 }, { t: -0.1, opacity: 0 }] },
      ],
    }),
  },
};

/** Motion graphics: ready-made animated pieces added at the playhead (Keo can sync them to the speech). */
function MotionGraphics({ time, onEdit }: { time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const ui = useUi();
  const add = async (piece: (typeof MOTION_PIECES)[number]) => {
    try {
      await onEdit([{ op: 'add_motion', piece, place: 'auto', start: time, duration: piece === 'light_sweep' ? 1.2 : piece === 'scene' ? 2.5 : piece === 'scene3d' ? 12 : 4, ...MOTION_SAMPLE[piece] }]);
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <div className="studio-pane-head">
        <span>Motion graphics</span>
      </div>
      <div className="motion-pieces">
        {MOTION_PIECES.map((p) => (
          <button key={p} className="btn sm" title={`${MOTION_PIECE_INFO[p].label}: ${MOTION_PIECE_INFO[p].use}`} onClick={() => void add(p)}>
            {MOTION_PIECE_INFO[p].label}
          </button>
        ))}
      </div>
      <p className="small muted">Added at the playhead; change the words in the Motion tab. Or ask Keo: “add motion graphics on what I say”.</p>
    </>
  );
}
