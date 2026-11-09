import { applyEdits, CAPTIONS_TRACK, EditError, findClip, projectDuration, type EditOp, type Project } from './studio';

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
  /** Pictures and videos laid over the talking video (pop-ins, B-roll cards, splits…). */
  overlays?: Array<{ clip: string; track: string; asset: string; box: Box }>;
}
export type IssueKind = 'face' | 'edge' | 'app-buttons' | 'overlap' | 'too-fast' | 'picture-face' | 'twice' | 'stuck' | 'same-words' | 'blank';
export interface ReviewIssue {
  kind: IssueKind;
  clip: string;
  at: number;
  detail: string;
  fix: string;
  /** The edit that fixes it, when Keo can be sure (one click in Studio, or studio__review fix). */
  ops?: EditOp[];
}

/**
 * The edit that moves a layer by (dx, dy) and scales it by `k` (fractions of the frame), or
 * nothing when it is animated (its own keyframes decide where it is) or not a layer.
 */
function shiftOps(p: Project, id: string, dx: number, dy: number, k = 1): EditOp[] | undefined {
  const f = findClip(p, id);
  const c = f?.clip;
  if (!c || c.type === 'audio' || c.type === 'adjust') return undefined;
  if (c.keys && (c.keys.x?.length || c.keys.y?.length || c.keys.scale?.length)) return undefined;
  const t = c.transform;
  const transform = { x: r3(Math.min(0.95, Math.max(0.05, t.x + dx))), y: r3(Math.min(0.95, Math.max(0.05, t.y + dy))), ...(k !== 1 ? { scale: r3(Math.max(0.05, t.scale * k)) } : {}) };
  return [{ op: 'set', clip: id, transform }];
}
const r3 = (n: number) => Math.round(n * 1000) / 1000;

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
    const key = `${i.clip}/${i.kind}${i.clip ? "" : `@${i.at}`}`;
    if (!found.has(key)) found.set(key, i);
  };
  for (const s of samples) {
    const face = s.person ? faceOf(s.person) : null;
    for (const x of s.texts) {
      const a = area(x.box);
      if (a <= 0) continue;
      // Words behind the person are meant to be there.
      const b = x.box;
      const h = b.y1 - b.y0;
      const w = b.x1 - b.x0;
      const cx = (b.x0 + b.x1) / 2;
      const cy = (b.y0 + b.y1) / 2;
      if (face && !x.track.startsWith('Behind text') && overlap(b, face) > Math.min(a, area(face)) * 0.2) {
        // Above the head when there is room (clear of the apps' top bar), else under the chin, else smaller and lower.
        const above = face.y0 - 0.03 - h / 2;
        const below = face.y1 + 0.05 + h / 2;
        const ops = above - h / 2 >= 0.1 ? shiftOps(p, x.clip, 0, above - cy) : below + h / 2 <= 0.84 ? shiftOps(p, x.clip, 0, below - cy) : shiftOps(p, x.clip, 0, Math.min(0.84 - h * 0.35, face.y1 + 0.04 + h * 0.35) - cy, 0.7);
        add({ kind: 'face', clip: x.clip, at: s.t, detail: 'covers the speaker’s face', fix: 'move it above the head or lower down (transform y), make it smaller, or put it behind the person (studio__moment text-behind)', ...(ops ? { ops } : {}) });
      }
      if (b.x0 < 0.02 || b.x1 > 0.98 || b.y0 < 0.02 || b.y1 > 0.98) {
        const k = Math.min(1, 0.94 / Math.max(0.01, w), 0.94 / Math.max(0.01, h));
        const hw = (w / 2) * k;
        const hh = (h / 2) * k;
        const dx = Math.max(0, 0.03 - (cx - hw)) - Math.max(0, cx + hw - 0.97);
        const dy = Math.max(0, 0.03 - (cy - hh)) - Math.max(0, cy + hh - 0.97);
        const ops = shiftOps(p, x.clip, dx, dy, k);
        add({ kind: 'edge', clip: x.clip, at: s.t, detail: 'is cut off at the edge of the frame', fix: 'make it smaller (style.sizePct), narrower (style.maxWidth) or move it in', ...(ops ? { ops } : {}) });
      }
      // The apps' buttons: a column on the right (from half way down) and the caption at the bottom.
      else if (vertical && (b.y1 > 0.9 || overlap(b, { x0: 0.87, y0: 0.5, x1: 1, y1: 0.85 }) > a * 0.08)) {
        const k = w > 0.8 ? 0.8 / w : 1;
        const dx = k < 1 ? 0.45 - cx : Math.min(0, 0.85 - b.x1);
        const dy = Math.min(0, 0.85 - (cy + (h / 2) * k));
        const ops = shiftOps(p, x.clip, dx, dy, k);
        add({ kind: 'app-buttons', clip: x.clip, at: s.t, detail: 'sits where TikTok, Reels and Shorts put their buttons and caption', fix: 'keep it left of x 0.85 and above y 0.85', ...(ops ? { ops } : {}) });
      }
    }
    // Pictures over the talking video: not on the face, and not the same picture twice at once.
    const seen = new Map<string, string>();
    for (const o of s.overlays ?? []) {
      // A full-frame cutaway (B-roll that replaces the speaker) is meant to cover them.
      const full = o.box.x0 <= 0.02 && o.box.x1 >= 0.98 && o.box.y0 <= 0.02 && o.box.y1 >= 0.98;
      if (face && !full && overlap(o.box, face) > area(face) * 0.15) {
        // Smaller, under the chin (the pop-in stays, the face shows).
        const h = (o.box.y1 - o.box.y0) * 0.6;
        const target = Math.min(0.86 - h / 2, face.y1 + 0.04 + h / 2);
        const ops = shiftOps(p, o.clip, 0, target - (o.box.y0 + o.box.y1) / 2, 0.6);
        add({ kind: 'picture-face', clip: o.clip, at: s.t, detail: 'covers the speaker’s face', fix: 'make it smaller and move it below the face (transform y about 0.72) or above the head, or show it full screen as a cutaway instead', ...(ops ? { ops } : {}) });
      }
      const other = seen.get(o.asset);
      if (o.asset && other && other !== o.clip)
        add({ kind: 'twice', clip: o.clip, at: s.t, detail: `shows the same picture as ${other} at the same time`, fix: 'delete one of the two', ops: [{ op: 'delete', clip: o.clip }] });
      else if (o.asset) seen.set(o.asset, o.clip);
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
      if (c.duration < need) add({ kind: 'too-fast', clip: c.id, at: c.start, detail: `shows ${words} word${words === 1 ? '' : 's'} for ${c.duration}s, too short to read`, fix: `keep it on screen for at least ${r2(need)}s`, ops: [{ op: 'trim', clip: c.id, duration: r2(need) }] });
    }
  }
  for (const i of timelineIssues(p)) add(i);
  return [...found.values()].sort((a, b) => a.at - b.at).slice(0, 40);
}

const plainWords = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter((w) => w.length > 1);

/**
 * What the timeline alone shows is wrong (no frames needed): a caption that hangs on screen while
 * other words are spoken (speech-to-text missed them), two titles saying the same thing at once,
 * and moments where nothing is on screen at all (a blank frame between the video and the end card).
 */
export function timelineIssues(p: Project): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const caps = p.tracks.find((t) => t.name === CAPTIONS_TRACK && !t.hidden);
  let stuck = 0;
  for (const c of caps?.clips ?? []) {
    if (c.type !== 'text' || stuck >= 6) continue;
    const n = c.text.split(/\s+/).filter(Boolean).length;
    const lit = Math.max(0, ...(c.words ?? []).map((w) => w.end - w.start));
    // With word times: a word lit too long, or the line left up long after its last word. Without: too long for its words.
    const last = Math.max(0, ...(c.words ?? []).map((w) => w.end));
    const tooLong = c.words?.length ? lit > 1.6 || c.duration - last > 1.2 : c.duration > Math.max(2.8, 0.75 * n + 1.2);
    if (tooLong) {
      stuck++;
      // Leaves a moment after its words: each word no longer than it takes to say.
      // Each word lit no longer than it takes to say; the line leaves a moment after the last one.
      const words = (c.words ?? []).map((w) => ({ ...w, end: r2(Math.min(w.end, w.start + 0.3 + 0.085 * w.text.length)) }));
      const said = words.reduce((t, w) => Math.max(t, w.end), 0);
      const keep = r2(Math.max(0.6, Math.min(c.duration, (said || 0.45 * n) + 0.3)));
      out.push({ kind: 'stuck', clip: c.id, at: c.start, detail: `stays on screen for ${r2(c.duration)}s with only “${c.text}” (speech-to-text likely missed words here, or the speaker mumbles)`, fix: 'listen there: cut the mumble if it is a stumble (studio__edit cut), or shorten the line (set duration) so it leaves when the words end', ...(keep < c.duration ? { ops: [{ op: 'trim', clip: c.id, duration: keep }, ...(words.length ? [{ op: 'set', clip: c.id, words }] : [])] as EditOp[] } : {}) });
    }
  }
  // Titles and motion graphics: the same words twice on screen at the same time.
  const shown = p.tracks.filter((t) => !t.hidden && t.name !== CAPTIONS_TRACK && !t.name.startsWith('Behind text')).flatMap((t) => t.clips).flatMap((c) => (c.type === 'text' || c.type === 'motion') && (c.type === 'text' ? c.text : (c.text ?? '')).trim() ? [{ c, words: plainWords(c.type === 'text' ? c.text : (c.text ?? '')) }] : []);
  for (let i = 0; i < shown.length; i++)
    for (let j = i + 1; j < shown.length; j++) {
      const a = shown[i]!;
      const b = shown[j]!;
      const from = Math.max(a.c.start, b.c.start);
      if (Math.min(a.c.start + a.c.duration, b.c.start + b.c.duration) - from < 0.3 || !a.words.length || !b.words.length) continue;
      const small = a.words.length <= b.words.length ? a.words : b.words;
      const big = new Set(small === a.words ? b.words : a.words);
      if (small.filter((w) => big.has(w)).length / small.length >= 0.6) {
        const later = a.c.start > b.c.start ? a.c : b.c;
        const other = later === a.c ? b.c : a.c;
        out.push({ kind: 'same-words', clip: later.id, at: r2(from), detail: `says the same as ${other.id} on screen at the same time`, fix: 'keep one of the two (delete the other), or make one say something else', ops: [{ op: 'delete', clip: later.id }] });
      }
    }
  // Nothing at all on screen (an empty frame between clips or before the end card).
  const end = projectDuration(p);
  const shownClips = p.tracks.filter((t) => !t.hidden && t.kind !== 'audio').flatMap((t) => t.clips);
  // Only for videos (a project of titles alone is laid out on purpose).
  const pictures = p.tracks.filter((t) => t.kind === 'video' && !t.hidden).flatMap((t) => t.clips).concat(shownClips.filter((c) => c.type === 'motion' || c.type === 'shape'));
  if (!pictures.length) return out;
  const spans = shownClips.map((c) => ({ from: c.start, to: c.start + c.duration })).sort((a, b) => a.from - b.from);
  const lastPicture = Math.max(0, ...pictures.map((c) => c.start + c.duration));
  const plainEnd = end - lastPicture > 0.8;
  let at = 0;
  let blanks = 0;
  for (const s of [...spans, { from: end, to: end }]) {
    // An empty moment after the video is part of the plain ending (fixed with it).
    if (s.from - at > 0.12 && blanks < 3 && !(plainEnd && at >= lastPicture - 0.01)) {
      blanks++;
      const gap: EditOp[] = [{ op: 'cut_range', from: r2(at), to: r2(s.from) }];
      out.push({ kind: 'blank', clip: '', at: r2(at), detail: `nothing at all shows from ${r2(at)}s to ${r2(s.from)}s`, fix: 'close the gap (move the next clip back), or put something there', ...(s.from < end ? { ops: gap } : {}) });
    }
    at = Math.max(at, s.to);
  }
  // The video ends, then only plain text on the empty background (an undesigned end card).
  if (plainEnd) {
    const cards = shownClips.filter((c) => c.type === 'text' && c.start + c.duration > lastPicture + 0.5);
    const card = cards[0];
    // Fix: the words start right where the video ends, over a living backdrop in the project's colours.
    const ops: EditOp[] = [];
    for (const c of cards) if (c.start > lastPicture + 0.01) ops.push({ op: 'move', clip: c.id, start: r2(Math.max(lastPicture, c.start - (cards[0]!.start - lastPicture))) });
    const close = Math.max(...cards.map((c) => c.start + c.duration - Math.max(0, cards[0]!.start - lastPicture)), lastPicture + 0.8);
    if (cards.length) ops.push({ op: 'add_motion', piece: 'backdrop', text: '-', start: r2(lastPicture), duration: r2(close - lastPicture), background: p.background, place: 'auto' } as EditOp);
    out.push({ kind: 'blank', clip: card?.id ?? '', at: r2(lastPicture), detail: `after the video ends (${r2(lastPicture)}s) there is only ${card ? 'plain text' : 'nothing'} on the empty background`, fix: 'make it a designed end card starting where the last clip ends (studio__moment follow-card, or a motion scene with the brand colours), or end the video with the last clip', ...(ops.length ? { ops } : {}) });
  }
  return out;
}

/**
 * Applies the fixes of these issues (those that have one), each on its own so one that no longer
 * fits does not stop the others. Cuts go last and from the end back, so earlier times stay right.
 */
export function fixIssues(p: Project, issues: ReviewIssue[], o: { rand?: () => string } = {}): { project: Project; fixed: ReviewIssue[]; skipped: ReviewIssue[] } {
  const cuts = (i: ReviewIssue) => (i.ops ?? []).some((x) => x.op === 'cut_range' || x.op === 'cut_ranges');
  const todo = issues.filter((i) => i.ops?.length).sort((a, b) => Number(cuts(a)) - Number(cuts(b)) || (cuts(a) ? b.at - a.at : a.at - b.at));
  let project = p;
  const fixed: ReviewIssue[] = [];
  const skipped: ReviewIssue[] = issues.filter((i) => !i.ops?.length);
  for (const i of todo) {
    try {
      project = applyEdits(project, i.ops!, o.rand ? { rand: o.rand } : {}).project;
      fixed.push(i);
    } catch (e) {
      if (!(e instanceof EditError)) throw e;
      skipped.push(i);
    }
  }
  return { project, fixed, skipped };
}

/** A stable name for an issue (to fix just that one). */
export function issueKey(i: { kind: string; clip: string; at: number }): string {
  return `${i.kind}/${i.clip}/${i.at}`;
}

/** The kinds the timeline alone shows (checked instantly, on every change, without looking at frames). */
export const TIMELINE_KINDS: readonly IssueKind[] = ['stuck', 'same-words', 'blank'];
