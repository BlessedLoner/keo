import { CAPTIONS_TRACK, type Project } from './studio';
import type { Brand, BrandPatch } from './studioBrand';

/**
 * Learning the user's style from a video they finished: the fonts they used for titles and
 * captions, their accent colour, their end card line and @handle. Keo proposes these for the brand
 * kit (the user saves them), so every later edit, template and end card looks like theirs.
 */
export interface LearnedStyle {
  patch: BrandPatch;
  /** What was learned, in words (for the user to read before saving). */
  found: string[];
}

const most = <T,>(xs: T[]): T | undefined => {
  const n = new Map<T, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};
const isHex = (c: unknown): c is string => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
const plainColour = (c: string) => ['#FFFFFF', '#000000', '#111111', '#101014'].includes(c.toUpperCase());

/** What a finished project says about the user's style, compared with their brand kit now. */
export function learnStyle(p: Project, brand: Brand): LearnedStyle {
  const texts = p.tracks.filter((t) => !t.hidden).flatMap((t) => t.clips.map((c) => ({ c, track: t.name })));
  const titles = texts.filter((x) => x.c.type === 'text' && x.track !== CAPTIONS_TRACK).map((x) => x.c as Extract<typeof x.c, { type: 'text' }>);
  const captions = texts.filter((x) => x.c.type === 'text' && x.track === CAPTIONS_TRACK).map((x) => x.c as Extract<typeof x.c, { type: 'text' }>);
  const motion = texts.filter((x) => x.c.type === 'motion').map((x) => x.c as Extract<typeof x.c, { type: 'motion' }>);
  const patch: BrandPatch = {};
  const found: string[] = [];

  const headline = most([...titles.map((t) => t.style.font), ...motion.map((m) => m.font).filter((f): f is string => !!f)]);
  if (headline && headline !== brand.headlineFont) {
    patch.headlineFont = headline;
    found.push(`Titles in ${headline}`);
  }
  const body = most(captions.map((c) => c.style.font));
  if (body && body !== brand.bodyFont) {
    patch.bodyFont = body;
    found.push(`Captions in ${body}`);
  }
  // The accent: the word highlight of captions, motion accents, coloured titles — not plain white or black.
  const accent = most([...captions.map((c) => c.highlight), ...motion.map((m) => m.accent), ...titles.map((t) => t.style.color)].filter(isHex).map((c) => c.toUpperCase()).filter((c) => !plainColour(c)));
  if (accent && accent !== brand.accent?.toUpperCase()) {
    patch.accent = accent;
    found.push(`Accent colour ${accent}`);
  }
  // The end card: the last title, its @handle and its line.
  const last = [...titles].sort((a, b) => b.start - a.start)[0];
  if (last) {
    const handle = /@[\w.]{2,40}/.exec(last.text)?.[0];
    if (handle && handle !== brand.handle) {
      patch.handle = handle;
      found.push(`Your handle ${handle}`);
    }
    const line = last.text.split(/\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('@'));
    if (line && line.length <= 120 && /follow|subscribe|more|join|share|like/i.test(line) && line !== brand.endText) {
      patch.endText = line;
      found.push(`End card line “${line}”`);
    }
  }
  return { patch, found };
}
