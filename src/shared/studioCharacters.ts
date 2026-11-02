import { z } from 'zod';

/**
 * Characters for faceless videos: the people (real or AI-made) a user's videos are told by or
 * about, kept for every project. Each has a look (words and pictures, so every scene shows the
 * same face) and a voice (so every line they say sounds like them).
 */

export const CharacterId = z.string().regex(/^ch_[A-Za-z0-9]{4,24}$/);

export const Character = z
  .object({
    id: CharacterId,
    name: z.string().trim().min(1).max(40),
    /** What they look like, in words (added to AI picture descriptions of their scenes). */
    look: z.string().trim().max(500).default(''),
    /** Their voice: Keo's voices (female, male), or an OpenAI voice name with the user's own key. */
    voice: z.string().regex(/^[a-z]{2,20}$/).default('female'),
    /** Personality, way of speaking, anything Keo should keep in mind when writing for them. */
    notes: z.string().trim().max(800).default(''),
    /** Their pictures (files Keo keeps in its own folder), the first one the main one. */
    pictures: z.array(z.string().min(3).max(1000)).max(4).default([]),
    createdAt: z.string(),
  })
  .strict();
export type Character = z.infer<typeof Character>;

/** A change to a character (a new one has no id yet). */
export const CharacterPatch = z
  .object({
    id: CharacterId.optional(),
    name: z.string().trim().min(1).max(40).optional(),
    look: z.string().trim().max(500).optional(),
    voice: z.string().regex(/^[a-z]{2,20}$/).optional(),
    notes: z.string().trim().max(800).optional(),
  })
  .strict();
export type CharacterPatch = z.infer<typeof CharacterPatch>;

/** The voices a character can have (Keo's own need a Keo account, OpenAI's the user's OpenAI key). */
export const CHARACTER_VOICES = [
  { id: 'female', label: 'Keo voice: female' },
  { id: 'male', label: 'Keo voice: male' },
  { id: 'nova', label: 'OpenAI: Nova (warm, female)' },
  { id: 'shimmer', label: 'OpenAI: Shimmer (bright, female)' },
  { id: 'alloy', label: 'OpenAI: Alloy (neutral)' },
  { id: 'echo', label: 'OpenAI: Echo (calm, male)' },
  { id: 'onyx', label: 'OpenAI: Onyx (deep, male)' },
  { id: 'fable', label: 'OpenAI: Fable (storyteller)' },
] as const;

/**
 * A script line's speaker: "Kira: Welcome back!" is Kira's line (when Kira is in the cast). The
 * name must be the whole start of the line, so "Note: this is…" is only a speaker if a character
 * is called Note.
 */
export function speakerOf(line: string, cast: Array<Pick<Character, 'id' | 'name'>>): { character: string; text: string } | null {
  const m = /^\s*([^:\n]{1,40}):\s+(.+)$/s.exec(line);
  if (!m) return null;
  const name = m[1]!.trim().toLowerCase();
  const c = cast.find((x) => x.name.trim().toLowerCase() === name);
  return c ? { character: c.id, text: m[2]!.trim() } : null;
}
