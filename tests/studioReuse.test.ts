import { describe, expect, it } from 'vitest';
import { applyEdits, newProject } from '../src/shared/studio';
import { reuseProject } from '../src/shared/studioReuse';

const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('Studio keeps unchanged parts of the project as they were (so only changes redraw)', () => {
  it('one moved clip: the other clips, the other tracks and the assets stay the same objects', () => {
    let p = newProject({ name: 'Reuse', format: 'vertical' });
    p = applyEdits(p, [
      { op: 'add_text', text: 'One', start: 0, duration: 2 },
      { op: 'add_text', text: 'Two', start: 3, duration: 2 },
      { op: 'add_shape', shape: 'rect', start: 0, duration: 4 },
    ]).project;
    const textTrack = p.tracks.find((t) => t.clips.some((c) => c.type === 'text'))!;
    const [one, two] = textTrack.clips;
    const next = applyEdits(copy(p), [{ op: 'move', clip: two!.id, start: 5 }]).project;
    const r = reuseProject(p, next);
    expect(r).not.toBe(p);
    const rText = r.tracks.find((t) => t.id === textTrack.id)!;
    expect(rText).not.toBe(textTrack);
    expect(rText.clips.find((c) => c.id === one!.id)).toBe(one);
    expect(rText.clips.find((c) => c.id === two!.id)!.start).toBe(5);
    for (const t of r.tracks.filter((x) => x.id !== textTrack.id)) expect(t).toBe(p.tracks.find((x) => x.id === t.id));
    expect(r.assets).toBe(p.assets);
  });

  it('the same project arriving again is the previous copy itself; another project is taken as it is', () => {
    let p = newProject({ name: 'Reuse', format: 'vertical' });
    p = applyEdits(p, [{ op: 'add_text', text: 'Hi', start: 0, duration: 2 }]).project;
    expect(reuseProject(p, copy(p))).toBe(p);
    const other = newProject({ name: 'Other', format: 'vertical' });
    expect(reuseProject(p, other)).toBe(other);
    // A change outside the tracks (the name) is a new copy, with the tracks kept.
    const renamed = reuseProject(p, { ...copy(p), name: 'New name' });
    expect(renamed.name).toBe('New name');
    expect(renamed.tracks[0]).toBe(p.tracks[0]);
  });
});
