import { describe, expect, it } from 'vitest';
import { aboutOf } from '../src/main/capabilities/studio';
import { applyEdits, describeProject, newProject, type Asset } from '../src/shared/studio';

describe('What the clips show', () => {
  it('reads the note from a vision reply, JSON or not', () => {
    expect(aboutOf('```json\n{"about": "A product photo of white sneakers on a wooden table."}\n```')).toBe('A product photo of white sneakers on a wooden table.');
    expect(aboutOf('  A screen recording\n of a chat app.  ')).toBe('A screen recording of a chat app.');
    expect(aboutOf('{"other": 1}')).toBe('{"other": 1}');
  });

  it('the note shows in the timeline Keo reads', () => {
    let n = 0;
    const rand = () => `r${String(++n).padStart(7, '0')}`;
    const pic: Asset = { id: 'as_pic00001', kind: 'image', path: 'C:/p.jpg', name: 'p.jpg', duration: 0, width: 800, height: 800, hasAudio: false, about: 'A product photo of sneakers' };
    const p = applyEdits({ ...newProject({ name: 'U', rand }), assets: [pic] }, [], { rand }).project;
    expect(describeProject(p)).toContain('as_pic00001 p.jpg (image; shows: "A product photo of sneakers")');
  });
});
