import { z } from 'zod';
import type { EditOp, Key, Project } from './studio';

/**
 * Screen showcase: a premium product walkthrough made from app screenshots, the way motion
 * designers make them. Each screen flies in as a glass panel turning in 3D on a living backdrop,
 * settles while a kinetic headline says what it is, drifts with a slow push, and swings away into
 * the next. A sample clip (an AI video, a clone) floats out beside the screen it belongs to. The
 * narration (Keo's voice) sets each scene's length; captions follow it.
 */

export const ShowcaseScene = z
  .object({
    /** The screenshot (a picture of the project). */
    screen: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/),
    /** The big words for this screen (2–6 words). */
    headline: z.string().trim().min(1).max(60),
    /** A small line above it (a kicker, e.g. "Keo Studio"). */
    kicker: z.string().trim().max(40).optional(),
    /** What the voice says during this screen (one or two sentences). */
    narration: z.string().trim().max(400).default(''),
    /** A clip of the project that floats beside the screen (an AI video, a clone…). */
    clip: z.string().regex(/^as_[A-Za-z0-9]{4,24}$/).optional(),
  })
  .strict();
export type ShowcaseScene = z.infer<typeof ShowcaseScene>;

export const SHOWCASE_TRACKS = { back: 'Showcase backdrop', screens: 'Screens', floating: 'Floating clips', titles: 'Showcase titles' } as const;

const r2 = (n: number) => Math.round(n * 100) / 100;
const k = (at: number, value: number, ease: Key['ease'] = 'in-out'): Key => ({ at: r2(at), value: r2(value), ease });

/**
 * The edit: `seconds` is each scene's length (from its narration). Screens are fitted whole and
 * sized for the frame; the backdrop and titles take the accent colours.
 */
export function showcaseOps(
  p: Project,
  scenes: Array<ShowcaseScene & { seconds: number }>,
  o: { accent?: string; accent2?: string; look?: 'dark' | 'light'; end?: { line: string; handle?: string } | null; whoosh?: string | null } = {},
): { ops: EditOp[]; duration: number; starts: number[] } {
  const vertical = p.height > p.width;
  const accent = o.accent ?? '#8B6BFF';
  const accent2 = o.accent2 ?? '#5FD4FF';
  const dark = (o.look ?? 'dark') === 'dark';
  const ops: EditOp[] = [];
  const cleared: EditOp[] = [];
  // Its own tracks, made again each time (a second showcase replaces the first).
  for (const name of Object.values(SHOWCASE_TRACKS)) if (p.tracks.some((t) => t.name === name)) cleared.push({ op: 'delete_track', track: p.tracks.find((t) => t.name === name)!.id });
  const starts: number[] = [];
  let t = 0;
  scenes.forEach((s, i) => {
    starts.push(r2(t));
    const d = Math.max(3.2, s.seconds);
    const dir = i % 2 === 0 ? 1 : -1;
    const a = p.assets.find((x) => x.id === s.screen);
    // A screenshot fitted whole: wide screens fill most of a tall frame's width.
    const wide = a ? a.width / Math.max(1, a.height) : 16 / 9;
    const S = vertical ? (wide > 1 ? 0.94 : 0.66) : wide > 1 ? 0.76 : 0.52;
    const y = vertical ? (s.clip ? 0.38 : 0.44) : 0.53;
    ops.push({
      op: 'add_media',
      assetId: s.screen,
      trackName: SHOWCASE_TRACKS.screens,
      start: r2(t),
      duration: r2(d),
      fit: 'contain',
      mask: { shape: 'rounded', radius: 0.035 },
      glass: true,
      shadow: 30,
      volume: 0,
      transform: { x: 0.5, y, scale: S },
      keys: {
        // Flies in turned away, settles almost square, drifts, then swings out the other way.
        tiltY: [k(0, dir * 58, 'out'), k(0.85, dir * 15, 'out'), k(d - 0.45, dir * -7), k(d, dir * -48, 'in')],
        tiltX: [k(0, 24, 'out'), k(0.85, 9, 'out'), k(d, 5)],
        scale: [k(0, S * 0.55, 'out'), k(0.85, S, 'out'), k(d - 0.45, S * 1.06), k(d, S * 0.86, 'in')],
        x: [k(0, 0.5 + dir * 0.3, 'out'), k(0.85, 0.5, 'out'), k(d - 0.45, 0.5 - dir * 0.025), k(d, 0.5 - dir * 0.32, 'in')],
        opacity: [k(0, 0), k(0.3, 1, 'out'), k(d - 0.25, 1), k(d, 0, 'in')],
      },
    });
    // The headline: a kicker and big words above the screen.
    ops.push({
      op: 'add_motion',
      piece: 'headline',
      text: s.headline,
      ...(s.kicker ? { sub: s.kicker } : {}),
      accent,
      accent2,
      color: dark ? '#FFFFFF' : '#111111',
      font: 'Poppins',
      trackName: SHOWCASE_TRACKS.titles,
      start: r2(t + 0.3),
      duration: r2(Math.max(1.6, d - 0.55)),
      place: 'auto',
      transform: { x: 0.5, y: vertical ? 0.15 : 0.13, scale: vertical ? 1 : 0.8 },
    });
    // A sample clip floats out beside its screen, turned towards it.
    if (s.clip) {
      const c = p.assets.find((x) => x.id === s.clip);
      const tall = c ? c.height > c.width : true;
      const cs = vertical ? (tall ? 0.44 : 0.62) : tall ? 0.46 : 0.42;
      const len = Math.max(1.5, Math.min(d - 1.1, c && c.kind === 'video' ? c.duration : d));
      ops.push({
        op: 'add_media',
        assetId: s.clip,
        trackName: SHOWCASE_TRACKS.floating,
        start: r2(t + 0.8),
        duration: r2(len),
        fit: 'contain',
        mask: { shape: 'rounded', radius: 0.06 },
        glass: true,
        shadow: 30,
        volume: 0,
        transform: { x: vertical ? 0.69 : 0.78, y: vertical ? 0.66 : 0.6, scale: cs },
        keys: {
          tiltY: [k(0, -dir * 40, 'out'), k(0.7, -dir * 16, 'out'), k(len, -dir * 9)],
          tiltX: [k(0, 16, 'out'), k(0.7, 6, 'out')],
          scale: [k(0, cs * 0.5, 'back'), k(0.7, cs, 'out'), k(len, cs * 1.04)],
          opacity: [k(0, 0), k(0.25, 1, 'out'), k(len - 0.25, 1), k(len, 0, 'in')],
        },
        loop: { kind: 'float', amount: 0.25, period: 4 },
      });
    }
    if (o.whoosh && i > 0) ops.push({ op: 'add_audio', assetId: o.whoosh, trackName: 'Effects', start: r2(Math.max(0, t - 0.15)), volume: 0.3 });
    t += d;
  });
  // The end: the line and the handle on the backdrop.
  if (o.end) {
    ops.push({ op: 'add_motion', piece: 'headline', text: o.end.line, ...(o.end.handle ? { sub: o.end.handle } : {}), accent, accent2, color: dark ? '#FFFFFF' : '#111111', font: 'Poppins', trackName: SHOWCASE_TRACKS.titles, start: r2(t + 0.1), duration: 2.6, place: 'auto', transform: { x: 0.5, y: 0.47, scale: 1.15 } });
    t += 2.8;
  }
  // A living backdrop under everything, for the whole length.
  ops.unshift(...cleared, { op: 'add_motion', piece: 'backdrop', text: '-', accent, accent2, background: dark ? '#07070C' : '#F3F1EC', trackName: SHOWCASE_TRACKS.back, start: 0, duration: r2(t), place: 'auto' });
  // The backdrop under everything else.
  ops.push({ op: 'set_track', trackName: SHOWCASE_TRACKS.back, position: 'bottom' });
  return { ops, duration: r2(t), starts };
}
