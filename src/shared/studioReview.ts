import { CAPTIONS_TRACK, projectDuration, type Project } from './studio';

/**
 * Keo's self-review: the mistakes an editor checks for before calling an edit done — text over a
 * face, text cut off at the edge or under the app's buttons, text on top of other text, and
 * titles gone before anyone can read them. The render window measures (where each text is, where
 * the person is); this decides what is wrong and how to fix it.
 */

/** A box as fractions of the frame. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface ReviewSample {
  t: number;
  /** Where the people are (null: no one). */
  person: Box | null;
  texts: Array<{ clip: string; track: string; box: Box }>;
}
export type IssueKind = 'face' | 'edge' | 'app-buttons' | 'overlap' | 'too-fast';
export interface ReviewIssue {
  kind: IssueKind;
  clip: string;
  at: number;
  detail: string;
  fix: string;
}

const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
function overlap(a: Box, b: Box): number {
  return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
}
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Where the face is: the top of the person, narrower than the shoulders. */
export function faceOf(person: Box): Box {
  const w = person.x1 - person.x0;
  const h = person.y1 - person.y0;
  const cx = (person.x0 + person.x1) / 2;
  return { x0: cx - w * 0.3, x1: cx + w * 0.3, y0: person.y0, y1: person.y0 + h * 0.32 };
}

/** When to look: about once a second (at most 90 times), and in the middle of every text. */
export function reviewTimes(p: Project): number[] {
  const d = projectDuration(p);
  if (d <= 0) return [];
  const step = Math.max(1, d / 90);
  const times = new Set<number>();
  for (let t = 0.5; t < d; t += step) times.add(r2(t));
  for (const tr of p.tracks)
    for (const c of tr.clips) if (c.type === 'text' && tr.name !== CAPTIONS_TRACK && !tr.hidden) times.add(r2(Math.min(d - 0.01, c.start + c.duration / 2)));
  return [...times].sort((a, b) => a - b).slice(0, 160);
}

/** What is wrong with the edit, one issue per text and kind (the first time it shows). */
export function reviewEdit(p: Project, samples: ReviewSample[]): ReviewIssue[] {
  const vertical = p.height > p.width;
  const found = new Map<string, ReviewIssue>();
  const add = (i: ReviewIssue) => {
    const key = `${i.clip}/${i.kind}`;
    if (!found.has(key)) found.set(key, i);
  };
  for (const s of samples) {
    const face = s.person ? faceOf(s.person) : null;
    for (const x of s.texts) {
      const a = area(x.box);
      if (a <= 0) continue;
      // Words behind the person are meant to be there.
      if (face && !x.track.startsWith('Behind text') && overlap(x.box, face) > Math.min(a, area(face)) * 0.2)
        add({ kind: 'face', clip: x.clip, at: s.t, detail: 'covers the speaker’s face', fix: 'move it above the head or lower down (transform y), make it smaller, or put it behind the person (studio__moment text-behind)' });
      if (x.box.x0 < 0.02 || x.box.x1 > 0.98 || x.box.y0 < 0.02 || x.box.y1 > 0.98)
        add({ kind: 'edge', clip: x.clip, at: s.t, detail: 'is cut off at the edge of the frame', fix: 'make it smaller (style.sizePct), narrower (style.maxWidth) or move it in' });
      // The apps' buttons: a column on the right (from half way down) and the caption at the bottom.
      else if (vertical && (x.box.y1 > 0.9 || overlap(x.box, { x0: 0.87, y0: 0.5, x1: 1, y1: 0.85 }) > a * 0.08))
        add({ kind: 'app-buttons', clip: x.clip, at: s.t, detail: 'sits where TikTok, Reels and Shorts put their buttons and caption', fix: 'keep it left of x 0.85 and above y 0.85' });
    }
    for (let i = 0; i < s.texts.length; i++)
      for (let j = i + 1; j < s.texts.length; j++) {
        const a = s.texts[i]!;
        const b = s.texts[j]!;
        if (overlap(a.box, b.box) > Math.min(area(a.box), area(b.box)) * 0.25)
          add({ kind: 'overlap', clip: b.clip, at: s.t, detail: `is on top of another text (${a.clip})`, fix: 'move one of them, or let one end before the other starts' });
      }
  }
  // Read in time: about 4 words a second, and a moment to notice it.
  for (const tr of p.tracks) {
    if (tr.name === CAPTIONS_TRACK || tr.hidden) continue;
    for (const c of tr.clips) {
      if (c.type !== 'text' || c.counter) continue;
      const words = c.text.split(/\s+/).filter(Boolean).length;
      const need = words <= 1 ? 0.5 : 0.25 * words + 0.4;
      if (c.duration < need) add({ kind: 'too-fast', clip: c.id, at: c.start, detail: `shows ${words} word${words === 1 ? '' : 's'} for ${c.duration}s, too short to read`, fix: `keep it on screen for at least ${r2(need)}s` });
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at).slice(0, 40);
}
