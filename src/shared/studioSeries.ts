import { z } from 'zod';

/**
 * A series: Studio projects that are episodes of one show, in order. Each new episode is made with
 * the last episode's edit (same look, captions, cards and timing) and the new episode's own clips,
 * and is named and numbered for the series.
 */

export const SeriesId = z.string().regex(/^se_[A-Za-z0-9]{4,24}$/);

export const Series = z
  .object({
    id: SeriesId,
    name: z.string().trim().min(1).max(80),
    /** The episodes' projects, in order (episode 1 first). */
    projects: z.array(z.string().regex(/^pr_[A-Za-z0-9]{4,24}$/)).max(500),
    format: z.enum(['vertical', 'landscape', 'square']).default('vertical'),
    createdAt: z.string(),
  })
  .strict();
export type Series = z.infer<typeof Series>;

/** An episode's name: the series, its number and (optionally) its own title. */
export function episodeName(series: string, n: number, title?: string): string {
  return `${series} · Ep ${n}${title?.trim() ? `: ${title.trim()}` : ''}`.slice(0, 120);
}
