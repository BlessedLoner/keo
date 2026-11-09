import { z } from 'zod';

/**
 * Proofreading a transcript like an editor would before captions go out: only words the
 * speech-to-text service misheard (a name heard as "KUI", "flowing me" for "following me").
 * Never a rewrite: the speaker's own words, grammar and fillers stay as they were said.
 */

export interface WordFix {
  heard: string;
  meant: string;
}

export const WordFixInput = z
  .object({
    heard: z.string().trim().min(1).max(60),
    meant: z.string().trim().min(1).max(60),
  })
  .strip();

const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/** Names the user's videos are likely to say: their brand, handle, the project's name and known spellings. */
export function namesFor(o: { brandName?: string; handle?: string; project?: string; spellings?: Array<{ say: string }>; extra?: string[] }): string[] {
  const out = new Set<string>();
  const add = (v: string | undefined) => {
    const t = (v ?? '').replace(/^@/, '').trim();
    if (t.length >= 2 && t.length <= 40) out.add(t);
  };
  add(o.brandName);
  // "@keo.ai" → "Keo": the handle's first part is usually the name said out loud.
  if (o.handle) {
    const base = o.handle.replace(/^@/, '').split(/[._]/)[0] ?? '';
    add(base ? base[0]!.toUpperCase() + base.slice(1) : undefined);
  }
  for (const s of o.spellings ?? []) add(s.say);
  for (const e of o.extra ?? []) add(e);
  if (o.project && !/^(my video|untitled|video)\b/i.test(o.project)) add(o.project);
  return [...out].slice(0, 20);
}

export function proofreadPrompt(names: string[]): string {
  return [
    'You proofread a speech-to-text transcript of the user’s own video before it becomes captions.',
    'Find only words the speech service MISHEARD: names, brands, products and technical terms spelled wrong, and words that make no sense where they are but sound almost the same as a word that does (e.g. "flowing me" for "following me").',
    'Never rewrite or improve what the speaker said: no grammar fixes, no rephrasing, no removed fillers or repeats, no added words. If unsure, leave it.',
    names.length ? `Names this speaker uses (a word that sounds like one of them, especially an odd capitalised one, is probably that name): ${names.join(', ')}.` : '',
    'Reply with JSON only: {"fixes":[{"heard":"KUI","meant":"Keo"}]}. "heard" is 1–4 words exactly as they appear in the transcript; every place it appears gets the fix, so make it specific enough. At most 25 fixes; {"fixes":[]} if nothing is misheard.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The model's fixes, kept only when they are real, small and found in the transcript. */
export function checkFixes(raw: unknown, transcript: string): WordFix[] {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { fixes?: unknown }).fixes) ? (raw as { fixes: unknown[] }).fixes : [];
  const words = transcript.split(/\s+/).map(plain).filter(Boolean);
  const out: WordFix[] = [];
  for (const f of list) {
    const r = WordFixInput.safeParse(f);
    if (!r.success) continue;
    const heard = r.data.heard.split(/\s+/).map(plain).filter(Boolean);
    const meant = r.data.meant.split(/\s+/).filter(Boolean);
    if (!heard.length || heard.length > 4 || !meant.length || meant.length > heard.length + 2) continue;
    if (heard.join(' ') === meant.map(plain).join(' ')) continue;
    // It must be in the transcript, word for word.
    const found = words.some((_, i) => heard.every((h, k) => words[i + k] === h));
    if (!found || out.some((o) => plain(o.heard) === plain(r.data.heard))) continue;
    out.push({ heard: r.data.heard, meant: r.data.meant });
    if (out.length >= 25) break;
  }
  return out;
}
