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
  'circle-text': 'Words around a circle that slowly turns (around a round photo when assets has one, else around the middle of the frame)',
  grid: 'Two to four pictures or videos in a grid of rounded tiles on a plain background, popping in one by one (examples, results, a collection)',
  sweep: 'Big words travelling across the whole screen while they are on (direction: left, right, up or down), like a fly-through or ticker; behind the person when on the talking video',
  'follow-card': 'End card: the name or @handle big in the middle and the platforms (text: "Instagram|TikTok|YouTube") popping in one by one as pills',
} as const;
export type MomentId = keyof typeof MOMENTS;

export interface MomentOptions {
  /** When (seconds on the timeline) and for how long. */
  at: number;
  duration?: number;
  /** The words (text-behind, word-card, circle-text), the two labels "Before|After" (split), or the name or @handle (follow-card). */
  text?: string;
  /** follow-card: the platforms, "Instagram|TikTok|YouTube". */
  text2?: string;
  /** Pictures or videos of the project (split takes two). */
  assets?: string[];
  /** Colours: the text (or card words) and the card or background. */
  color?: string;
  background?: string;
  /** Where (image-pop): left, right or centre. */
  side?: 'left' | 'right' | 'center';
  /** Where the speaker is at that time (fractions of the frame), when Keo found them: pictures keep off their face. */
  person?: { x0: number; y0: number; x1: number; y1: number } | null;
  /** sweep: which way the words travel. */
  direction?: 'left' | 'right' | 'up' | 'down';
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

/** The crop that makes a picture square (its middle). */
function squareCrop(p: Project, assetId: string): { left: number; top: number; right: number; bottom: number } {
  const a = p.assets.find((x) => x.id === assetId);
  const w = a?.width || 1;
  const h = a?.height || 1;
  const side = w > h ? Math.min(0.45, (1 - h / w) / 2) : 0;
  const tb = h > w ? Math.min(0.45, (1 - w / h) / 2) : 0;
  return { left: r2(side), right: r2(side), top: r2(tb), bottom: r2(tb) };
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
          // A copy of the talking video: its sound already plays below.
          volume: 0,
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
    case 'circle-text': {
      const d = o.duration ?? 4;
      // The words repeated around the whole circle, with dots between.
      const word = words().toUpperCase();
      const ring = Array.from({ length: Math.max(1, Math.round(28 / (word.length + 3))) }, () => word).join(' • ') + ' • ';
      // The circle's radius (a share of the frame's width) sets the size of the letters.
      const radius = (vertical ? 0.33 : 0.2) * p.width;
      const px = (2 * Math.PI * radius) / (ring.length * 0.62);
      const sizePct = r2(Math.max(1.5, Math.min(9, (px / p.height) * 100)));
      const ops: EditOp[] = [];
      if (o.assets?.length) {
        const [asset] = media(1, 'a round photo for the middle');
        ops.push({ op: 'add_media', assetId: asset!, trackName: 'Circle', top: true, start: r2(at), duration: r2(d), fit: 'cover', mask: { shape: 'circle', radius: 0.5 }, transform: { x: 0.5, y: 0.45, scale: vertical ? 0.5 : 0.36 }, enter: { kind: 'zoom-in', seconds: 0.35 } });
      }
      ops.push({
        op: 'add_text',
        text: ring,
        start: r2(at),
        duration: r2(d),
        trackName: 'Circle words',
        animIn: 'fade',
        animOut: 'fade',
        style: { font: 'Montserrat', weight: 'bold', sizePct, color: o.color ?? '#FFFFFF', curve: 200, letterSpacing: 2, shadow: 10, maxWidth: 1 },
        transform: { x: 0.5, y: 0.45 },
        loop: { kind: 'spin', amount: 0.15, period: 12 },
      });
      return ops;
    }
    case 'grid': {
      const list = (o.assets ?? []).filter((a) => p.assets.some((x) => x.id === a && x.kind !== 'audio'));
      if (list.length < 2) media(2, 'two to four pictures or videos for the grid');
      const tiles = list.slice(0, 4);
      const d = o.duration ?? 3.5;
      // Two columns; one or two rows, centred.
      const rows = Math.ceil(tiles.length / 2);
      const tile = vertical ? 0.44 : 0.3;
      const cellH = (tile * p.width) / p.height;
      const ops: EditOp[] = [{ op: 'add_shape', shape: 'rect', start: r2(at), duration: r2(d), trackName: 'Grid back', style: { width: 1, height: 1, radius: 0, fill: o.background ?? '#F4F4F2' }, enter: { kind: 'fade', seconds: 0.2 } }];
      tiles.forEach((asset, i) => {
        const col = i % 2;
        const row = Math.floor(i / 2);
        const lone = tiles.length % 2 === 1 && i === tiles.length - 1;
        const sq = squareCrop(p, asset);
        ops.push({
          op: 'add_media',
          assetId: asset,
          trackName: 'Grid',
          top: true,
          start: r2(at + 0.15 * i),
          duration: r2(d - 0.15 * i),
          // A square tile: the middle of the picture, shown whole (a cropped picture keeps its size,
          // so the scale makes what is left as wide as a tile).
          fit: 'contain',
          crop: sq,
          mask: { shape: 'rounded', radius: 0.08 },
          shadow: 18,
          transform: { x: lone ? 0.5 : r2(0.5 + (col ? 1 : -1) * (tile / 2 + 0.015)), y: r2(0.5 + (row - (rows - 1) / 2) * (cellH + 0.02)), scale: r2(tile / (naturalSize(p, asset)[0] * (1 - sq.left - sq.right))) },
          enter: { kind: 'pop', seconds: 0.3 },
        });
      });
      return ops;
    }
    case 'sweep': {
      const d = o.duration ?? 2.5;
      const text = words().toUpperCase();
      const across = o.direction === 'up' || o.direction === 'down' ? false : true;
      const sizePct = vertical ? 13 : 18;
      // How wide the line is (a frame width is 1; Anton capitals are about 0.42 of their height
      // wide), so it starts and ends just off screen.
      const lineW = (text.length * 0.42 * (sizePct / 100) * p.height) / p.width;
      const lineH = (sizePct / 100) * 1.1;
      const far = across ? 1 + lineW / 2 : 1 + lineH / 2;
      const near = across ? -lineW / 2 : -lineH / 2;
      // Left and up travel from the far side to the near one; right and down the other way.
      const [from, to] = o.direction === 'right' || o.direction === 'down' ? [near, far] : [far, near];
      // On the talking video it goes behind the person, like the text-behind moment.
      const c = talkingAt(p, at);
      const ops: EditOp[] = [];
      const [behind, person] = pairNames(p, 'Behind text', 'Person cut-out');
      ops.push({
        op: 'add_text',
        text,
        start: r2(at),
        duration: r2(d),
        ...(c ? { trackName: behind } : {}),
        animIn: 'none',
        animOut: 'none',
        style: { font: 'Anton', weight: 'normal', sizePct, color: o.color ?? '#FFFFFF', uppercase: true, shadow: 0, maxWidth: Math.min(6, Math.max(1, lineW + 0.2)) },
        transform: across ? { x: r2(from), y: vertical ? 0.4 : 0.45 } : { x: 0.5, y: r2(from) },
        keys: { [across ? 'x' : 'y']: [
          { at: 0, value: r2(from), ease: 'linear' },
          { at: r2(d), value: r2(to), ease: 'linear' },
        ] },
      });
      if (c) {
        const span = Math.min(d, c.start + c.duration - at);
        const offset = (at - c.start) * c.speed;
        ops.push({ op: 'add_media', assetId: c.assetId, trackName: person, top: true, start: r2(at), in: r2(c.in + offset), duration: r2(span), fit: c.fit, transform: { ...c.transform }, cutout: true, volume: 0, ...(c.mask ? { mask: c.mask } : {}), ...(c.flipX ? { flipX: true } : {}), ...(c.color ? { color: c.color } : {}) });
      }
      return ops;
    }
    case 'follow-card': {
      const d = o.duration ?? 3;
      const handle = words();
      const platforms = (o.text2 ?? 'Instagram|TikTok|YouTube').split('|').map((s) => s.trim()).filter(Boolean).slice(0, 4);
      const ops: EditOp[] = [
        { op: 'add_shape', shape: 'rect', start: r2(at), duration: r2(d), trackName: 'Cards', style: { width: 1, height: 1, radius: 0, fill: o.background ?? '#0D0D0F' }, enter: { kind: 'fade', seconds: 0.3 } },
        {
          op: 'add_text',
          text: handle,
          start: r2(at + 0.1),
          duration: r2(d - 0.1),
          trackName: 'Card words',
          animIn: 'pop',
          animOut: 'none',
          animSeconds: 0.3,
          style: { font: 'Montserrat', weight: 'black', sizePct: vertical ? 5.5 : 8, color: o.color ?? '#FFFFFF', shadow: 0, maxWidth: 0.9 },
          transform: { x: 0.5, y: 0.42 },
        },
      ];
      const gap = vertical ? 0.07 : 0.1;
      platforms.forEach((name, i) =>
        ops.push({
          op: 'add_text',
          text: name,
          start: r2(at + 0.45 + i * 0.25),
          duration: r2(d - 0.45 - i * 0.25),
          trackName: 'Card words',
          animIn: 'pop',
          animOut: 'none',
          animSeconds: 0.2,
          style: { font: 'Poppins', weight: 'bold', sizePct: vertical ? 3.4 : 4.6, color: '#111111', shadow: 0, box: true, boxColor: o.color ?? '#FFFFFF' },
          transform: { x: 0.5, y: r2(0.54 + i * gap) },
        }),
      );
      return ops;
    }
    case 'image-pop': {
      const [asset] = media(1, 'a picture or video to show (what the speaker is talking about)');
      const d = o.duration ?? 3;
      const x = o.side === 'left' ? 0.3 : o.side === 'center' ? 0.5 : 0.7;
      // Where it goes: under the face, over the chest (a vertical talking video has the face in
      // the upper half), or, when Keo found the speaker, the bigger free space below their face or
      // above their head.
      let y = vertical ? 0.72 : 0.62;
      let room = vertical ? 0.28 : 0.5;
      if (o.person) {
        const faceBottom = o.person.y0 + (o.person.y1 - o.person.y0) * 0.32;
        const below = 0.88 - faceBottom;
        const above = o.person.y0 - 0.06;
        const [lo, hi] = below >= above ? [faceBottom + 0.02, 0.88] : [0.06, o.person.y0 - 0.01];
        room = Math.max(0.12, Math.min(room, (hi - lo) * 0.9));
        y = r2((lo + hi) / 2);
      }
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
          transform: { x, y, scale: vertical ? fitScale(p, asset!, 0.5, room) : fitScale(p, asset!, 0.36, room), rotation: o.side === 'left' ? 4 : -4 },
          enter: { kind: 'pop', seconds: 0.35 },
          exit: { kind: 'zoom-out', seconds: 0.25 },
          loop: { kind: 'float', amount: 0.15, period: 3 },
        },
      ];
    }
  }
}

/** A moment Keo saw in a template: when (seconds into the template) and what it needs. */
export interface TemplateMoment {
  at: number;
  moment: MomentId;
  /** What the clip should show, in the user's terms (split and image-pop): "a photo of the product". */
  needs?: string;
}

const STOP_WORDS = new Set('the a an and or but so to of in on at for with is are was were be it this that you i we they my your our'.split(' '));
const plain = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');

/**
 * A template's moments on the user's video: each at the same point of the story (scaled to the
 * talking video's length), with words from what the user says there (never the template's own
 * words). Moments that need a picture or video come back as questions for the user.
 */
export function placeMoments(
  moments: TemplateMoment[],
  templateSeconds: number,
  main: { start: number; duration: number },
  words: Array<{ text: string; start: number; end: number }>,
): { place: Array<{ moment: MomentId; at: number; text?: string }>; ask: Array<{ moment: MomentId; at: number; needs: string }>; skipped: number } {
  const place: Array<{ moment: MomentId; at: number; text?: string }> = [];
  const ask: Array<{ moment: MomentId; at: number; needs: string }> = [];
  let skipped = 0;
  const scale = templateSeconds > 0 ? main.duration / templateSeconds : 1;
  const used = new Set<string>();
  for (const m of [...moments].sort((a, b) => a.at - b.at)) {
    const at = r2(Math.min(main.start + main.duration - 0.5, main.start + m.at * scale));
    if (at < main.start) continue;
    // The end card carries the user's own name (from their brand kit), not words they said.
    if (m.moment === 'follow-card') {
      place.push({ moment: m.moment, at });
      continue;
    }
    if (m.moment === 'split' || m.moment === 'image-pop') {
      ask.push({ moment: m.moment, at, needs: m.needs ?? (m.moment === 'split' ? 'two pictures or videos to compare' : 'a picture or video of what you are talking about') });
      continue;
    }
    // The strongest word said around then: the longest one not used yet.
    const near = words.filter((w) => w.start >= at - 2 && w.start <= at + 2.5 && !STOP_WORDS.has(plain(w.text)) && !used.has(plain(w.text)) && plain(w.text).length >= 3);
    const best = near.sort((a, b) => plain(b.text).length - plain(a.text).length || Math.abs(a.start - at) - Math.abs(b.start - at))[0];
    if (!best) {
      skipped++;
      continue;
    }
    used.add(plain(best.text));
    // On the word itself, so it lands as it is said.
    place.push({ moment: m.moment, at: r2(best.start), text: best.text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') });
  }
  return { place, ask, skipped };
}
