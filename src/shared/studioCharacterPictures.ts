import { z } from 'zod';

/**
 * Put the user's character into their own pictures: the same pose, place, light and camera, the
 * character's face and body, and either the same clothes or a new outfit. One realistic picture
 * (Nano Banana Pro) per picture, made from the character's photos and the picture itself.
 */

/** Picture shapes the picture model makes. */
export const PICTURE_ASPECTS = ['1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9', '21:9'] as const;
export type PictureAspect = (typeof PICTURE_ASPECTS)[number];

/** The shape closest to a picture's own (so nothing is cropped or stretched). */
export function nearestAspect(width: number, height: number): PictureAspect {
  const r = Math.log(Math.max(1, width) / Math.max(1, height));
  let best: PictureAspect = '1:1';
  let gap = Infinity;
  for (const a of PICTURE_ASPECTS) {
    const [w, h] = a.split(':').map(Number) as [number, number];
    const d = Math.abs(Math.log(w / h) - r);
    if (d < gap) {
      gap = d;
      best = a;
    }
  }
  return best;
}

/** "Keo picks": the picture model chooses a cute, feminine outfit from what it sees in the picture. */
export const CUTE_OUTFIT = 'cute';

export const CharacterPictureJob = z
  .object({
    /** A picture of the project. */
    assetId: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/),
    /** A new outfit, described, or "cute" (a cute, feminine outfit chosen to suit the picture). Left out: the clothes stay exactly as they are. */
    outfit: z.string().trim().min(2).max(300).optional(),
    /** Anything else to change, in the user's words (e.g. "sitting on the bed, hand on her hip", "smiling", "holding a coffee"). */
    change: z.string().trim().min(2).max(300).optional(),
    /** Which person to replace when the picture has several (e.g. "the woman on the left"). */
    person: z.string().trim().min(2).max(120).optional(),
  })
  .strict();
export type CharacterPictureJob = z.infer<typeof CharacterPictureJob>;

/**
 * What the picture model is asked: the character's photos come first, the picture to change last.
 * Everything that makes the character who they are comes from their photos only (face, body,
 * tattoos, marks); the picture gives the scene, and its person's own face and body are not kept.
 */
export function characterPicturePrompt(who: string, photos: number, job: { outfit?: string; change?: string; person?: string }): string {
  const target = job.person ? `${job.person} in the last picture` : 'the person in the last picture';
  const from = photos > 1 ? `the first ${photos} pictures` : 'the first picture';
  const cute = job.outfit?.trim().toLowerCase() === CUTE_OUTFIT;
  const clothes = !job.outfit
    ? 'Keep the clothes, shoes, jewellery and accessories exactly as they are in the last picture.'
    : cute
      ? `Change the clothes to a cute, feminine outfit that suits the pose, the place and the mood of the picture (soft colours, flattering fit, tasteful), worn naturally, with real fabric, folds and light on it.`
      : `Change the clothes: dress ${who} in ${job.outfit}, fitted naturally to the pose, with real fabric, folds and light on it. Keep the shoes and accessories only if they suit the new outfit.`;
  return [
    `Replace ${target} with ${who}, the person in ${from}.`,
    `${who} must look exactly like ${from}: the same face and features, eyes, eyebrows, lips, makeup style, hair (colour, length, texture and style), skin tone, body shape and proportions, height and build, and every tattoo, piercing, birthmark, mole and freckle, in the same places. Where the clothes leave skin showing, show ${who}'s own tattoos and marks there; never copy the face, body, skin, tattoos or hair of the person in the last picture.`,
    job.change
      ? `Also change, as asked: ${job.change}. Apart from that keep the last picture's composition, camera angle, lens, background, lighting and colours.`
      : `Keep everything else in the last picture the same: the pose, the hands and where they are, the position and size in the frame, the camera angle and lens, the background, the lighting and the colours.`,
    clothes,
    job.person ? 'Leave everyone else in the picture as they are.' : '',
    'A real photograph: natural skin texture, true-to-life light and shadows, sharp focus, correct hands. No text, no watermark, not a drawing or a 3D render.',
  ]
    .filter(Boolean)
    .join(' ');
}
