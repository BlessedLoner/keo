import { z } from 'zod';
import type { EditOp, Key, Project } from './studio';
import { timelineWords } from './studio';

/**
 * Talk-matched cutaways: while the user talks (a podcast, a talking-head explainer), the screenshots,
 * pictures and clips they added come in at the moment their words are about them — as glass cards
 * that pop, slide or rise in, float a little while they are spoken about, then leave the way they
 * came. The talking video stays underneath, whole. Keo picks the moments from the words (or the user
 * names them); every card is an ordinary clip on its own track, so it can be moved or restyled.
 */

export const CUTAWAY_TRACK = 'Cutaways';

export const CutawayStyle = z.enum(['pop', 'slide', 'rise', 'tilt', 'wipe', 'iris', 'corner', 'full']);
export type CutawayStyle = z.infer<typeof CutawayStyle>;

export const CutawayMoment = z
  .object({
    /** The picture or video of the project to show. */
    asset: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/),
    /** When it comes in (timeline seconds): when the words are about it. */
    at: z.number().min(0).max(36000),
    /** How long it stays (default: about 3.5 s for a picture, the clip's length up to 6 s for a video). */
    seconds: z.number().min(1).max(30).optional(),
    /** How it comes in and goes out: pop, slide, rise, tilt (3D), wipe or iris (revealed through a moving edge or a growing circle), corner (small), full (takes the stage). */
    style: CutawayStyle.optional(),
    /** Where it sits when there is a choice (the speaker's free side is used otherwise). */
    side: z.enum(['left', 'right', 'center']).optional(),
    /** The glass finish (a sheen, a bright edge, a reflection). Default on. */
    glass: z.boolean().optional(),
    /** Play the clip's own sound (a video), under the voice. Default off. */
    sound: z.boolean().optional(),
  })
  .strict();
export type CutawayMoment = z.infer<typeof CutawayMoment>;

/** Where the speaker is in the frame at a time (fractions of the frame), measured on this PC. */
export type CutawayPerson = { t: number; box: { x0: number; y0: number; x1: number; y1: number } | null };

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const k = (at: number, value: number, ease: Key['ease'] = 'in-out'): Key => ({ at: r2(Math.max(0, at)), value: r3(value), ease });
const STYLES: CutawayStyle[] = ['pop', 'slide', 'wipe', 'tilt', 'iris', 'rise'];
const MARGIN = 0.045;

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** The speaker nearest a time (within 6 s), or null. */
function personAt(people: CutawayPerson[] | undefined, t: number): Rect | null {
  let best: { d: number; box: Rect | null } | null = null;
  for (const x of people ?? []) {
    const d = Math.abs(x.t - t);
    if (d < 6 && (!best || d < best.d)) best = { d, box: x.box };
  }
  return best?.box ?? null;
}

/** The band the captions take at a time (top and bottom, fractions of the frame), or null. */
function captionBand(p: Project, from: number, to: number): { y0: number; y1: number } | null {
  const ys: number[] = [];
  for (const t of p.tracks) {
    if (!/caption/i.test(t.name) || t.hidden) continue;
    for (const c of t.clips) if (c.start < to && c.start + c.duration > from && 'transform' in c) ys.push(c.transform.y);
  }
  if (!ys.length) return null;
  const y = ys.sort((a, b) => a - b)[Math.floor(ys.length / 2)]!;
  return { y0: Math.max(0, y - 0.07), y1: Math.min(1, y + 0.07) };
}

/** The scale at which a picture of aspect `ar`, fitted whole, fills at most 90% of a free area. */
function fitScale(p: Project, ar: number, r: Rect): number {
  const W = p.width;
  const H = p.height;
  const fw = Math.max(0, r.x1 - r.x0);
  const fh = Math.max(0, r.y1 - r.y0);
  // Fitted whole ("contain") at scale s, the picture is s·min(W, H·ar) wide and s·min(W/ar, H) tall.
  return Math.min((fw * W * 0.9) / Math.min(W, H * ar), (fh * H * 0.9) / Math.min(W / ar, H));
}

/** The free areas of the frame at a moment: beside the speaker (wide) or above and below the face (tall), minus the captions. */
function freeAreas(p: Project, person: Rect | null, band: { y0: number; y1: number } | null): Rect[] {
  const vertical = p.height > p.width;
  const out: Rect[] = [];
  if (!vertical) {
    if (person) {
      out.push({ x0: MARGIN, y0: MARGIN, x1: person.x0 - 0.025, y1: 1 - MARGIN });
      out.push({ x0: person.x1 + 0.025, y0: MARGIN, x1: 1 - MARGIN, y1: 1 - MARGIN });
    } else {
      out.push({ x0: 0.52, y0: MARGIN, x1: 1 - MARGIN, y1: 1 - MARGIN }, { x0: MARGIN, y0: MARGIN, x1: 0.48, y1: 1 - MARGIN });
    }
  } else if (person) {
    const faceBottom = person.y0 + (person.y1 - person.y0) * 0.45;
    out.push({ x0: MARGIN, y0: MARGIN, x1: 1 - MARGIN, y1: person.y0 - 0.02 });
    out.push({ x0: MARGIN, y0: faceBottom + 0.02, x1: 1 - MARGIN, y1: 1 - MARGIN });
  } else {
    out.push({ x0: MARGIN, y0: 0.5, x1: 1 - MARGIN, y1: 0.93 }, { x0: MARGIN, y0: 0.07, x1: 1 - MARGIN, y1: 0.42 });
  }
  if (!band) return out.filter((r) => r.x1 - r.x0 > 0.12 && r.y1 - r.y0 > 0.12);
  // Captions cross an area: keep the bigger part above or below them.
  return out
    .map((r) => {
      if (band.y1 <= r.y0 || band.y0 >= r.y1) return r;
      const above = { ...r, y1: Math.min(r.y1, band.y0 - 0.01) };
      const below = { ...r, y0: Math.max(r.y0, band.y1 + 0.01) };
      return above.y1 - above.y0 >= below.y1 - below.y0 ? above : below;
    })
    .filter((r) => r.x1 - r.x0 > 0.12 && r.y1 - r.y0 > 0.12);
}

/** Where a card goes and how big: the free area where it can be biggest (the side asked for when it fits). */
function placeCard(p: Project, ar: number, style: CutawayStyle, side: CutawayMoment['side'], person: Rect | null, band: { y0: number; y1: number } | null): { x: number; y: number; S: number } {
  const vertical = p.height > p.width;
  if (style === 'full') {
    // The stage: the picture big in the middle (over the speaker on purpose, for a reveal).
    const S = Math.min(0.9, fitScale(p, ar, { x0: 0.05, y0: 0.06, x1: 0.95, y1: band ? band.y0 - 0.01 : 0.94 }));
    return { x: 0.5, y: band ? r3((0.06 + band.y0) / 2) : 0.5, S: r3(Math.max(0.3, S)) };
  }
  let areas = freeAreas(p, person, band);
  // A side asked for is kept when the card fits there nearly as big as on the roomier side.
  if (side && side !== 'center' && !vertical) {
    const wanted = areas.filter((r) => (side === 'left' ? r.x1 <= 0.55 : r.x0 >= 0.45));
    const most = Math.max(0, ...areas.map((r) => fitScale(p, ar, r)));
    if (wanted.length && fitScale(p, ar, wanted[0]!) >= 0.8 * most) areas = wanted;
  }
  let best: { r: Rect; s: number } | null = null;
  for (const r of areas) {
    const s = fitScale(p, ar, r);
    if (!best || s > best.s) best = { r, s };
  }
  if (!best || best.s < 0.16) {
    // Nowhere free enough: a small card in the top corner away from the speaker.
    const right = !person || (person.x0 + person.x1) / 2 < 0.5;
    const S = vertical ? 0.4 : 0.24;
    return { x: right ? 1 - MARGIN - S / 2 : MARGIN + S / 2, y: vertical ? 0.16 : 0.2, S };
  }
  // Not too big beside a speaker (it should feel like a card, not a new shot), nor too small to read.
  const cap = style === 'corner' ? (vertical ? 0.42 : 0.26) : vertical ? 0.86 : 0.5;
  const S = Math.max(0.2, Math.min(cap, best.s));
  const r = best.r;
  // In the middle of its area; a corner card sits in the area's top outer corner.
  if (style === 'corner') {
    const right = (r.x0 + r.x1) / 2 >= 0.5;
    const half = (S * Math.min(p.width, p.height * ar)) / p.width / 2;
    return { x: r3(right ? r.x1 - half : r.x0 + half), y: r3(r.y0 + (S * Math.min(p.width / ar, p.height)) / p.height / 2 + 0.01), S: r3(S) };
  }
  return { x: r3((r.x0 + r.x1) / 2), y: r3((r.y0 + r.y1) / 2), S: r3(S) };
}

/** The edit for the moments: one glass card each on the Cutaways track (made again each time). */
export function cutawayOps(
  p: Project,
  moments: CutawayMoment[],
  o: { whoosh?: string | null; people?: CutawayPerson[] } = {},
): { ops: EditOp[]; placed: Array<{ asset: string; at: number; seconds: number; style: CutawayStyle; side: string; x: number; y: number; scale: number }> } {
  const vertical = p.height > p.width;
  const ops: EditOp[] = [];
  const old = p.tracks.find((t) => t.name === CUTAWAY_TRACK);
  if (old) ops.push({ op: 'delete_track', track: old.id });
  const placed: Array<{ asset: string; at: number; seconds: number; style: CutawayStyle; side: string; x: number; y: number; scale: number }> = [];
  const sorted = [...moments].sort((a, b) => a.at - b.at);
  let lastEnd = -1;
  sorted.forEach((m, i) => {
    const a = p.assets.find((x) => x.id === m.asset);
    if (!a || a.kind === 'audio') return;
    const video = a.kind === 'video';
    let d = m.seconds ?? (video ? Math.min(6, Math.max(2.5, a.duration || 4)) : 3.5);
    let at = Math.max(0, m.at);
    // Never two cards at once: a card waits for the one before it to leave.
    if (at < lastEnd + 0.15) at = lastEnd + 0.15;
    if (video && a.duration) d = Math.min(d, a.duration);
    d = Math.max(1.2, d);
    let style = m.style ?? STYLES[i % STYLES.length]!;
    const ar = a.width && a.height ? a.width / a.height : 16 / 9;
    const person = personAt(o.people, at + Math.min(1, d / 2));
    const band = captionBand(p, at, at + d);
    let spot = placeCard(p, ar, style, m.side, person, band);
    // Too small to read beside the speaker (a phone screenshot in a tall video): it takes the stage
    // for its moment instead, above the captions, unless a style was asked for.
    const area = ((spot.S * Math.min(p.width, p.height * ar)) / p.width) * ((spot.S * Math.min(p.width / ar, p.height)) / p.height);
    if (!m.style && style !== 'corner' && area < (vertical ? 0.09 : 0.035)) {
      style = 'full';
      spot = placeCard(p, ar, style, m.side, person, band);
    }
    const { x, y, S } = spot;
    // It comes from (and leaves to) the side it sits on.
    const dir = x >= 0.5 ? 1 : -1;
    const inT = 0.5;
    const outT = 0.4;
    const keys: Record<string, Key[]> = {};
    let enter: { kind: 'wipe-left' | 'wipe-right' | 'iris'; seconds: number } | undefined;
    let exit: typeof enter;
    if (style !== 'wipe' && style !== 'iris') keys.opacity = [k(0, 0), k(0.22, 1, 'out'), k(d - outT * 0.6, 1), k(d, 0, 'in')];
    if (style === 'pop' || style === 'corner') {
      keys.scale = [k(0, S * 0.35, 'back'), k(inT, S, 'back'), k(d - outT, S * 1.03), k(d, S * 0.6, 'in')];
      keys.tiltY = [k(0, dir * -14, 'out'), k(inT, dir * -6, 'out'), k(d, dir * -3)];
    } else if (style === 'slide') {
      const from = x + dir * (vertical ? 0.9 : 0.6);
      keys.x = [k(0, from, 'out'), k(inT + 0.1, x, 'out'), k(d - outT, x - dir * 0.012), k(d, from, 'in')];
      keys.tiltY = [k(0, dir * -38, 'out'), k(inT + 0.1, dir * -9, 'out'), k(d - outT, dir * -5), k(d, dir * -36, 'in')];
      keys.scale = [k(0, S * 0.92), k(inT, S, 'out'), k(d, S * 1.03)];
    } else if (style === 'rise') {
      keys.y = [k(0, y + 0.4, 'out'), k(inT + 0.1, y, 'out'), k(d - outT, y - 0.008), k(d, y + 0.4, 'in')];
      keys.tiltX = [k(0, 34, 'out'), k(inT + 0.1, 8, 'out'), k(d - outT, 5), k(d, 30, 'in')];
      keys.scale = [k(0, S * 0.9), k(inT, S, 'out'), k(d, S * 1.03)];
    } else if (style === 'tilt') {
      keys.tiltY = [k(0, dir * -55, 'out'), k(inT + 0.25, dir * -14, 'out'), k(d - outT, dir * -8), k(d, dir * 45, 'in')];
      keys.tiltX = [k(0, 20, 'out'), k(inT + 0.25, 7, 'out'), k(d, 4)];
      keys.scale = [k(0, S * 0.6, 'out'), k(inT + 0.25, S, 'out'), k(d - outT, S * 1.05), k(d, S * 0.8, 'in')];
    } else if (style === 'wipe') {
      // Revealed by a moving edge from the speaker's side, a slow push, then wiped away the same way.
      enter = { kind: dir > 0 ? 'wipe-left' : 'wipe-right', seconds: 0.55 };
      exit = { kind: dir > 0 ? 'wipe-right' : 'wipe-left', seconds: 0.4 };
      keys.scale = [k(0, S * 0.97, 'out'), k(d, S * 1.04)];
      keys.tiltY = [k(0, dir * -6), k(d, dir * -2)];
    } else if (style === 'iris') {
      // Opens from a circle in its middle and closes back into it.
      enter = { kind: 'iris', seconds: 0.6 };
      exit = { kind: 'iris', seconds: 0.45 };
      keys.scale = [k(0, S * 1.06, 'out'), k(0.8, S, 'out'), k(d, S * 1.02)];
    } else {
      // full: the picture takes the stage, with a slow push.
      keys.scale = [k(0, S * 0.8, 'out'), k(inT, S, 'out'), k(d - outT, S * 1.05), k(d, S * 0.92, 'in')];
      keys.tiltX = [k(0, 12, 'out'), k(inT, 4, 'out'), k(d, 2)];
    }
    ops.push({
      op: 'add_media',
      assetId: a.id,
      trackName: CUTAWAY_TRACK,
      start: r2(at),
      duration: r2(d),
      ...(video ? { in: 0 } : {}),
      fit: 'contain',
      mask: { shape: 'rounded', radius: style === 'corner' ? 0.08 : 0.05 },
      ...(m.glass === false ? {} : { glass: true }),
      shadow: 30,
      volume: video && m.sound ? 0.5 : 0,
      transform: { x, y, scale: S },
      keys,
      ...(enter ? { enter } : {}),
      ...(exit ? { exit } : {}),
      ...(style === 'corner' || style === 'pop' ? { loop: { kind: 'float' as const, amount: 0.18, period: 4 } } : {}),
    });
    if (o.whoosh) ops.push({ op: 'add_audio', assetId: o.whoosh, trackName: 'Effects', start: r2(Math.max(0, at - 0.12)), volume: 0.22 });
    placed.push({ asset: a.id, at: r2(at), seconds: r2(d), style, side: x > 0.55 ? 'right' : x < 0.45 ? 'left' : 'center', x, y, scale: S });
    lastEnd = at + d;
  });
  // The cards above everything else (over the talking video and its captions' track).
  if (ops.some((x) => x.op === 'add_media')) ops.push({ op: 'set_track', trackName: CUTAWAY_TRACK, position: 'top' });
  return { ops, placed };
}

const STOP = new Set('the a an and or but of to in on at for with this that these those is are was were be been it its i you we they he she my your our their me us them so as from by about into than then there here what which who how when where why just also very really can will would could should do does did have has had not no yes like get got make made'.split(' '));
const stem = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]/gu, '').replace(/(ing|ed|es|s)$/u, '');

/**
 * Where each picture or clip belongs in the talk: the moment the spoken words best match what it
 * shows (its note from studio__understand_media, else its file name). Ones that match nothing are
 * spread over the parts of the talk that are not taken yet. Needs the talk transcribed.
 */
export function matchCutaways(p: Project, assetIds: string[]): Array<{ asset: string; at: number; why: string }> {
  const words = timelineWords(p);
  if (!words.length) return [];
  const total = words[words.length - 1]!.end;
  const keyWords = (s: string) => new Set(s.split(/[\s_\-.,;:!?()[\]"'/]+/).map(stem).filter((w) => w.length > 2 && !STOP.has(w)));
  const out: Array<{ asset: string; at: number; why: string }> = [];
  const taken: number[] = [];
  const leftOver: string[] = [];
  for (const id of assetIds) {
    const a = p.assets.find((x) => x.id === id);
    if (!a || a.kind === 'audio') continue;
    const want = keyWords(`${a.about ?? ''} ${a.name.replace(/\.[a-z0-9]+$/i, '')}`);
    if (!want.size) {
      leftOver.push(id);
      continue;
    }
    // A sliding window of ~8 words: the place where most of the asset's words are said.
    let best = { score: 0, at: 0, hit: '' };
    for (let i = 0; i < words.length; i++) {
      const win = words.slice(i, i + 8);
      const hits = new Set(win.map((w) => stem(w.text)).filter((w) => want.has(w)));
      const near = taken.some((t) => Math.abs(t - words[i]!.start) < 3);
      const score = hits.size - (near ? 0.5 : 0);
      if (score > best.score) best = { score, at: words[i]!.start, hit: [...hits].join(', ') };
    }
    if (best.score >= 1) {
      out.push({ asset: id, at: r2(best.at), why: `the words “${best.hit}”` });
      taken.push(best.at);
    } else leftOver.push(id);
  }
  // The rest: evenly over the talk, away from the ones already placed (and not in the first 2 s).
  leftOver.forEach((id, i) => {
    let at = 2 + ((total - 4) * (i + 1)) / (leftOver.length + 1);
    for (let guard = 0; guard < 20 && taken.some((t) => Math.abs(t - at) < 4); guard++) at += 1.5;
    at = Math.min(Math.max(0, total - 3), at);
    out.push({ asset: id, at: r2(at), why: 'no matching words; spread over the talk' });
    taken.push(at);
  });
  return out.sort((a, b) => a.at - b.at);
}
