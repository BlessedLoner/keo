import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Project } from '../src/shared/studio';
import { faceOf, reviewEdit, reviewTimes } from '../src/shared/studioReview';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;
function project(): Project {
  n = 0;
  return applyEdits({ ...newProject({ name: 'R', rand }), width: 1080, height: 1920 }, [
    { op: 'add_text', text: 'What nobody tells you', start: 0, duration: 3 },
    { op: 'add_text', text: 'Three quick ways to grow', start: 4, duration: 0.6 },
  ], { rand }).project;
}
const ids = (p: Project) => p.tracks.flatMap((t) => t.clips).map((c) => c.id);
const person = { x0: 0.2, y0: 0.3, x1: 0.8, y1: 1 };

describe('Keo self-review', () => {
  it('finds the face at the top of the person', () => {
    const f = faceOf(person);
    expect([f.y0, Math.round(f.y1 * 100) / 100, Math.round(f.x0 * 100) / 100, Math.round(f.x1 * 100) / 100]).toEqual([0.3, 0.52, 0.32, 0.68]);
  });

  it('text on the face, at the edge, under the app buttons, on other text', () => {
    const p = project();
    const [a, b] = ids(p);
    const issues = reviewEdit(p, [
      { t: 1, person, texts: [{ clip: a!, track: 'Text', box: { x0: 0.25, y0: 0.35, x1: 0.75, y1: 0.45 } }] },
      { t: 2, person, texts: [{ clip: a!, track: 'Text', box: { x0: 0.01, y0: 0.1, x1: 0.6, y1: 0.2 } }] },
      { t: 4.2, person: null, texts: [{ clip: b!, track: 'Text', box: { x0: 0.6, y0: 0.6, x1: 0.95, y1: 0.7 } }, { clip: 'cl_other001', track: 'Text', box: { x0: 0.6, y0: 0.62, x1: 0.95, y1: 0.7 } }] },
    ]);
    expect(issues.map((i) => [i.kind, i.clip, i.at])).toEqual([
      ['face', a, 1],
      ['edge', a, 2],
      ['too-fast', b, 4],
      ['app-buttons', b, 4.2],
      ['app-buttons', 'cl_other001', 4.2],
      ['overlap', 'cl_other001', 4.2],
    ]);
  });

  it('words behind the person and clean frames are fine', () => {
    const p = project();
    const [a] = ids(p);
    expect(reviewEdit(p, [{ t: 1, person, texts: [{ clip: a!, track: 'Behind text', box: { x0: 0.25, y0: 0.35, x1: 0.75, y1: 0.45 } }] }]).filter((i) => i.kind !== 'too-fast')).toEqual([]);
    expect(reviewEdit(p, [{ t: 1, person, texts: [{ clip: a!, track: 'Text', box: { x0: 0.1, y0: 0.08, x1: 0.9, y1: 0.2 } }] }]).filter((i) => i.kind !== 'too-fast')).toEqual([]);
  });

  it('looks about once a second and in the middle of every text', () => {
    const t = reviewTimes(project());
    expect(t).toContain(1.5);
    expect(t).toContain(4.3);
    expect(t[0]).toBe(0.5);
  });
});
