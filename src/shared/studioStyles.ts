import { LOOKS, isAV, projectDuration, type EditOp, type MediaClip, type Project, type TextMarkInput, type Zoom } from './studio';

/**
 * Keo's editing styles: whole looks learned from real edits, applied to the user's own talking
 * video. Each style becomes ordinary edits (one undo), so every word, frame and card can be changed
 * after. Keo chooses the words to stress (it has read the transcript); without them, Keo's own
 * guess picks a few strong words.
 */

export const STYLES = {
  'podcast-frame':
    'Podcast in a rounded frame on a dark background: a mixed-font headline (bold sans with an elegant serif italic) opens it, single bold words pop beside the speaker on key moments, and it ends on a follow card',
  'doc-serif':
    'Documentary: black-and-white picture, clean white captions with the key words in red serif italic, a big title, lists that build item by item, and a brand end card',
} as const;
export type StyleId = keyof typeof STYLES;

export interface SpokenWord {
  text: string;
  start: number;
  end: number;
}
export interface SpokenLine extends SpokenWord {
  words?: SpokenWord[];
}

export interface StyleOptions {
  /** The timeline's words (seconds on the timeline). */
  words: SpokenWord[];
  /** The timeline's words as caption lines (doc-serif). */
  lines?: SpokenLine[];
  /** Words to stress (as said). Keo's guess when missing. */
  emphasis?: string[];
  /** The opening headline, and which of its words go in the serif italic. */
  headline?: string;
  headlineEmphasis?: string;
  /** End card: the line, and a name or @handle under it (no end card without them). */
  endText?: string;
  handle?: string;
  /** Lists that build item by item (seconds on the timeline). */
  lists?: Array<{ at: number; title?: string; items: string[]; seconds?: number }>;
  /** The accent colour (red in doc-serif, warm yellow in podcast-frame). */
  accent?: string;
  /** Mirror the picture back (front cameras record mirrored: writing reads backwards). */
  flip?: boolean;
  /** Keo's sound effects (asset ids of this project): a pop on stressed words, a whoosh on titles. */
  sfx?: { pop?: string; whoosh?: string };
}

export class StyleError extends Error {}

const STOP = new Set(
  'a an the and or but so if then than that this these those to of in on at by for with from up down out over under again is are was were be been being am do does did have has had i me my we our you your he him his she her it its they them their what which who whom when where why how all any both each few more most other some such no nor not only own same too very can will just dont should now also really like know think going get got make made thing things kind lot yeah okay ok well right because about into there here want would could gonna actually literally'.split(' '),
);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * Keo's guess at the words worth stressing: long, uncommon words, not repeated too soon, about one
 * every few seconds of speech.
 */
export function guessEmphasis(words: SpokenWord[], every = 4): string[] {
  const seen = new Map<string, number>();
  for (const w of words) seen.set(norm(w.text), (seen.get(norm(w.text)) ?? 0) + 1);
  const out: string[] = [];
  let last = -Infinity;
  for (const w of words) {
    const n = norm(w.text);
    if (n.length < 5 || STOP.has(n) || w.start - last < every || out.includes(n)) continue;
    // Said very often: it is the subject, not a highlight.
    if ((seen.get(n) ?? 0) > 3) continue;
    out.push(n);
    last = w.start;
  }
  return out;
}

/** Where the stressed words are said: each one once, the first time after the one before. */
function emphasisTimes(words: SpokenWord[], emphasis: string[]): SpokenWord[] {
  const want = new Set(emphasis.map(norm).filter(Boolean));
  const out: SpokenWord[] = [];
  const used = new Set<string>();
  for (const w of words) {
    const n = norm(w.text);
    if (!want.has(n) || used.has(n)) continue;
    // Not on top of the previous one.
    if (out.length && w.start - out.at(-1)!.start < 1.2) continue;
    used.add(n);
    out.push(w);
  }
  return out;
}

/** The talking video: the clips on the main video track. */
function mainClips(p: Project): MediaClip[] {
  const t = p.tracks.find((x) => x.kind === 'video' && x.name !== 'B-roll' && x.clips.some((c) => c.type === 'media'));
  return (t?.clips.filter((c): c is MediaClip => isAV(c) && c.type === 'media') ?? []) as MediaClip[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const clean = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** The edits that give the project a style. */
export function styleOps(p: Project, id: StyleId, o: StyleOptions): EditOp[] {
  const main = mainClips(p);
  if (!main.length) throw new StyleError('Put the talking video on the timeline first.');
  const end = projectDuration(p);
  const vertical = p.height >= p.width;
  const emphasis = o.emphasis?.length ? o.emphasis : guessEmphasis(o.words);
  const hits = emphasisTimes(o.words, emphasis);
  const ops: EditOp[] = [{ op: 'set_project', loudness: 'social' }];
  // Finishing touches on the talking video: a punch-in on every other stressed word (back out
  // smoothly), a fade in at the start and a fade out into the end card.
  const punch = new Map<string, Zoom[]>();
  hits.forEach((w, i) => {
    if (i % 2) return;
    const c = main.find((x) => w.start >= x.start && w.start < x.start + x.duration);
    if (!c) return;
    const at = (w.start - c.start) * c.speed;
    const back = Math.min(c.duration * c.speed - 0.05, at + 1.6 * c.speed);
    if (back - at < 0.4) return;
    const list = punch.get(c.id) ?? [];
    list.push({ at: r2(at), scale: 1.12, x: 0.5, y: 0.4, ease: 'cut' }, { at: r2(back), scale: 1, x: 0.5, y: 0.5, ease: 'smooth' });
    punch.set(c.id, list);
  });
  const touches = (c: MediaClip, k: number): Partial<Extract<EditOp, { op: 'set' }>> => {
    const z = punch.get(c.id);
    // The clip's own zooms stay; new ones only where it has none close by.
    const own = c.zooms ?? [];
    const add = (z ?? []).filter((n) => !own.some((o) => Math.abs(o.at - n.at) < 0.8));
    return {
      ...(add.length ? { zooms: [...own, ...add].sort((a, b) => a.at - b.at) } : {}),
      ...(k === 0 ? { fadeIn: 0.3 } : {}),
      ...(k === main.length - 1 && (o.endText || o.handle) ? { fadeOut: 0.4 } : {}),
    };
  };
  const sound = (asset: string | undefined, at: number, volume: number) => {
    if (asset) ops.push({ op: 'add_audio', assetId: asset, trackName: 'Effects', start: r2(Math.max(0, at)), volume });
  };
  const headlineMarks = (accentFont: string, color?: string): TextMarkInput[] =>
    o.headlineEmphasis ? [{ words: o.headlineEmphasis, font: accentFont, italic: true, weight: 'normal', scale: 1.2, ...(color ? { color } : {}) }] : [];

  if (id === 'podcast-frame') {
    const accent = o.accent ?? '#FFD23F';
    ops.push({ op: 'set_project', background: '#0D0D0F' });
    main.forEach((c, k) =>
      ops.push({
        op: 'set',
        clip: c.id,
        ...touches(c, k),
        mask: { shape: 'rounded', radius: 0.07 },
        transform: { scale: vertical ? 0.84 : 0.8, y: vertical ? 0.55 : 0.52 },
        ...(o.flip ? { flipX: !c.flipX } : {}),
      }),
    );
    if (o.headline) sound(o.sfx?.whoosh, 0, 0.35);
    if (o.headline)
      ops.push({
        op: 'add_text',
        text: o.headline,
        start: 0,
        duration: Math.min(4, Math.max(2, end)),
        animIn: 'words',
        animOut: 'fade',
        animSeconds: 0.6,
        style: { font: 'Montserrat', weight: 'black', sizePct: vertical ? 3.6 : 5, color: '#FFFFFF', shadow: 0, maxWidth: 0.86, lineHeight: 1.1 },
        marks: headlineMarks('Instrument Serif', accent),
        transform: { x: 0.5, y: vertical ? 0.075 : 0.1 },
      });
    for (const w of hits) sound(o.sfx?.pop, w.start - 0.02, 0.3);
    hits.forEach((w, i) =>
      ops.push({
        op: 'add_text',
        text: clean(w.text).toUpperCase() || w.text.toUpperCase(),
        start: r2(w.start),
        duration: 1.1,
        animIn: 'pop',
        animOut: 'fade',
        animSeconds: 0.18,
        style: { font: 'Anton', weight: 'normal', sizePct: vertical ? 7.5 : 10, color: i % 3 === 1 ? accent : '#FFFFFF', shadow: 18, letterSpacing: 1 },
        transform: { x: i % 2 ? 0.7 : 0.3, y: vertical ? 0.7 : 0.66 },
      }),
    );
    if (o.endText || o.handle) {
      const text = [o.endText, o.handle].filter(Boolean).join('\n');
      ops.push({
        op: 'add_text',
        text,
        start: r2(end),
        duration: 2.5,
        animIn: 'words',
        animOut: 'none',
        animSeconds: 0.5,
        style: { font: 'Montserrat', weight: 'black', sizePct: vertical ? 5 : 7, color: '#FFFFFF', shadow: 0, maxWidth: 0.8 },
        ...(o.handle ? { marks: [{ words: o.handle, font: 'Instrument Serif', italic: true, weight: 'normal' as const, color: accent, scale: 0.9 }] } : {}),
        transform: { x: 0.5, y: 0.5 },
      });
    }
  } else {
    const accent = o.accent ?? '#E53935';
    ops.push({ op: 'set_project', background: '#000000' });
    main.forEach((c, k) => ops.push({ op: 'set', clip: c.id, ...touches(c, k), color: LOOKS['black-white'], ...(o.flip ? { flipX: !c.flipX } : {}) }));
    if (o.headline) sound(o.sfx?.whoosh, 0, 0.35);
    const stress = new Set(emphasis.map(norm));
    const lines = o.lines ?? [];
    if (lines.length)
      ops.push({
        op: 'add_captions',
        replace: true,
        highlight: null,
        animIn: 'fade',
        style: { font: 'Inter', weight: 'bold', sizePct: vertical ? 4.2 : 5.5, color: '#FFFFFF', outline: 0, shadow: 14, uppercase: false },
        transform: { y: vertical ? 0.72 : 0.84 },
        lines: lines.map((l) => {
          const marks = l.text
            .split(/\s+/)
            .filter((w) => stress.has(norm(w)))
            .slice(0, 3)
            .map((w) => ({ words: w, font: 'Instrument Serif', italic: true, weight: 'normal' as const, color: accent, scale: 1.3 }));
          return { text: l.text, start: l.start, end: l.end, ...(l.words?.length ? { words: l.words } : {}), ...(marks.length ? { marks } : {}) };
        }),
      });
    if (o.headline)
      ops.push({
        op: 'add_text',
        text: o.headline,
        start: 0,
        duration: Math.min(3.5, Math.max(2, end)),
        animIn: 'blur-in',
        animOut: 'fade',
        animSeconds: 0.7,
        style: { font: 'Playfair Display', weight: 'bold', sizePct: vertical ? 6 : 9, color: '#FFFFFF', shadow: 30, maxWidth: 0.86, lineHeight: 1.05 },
        marks: headlineMarks('Instrument Serif', accent),
        // Above the head, not on the face.
        transform: { x: 0.5, y: vertical ? 0.14 : 0.18 },
      });
    if (o.endText || o.handle) {
      const text = [o.endText, o.handle].filter(Boolean).join('\n');
      ops.push({
        op: 'add_text',
        text,
        start: r2(end),
        duration: 2.5,
        animIn: 'blur-in',
        animOut: 'none',
        animSeconds: 0.6,
        style: { font: 'Instrument Serif', weight: 'normal', sizePct: vertical ? 6 : 8, color: '#FFFFFF', shadow: 0, maxWidth: 0.8 },
        ...(o.handle ? { marks: [{ words: o.handle, font: 'Inter', weight: 'bold' as const, color: accent, scale: 0.55 }] } : {}),
        transform: { x: 0.5, y: 0.5 },
      });
    }
  }

  // Lists that build: the title, then each item joins it, all leaving together.
  for (const l of o.lists ?? []) {
    const items = l.items.map((s) => s.trim()).filter(Boolean).slice(0, 8);
    if (!items.length) continue;
    sound(o.sfx?.whoosh, l.at, 0.3);
    const step = 0.7;
    const total = l.seconds ?? Math.max(3, (items.length + 1) * step + 1.5);
    const serif = id === 'doc-serif';
    const top = vertical ? 0.24 : 0.22;
    const gap = vertical ? 0.06 : 0.09;
    // A soft dark card behind the list, so it reads over any background.
    const rows = items.length + (l.title ? 1 : 0);
    ops.push({
      op: 'add_shape',
      shape: 'rect',
      start: r2(l.at),
      duration: r2(total),
      style: { width: vertical ? 0.84 : 0.6, height: rows * gap + 0.05, radius: 0.12, fill: '#000000' },
      transform: { x: 0.5, y: top + ((l.title ? -gap : 0) + (items.length - 1) * gap) / 2, opacity: 0.55 },
      enter: { kind: 'fade', seconds: 0.3 },
      exit: { kind: 'fade', seconds: 0.3 },
    });
    if (l.title)
      ops.push({
        op: 'add_text',
        text: l.title,
        start: r2(l.at),
        duration: r2(total),
        animIn: 'fade',
        animOut: 'fade',
        style: serif ? { font: 'Instrument Serif', weight: 'normal', sizePct: vertical ? 5 : 7, color: o.accent ?? '#E53935', shadow: 12 } : { font: 'Montserrat', weight: 'black', sizePct: vertical ? 4.4 : 6, color: '#FFFFFF', uppercase: true, shadow: 12 },
        transform: { x: 0.5, y: top - gap },
      });
    items.forEach((item, i) =>
      ops.push({
        op: 'add_text',
        text: `${i + 1}. ${item}`.slice(0, 200),
        start: r2(l.at + (i + 1) * step),
        duration: r2(Math.max(0.5, total - (i + 1) * step)),
        animIn: 'slide-up',
        animOut: 'fade',
        animSeconds: 0.3,
        style: { font: serif ? 'Inter' : 'Poppins', weight: 'bold', sizePct: vertical ? 3.4 : 4.6, color: '#FFFFFF', shadow: 14, align: 'left', maxWidth: 0.8 },
        transform: { x: 0.5, y: top + i * gap },
      }),
    );
  }
  return ops;
}
