import { useEffect, useState } from 'react';
import { MOTION_ICONS, MOTION_PIECE_INFO, MOTION_PIECES, type EditOp, type MotionClip } from '@shared/studio';
import { Color, Num, Section } from './fields';

type SetPatch = Omit<Extract<EditOp, { op: 'set' }>, 'op' | 'clip'>;

/** Which fields each piece uses (the others are hidden). */
const USES: Record<MotionClip['piece'], { sub?: string; items?: string; icon?: boolean; value?: boolean }> = {
  headline: { sub: 'Kicker (small line above)' },
  word_pop: { icon: true },
  icon_burst: { items: 'Icons (one per line: an icon name or an emoji)' },
  chips: { items: 'Points (one per line)', icon: true },
  stat: { sub: 'Kicker (small line above)', value: true },
  list: { items: 'Rows (one per line)' },
  lower_third: { sub: 'Role or handle' },
  quote: { sub: 'Who said it' },
  card3d: { sub: 'Line under the title', icon: true },
  highlight: { items: 'Words to mark (one per line; default the last word)' },
  callout: {},
  light_sweep: {},
};

/** The Motion tab: a motion clip's piece, words, items, icon, number and colours. */
export function MotionClipFields({ clip, set }: { clip: MotionClip; set: (p: SetPatch) => void }) {
  const [text, setText] = useState(clip.text);
  const [sub, setSub] = useState(clip.sub ?? '');
  const [items, setItems] = useState((clip.items ?? []).join('\n'));
  const [icon, setIcon] = useState(clip.icon ?? '');
  const [unit, setUnit] = useState(clip.unit ?? '');
  useEffect(() => setText(clip.text), [clip.text]);
  useEffect(() => setSub(clip.sub ?? ''), [clip.sub]);
  useEffect(() => setItems((clip.items ?? []).join('\n')), [clip.items]);
  useEffect(() => setIcon(clip.icon ?? ''), [clip.icon]);
  useEffect(() => setUnit(clip.unit ?? ''), [clip.unit]);
  const uses = USES[clip.piece];
  const list = items
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((x) => x.slice(0, 60));
  return (
    <>
      <Section title="Motion">
        <label className="insp-num wide">
          <span>Piece</span>
          <select className="select" value={clip.piece} onChange={(e) => set({ motion: { piece: e.target.value as MotionClip['piece'] } })}>
            {MOTION_PIECES.map((p) => (
              <option key={p} value={p} title={MOTION_PIECE_INFO[p].use}>
                {MOTION_PIECE_INFO[p].label}
              </option>
            ))}
          </select>
        </label>
        <p className="small muted insp-tip-inline">{MOTION_PIECE_INFO[clip.piece].use}</p>
        <textarea className="textarea insp-text" rows={2} value={text} maxLength={200} aria-label="Words" onChange={(e) => setText(e.target.value)} onBlur={() => text.trim() && text !== clip.text && set({ text: text.trim() })} />
        {uses.sub && (
          <label className="insp-num wide">
            <span>{uses.sub}</span>
            <input className="input" value={sub} maxLength={160} onChange={(e) => setSub(e.target.value)} onBlur={() => sub.trim() !== (clip.sub ?? '') && set({ motion: { sub: sub.trim() || null } })} />
          </label>
        )}
        {uses.items && (
          <label className="insp-num wide">
            <span>{uses.items}</span>
            <textarea className="textarea" rows={4} value={items} onChange={(e) => setItems(e.target.value)} onBlur={() => list.join('\n') !== (clip.items ?? []).join('\n') && set({ motion: { items: list.length ? list : null } })} />
          </label>
        )}
        {uses.icon && (
          <label className="insp-num wide">
            <span>Icon (a name or an emoji)</span>
            <input className="input" list="keo-motion-icons" value={icon} maxLength={24} onChange={(e) => setIcon(e.target.value)} onBlur={() => icon.trim() !== (clip.icon ?? '') && set({ motion: { icon: icon.trim() || null } })} />
            <datalist id="keo-motion-icons">
              {MOTION_ICONS.map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </label>
        )}
        {uses.value && (
          <div className="insp-grid">
            <Num label="Number" value={clip.value ?? 0} min={-1e12} max={1e12} step={1} onCommit={(v) => set({ motion: { value: v } })} />
            <label className="insp-num">
              <span>Unit</span>
              <input className="input" value={unit} maxLength={12} placeholder="%, $, k…" onChange={(e) => setUnit(e.target.value)} onBlur={() => unit !== (clip.unit ?? '') && set({ motion: { unit: unit || null } })} />
            </label>
          </div>
        )}
      </Section>
      <Section title="Colours">
        <div className="insp-grid">
          <Color label="Accent" value={clip.accent} onCommit={(v) => set({ motion: { accent: v } })} />
          <Color label="Second accent" value={clip.accent2} onCommit={(v) => set({ motion: { accent2: v } })} />
          <Color label="Text" value={clip.color} onCommit={(v) => set({ motion: { color: v } })} />
        </div>
      </Section>
    </>
  );
}
