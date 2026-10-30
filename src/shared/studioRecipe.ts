import { CAPTIONS_TRACK, LOOKS, type EditOp, type LookId, type TextStyle, type Transition } from './studio';

/**
 * Templates as recipes: what Keo measures in a template video (its shots and their rhythm, which
 * shots are camera footage and which are screen recordings, its captions, look, end card and
 * sound), kept so the same edit can be made again with the user's own clips.
 */

export type ShotKind = 'camera' | 'screen' | 'graphic' | 'end-card';

export interface Recipe {
  id: string;
  name: string;
  /** The template it was learned from (file name). */
  source: string;
  seconds: number;
  aspect: 'vertical' | 'square' | 'landscape';
  shots: Array<{ start: number; end: number; kind: ShotKind }>;
  captions: { on: boolean; style: 'phrase' | 'word' | 'none'; wordsPerLine: number; position: 'center' | 'lower' | 'upper'; uppercase: boolean };
  look: LookId | null;
  transition: Transition['kind'] | 'cut';
  endCard: { on: boolean; seconds: number; text: string | null };
  audio: { voice: boolean; music: boolean; bpm: number | null; whooshOnCuts: boolean; musicGenre: string | null };
  /** What Keo saw, in its own words (for the next time it uses the recipe). */
  notes: string;
  learnedAt: string;
}

/**
 * A shot's kind from its colour fingerprint (a 64-bin histogram summing to 1): screen recordings
 * are a few flat colours, end cards mostly black, camera footage spread across many colours.
 * A first guess; Keo corrects it by looking at the frames.
 */
export function guessShotKind(sig: number[]): ShotKind {
  const sorted = [...sig].sort((a, b) => b - a);
  const top = sorted.slice(0, 4).reduce((n, v) => n + v, 0);
  // Nearly all black: an end card (a dark-mode screen recording still has some light in it).
  if ((sig[0] ?? 0) > 0.9) return 'end-card';
  if (top > 0.72) return 'screen';
  return 'camera';
}

/** The shots between cuts (seconds) of a template `seconds` long, each with its kind. */
export function shotsFrom(cuts: number[], seconds: number, kinds: ShotKind[]): Recipe['shots'] {
  const edges = [0, ...cuts.filter((c) => c > 0.05 && c < seconds - 0.05).sort((a, b) => a - b), seconds];
  const out: Recipe['shots'] = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push({ start: round(edges[i]!), end: round(edges[i + 1]!), kind: kinds[i] ?? 'camera' });
  return out;
}

/** How fast the template cuts: the median shot (end card left out), and the shortest and longest. */
export function rhythm(r: Pick<Recipe, 'shots'>): { median: number; min: number; max: number; cutsPerMinute: number } {
  const body = r.shots.filter((s) => s.kind !== 'end-card').map((s) => s.end - s.start);
  if (!body.length) return { median: 3, min: 3, max: 3, cutsPerMinute: 20 };
  const sorted = [...body].sort((a, b) => a - b);
  const total = body.reduce((n, v) => n + v, 0);
  return { median: round(sorted[Math.floor(sorted.length / 2)]!), min: round(sorted[0]!), max: round(sorted.at(-1)!), cutsPerMinute: Math.round((body.length / Math.max(1, total)) * 60) };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The caption look a recipe asks for. */
export function recipeCaptionStyle(r: Recipe): { style: Partial<TextStyle>; y: number } {
  const y = r.captions.position === 'center' ? 0.5 : r.captions.position === 'upper' ? 0.2 : 0.76;
  return { style: { sizePct: r.captions.style === 'phrase' ? 6.5 : 5.6, weight: 'black', color: '#FFFFFF', outline: r.captions.style === 'phrase' ? 0 : 6, outlineColor: '#000000', shadow: 16, uppercase: r.captions.uppercase, maxWidth: 0.82 }, y };
}

export interface RecipeSources {
  /** The talking clip on the timeline (its sound is the voice-over), and its length there. */
  main: { clip: string; start: number; duration: number };
  /** Screen recordings and other cutaways: assets and how much of each can be used. */
  cutaways: Array<{ assetId: string; duration: number; kind: 'video' | 'image' }>;
  /** The spoken words on the timeline (for captions), if known. */
  words: Array<{ text: string; start: number; end: number }>;
  /** Text for the end card (a website, handle or call to action), if the recipe has one. */
  endText: string | null;
}

/**
 * The edit a recipe makes with the user's clips, as ordinary Studio edits: cutaways laid over the
 * talking clip at the template's rhythm and in its order of shot kinds (camera shots show the
 * talking clip, screen shots a cutaway), its transition into each cutaway, captions in its style,
 * its look and its end card. Times are where the edit starts on the timeline.
 */
export function recipeOps(r: Recipe, src: RecipeSources): { ops: EditOp[]; cutawayStarts: number[] } {
  const ops: EditOp[] = [];
  const cutawayStarts: number[] = [];
  const body = r.shots.filter((s) => s.kind !== 'end-card');
  const total = src.main.duration;
  // The template's own pattern of shot lengths and kinds, repeated for as long as the voice lasts.
  let t = src.main.start;
  let i = 0;
  const used = new Map<string, number>();
  let cut = 0;
  while (t < src.main.start + total - 0.4 && body.length) {
    const shot = body[i % body.length]!;
    const len = Math.max(0.6, shot.end - shot.start);
    const end = Math.min(src.main.start + total, t + len);
    if ((shot.kind === 'screen' || shot.kind === 'graphic') && src.cutaways.length) {
      // The next cutaway, from where it was left off (so the same moment does not repeat).
      const c = src.cutaways[cut % src.cutaways.length]!;
      cut++;
      const from = used.get(c.assetId) ?? 0;
      const room = c.kind === 'image' ? Infinity : c.duration - from;
      const d = Math.min(end - t, room);
      if (d >= 0.4) {
        ops.push({ op: 'add_media', assetId: c.assetId, start: round(t), duration: round(d), trackName: 'B-roll', ...(c.kind === 'video' ? { in: round(from) } : {}), fit: 'cover' });
        cutawayStarts.push(round(t));
        if (c.kind === 'video') used.set(c.assetId, from + d >= c.duration - 0.5 ? 0 : from + d);
      }
    }
    t = end;
    i++;
  }
  // Captions in the template's style, a few words a line.
  if (r.captions.on && src.words.length) {
    const per = Math.max(1, Math.min(8, r.captions.wordsPerLine));
    const lines: Array<{ text: string; start: number; end: number; words: Array<{ text: string; start: number; end: number }> }> = [];
    for (let k = 0; k < src.words.length; k += per) {
      const w = src.words.slice(k, k + per);
      const text = w.map((x) => x.text).join(' ');
      lines.push({ text: r.captions.uppercase ? text.toUpperCase() : text, start: round(w[0]!.start), end: round(w.at(-1)!.end), words: w.map((x) => ({ text: x.text, start: round(x.start), end: round(x.end) })) });
    }
    const look = recipeCaptionStyle(r);
    ops.push({ op: 'add_captions', lines, style: look.style, transform: { y: look.y }, highlight: null, animIn: r.captions.style === 'word' ? 'words' : 'pop', replace: true });
  }
  // The end card: black, with the website or handle, after the voice.
  if (r.endCard.on) {
    const at = round(src.main.start + total);
    const seconds = Math.max(1.5, Math.min(5, r.endCard.seconds || 2.5));
    ops.push({ op: 'add_shape', shape: 'rect', start: at, duration: seconds, style: { width: 1.2, height: 1.2, radius: 0, fill: '#000000' }, trackName: 'End card' });
    if (src.endText) ops.push({ op: 'add_text', text: src.endText, start: at, duration: seconds, animIn: 'fade', style: { sizePct: 6, weight: 'black', color: '#FFFFFF', shadow: 0 } });
  }
  return { ops, cutawayStarts };
}

/** The look a recipe's colour grade matches (for the clips it uses). */
export const lookOf = (r: Recipe) => (r.look ? LOOKS[r.look] : null);
export { CAPTIONS_TRACK };
