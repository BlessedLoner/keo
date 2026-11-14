import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Project, type TextClip } from '../src/shared/studio';
import { baseOf, placeOps } from '../src/shared/studioPlacing';

function withText(keys?: TextClip['keys']): { p: Project; c: TextClip } {
  let p = newProject({ name: 'T', format: 'vertical' });
  p = applyEdits(p, [{ op: 'add_text', text: 'Hello there', start: 0, duration: 4, transform: { x: 0.3, y: 0.7, scale: 1 }, ...(keys ? { keys } : {}) }]).project;
  const c = p.tracks.flatMap((t) => t.clips).find((x): x is TextClip => x.type === 'text')!;
  return { p, c };
}

describe('Placing text by hand on the preview', () => {
  it('moves and resizes plain text exactly where it was put', () => {
    const { p, c } = withText();
    const base = baseOf(c, 1);
    expect(base).toMatchObject({ x: 0.3, y: 0.7, scale: 1 });
    const after = applyEdits(p, placeOps(c, 1, 30, { x: 0.5, y: 0.4, scale: 1.6 }, base)).project;
    const t = after.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id) as TextClip;
    expect(t.transform).toMatchObject({ x: 0.5, y: 0.4, scale: 1.6 });
  });

  it('animated text: off a keyframe the whole animation moves with it (no sliding back); on one, that keyframe changes', () => {
    const { p, c } = withText({ x: [{ at: 0, value: 0.2, ease: 'in-out' }, { at: 2, value: 0.6, ease: 'in-out' }], scale: [{ at: 0, value: 1, ease: 'in-out' }, { at: 2, value: 2, ease: 'in-out' }] });
    // At 1 s it is at x 0.4, scale 1.5 (between its keyframes).
    const base = baseOf(c, 1);
    expect(base.x).toBeCloseTo(0.4, 1);
    const moved = applyEdits(p, placeOps(c, 1, 30, { x: base.x + 0.1, scale: base.scale * 2 }, base)).project;
    const m = moved.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id) as TextClip;
    expect(m.keys!.x!.map((k) => k.value)).toEqual([0.3, 0.7]);
    expect(m.keys!.scale!.map((k) => k.value)).toEqual([2, 4]);
    // On the keyframe at 2 s: only that one changes.
    const on = applyEdits(p, placeOps(c, 2, 30, { x: 0.9 }, baseOf(c, 2))).project;
    const o = on.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id) as TextClip;
    expect(o.keys!.x!.map((k) => k.value)).toEqual([0.2, 0.9]);
  });

  it('a change to one field keeps all the others (position, style, colour grade)', () => {
    const { p, c } = withText();
    let q = applyEdits(p, [{ op: 'set', clip: c.id, style: { font: 'Anton', sizePct: 9, color: '#FF0000' } }]).project;
    q = applyEdits(q, [{ op: 'set', clip: c.id, transform: { scale: 2 } }, { op: 'set', clip: c.id, style: { maxWidth: 0.5 } }]).project;
    const t = q.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id) as TextClip;
    expect(t.transform).toMatchObject({ x: 0.3, y: 0.7, scale: 2 });
    expect(t.style).toMatchObject({ font: 'Anton', sizePct: 9, color: '#FF0000', maxWidth: 0.5 });
  });

  it('sets how wide a line of text can be', () => {
    const { p, c } = withText();
    const after = applyEdits(p, placeOps(c, 1, 30, {}, baseOf(c, 1), 0.45)).project;
    expect((after.tracks.flatMap((x) => x.clips).find((x) => x.id === c.id) as TextClip).style.maxWidth).toBe(0.45);
  });
});
