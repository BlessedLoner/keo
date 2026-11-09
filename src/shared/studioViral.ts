import type { SpokenWord } from './studioStyles';
import { planBeats, sentences, type MotionBeat, type MotionEditEnergy, type MotionEditLook } from './studioMotionEdit';

/**
 * Viral video templates: the structures short videos that travel are built on, made from the
 * user's own talking video (their words, never invented ones). Each becomes a motion edit — the
 * camera moves, keyword scenes and graphics placed on what is said — plus a hook and an end card.
 */

export const VIRAL_TEMPLATES = {
  'hook-payoff': { label: 'Hook → story → payoff', use: 'A bold opening line, quick punch-ins and keyword scenes while you talk, and your last point landing big.', energy: 'high', look: 'mix' },
  listicle: { label: 'Numbered list', use: 'For “3 things…”, “5 steps…”: every point you count gets its own numbered scene, then a recap list.', energy: 'normal', look: 'light' },
  'myth-fact': { label: 'Myth vs fact', use: 'When you bust a belief: what people think on a dark scene, what is true on a light one.', energy: 'normal', look: 'mix' },
  'story-time': { label: 'Story time', use: 'A calm, cinematic telling: dark scenes, slow pushes, the strongest lines as big words.', energy: 'calm', look: 'dark' },
} as const satisfies Record<string, { label: string; use: string; energy: MotionEditEnergy; look: MotionEditLook }>;
export type ViralId = keyof typeof VIRAL_TEMPLATES;

const STOP = new Set('a an the and or but so to of in on at for with is are was were be been it its this that these those i you we they he she my your our their me us them just really very like um uh okay so well then there here what which who how do does did have has had can will would could should not no yes'.split(' '));
const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
/** The words of a sentence worth showing (up to `n`), in the speaker's order. */
function keyWords(s: SpokenWord[], n = 4): string {
  const words = s.map((w) => w.text.replace(/[^\p{L}\p{N}'%$-]+/gu, '')).filter(Boolean);
  const strong = words.filter((w) => !STOP.has(plain(w)));
  return (strong.length >= 2 ? strong : words).slice(0, n).join(' ');
}
/** The first words of a sentence, exactly as said (a beat lands on them). */
const said = (s: SpokenWord[], n = 4) => s.slice(0, n).map((w) => w.text).join(' ');
const ORDINAL = /^(first(ly)?|second(ly)?|third(ly)?|fourth(ly)?|fifth(ly)?|next|finally|lastly|number|one|two|three|four|five|step)$/;
const MYTH = /\b(myth|people think|they say|everyone says|most people|you might think|believe|wrong|misconception)\b/i;
const FACT = /\b(actually|truth|in fact|reality|the real|really is|turns out)\b/i;

export interface ViralPlan {
  beats: MotionBeat[];
  hook?: string;
  energy: MotionEditEnergy;
  look: MotionEditLook;
  /** Why the template could not use its own structure (then it falls back to hook → payoff). */
  note?: string;
}

/** A template's motion edit from the transcript. `hook`: the user's own opening line, if given. */
export function viralPlan(id: ViralId, words: SpokenWord[], o: { hook?: string } = {}): ViralPlan {
  const t = VIRAL_TEMPLATES[id];
  const ss = sentences(words).filter((s) => s.length >= 2);
  const first = ss[0];
  const hook = (o.hook?.trim() || (first ? keyWords(first, 7) : '')).slice(0, 120) || undefined;
  const base = (energy: MotionEditEnergy, note?: string): ViralPlan => {
    const beats = planBeats(words, energy);
    // The payoff: the last sentence lands as a big scene.
    const last = ss.at(-1);
    if (last && last !== first && !beats.some((b) => b.at !== undefined && b.at >= last[0]!.start - 0.5)) beats.push({ kind: 'scene', say: said(last), text: keyWords(last), at: last[0]!.start });
    return { beats, ...(hook ? { hook } : {}), energy, look: 'mix', ...(note ? { note } : {}) };
  };
  if (id === 'hook-payoff') return base('high');
  if (id === 'listicle') {
    const points = ss.filter((s) => ORDINAL.test(plain(s[0]!.text)) || (s.length > 2 && plain(s[0]!.text) === 'the' && ORDINAL.test(plain(s[1]!.text))));
    if (points.length < 2) return base('normal', 'No numbered points were heard (“first…”, “second…”), so Keo made a hook → payoff edit instead.');
    const beats: MotionBeat[] = points.slice(0, 7).map((s, i) => ({ kind: 'scene', say: said(s), text: keyWords(s.slice(1)), sub: `#${i + 1}`, at: s[0]!.start }));
    // The recap: every point as a list, each row on its own words.
    const end = points.at(-1)!;
    const after = ss.find((s) => s[0]!.start > end.at(-1)!.end + 0.5);
    if (after && points.length >= 3) beats.push({ kind: 'frame', say: said(after), text: 'Recap', piece: 'list', items: points.slice(0, 5).map((s) => keyWords(s.slice(1), 3)), at: after[0]!.start });
    return { beats, ...(hook ? { hook } : {}), energy: t.energy, look: t.look };
  }
  if (id === 'myth-fact') {
    const beats: MotionBeat[] = [];
    for (const s of ss) {
      const line = s.map((w) => w.text).join(' ');
      if (MYTH.test(line)) beats.push({ kind: 'scene', say: said(s), text: keyWords(s), sub: 'MYTH', tone: 'dark', at: s[0]!.start });
      else if (FACT.test(line)) beats.push({ kind: 'scene', say: said(s), text: keyWords(s), sub: 'FACT', tone: 'light', at: s[0]!.start });
    }
    if (beats.length < 2) return base('normal', 'No myth and fact were heard (“people think…”, “actually…”), so Keo made a hook → payoff edit instead.');
    // Between them: punch-ins keep it moving.
    const plan = planBeats(words, 'normal').filter((b) => b.kind === 'punch');
    return { beats: [...beats, ...plan].sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), ...(hook ? { hook } : {}), energy: t.energy, look: t.look };
  }
  // Story time: calm, the strongest lines as big words.
  const beats = planBeats(words, 'calm').filter((b) => b.kind !== 'pop');
  return { beats, hook: hook ? `Story time: ${hook}` : 'Story time', energy: 'calm', look: 'dark' };
}
