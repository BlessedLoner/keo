import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, resolveMarks, type TextClip } from '../src/shared/studio';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
const texts = (p: ReturnType<typeof newProject>) => p.tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.type === 'text');

describe('Rich text marks', () => {
  it('finds marked words, ignoring case and punctuation', () => {
    expect(resolveMarks('This is how you WIN!', [{ words: 'win', italic: true }])).toEqual([{ from: 4, to: 5, italic: true }]);
    expect(resolveMarks('the best of the best', [{ words: 'the best' }, { words: 'the best', color: '#FF0000' }])).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5, color: '#FF0000' },
    ]);
  });

  it('keeps word indexes, clamps them and drops what it cannot place', () => {
    expect(resolveMarks('one two three', [{ from: 1, to: 9, scale: 2 }])).toEqual([{ from: 1, to: 3, scale: 2 }]);
    expect(resolveMarks('one two', [{ words: 'missing' }, { from: 5, to: 6 }])).toEqual([]);
  });

  it('adds, changes and removes marks through edits', () => {
    n = 0;
    let p = applyEdits(newProject({ name: 'M', rand }), [{ op: 'add_text', text: 'Make it count', start: 0, duration: 2, marks: [{ words: 'count', font: 'Instrument Serif', italic: true, color: '#E53935', scale: 1.4 }] }], { rand }).project;
    const t = texts(p)[0]!;
    expect(t.marks).toEqual([{ from: 2, to: 3, font: 'Instrument Serif', italic: true, color: '#E53935', scale: 1.4 }]);
    p = applyEdits(p, [{ op: 'set', clip: t.id, marks: [{ words: 'make', weight: 'black' }] }], { rand }).project;
    expect(texts(p)[0]!.marks).toEqual([{ from: 0, to: 1, weight: 'black' }]);
    p = applyEdits(p, [{ op: 'set', clip: t.id, marks: null }], { rand }).project;
    expect(texts(p)[0]!.marks).toBeUndefined();
  });

  it('marks only go on text', () => {
    n = 0;
    const p = applyEdits(newProject({ name: 'M', rand }), [{ op: 'add_shape', shape: 'rect', start: 0, duration: 2 }], { rand }).project;
    const id = p.tracks.flatMap((t) => t.clips)[0]!.id;
    expect(() => applyEdits(p, [{ op: 'set', clip: id, marks: [{ words: 'x' }] }], { rand })).toThrow();
  });
});
