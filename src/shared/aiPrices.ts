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

/** A new picture of a character with the same face (Nano Banana edit), US dollars. */
export const CHARACTER_PICTURE_USD = 0.0398;
