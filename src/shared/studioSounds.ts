/**
 * The user's sound library (all projects): their own music and sound effects, sorted by kind and
 * genre so they (and Keo) can find the right one, plus Keo's own sound effects.
 */

export const MUSIC_GENRES = ['hip-hop', 'afrobeats', 'amapiano', 'pop', 'rnb', 'lofi', 'electronic', 'house', 'rock', 'cinematic', 'ambient', 'acoustic', 'gospel', 'corporate', 'funny', 'other'] as const;
export type MusicGenre = (typeof MUSIC_GENRES)[number];
export const EFFECT_KINDS = ['whoosh', 'pop', 'click', 'riser', 'impact', 'ding', 'swipe', 'glitch', 'laugh', 'applause', 'typing', 'other'] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const GENRE_LABEL: Record<MusicGenre | EffectKind, string> = {
  'hip-hop': 'Hip hop',
  afrobeats: 'Afrobeats',
  amapiano: 'Amapiano',
  pop: 'Pop',
  rnb: 'R&B',
  lofi: 'Lo-fi',
  electronic: 'Electronic',
  house: 'House',
  rock: 'Rock',
  cinematic: 'Cinematic',
  ambient: 'Ambient',
  acoustic: 'Acoustic',
  gospel: 'Gospel',
  corporate: 'Corporate',
  funny: 'Funny',
  other: 'Other',
  whoosh: 'Whoosh',
  click: 'Click',
  riser: 'Riser',
  impact: 'Impact / boom',
  ding: 'Ding',
  swipe: 'Swipe',
  glitch: 'Glitch',
  laugh: 'Laugh',
  applause: 'Applause',
  typing: 'Typing',
};

export interface Sound {
  id: string;
  name: string;
  kind: 'music' | 'effect';
  /** A music genre, or the kind of sound effect. */
  genre: MusicGenre | EffectKind;
  tags: string[];
  duration: number;
  addedAt: string;
  /** One of Keo's own sound effects (made on this PC, always there). */
  builtIn?: boolean;
}

const MUSIC_WORDS: Array<[MusicGenre, RegExp]> = [
  ['hip-hop', /hip.?hop|rap|trap|drill|boom.?bap/i],
  ['afrobeats', /afro|naija|afrobeat/i],
  ['amapiano', /amapiano|piano.?house|log.?drum/i],
  ['rnb', /\br.?n.?b\b|rnb|soul/i],
  ['lofi', /lo.?fi|chill|study/i],
  ['house', /\bhouse\b|deep house|techno/i],
  ['electronic', /edm|electro|synth|dubstep|dance/i],
  ['rock', /rock|guitar riff|metal|punk/i],
  ['cinematic', /cinematic|epic|trailer|orchestra|film/i],
  ['ambient', /ambient|calm|relax|meditat/i],
  ['acoustic', /acoustic|folk|ukulele/i],
  ['gospel', /gospel|worship|praise|choir/i],
  ['corporate', /corporate|business|upbeat|motivat|inspir/i],
  ['funny', /funny|comedy|meme|silly/i],
  ['pop', /\bpop\b/i],
];
const EFFECT_WORDS: Array<[EffectKind, RegExp]> = [
  ['whoosh', /whoosh|woosh|swoosh|transition|wind/i],
  ['swipe', /swipe|swish/i],
  ['pop', /\bpop\b|bubble|plop/i],
  ['click', /click|tap|mouse/i],
  ['riser', /riser|rise|build.?up|uplift/i],
  ['impact', /impact|boom|hit|thud|bass drop|slam/i],
  ['ding', /ding|bell|chime|notif|success/i],
  ['glitch', /glitch|static|error/i],
  ['laugh', /laugh|haha/i],
  ['applause', /applause|clap|cheer/i],
  ['typing', /typing|keyboard|type/i],
];

/** What a sound is likely to be, from its file name and length (the user can change it). */
export function guessSound(name: string, duration: number): { kind: 'music' | 'effect'; genre: MusicGenre | EffectKind } {
  const effect = EFFECT_WORDS.find(([, re]) => re.test(name))?.[0];
  const music = MUSIC_WORDS.find(([, re]) => re.test(name))?.[0];
  // Short sounds are effects, long ones music, unless the name says otherwise.
  const kind: 'music' | 'effect' = music && !effect ? 'music' : effect && duration < 30 ? 'effect' : duration <= 12 ? 'effect' : 'music';
  return { kind, genre: kind === 'music' ? (music ?? 'other') : (effect ?? 'other') };
}

/** Sounds matching a search (name, genre or tag) and filters, newest first. */
export function findSounds(all: Sound[], q: { query?: string | undefined; kind?: 'music' | 'effect' | undefined; genre?: string | undefined }): Sound[] {
  const words = (q.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return all
    .filter((s) => (!q.kind || s.kind === q.kind) && (!q.genre || s.genre === q.genre))
    .filter((s) => words.every((w) => `${s.name} ${GENRE_LABEL[s.genre]} ${s.genre} ${s.tags.join(' ')}`.toLowerCase().includes(w)))
    .sort((a, b) => (a.builtIn === b.builtIn ? b.addedAt.localeCompare(a.addedAt) : a.builtIn ? 1 : -1));
}
