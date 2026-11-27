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

export const CutawayStyle = z.enum(['pop', 'slide', 'rise', 'tilt', 'corner', 'full']);
export type CutawayStyle = z.infer<typeof CutawayStyle>;

export const CutawayMoment = z
  .object({
    /** The picture or video of the project to show. */
    asset: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/),
    /** When it comes in (timeline seconds): when the words are about it. */
    at: z.number().min(0).max(36000),
    /** How long it stays (default: about 3.5 s for a picture, the clip's length up to 6 s for a video). */
    seconds: z.number().min(1).max(30).optional(),
    /** How it moves in and out. */
    style: CutawayStyle.optional(),
    /** Where it sits: beside the speaker (left or right) or in the middle. */
    side: z.enum(['left', 'right', 'center']).optional(),
    /** The glass finish (a sheen, a bright edge, a reflection). Default on. */
    glass: z.boolean().optional(),
    /** Play the clip's own sound (a video), under the voice. Default off. */
    sound: z.boolean().optional(),
  })
  .strict();
export type CutawayMoment = z.infer<typeof CutawayMoment>;

const r2 = (n: number) => Math.round(n * 100) / 100;
const k = (at: number, value: number, ease: Key['ease'] = 'in-out'): Key => ({ at: r2(Math.max(0, at)), value: r2(value), ease });
const STYLES: CutawayStyle[] = ['pop', 'slide', 'tilt', 'rise'];

/** The edit for the moments: one glass card each on the Cutaways track (made again each time). */
export function cutawayOps(p: Project, moments: CutawayMoment[], o: { whoosh?: string | null } = {}): { ops: EditOp[]; placed: Array<{ asset: string; at: number; seconds: number; style: CutawayStyle; side: string }> } {
  const vertical = p.height > p.width;
  const ops: EditOp[] = [];
  const old = p.tracks.find((t) => t.name === CUTAWAY_TRACK);
  if (old) ops.push({ op: 'delete_track', track: old.id });
  const placed: Array<{ asset: string; at: number; seconds: number; style: CutawayStyle; side: string }> = [];
  const sorted = [...moments].sort((a, b) => a.at - b.at);
  let lastEnd = -1;
  sorted.forEach((m, i) => {
    const a = p.assets.find((x) => x.id === m.asset);
    if (!a || a.kind === 'audio') return;
    const video = a.kind === 'video';
    let d = m.seconds ?? (video ? Math.min(6, Math.max(2.5, a.duration || 4)) : 3.5);
    let at = Math.max(0, m.at);
    // Never two cards at once: a card waits for the one before it to leave.
    if (at < lastEnd + 0.1) at = lastEnd + 0.1;
    if (video && a.duration) d = Math.min(d, a.duration);
    d = Math.max(1.2, d);
    const style = m.style ?? STYLES[i % STYLES.length]!;
    const side = m.side ?? (style === 'full' ? 'center' : vertical ? 'center' : i % 2 === 0 ? 'right' : 'left');
    const dir = side === 'left' ? -1 : 1;
    const wide = a.width / Math.max(1, a.height);
    // Sized for the frame: beside the speaker in a wide video, over the lower middle in a tall one.
    let S = style === 'full' ? (vertical ? 0.9 : wide > 1 ? 0.8 : 0.56) : style === 'corner' ? (vertical ? 0.42 : 0.26) : vertical ? (wide > 1 ? 0.84 : 0.56) : wide > 1 ? 0.46 : 0.32;
    S = r2(S);
    const x = style === 'full' || side === 'center' ? 0.5 : style === 'corner' ? (side === 'left' ? 0.2 : 0.8) : side === 'left' ? 0.27 : 0.73;
    const y = style === 'corner' ? (vertical ? 0.22 : 0.24) : vertical ? (style === 'full' ? 0.45 : 0.62) : 0.5;
    const inT = 0.5;
    const outT = 0.4;
    const keys: Record<string, Key[]> = { opacity: [k(0, 0), k(0.22, 1, 'out'), k(d - outT * 0.6, 1), k(d, 0, 'in')] };
    if (style === 'pop' || style === 'corner') {
      keys.scale = [k(0, S * 0.35, 'back'), k(inT, S, 'back'), k(d - outT, S * 1.03), k(d, S * 0.6, 'in')];
      keys.tiltY = [k(0, dir * -14, 'out'), k(inT, dir * -6, 'out'), k(d, dir * -3)];
    } else if (style === 'slide') {
      const from = side === 'center' ? 0.5 + 0.7 : x + dir * 0.7;
      keys.x = [k(0, from, 'out'), k(inT + 0.1, x, 'out'), k(d - outT, x - dir * 0.015), k(d, from, 'in')];
      keys.tiltY = [k(0, dir * -38, 'out'), k(inT + 0.1, dir * -9, 'out'), k(d - outT, dir * -5), k(d, dir * -36, 'in')];
      keys.scale = [k(0, S * 0.92), k(inT, S, 'out'), k(d, S * 1.04)];
    } else if (style === 'rise') {
      keys.y = [k(0, y + 0.45, 'out'), k(inT + 0.1, y, 'out'), k(d - outT, y - 0.01), k(d, y + 0.45, 'in')];
      keys.tiltX = [k(0, 34, 'out'), k(inT + 0.1, 8, 'out'), k(d - outT, 5), k(d, 30, 'in')];
      keys.scale = [k(0, S * 0.9), k(inT, S, 'out'), k(d, S * 1.03)];
    } else if (style === 'tilt') {
      keys.tiltY = [k(0, dir * -55, 'out'), k(inT + 0.25, dir * -14, 'out'), k(d - outT, dir * -8), k(d, dir * 45, 'in')];
      keys.tiltX = [k(0, 20, 'out'), k(inT + 0.25, 7, 'out'), k(d, 4)];
      keys.scale = [k(0, S * 0.6, 'out'), k(inT + 0.25, S, 'out'), k(d - outT, S * 1.05), k(d, S * 0.8, 'in')];
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
      ...(style === 'corner' || style === 'pop' ? { loop: { kind: 'float' as const, amount: 0.2, period: 4 } } : {}),
    });
    if (o.whoosh) ops.push({ op: 'add_audio', assetId: o.whoosh, trackName: 'Effects', start: r2(Math.max(0, at - 0.12)), volume: 0.22 });
    placed.push({ asset: a.id, at: r2(at), seconds: r2(d), style, side });
    lastEnd = at + d;
  });
  // The cards above the talking video (and above captions' track is left to the user's layout).
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
