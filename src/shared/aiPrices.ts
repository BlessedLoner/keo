/**
 * What fal.ai's models cost (their list prices when this was written: check fal.ai/pricing), so
 * Keo can say the price before the user pays it, in the main process and in the page alike.
 */

/** Swapping the person in a video (Wan 2.2 Animate Replace): US dollars per billed second (16 frames). */
export const SWAP_PER_SECOND = { '480p': 0.04, '580p': 0.06, '720p': 0.08 } as const;
export type SwapResolution = keyof typeof SWAP_PER_SECOND;

/** About what a swap costs: fal.ai counts the video's frames, 16 to a billed second. */
export function swapCost(seconds: number, fps: number, resolution: SwapResolution): number {
  return Math.ceil(((seconds * fps) / 16) * SWAP_PER_SECOND[resolution] * 100 - 1e-6) / 100;
}

/** A line in a character's own voice (Chatterbox, from their voice sample): US dollars per 1000 letters. */
export const OWN_VOICE_PER_1K_CHARS = 0.025;

/** About what speaking this text in a character's own voice costs. */
export function ownVoiceCost(text: string): number {
  return Math.ceil((text.length / 1000) * OWN_VOICE_PER_1K_CHARS * 1000 - 1e-6) / 1000;
}

/** Designing a voice from a description (MiniMax Voice Design: $30 per million letters of the sample line). */
export const VOICE_DESIGN_PER_1M_CHARS = 30;

/** A new picture of a character with the same face (Nano Banana edit), US dollars. */
export const CHARACTER_PICTURE_USD = 0.0398;

/**
 * Creative assets (fal.ai list prices, November 2026): a cut-out (Bria, $0.018; $0.03 with what to
 * keep), an illustration (Recraft V3, $0.04), a vector (Recraft in a vector style $0.08 + to SVG $0.01),
 * lettering or a transparent element (Ideogram V3: $0.03 draft, $0.06 standard, $0.09 best).
 */
export function assetCost(kind: 'cutout' | 'illustration' | 'vector' | 'lettering' | 'element', o: { keep?: boolean; quality?: 'draft' | 'standard' | 'best' } = {}): number {
  switch (kind) {
    case 'cutout':
      return o.keep ? 0.03 : 0.018;
    case 'illustration':
      return 0.04;
    case 'vector':
      return 0.09;
    default:
      return o.quality === 'draft' ? 0.03 : o.quality === 'best' ? 0.09 : 0.06;
  }
}

/** Keo Cloud's Studio credits: 1 credit is 1 US cent and covers half a cent of fal.ai's price. */
export const CREDITS_PER_USD = 200;

/** fal.ai's price in Studio credits (as Keo Cloud charges it). */
export function usdToCredits(usd: number): number {
  return Math.max(1, Math.ceil(usd * CREDITS_PER_USD - 1e-6));
}

/** A price as the user pays it: Studio credits through Keo Cloud, dollars on their own fal.ai key. */
export function studioPrice(usd: number, via: 'own' | 'keo' | null): string {
  if (via === 'own') return `$${usd < 0.1 ? usd.toFixed(3).replace(/0$/, '') : usd.toFixed(2)}`;
  const n = usdToCredits(usd);
  return `${n.toLocaleString()} credit${n === 1 ? '' : 's'}`;
}

/** A realistic frame or picture (Nano Banana Pro, 1K or 2K), US dollars. */
export const REAL_PICTURE_USD = 0.15;

/**
 * A 3D model from a picture (fal.ai Trellis 2, textured GLB), US dollars. fal.ai's page does not
 * state it; third-party listings say $0.25–0.35, so the top of that range is charged.
 */
export const MODEL_3D_USD = 0.35;

/** A game car: its realistic studio picture, then the 3D model made from it. */
export const CAR_MODEL_USD = REAL_PICTURE_USD + MODEL_3D_USD;

/** Clone with Kling Motion Control (the character performs the video's moves): US dollars a second. */
export const MOTION_CLONE_PER_SECOND = 0.112;

/** About what a stable clone costs: the character placed into the video's first frame, then filmed doing its moves. */
export function motionCloneCost(seconds: number): number {
  return Math.ceil((REAL_PICTURE_USD + Math.max(1, seconds) * MOTION_CLONE_PER_SECOND) * 100 - 1e-6) / 100;
}

/** A talking character (Kling AI Avatar v2: a picture lip-synced to a voice): US dollars a second, by quality. */
export const TALK_PER_SECOND = { pro: 0.115, standard: 0.0562 } as const;
export type TalkQuality = keyof typeof TALK_PER_SECOND;
/** A talking clip is up to a minute long (longer scripts are made in parts). */
export const TALK_MAX_SECONDS = 60;

/**
 * About what a talking character costs: the lip-sync by the second of the voice, a new framed
 * picture of them when one is made (their picture in another shape, or in a scene), and their own
 * voice when it is spoken in it.
 */
export function talkCost(seconds: number, quality: TalkQuality, o: { picture?: boolean; ownVoiceUsd?: number } = {}): number {
  const usd = Math.max(1, Math.ceil(seconds)) * TALK_PER_SECOND[quality] + (o.picture ? REAL_PICTURE_USD : 0) + (o.ownVoiceUsd ?? 0);
  return Math.ceil(usd * 100 - 1e-6) / 100;
}

/** Music made for the video (ElevenLabs Music v2.5): US dollars a minute of music, each started minute counted. */
export const MUSIC_PER_MINUTE = 0.6;
/** A piece of music is 5 seconds to 5 minutes long. */
export const MUSIC_SECONDS = { min: 5, max: 300 } as const;
export function musicCost(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60 - 1e-9)) * MUSIC_PER_MINUTE;
}

/** A sound effect made from words (ElevenLabs Sound Effects v3): US dollars a second, up to 30 seconds. */
export const SFX_PER_SECOND = 0.002;
export const SFX_MAX_SECONDS = 30;
export function sfxCost(seconds: number): number {
  return Math.ceil(Math.max(1, Math.ceil(seconds)) * SFX_PER_SECOND * 1000 - 1e-6) / 1000;
}
