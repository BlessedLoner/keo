import { isAV, type EditOp, type MediaClip, type Project, type Zoom } from './studio';

/**
 * Moments: the pieces edits are made of (a word behind the speaker, a word card, a before/after
 * split, a picture popping in). Each one becomes ordinary edits (one undo). A moment that needs a
 * picture or video the project does not have says exactly what to ask the user for.
 */

export const MOMENTS = {
  'text-behind': 'Big words behind the speaker: the person stays in front of the text (AI cut-out of the talking video; no green screen needed)',
  'word-card': 'A full-screen colour card with one big word or short phrase (a beat between ideas)',
  split: 'Two pictures or videos side by side in rounded cards (before/after, this vs that), with labels',
  'image-pop': 'A picture or video pops in over the talking video as a rounded card with a shadow, tilted a little, floating',
} as const;
export type MomentId = keyof typeof MOMENTS;

export interface MomentOptions {
  /** When (seconds on the timeline) and for how long. */
  at: number;
  duration?: number;
  /** The words (text-behind, word-card) or the two labels "Before|After" (split). */
  text?: string;
  /** Pictures or videos of the project (split takes two). */
  assets?: string[];
  /** Colours: the text (or card words) and the card or background. */
  color?: string;
  background?: string;
  /** Where (image-pop): left, right or centre. */
  side?: 'left' | 'right' | 'center';
}

/** What is missing for a moment: Keo asks the user for it (or picks other clips of the project). */
export class MomentNeeds extends Error {}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The scale that makes a picture (shown whole) as big as fits a box of bw × bh (fractions of the
 * frame): a wide photo fills the width, a tall one the height.
 */
export function fitScale(p: Project, assetId: string, bw: number, bh: number): number {
  const [w, h] = naturalSize(p, assetId);
  return r2(Math.min(bw / w, bh / h));
}

/** A picture's size shown whole in the frame (contain), as fractions of the frame. */
function naturalSize(p: Project, assetId: string): [number, number] {
  const a = p.assets.find((x) => x.id === assetId);
  const frame = p.width / p.height;
  const aspect = a && a.width > 0 && a.height > 0 ? a.width / a.height : frame;
  return aspect > frame ? [1, frame / aspect] : [aspect / frame, 1];
}

/** The talking video's clip at a time (the main video track). */
function talkingAt(p: Project, t: number): MediaClip | null {
  const track = p.tracks.find((x) => x.kind === 'video' && x.name !== 'B-roll' && x.clips.some((c) => c.type === 'media'));
  const c = track?.clips.find((x) => isAV(x) && x.type === 'media' && t >= x.start && t < x.start + x.duration);
  return (c as MediaClip | undefined) ?? null;
}

/** A free name for a pair of tracks that must stay in order (the lower one first). */
function pairNames(p: Project, lower: string, upper: string): [string, string] {
  for (let n = 1; n < 50; n++) {
    const [a, b] = n === 1 ? [lower, upper] : [`${lower} ${n}`, `${upper} ${n}`];
    const ia = p.tracks.findIndex((t) => t.name === a);
    const ib = p.tracks.findIndex((t) => t.name === b);
    // Fine: both new, the lower one only (the upper is made on top), or both in order.
    if ((ia < 0 && ib < 0) || (ia >= 0 && ib < 0) || (ia >= 0 && ib > ia)) return [a, b];
  }
  return [lower, upper];
}

/** The edits that make a moment. */
export function momentOps(p: Project, id: MomentId, o: MomentOptions): EditOp[] {
  const at = Math.max(0, o.at);
  const vertical = p.height >= p.width;
  const media = (n: number, what: string) => {
    const list = (o.assets ?? []).map((a) => p.assets.find((x) => x.id === a)).filter((a) => a && a.kind !== 'audio');
    if (list.length < n) throw new MomentNeeds(`The ${id} moment needs ${what}. Ask the user for ${n > 1 ? 'them' : 'it'} (they can drop the files into Studio), or use clips of this project.`);
    return list.slice(0, n).map((a) => a!.id);
  };
  const words = () => {
    const t = (o.text ?? '').trim();
    if (!t) throw new MomentNeeds(`The ${id} moment needs its words (text).`);
    return t.slice(0, 200);
  };

  switch (id) {
    case 'text-behind': {
      const c = talkingAt(p, at);
      if (!c) throw new MomentNeeds('The text-behind moment needs the talking video on the timeline at that time.');
      const d = Math.min(o.duration ?? 2.5, c.start + c.duration - at);
      if (d < 0.3) throw new MomentNeeds('The talking video ends there: choose an earlier time.');
      const [behind, person] = pairNames(p, 'Behind text', 'Person cut-out');
      const offset = (at - c.start) * c.speed;
      // The cut-out copy sits exactly on the talking video: same framing, mirror, colour and zooms.
      const zooms: Zoom[] = (c.zooms ?? []).map((z) => ({ ...z, at: r2(Math.max(0, z.at - offset)) }));
      const text = words();
      const long = text.length > 8;
      return [
        {
          op: 'add_text',
          text,
          start: r2(at),
          duration: r2(d),
          trackName: behind,
          animIn: 'zoom',
          animOut: 'fade',
          animSeconds: 0.35,
          style: { font: 'Anton', weight: 'normal', sizePct: long ? (vertical ? 11 : 16) : vertical ? 18 : 26, color: o.color ?? '#FFFFFF', uppercase: true, shadow: 0, maxWidth: 0.95, lineHeight: 0.95 },
          transform: { x: 0.5, y: vertical ? 0.36 : 0.4 },
        },
        {
          op: 'add_media',
          assetId: c.assetId,
          trackName: person,
          top: true,
          start: r2(at),
          in: r2(c.in + offset),
          duration: r2(d),
          fit: c.fit,
          transform: { ...c.transform },
          cutout: true,
          ...(c.mask ? { mask: c.mask } : {}),
          ...(c.flipX ? { flipX: true } : {}),
          ...(c.color ? { color: c.color } : {}),
          ...(zooms.length ? { zooms } : {}),
        },
      ];
    }
    case 'word-card': {
      const d = o.duration ?? 1.2;
      return [
        { op: 'add_shape', shape: 'rect', start: r2(at), duration: r2(d), trackName: 'Cards', style: { width: 1, height: 1, radius: 0, fill: o.background ?? '#F2EFE8' }, enter: { kind: 'flash', seconds: 0.15 } },
        {
          op: 'add_text',
          text: words(),
          start: r2(at),
          duration: r2(d),
          trackName: 'Card words',
          animIn: 'pop',
          animOut: 'none',
          animSeconds: 0.2,
          style: { font: 'Instrument Serif', weight: 'normal', sizePct: vertical ? 9 : 13, color: o.color ?? '#111111', shadow: 0, maxWidth: 0.85, lineHeight: 1 },
          transform: { x: 0.5, y: 0.5 },
        },
      ];
    }
    case 'split': {
      const [a, b] = media(2, 'two pictures or videos (the before and the after, or the two things compared)');
      const d = o.duration ?? 4;
      const [l1, l2] = (o.text ?? 'Before|After').split('|').map((s) => s.trim());
      // Stacked in a vertical video, side by side in a landscape one.
      const spots = vertical
        ? [
            { x: 0.5, y: 0.29 },
            { x: 0.5, y: 0.71 },
          ]
        : [
            { x: 0.27, y: 0.52 },
            { x: 0.73, y: 0.52 },
          ];
      const ops: EditOp[] = [{ op: 'add_shape', shape: 'rect', start: r2(at), duration: r2(d), trackName: 'Split back', style: { width: 1, height: 1, radius: 0, fill: o.background ?? '#F4F4F2' }, enter: { kind: 'fade', seconds: 0.25 } }];
      const scales = [a, b].map((x) => (vertical ? fitScale(p, x!, 0.9, 0.4) : fitScale(p, x!, 0.44, 0.78)));
      [a, b].forEach((asset, i) =>
        ops.push({
          op: 'add_media',
          assetId: asset!,
          trackName: 'Split',
          top: true,
          start: r2(at + i * 0.25),
          duration: r2(d - i * 0.25),
          fit: 'contain',
          mask: { shape: 'rounded', radius: 0.08 },
          shadow: 24,
          transform: { ...spots[i]!, scale: scales[i]! },
          enter: { kind: i ? 'slide-left' : 'slide-right', seconds: 0.4 },
        }),
      );
      [l1, l2].forEach((label, i) => {
        if (!label) return;
        const s = spots[i]!;
        ops.push({
          op: 'add_text',
          text: label,
          start: r2(at + 0.3 + i * 0.25),
          duration: r2(d - 0.3 - i * 0.25),
          trackName: 'Split labels',
          animIn: 'pop',
          animOut: 'fade',
          style: { font: 'Poppins', weight: 'black', sizePct: vertical ? 3 : 4.2, color: o.color ?? '#111111', shadow: 0, box: true, boxColor: '#FFFFFF' },
          // On the card's top edge.
          transform: { x: s.x, y: r2(s.y - (naturalSize(p, [a, b][i]!)[1] * scales[i]!) / 2) },
        });
      });
      return ops;
    }
    case 'image-pop': {
      const [asset] = media(1, 'a picture or video to show (what the speaker is talking about)');
      const d = o.duration ?? 3;
      const x = o.side === 'left' ? 0.3 : o.side === 'center' ? 0.5 : 0.7;
      // Under the face, over the chest (a vertical talking video has the face in the upper half).
      return [
        {
          op: 'add_media',
          assetId: asset!,
          trackName: 'Pop-ins',
          top: true,
          start: r2(at),
          duration: r2(d),
          fit: 'contain',
          mask: { shape: 'rounded', radius: 0.1 },
          shadow: 30,
          transform: { x, y: vertical ? 0.72 : 0.62, scale: vertical ? fitScale(p, asset!, 0.5, 0.28) : fitScale(p, asset!, 0.36, 0.5), rotation: o.side === 'left' ? 4 : -4 },
          enter: { kind: 'pop', seconds: 0.35 },
          exit: { kind: 'zoom-out', seconds: 0.25 },
          loop: { kind: 'float', amount: 0.15, period: 3 },
        },
      ];
    }
  }
}
