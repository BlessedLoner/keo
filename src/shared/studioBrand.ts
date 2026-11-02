import { z } from 'zod';

/**
 * The user's brand kit: what Keo remembers for every video (their name or @handle, colours,
 * fonts, end card line, favourite style), so it does not ask each time. Kept on this PC.
 */
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const Spelling = z.object({ heard: z.string().trim().min(1).max(60), say: z.string().trim().min(1).max(60) }).strict();

export const Brand = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    handle: z.string().trim().min(1).max(60).optional(),
    accent: Hex.optional(),
    headlineFont: z.string().trim().min(1).max(80).optional(),
    bodyFont: z.string().trim().min(1).max(80).optional(),
    endText: z.string().trim().min(1).max(120).optional(),
    style: z.enum(['podcast-frame', 'doc-serif']).optional(),
    /** Words speech-to-text gets wrong, and how they are written ("KUI" heard, "Keo" meant). */
    spellings: z.array(Spelling).max(40).optional(),
  })
  .strict();
export type Brand = z.infer<typeof Brand>;

/** A change to the brand kit: a value sets it, null forgets it. */
export const BrandPatch = z
  .object({
    name: z.string().trim().min(1).max(60).nullable().optional(),
    handle: z.string().trim().min(1).max(60).nullable().optional(),
    accent: Hex.nullable().optional(),
    headlineFont: z.string().trim().min(1).max(80).nullable().optional(),
    bodyFont: z.string().trim().min(1).max(80).nullable().optional(),
    endText: z.string().trim().min(1).max(120).nullable().optional(),
    style: z.enum(['podcast-frame', 'doc-serif']).nullable().optional(),
    spellings: z.array(Spelling).max(40).nullable().optional(),
  })
  .strict();
export type BrandPatch = z.infer<typeof BrandPatch>;

export function patchBrand(b: Brand, patch: BrandPatch): Brand {
  const out: Record<string, unknown> = { ...b };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return Brand.parse(out);
}

/** The brand kit in a sentence for Keo (empty when nothing is saved). */
export function describeBrand(b: Brand): string {
  const parts = [
    b.name && `name ${JSON.stringify(b.name)}`,
    b.handle && `handle ${JSON.stringify(b.handle)}`,
    b.accent && `accent colour ${b.accent}`,
    b.headlineFont && `headline font ${b.headlineFont}`,
    b.bodyFont && `body font ${b.bodyFont}`,
    b.endText && `end card line ${JSON.stringify(b.endText)}`,
    b.style && `favourite style ${b.style}`,
    b.spellings?.length && `spellings ${b.spellings.map((x) => `"${x.heard}" is "${x.say}"`).join(', ')}`,
  ].filter(Boolean);
  return parts.join(', ');
}

/** Spoken words with the brand kit's spellings applied ("KUI" heard, "Keo" meant), keeping their times. */
export function respell<T extends { text: string; start: number; end: number }>(words: T[], spellings: Brand['spellings']): T[] {
  if (!spellings?.length) return words;
  const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
  let out = words;
  for (const s of spellings) {
    const find = s.heard.split(/\s+/).map(plain).filter(Boolean);
    const into = s.say.split(/\s+/).filter(Boolean);
    if (!find.length || !into.length) continue;
    const next: T[] = [];
    for (let i = 0; i < out.length; ) {
      if (!find.every((w, k) => plain(out[i + k]?.text ?? '') === w)) {
        next.push(out[i++]!);
        continue;
      }
      const first = out[i]!;
      const last = out[i + find.length - 1]!;
      // Punctuation after the misheard words stays ("KUI," → "Keo,").
      const trail = /[^\p{L}\p{N}]*$/u.exec(last.text)![0];
      const each = (last.end - first.start) / into.length;
      into.forEach((w, k) => next.push({ ...first, text: k === into.length - 1 ? `${w}${trail}` : w, start: first.start + k * each, end: first.start + (k + 1) * each }));
      i += find.length;
    }
    out = next;
  }
  return out;
}
