import { z } from 'zod';

/**
 * The user's brand kit: what Keo remembers for every video (their name or @handle, colours,
 * fonts, end card line, favourite style), so it does not ask each time. Kept on this PC.
 */
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const Brand = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    handle: z.string().trim().min(1).max(60).optional(),
    accent: Hex.optional(),
    headlineFont: z.string().trim().min(1).max(80).optional(),
    bodyFont: z.string().trim().min(1).max(80).optional(),
    endText: z.string().trim().min(1).max(120).optional(),
    style: z.enum(['podcast-frame', 'doc-serif']).optional(),
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
  ].filter(Boolean);
  return parts.join(', ');
}
