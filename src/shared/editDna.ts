/**
 * Keo Studio — EDIT DNA.
 *
 * A blueprint is the editing structure of a reference video, measured and reconstructed: its shots
 * (timing, role, how each one is entered, the camera move, speed and colour), the text on screen,
 * motion graphics, effects, and the audio's beat and timing. It never holds the reference's footage,
 * music or file paths — only the editing — so it can be reused on anyone's clips. The interpreter
 * turns a blueprint plus the user's clips into ordinary Studio edit operations: everything stays
 * editable on the timeline (one undo step).
 *
 * The format is versioned (schema) and every element has a stable id. Each element records how
 * sure the measurement is and the report says, element by element, what Keo reproduces natively,
 * what it approximates and what it cannot reproduce yet.
 */
import { z } from 'zod';
import { ColorGrade, Cut, Effects, KEO_FONTS, MOTION_PIECES, SpeedPoint, TextAnimIn, TextAnimOut, TRANSITIONS, type EditOp, type Project, type Zoom } from './studio';
import { DnaStyle } from './editDnaStyle';

export const EDNA_SCHEMA = 1;

export const DNA_CATEGORIES = ['Cinematic', 'Commercial', 'Social Media', 'TikTok & Reels', 'Motion Graphics', 'Typography', 'Transitions', 'Beat Sync', 'Product Showcase', 'Storytelling', 'Documentary', 'Gaming', 'Luxury', 'Promotional', 'Experimental'] as const;

export const SHOT_ROLES = ['opening', 'main', 'detail', 'product', 'b-roll', 'reaction', 'title-card', 'ending'] as const;
export type ShotRole = (typeof SHOT_ROLES)[number];

const Sec = z.number().min(0).max(24 * 3600);
const Id = z.string().regex(/^[a-z]{1,4}\d{1,4}$/);
const Unit = z.number().min(0).max(1);

export const DnaShot = z
  .object({
    id: Id,
    start: Sec,
    end: Sec,
    role: z.enum(SHOT_ROLES).default('main'),
    kind: z.enum(['camera', 'screen', 'graphic', 'end-card']).default('camera'),
    /** How this shot is entered from the one before. */
    cutIn: z.object({ kind: z.union([z.literal('cut'), z.enum(TRANSITIONS)]), seconds: z.number().min(0).max(4) }).strict().default({ kind: 'cut', seconds: 0 }),
    /** The camera move across the shot: scale from → to (1 = still), and drift as fractions of the frame. */
    camera: z.object({ zoomFrom: z.number().min(0.5).max(3), zoomTo: z.number().min(0.5).max(3), panX: z.number().min(-0.5).max(0.5), panY: z.number().min(-0.5).max(0.5) }).strict().default({ zoomFrom: 1, zoomTo: 1, panX: 0, panY: 0 }),
    /** Playback speed of the footage in this shot (1 = normal). */
    speed: z.number().min(0.1).max(8).default(1),
    /** A measured speed ramp across the shot (slow motion into normal speed and so on). */
    ramp: z.array(SpeedPoint).min(2).max(16).optional(),
    /** The camera's path through the shot when it is not a straight move: zoom and centre at fractions of the shot. */
    path: z.array(z.object({ t: Unit, zoom: z.number().min(0.5).max(3), x: Unit, y: Unit }).strict()).min(2).max(10).optional(),
    /** A cut-out mask seen on the shot (split screen, shape reveal). */
    mask: Cut.optional(),
    /** Where the main subject is (centre, fractions of the frame), so the user's clip can be framed the same way. */
    subject: z.object({ x: Unit, y: Unit, size: Unit }).strict().optional(),
    /** The cut into this shot lands on a beat of the music. */
    onBeat: z.boolean().default(false),
    look: ColorGrade.partial().optional(),
    /** What the shot shows, in plain words (what Keo saw), to pick the user's clip for it. */
    about: z.string().max(200).default(''),
    /** How much movement there is (0 still – 1 frantic). */
    energy: Unit.default(0.2),
    confidence: Unit.default(0.6),
  })
  .strict();
export type DnaShot = z.infer<typeof DnaShot>;

export const DnaText = z
  .object({
    id: Id,
    at: Sec,
    duration: z.number().min(0.1).max(600),
    text: z.string().trim().min(1).max(200),
    role: z.enum(['title', 'subtitle', 'caption', 'label', 'call-to-action', 'credit']).default('title'),
    x: Unit.default(0.5),
    y: Unit.default(0.5),
    sizePct: z.number().min(1).max(40).default(6),
    /** The kind of lettering seen (Keo picks a font of that kind). */
    lettering: z.enum(['sans', 'display', 'serif', 'script', 'mono', 'handwritten']).default('sans'),
    weight: z.enum(['normal', 'bold', 'black']).default('bold'),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FFFFFF'),
    uppercase: z.boolean().default(false),
    box: z.boolean().default(false),
    outline: z.boolean().default(false),
    glow: z.boolean().default(false),
    letterSpacing: z.number().min(-5).max(40).default(0),
    animIn: TextAnimIn.default('fade'),
    animOut: TextAnimOut.default('fade'),
    /** The closest of Keo's fonts to the lettering seen. */
    font: z.string().trim().min(1).max(80).optional(),
    /** It moves with a person or thing in the video (rebuilt by tracking the same place in the user's clip). */
    pinned: z.boolean().optional(),
    confidence: Unit.default(0.6),
  })
  .strict();
export type DnaText = z.infer<typeof DnaText>;

/**
 * The reference's captions (the speaker's words written on screen): only their style is kept, so
 * the same look is made from the user's own speech.
 */
export const DnaCaptions = z
  .object({
    font: z.string().trim().min(1).max(80),
    sizePct: z.number().min(1).max(40),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    /** The colour of the word being said (or emphasised), when it differs. */
    highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    y: Unit,
    uppercase: z.boolean(),
    weight: z.enum(['normal', 'bold', 'black']),
    outline: z.boolean(),
    box: z.boolean(),
    maxWords: z.number().int().min(1).max(8),
    animIn: TextAnimIn,
    confidence: Unit.default(0.5),
  })
  .strict();
export type DnaCaptions = z.infer<typeof DnaCaptions>;

export const DnaGraphic = z
  .object({
    id: Id,
    at: Sec,
    duration: z.number().min(0.2).max(600),
    piece: z.enum(MOTION_PIECES),
    text: z.string().trim().min(1).max(200),
    sub: z.string().trim().max(160).optional(),
    items: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
    x: Unit.default(0.5),
    y: Unit.default(0.5),
    confidence: Unit.default(0.5),
  })
  .strict();
export type DnaGraphic = z.infer<typeof DnaGraphic>;

export const DnaEffect = z
  .object({
    id: Id,
    at: Sec,
    duration: z.number().min(0.1).max(600),
    effects: Effects.optional(),
    color: ColorGrade.partial().optional(),
    confidence: Unit.default(0.5),
  })
  .strict();
export type DnaEffect = z.infer<typeof DnaEffect>;

export const DnaReportItem = z
  .object({
    element: z.string().max(120),
    status: z.enum(['native', 'approximated', 'needs-asset', 'unsupported', 'low-confidence']),
    note: z.string().max(300),
  })
  .strict();
export type DnaReportItem = z.infer<typeof DnaReportItem>;

export const DnaFingerprint = z
  .object({
    shots: z.number().int().min(0),
    /** Where the cuts fall, as 16 slots of the running time (share of cuts in each). */
    profile: z.array(z.number()).length(16),
    /** Median shot length (seconds). */
    pace: z.number().min(0),
    /** The order of transitions, one letter each (c cut, x crossfade, f flash, d dip, o other). */
    transitions: z.string().max(400),
    texts: z.number().int().min(0),
    graphics: z.number().int().min(0),
    onBeat: Unit,
    aspect: z.enum(['vertical', 'square', 'landscape']),
    /** Average colour of the shots (the 64-bin signature folded to 8 hue-light slots). */
    color: z.array(z.number()).length(8),
  })
  .strict();
export type DnaFingerprint = z.infer<typeof DnaFingerprint>;

export const Blueprint = z
  .object({
    schema: z.literal(EDNA_SCHEMA),
    id: z.string().regex(/^dna_[A-Za-z0-9]{6,24}$/),
    version: z.number().int().min(1).default(1),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(400).default(''),
    category: z.string().trim().min(1).max(40).default('Experimental'),
    tags: z.array(z.string().trim().min(1).max(30)).max(16).default([]),
    /** What it was measured from (no path: the name, size and shape of the reference only). */
    source: z
      .object({
        fileName: z.string().max(200),
        seconds: z.number().min(0),
        width: z.number().int().min(0),
        height: z.number().int().min(0),
        fps: z.number().min(0).optional(),
        hasAudio: z.boolean(),
        bytes: z.number().min(0).optional(),
      })
      .strict(),
    aspect: z.enum(['vertical', 'square', 'landscape']),
    seconds: z.number().min(0.1),
    shots: z.array(DnaShot).max(400),
    texts: z.array(DnaText).max(200).default([]),
    /** Caption style (the user's words are captioned this way when the edit is applied). */
    captions: DnaCaptions.nullable().optional(),
    /**
     * The style of the edit (layout, the speaker's words on screen, cards, punch-ins, ending),
     * read from its frames: applied, it is rebuilt on the user's own talking video.
     */
    style: DnaStyle.nullable().optional(),
    graphics: z.array(DnaGraphic).max(100).default([]),
    effects: z.array(DnaEffect).max(100).default([]),
    audio: z
      .object({
        voice: z.boolean(),
        music: z.boolean(),
        bpm: z.number().min(30).max(260).nullable(),
        /** Beat times (seconds into the reference), to cut the user's music on. */
        beats: z.array(Sec).max(600).default([]),
        whooshOnCuts: z.boolean().default(false),
      })
      .strict(),
    look: ColorGrade.partial().optional(),
    /**
     * How close Keo's rebuild came, measured: the reference's own footage rebuilt with the blueprint,
     * rendered, and compared frame by frame with the reference (0–1), with the cuts that line up.
     */
    quality: z
      .object({ score: Unit, frames: Unit, cuts: Unit, camera: Unit.optional(), samples: z.number().int().min(0), note: z.string().max(300) })
      .strict()
      .nullable()
      .optional(),
    /** Studio capabilities the edit needs (transitions:…, effects:…, motion:…, text, keyframes, speed). */
    capabilities: z.array(z.string().max(60)).max(80).default([]),
    fingerprint: DnaFingerprint,
    report: z.array(DnaReportItem).max(200).default([]),
    /** ready: complete; partial: some stages could not run (see report); failed: unusable. */
    status: z.enum(['ready', 'partial', 'failed']),
    favorite: z.boolean().default(false),
    /** Private by default; sharing needs the user's statement that they may share it. */
    sharing: z
      .object({
        state: z.enum(['private', 'shareable']),
        rights: z.enum(['own', 'licensed', 'technique-only']).nullable(),
        /** In the online shared library (Keo Cloud) under this id, since this time; only the user publishes. */
        published: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{6,40}$/), at: z.string().max(40) }).strict().nullable().optional(),
      })
      .strict()
      .default({ state: 'private', rights: null }),
    history: z.array(z.object({ version: z.number().int(), at: z.string(), note: z.string().max(200) }).strict()).max(50).default([]),
    /** Ids of related blueprints found when it was made. */
    related: z.array(z.string()).max(10).default([]),
    origin: z.enum(['reference', 'imported', 'shared', 'combined']).default('reference'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type Blueprint = z.infer<typeof Blueprint>;

/** Older blueprints brought up to the current schema (one place for every future migration). */
export function migrateBlueprint(raw: unknown): Blueprint {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // Schema 1 is the first; later versions add their steps here.
  return Blueprint.parse({ ...o, schema: EDNA_SCHEMA });
}

// ---------------------------------------------------------------- fingerprints and matching

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function fingerprintOf(b: Pick<Blueprint, 'shots' | 'seconds' | 'texts' | 'graphics' | 'aspect'>, colors: number[][] = []): DnaFingerprint {
  const cuts = b.shots.slice(1).map((s) => s.start / Math.max(0.1, b.seconds));
  const profile = new Array<number>(16).fill(0);
  for (const c of cuts) profile[Math.min(15, Math.floor(c * 16))]! += 1;
  const total = Math.max(1, cuts.length);
  const lengths = b.shots.map((s) => s.end - s.start).sort((x, y) => x - y);
  const letter = (k: string) => (k === 'cut' ? 'c' : k === 'crossfade' ? 'x' : k === 'flash' ? 'f' : k === 'dip' ? 'd' : 'o');
  const color = new Array<number>(8).fill(0);
  for (const sig of colors) for (let i = 0; i < 64; i++) color[(((i >> 4) & 3) >> 1) * 4 + (((i >> 2) & 3) >> 1) * 2 + ((i & 3) >> 1)]! += (sig[i] ?? 0) / Math.max(1, colors.length);
  return {
    shots: b.shots.length,
    profile: profile.map((v) => r3(v / total)),
    pace: r3(lengths[Math.floor(lengths.length / 2)] ?? b.seconds),
    transitions: b.shots
      .slice(1)
      .map((s) => letter(s.cutIn.kind))
      .join('')
      .slice(0, 400),
    texts: b.texts.length,
    graphics: b.graphics.length,
    onBeat: r3(b.shots.length > 1 ? b.shots.slice(1).filter((s) => s.onBeat).length / (b.shots.length - 1) : 0),
    aspect: b.aspect,
    color: color.map(r3),
  };
}

/** How alike two edits are in structure (0–1), from several signals — never from looks alone. */
export function similarity(a: DnaFingerprint, b: DnaFingerprint): { score: number; signals: Record<string, number> } {
  const shots = 1 - Math.min(1, Math.abs(a.shots - b.shots) / Math.max(4, Math.max(a.shots, b.shots)));
  const profile = 1 - a.profile.reduce((n, v, i) => n + Math.abs(v - (b.profile[i] ?? 0)), 0) / 2;
  const pace = 1 - Math.min(1, Math.abs(Math.log((a.pace + 0.05) / (b.pace + 0.05))) / Math.log(4));
  // Transition order: share of positions (scaled to the shorter) with the same kind.
  const n = Math.min(a.transitions.length, b.transitions.length);
  let same = 0;
  for (let i = 0; i < n; i++) if (a.transitions[Math.floor((i * a.transitions.length) / n)] === b.transitions[Math.floor((i * b.transitions.length) / n)]) same++;
  const transitions = a.transitions.length || b.transitions.length ? (n ? same / n : 0) * (n / Math.max(a.transitions.length, b.transitions.length)) : 1;
  const text = 1 - Math.min(1, Math.abs(a.texts - b.texts) / Math.max(3, a.texts, b.texts));
  const graphics = 1 - Math.min(1, Math.abs(a.graphics - b.graphics) / Math.max(3, a.graphics, b.graphics));
  const beat = 1 - Math.abs(a.onBeat - b.onBeat);
  const color = 1 - a.color.reduce((s, v, i) => s + Math.abs(v - (b.color[i] ?? 0)), 0) / 2;
  const aspect = a.aspect === b.aspect ? 1 : 0.7;
  const signals = { shots, profile, pace, transitions, text, graphics, beat, color, aspect };
  const score = (shots * 0.14 + profile * 0.22 + pace * 0.14 + transitions * 0.16 + text * 0.08 + graphics * 0.06 + beat * 0.08 + color * 0.07 + aspect * 0.05) / 1;
  return { score: r3(score), signals: Object.fromEntries(Object.entries(signals).map(([k, v]) => [k, r3(v)])) };
}

export type MatchLevel = 'same' | 'similar' | 'related' | 'new';
export function matchLevel(score: number, a: DnaFingerprint, b: DnaFingerprint): MatchLevel {
  if (score >= 0.93 && Math.abs(a.shots - b.shots) <= 1 && a.aspect === b.aspect) return 'same';
  if (score >= 0.8) return 'similar';
  if (score >= 0.65) return 'related';
  return 'new';
}

/** The library ranked against a fingerprint (best first), with each match's level. */
export function findMatches(f: DnaFingerprint, library: Blueprint[], exceptId?: string): Array<{ id: string; name: string; score: number; level: MatchLevel }> {
  return library
    .filter((b) => b.id !== exceptId && b.status !== 'failed')
    .map((b) => {
      const s = similarity(f, b.fingerprint);
      return { id: b.id, name: b.name, score: s.score, level: matchLevel(s.score, f, b.fingerprint) };
    })
    .sort((x, y) => y.score - x.score);
}

/** Natural-language search: the request's words against names, categories, tags, descriptions and what the shots show. */
export function searchBlueprints(query: string, library: Blueprint[], o: { aspect?: Blueprint['aspect']; clips?: number } = {}): Array<{ id: string; name: string; score: number; why: string }> {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
  return library
    .filter((b) => b.status !== 'failed')
    .map((b) => {
      const hay = `${b.name} ${b.category} ${b.tags.join(' ')} ${b.description} ${b.shots.map((s) => s.about).join(' ')} ${b.graphics.map((g) => g.piece).join(' ')}`.toLowerCase();
      const hits = words.filter((w) => hay.includes(w) || (SYN[w] ?? []).some((s) => hay.includes(s)));
      let score = words.length ? hits.length / words.length : 0.2;
      const why: string[] = hits.length ? [`matches “${hits.join('”, “')}”`] : [];
      if (o.aspect && b.aspect === o.aspect) {
        score += 0.1;
        why.push('same shape as your project');
      }
      if (o.clips !== undefined) {
        const need = b.shots.length;
        const fit = o.clips >= need ? 1 : o.clips / Math.max(1, need);
        score += 0.15 * fit;
        why.push(o.clips >= Math.ceil(need / 2) ? `${o.clips} clips for ${need} shots` : `only ${o.clips} clips for ${need} shots (shots will repeat clips)`);
      }
      if (b.favorite) score += 0.05;
      if (b.status === 'partial') score -= 0.05;
      return { id: b.id, name: b.name, score: r3(score), why: why.join('; ') };
    })
    .sort((x, y) => y.score - x.score);
}
const STOP = new Set(['the', 'and', 'with', 'for', 'make', 'create', 'video', 'edit', 'using', 'use', 'like', 'some', 'that', 'this', 'from', 'into', 'want', 'please']);
const SYN: Record<string, string[]> = {
  luxury: ['elegant', 'premium', 'fashion', 'luxury'],
  cinematic: ['film', 'movie', 'cinematic', 'letterbox'],
  fast: ['tiktok', 'reels', 'beat', 'quick', 'fast'],
  promo: ['promotional', 'commercial', 'product', 'ad'],
  typography: ['text', 'title', 'typography', 'kinetic'],
  smooth: ['crossfade', 'dissolve', 'zoom', 'smooth'],
};

// ---------------------------------------------------------------- applying a blueprint

/** A stretch of a media file (seconds into it). */
export interface DnaSpan {
  start: number;
  end: number;
}

export interface DnaClip {
  assetId: string;
  kind: 'video' | 'image';
  /** Usable length (seconds); pictures can last any time. */
  duration: number;
  /** What Keo knows it shows (to match shot roles). */
  about?: string;
  /** Where someone speaks in it (seconds into the file), when known. */
  speech?: DnaSpan[];
}

/** Fonts Keo uses for each kind of lettering seen. */
const LETTERING_FONT: Record<DnaText['lettering'], string> = { sans: 'Montserrat', display: 'Anton', serif: 'Playfair Display', script: 'Great Vibes', mono: 'Space Mono', handwritten: 'Caveat' };

/** Which clip fills which shot: the user's choices first, then roles by what clips show, then in order (never the same part twice). */
export function mapClips(b: Pick<Blueprint, 'shots'>, clips: DnaClip[], roles: Record<string, string> = {}): Array<{ shot: DnaShot; clip: DnaClip | null }> {
  if (!clips.length) return b.shots.map((shot) => ({ shot, clip: null }));
  const byId = new Map(clips.map((c) => [c.assetId, c]));
  const words: Record<ShotRole, string[]> = { opening: ['wide', 'establish', 'landscape', 'city', 'opening'], main: [], detail: ['close', 'detail', 'hand', 'texture'], product: ['product', 'bottle', 'shoe', 'phone', 'package', 'item'], 'b-roll': [], reaction: ['face', 'smile', 'person', 'reaction'], 'title-card': ['text', 'logo', 'title'], ending: ['logo', 'end', 'sunset', 'wide'] };
  let next = 0;
  return b.shots.map((shot, i) => {
    const chosen = roles[shot.id] ? byId.get(roles[shot.id]!) : undefined;
    if (chosen) return { shot, clip: chosen };
    const hint = words[shot.role] ?? [];
    const byRole = hint.length ? clips.find((c) => c.about && hint.some((w) => c.about!.toLowerCase().includes(w))) : undefined;
    if (byRole && (i === 0 || i === b.shots.length - 1 || shot.role === 'product')) return { shot, clip: byRole };
    // In order, preferring pictures for graphic shots and videos for camera shots.
    const want = shot.kind === 'graphic' ? 'image' : 'video';
    const pool = clips.filter((c) => c.kind === want);
    const list = pool.length ? pool : clips;
    const c = list[next % list.length]!;
    next++;
    return { shot, clip: c };
  });
}

/** How captions are rebuilt: the user's own spoken words, in the reference's caption style. */
export interface DnaCaptionPlan {
  style: NonNullable<Extract<EditOp, { op: 'add_captions' }>['style']>;
  highlight: string | null;
  animIn: DnaText['animIn'];
  maxWords: number;
  y: number;
}

export interface ApplyResult {
  ops: EditOp[];
  /** What changed against the blueprint because of the footage (plain words for the user). */
  notes: string[];
  seconds: number;
  /** For each media clip added (in time order): which reference shot it rebuilds, and whether it opens that shot. */
  pieces: Array<{ shot: number; first: boolean }>;
  /** talk: the user's speech plays whole and the reference's rhythm is cut into it; montage: shots filled with parts of the clips. */
  mode: 'talk' | 'montage';
  /** Captions to make from the user's speech (null: none in the reference, or no speech). */
  captions: DnaCaptionPlan | null;
}

export type DnaFitMode = 'talk' | 'montage';
export type DnaLength = 'reference' | 'footage';

/** The caption style of a blueprint: measured, or read from the texts the model called captions. */
export function captionsOf(b: Pick<Blueprint, 'texts'> & { captions?: DnaCaptions | null | undefined }): DnaCaptions | null {
  if (b.captions) return b.captions;
  const caps = b.texts.filter((t) => t.role === 'caption' || t.role === 'subtitle');
  if (!caps.length) return null;
  const most = <T,>(xs: T[]): T => {
    const n = new Map<string, { v: T; c: number }>();
    for (const x of xs) {
      const k = JSON.stringify(x);
      n.set(k, { v: x, c: (n.get(k)?.c ?? 0) + 1 });
    }
    return [...n.values()].sort((a, c) => c.c - a.c)[0]!.v;
  };
  const colors = [...new Set(caps.map((t) => t.color))];
  const words = caps.map((t) => t.text.split(/\s+/).length).sort((x, y) => x - y);
  const base = most(caps.map((t) => t.color));
  const ys = caps.map((t) => t.y).sort((x, y) => x - y);
  return {
    font: most(caps.map((t) => t.font ?? LETTERING_FONT[t.lettering])),
    sizePct: most(caps.map((t) => t.sizePct)),
    color: base,
    highlight: colors.find((c) => c !== base) ?? null,
    y: ys[Math.floor(ys.length / 2)]!,
    uppercase: most(caps.map((t) => t.uppercase)),
    weight: most(caps.map((t) => t.weight)),
    outline: most(caps.map((t) => t.outline)),
    box: most(caps.map((t) => t.box)),
    maxWords: Math.max(1, Math.min(6, words[Math.floor(words.length / 2)] ?? 3)),
    animIn: most(caps.map((t) => t.animIn)),
    confidence: 0.5,
  };
}

const sec3 = (v: number) => Math.round(v * 1000) / 1000;

/** Where the camera is at a fraction of a shot: on its measured path, or along its straight move. */
function camAt(shot: DnaShot, u: number): { scale: number; x: number; y: number } {
  const p = shot.path;
  if (p?.length) {
    let k = 0;
    while (k < p.length - 1 && p[k + 1]!.t < u) k++;
    const a = p[k]!;
    const c = p[Math.min(p.length - 1, k + 1)]!;
    const f = c.t > a.t ? Math.max(0, Math.min(1, (u - a.t) / (c.t - a.t))) : 0;
    return { scale: a.zoom + (c.zoom - a.zoom) * f, x: a.x + (c.x - a.x) * f, y: a.y + (c.y - a.y) * f };
  }
  const cam = shot.camera;
  return { scale: cam.zoomFrom + (cam.zoomTo - cam.zoomFrom) * u, x: 0.5 + cam.panX * u, y: 0.5 + cam.panY * u };
}

/** The camera moves of a part of a shot (from fraction u0 to u1 of it) as zoom keyframes, with the shot's framing. */
function zoomsFor(shot: DnaShot, u0: number, u1: number, dur: number, framing: number): Zoom[] | null {
  const cam = shot.camera;
  const moving = !!shot.path?.length || Math.abs(cam.zoomTo - cam.zoomFrom) > 0.015 || Math.abs(cam.panX) > 0.01 || Math.abs(cam.panY) > 0.01;
  const clampXY = (v: number) => Math.min(1, Math.max(0, v));
  const at = (u: number) => {
    const c = camAt(shot, u);
    return { scale: Math.min(4, Math.max(1, c.scale * framing)), x: clampXY(c.x), y: clampXY(c.y) };
  };
  if (!moving) return framing > 1.01 ? [{ at: 0, scale: Math.min(4, framing), x: 0.5, y: 0.5, ease: 'cut' }] : null;
  const pts = [u0, ...(shot.path ?? []).map((q) => q.t).filter((t) => t > u0 + 0.02 && t < u1 - 0.02), u1];
  return pts.map((u, k) => ({ at: sec3(((u - u0) / Math.max(1e-6, u1 - u0)) * dur), ...at(u), ease: k === 0 ? 'cut' : 'ramp' }));
}

/** How much closer each shot is framed than the widest one (from the size of its subject): talking-head punch-ins. */
function framings(b: Blueprint): number[] {
  const sized = b.shots.map((s) => s.subject?.size ?? null);
  const known = sized.filter((x): x is number => x !== null && x > 0.05);
  const wide = known.length >= 2 ? Math.min(...known) : null;
  if (!wide || Math.max(...known) / wide < 1.12) return b.shots.map(() => 1);
  return sized.map((x) => (x && x > 0.05 ? Math.max(1, Math.min(1.6, Math.round((x / wide) * 100) / 100)) : 1));
}

/**
 * The order of the reference's shots over a timeline of `total` seconds: the opening first, the
 * middle shots in a loop, the ending last. Cuts move to the nearest natural break within ±40 %.
 */
function shotPlan(b: Blueprint, total: number, breaks: number[] = []): Array<{ idx: number; from: number; to: number }> {
  const n = b.shots.length;
  const L = b.shots.map((s) => Math.max(0.4, s.end - s.start));
  const shortest = Math.min(...L);
  const middle = n > 2 ? Array.from({ length: n - 2 }, (_, k) => k + 1) : Array.from({ length: n }, (_, k) => k);
  const out: Array<{ idx: number; from: number; to: number }> = [];
  let t = 0;
  for (let i = 0; t < total - 0.05 && i < 5000; i++) {
    let idx: number;
    if (i === 0) idx = 0;
    else if (n > 2 && total - t <= L[n - 1]! * 1.3) idx = n - 1;
    else idx = middle[(i - (n > 2 ? 1 : 0)) % middle.length]!;
    let end = t + L[idx]!;
    if (n > 2 && idx === n - 1) end = total;
    else {
      const want = end;
      const snap = breaks.filter((c) => c > t + L[idx]! * 0.6 && c < t + L[idx]! * 1.4).sort((x, y) => Math.abs(x - want) - Math.abs(y - want))[0];
      if (snap !== undefined) end = snap;
    }
    if (total - end < shortest * 0.5) end = total;
    end = Math.min(total, end);
    out.push({ idx, from: sec3(t), to: sec3(end) });
    t = end;
  }
  return out;
}

/**
 * The parts of the user's talking clips that carry speech, in order: dead air at the ends goes, and
 * pauses longer than the reference's pace allows are cut (jump cuts) — never inside a word.
 */
export function talkParts(b: Pick<Blueprint, 'fingerprint' | 'seconds'>, clips: DnaClip[], length: DnaLength, gap?: number): { parts: Array<{ assetId: string; from: number; to: number }>; pauses: number; cutShort: boolean } {
  const fast = b.fingerprint.pace < 4;
  const keepGap = gap ?? (fast ? 0.6 : 2);
  const parts: Array<{ assetId: string; from: number; to: number; ends: number[] }> = [];
  let pauses = 0;
  for (const c of clips) {
    if (c.kind !== 'video') continue;
    const spans = (c.speech ?? []).filter((s) => s.end > s.start + 0.05).sort((x, y) => x.start - y.start);
    if (!spans.length) {
      parts.push({ assetId: c.assetId, from: 0, to: c.duration, ends: [] });
      continue;
    }
    // Stretches of speech (short breaths stay inside them; where each phrase ends is kept for a clean stop).
    const runs: Array<DnaSpan & { ends: number[] }> = [];
    for (const s of spans) {
      const last = runs.at(-1);
      if (last && s.start - last.end <= keepGap) {
        last.ends.push(last.end);
        last.end = Math.max(last.end, s.end);
      } else runs.push({ ...s, ends: [] });
    }
    pauses += runs.length - 1;
    for (const r of runs) {
      const from = Math.max(0, r.start - 0.12);
      const to = Math.min(c.duration, r.end + 0.25);
      const last = parts.at(-1);
      if (last && last.assetId === c.assetId && from <= last.to) {
        last.ends.push(last.to - 0.25, ...r.ends);
        last.to = Math.max(last.to, to);
      } else if (to - from > 0.15) parts.push({ assetId: c.assetId, from, to, ends: r.ends });
    }
  }
  const plain = (list: typeof parts) => list.map(({ assetId, from, to }) => ({ assetId, from, to }));
  if (length === 'footage') return { parts: plain(parts), pauses, cutShort: false };
  // As long as the reference: whole stretches of speech until it is reached; one that runs far over stops at the pause nearest the length.
  const out: typeof parts = [];
  let t = 0;
  let cutShort = false;
  for (const p of parts) {
    if (t >= b.seconds * 0.9) break;
    const len = p.to - p.from;
    if (t + len > b.seconds * 1.25) {
      const room = Math.max(1, b.seconds - t);
      const pause = p.ends.filter((e) => e - p.from >= room * 0.7 && e - p.from <= room * 1.4).sort((x, y) => Math.abs(x - p.from - room) - Math.abs(y - p.from - room))[0];
      out.push({ ...p, to: pause !== undefined ? Math.min(p.to, pause + 0.25) : p.from + room });
      cutShort = pause === undefined;
      break;
    }
    out.push(p);
    t += len;
  }
  return { parts: plain(out), pauses, cutShort };
}

/** A reference moment on the new timeline: the opening stays at the start, the ending at the end, the rest in proportion. */
function timeMap(b: Blueprint, out: number): (t: number) => number {
  const ref = Math.max(0.1, b.seconds);
  if (Math.abs(out - ref) < 0.3) return (t) => Math.min(out, t);
  const lastStart = b.shots.length > 2 ? b.shots.at(-1)!.start : ref;
  const head = Math.min(3, ref * 0.2);
  return (t) => sec3(Math.max(0, Math.min(out - 0.2, t < head ? t : t >= lastStart ? out - (ref - t) : (t / ref) * out)));
}

/** Talking footage: speech in it covers a quarter or more of the chosen videos. */
export function isTalking(clips: DnaClip[]): boolean {
  const videos = clips.filter((c) => c.kind === 'video' && c.speech);
  const total = videos.reduce((n, c) => n + c.duration, 0);
  const said = videos.reduce((n, c) => n + c.speech!.reduce((m, s) => m + Math.max(0, s.end - s.start), 0), 0);
  return total > 2 && said / total >= 0.25;
}

/**
 * The edit operations that rebuild a blueprint with the user's clips at `at` seconds.
 *
 * Talking footage (mode talk): the user's speech plays whole, in order — dead air trimmed and long
 * pauses cut as the reference's pace allows — and the reference's shots are laid over it as a
 * repeating rhythm: each part gets that shot's framing (punch-ins), camera move, transition, colour
 * and effects; cuts land in pauses where one is near. Speed changes are left out (speech stays natural).
 *
 * Other footage (mode montage): each shot gets a different part of a clip (spread through each
 * clip so nothing repeats while there is footage), with its timing, transition, camera, speed and
 * colour. Length: like the reference, or (footage) long enough for all the clips, the reference's
 * middle shots repeating. Text, graphics and effects keep their place: the opening's at the start,
 * the ending's at the end, the rest in proportion.
 */
export function blueprintOps(
  b: Blueprint,
  project: Pick<Project, 'width' | 'height'>,
  clips: DnaClip[],
  o: { at?: number; roles?: Record<string, string>; trackName?: string; only?: Array<'shots' | 'texts' | 'graphics' | 'effects'>; sourceTimes?: boolean; mode?: DnaFitMode; length?: DnaLength } = {},
): ApplyResult {
  const at = Math.max(0, o.at ?? 0);
  const parts = new Set(o.only ?? ['shots', 'texts', 'graphics', 'effects']);
  const ops: EditOp[] = [];
  const notes: string[] = [];
  const pieces: ApplyResult['pieces'] = [];
  const trackName = o.trackName ?? 'Edit DNA';
  const mode: DnaFitMode = o.sourceTimes ? 'montage' : (o.mode ?? (isTalking(clips) ? 'talk' : 'montage'));
  const length: DnaLength = o.length ?? (mode === 'talk' ? 'footage' : 'reference');
  const frame = framings(b);
  const media = (assetId: string, start: number, inPoint: number, dur: number, zooms: Zoom[] | null) =>
    ops.push({ op: 'add_media', assetId, start: sec3(at + start), in: sec3(inPoint), duration: sec3(dur), trackName, fit: 'cover', ...(zooms ? { zooms } : {}) });
  let out = 0;
  // Where each reference shot landed (single pass only), for the text timing of a montage the length of the reference.
  let shift: Array<{ from: number; to: number; delta: number }> | null = null;

  if (parts.has('shots') && mode === 'talk' && clips.some((c) => c.kind === 'video')) {
    const { parts: said, pauses, cutShort } = talkParts(b, clips, length);
    const total = said.reduce((n, p) => n + (p.to - p.from), 0);
    const starts: number[] = [];
    let t = 0;
    for (const p of said) {
      starts.push(t);
      t += p.to - p.from;
    }
    const plan = shotPlan(b, total, starts.slice(1));
    said.forEach((p, k) => {
      const po = starts[k]!;
      const pe = po + (p.to - p.from);
      for (const seg of plan) {
        const a = Math.max(po, seg.from);
        const e = Math.min(pe, seg.to);
        if (e - a < 0.04) continue;
        const shot = b.shots[seg.idx]!;
        const span = Math.max(0.01, seg.to - seg.from);
        media(p.assetId, a, p.from + (a - po), e - a, zoomsFor(shot, (a - seg.from) / span, (e - seg.from) / span, e - a, frame[seg.idx]!));
        pieces.push({ shot: seg.idx, first: Math.abs(a - seg.from) < 1e-3 });
      }
    });
    out = total;
    notes.push(`Your speech plays whole, in order (${fmtSec(total)}); the reference’s ${b.shots.length}-shot rhythm${plan.length > b.shots.length ? ' repeats across it' : ' is laid over it'}: ${plan.length} shots with its framing, camera moves, transitions and look.`);
    if (pauses) notes.push(`${pauses} long pause${pauses > 1 ? 's were' : ' was'} cut out (jump cuts), as the reference’s pace does; words are never cut.`);
    if (cutShort) notes.push('The edit stops near the reference’s length, in the middle of a sentence. Choose “All my footage” to keep everything you said.');
    if (b.shots.some((s) => s.ramp?.length || Math.abs(s.speed - 1) > 0.04)) notes.push('The reference’s speed changes were left out so your voice stays natural.');
    if (b.shots.some((s) => s.mask)) notes.push('The reference’s masks and split screens were left out: they need a second picture beside your talking shot.');
  } else if (parts.has('shots')) {
    const videos = clips.filter((c) => c.kind === 'video');
    const footage = videos.reduce((n, c) => n + c.duration, 0) + clips.filter((c) => c.kind === 'image').length * 3;
    const total = o.sourceTimes || length === 'reference' ? b.seconds : Math.max(b.seconds, footage);
    const once = total <= b.seconds + 0.05;
    const seq = once ? b.shots.map((s, idx) => ({ idx, from: s.start, to: s.end })) : shotPlan(b, total);
    const map = mapClips({ shots: seq.map((s) => b.shots[s.idx]!) }, clips, o.roles);
    // How often each clip is used, and how much of it that takes: its parts are spread through it.
    const uses = new Map<string, { n: number; need: number; k: number }>();
    map.forEach(({ shot, clip }, i) => {
      if (!clip) return;
      const u = uses.get(clip.assetId) ?? { n: 0, need: 0, k: 0 };
      u.n++;
      u.need += Math.max(0.2, seq[i]!.to - seq[i]!.from) * (clip.kind === 'video' ? shot.speed : 1);
      uses.set(clip.assetId, u);
    });
    shift = once ? [] : null;
    let t = 0;
    let lost = 0;
    const repeated = new Set<string>();
    map.forEach(({ shot, clip }, i) => {
      const s = seq[i]!;
      const want = Math.max(0.2, s.to - s.from);
      if (!clip) {
        notes.push(`No clip for shot ${shot.id} (${shot.role}): left as a gap to fill.`);
        t += want;
        return;
      }
      const speed = clip.kind === 'video' ? shot.speed : 1;
      const avail = clip.kind === 'image' ? Infinity : clip.duration / speed;
      let dur = want;
      if (avail < want - 0.05) {
        dur = Math.max(0.2, avail);
        lost += want - dur;
      }
      const u = uses.get(clip.assetId)!;
      const room = clip.kind === 'image' ? 0 : Math.max(0, clip.duration - dur * speed);
      const inPoint = clip.kind === 'image' ? 0 : o.sourceTimes ? Math.min(room, shot.start) : u.n > 1 ? (room * u.k) / (u.n - 1) : Math.min(room, room * 0.15);
      u.k++;
      if (clip.kind === 'video' && u.need > clip.duration + 0.5) repeated.add(clip.assetId);
      media(clip.assetId, t, inPoint, dur, zoomsFor(shot, 0, 1, dur, frame[s.idx]!));
      pieces.push({ shot: s.idx, first: true });
      shift?.push({ from: shot.start, to: shot.end, delta: t - shot.start });
      t += dur;
    });
    out = t;
    if (lost > 0.05) notes.push(`The edit is ${lost.toFixed(1)} s shorter than planned because some clips are shorter than their shots.`);
    if (repeated.size) notes.push(`Your footage is shorter than the edit, so ${repeated.size === 1 ? 'one clip is' : `${repeated.size} clips are`} used more than once (different moments where possible). Add more clips for a fresher result.`);
    if (!once) notes.push(`The reference is ${fmtSec(b.seconds)}; your clips fill ${fmtSec(out)}, so its middle shots repeat in the same rhythm.`);
  }
  if (!parts.has('shots')) out = b.seconds;
  const ref = timeMap(b, out);
  const place = (t: number) => {
    if (shift) {
      const s = shift.find((x) => t >= x.from - 1e-6 && t < x.to + 1e-6) ?? shift.at(-1);
      return Math.max(at, sec3(at + t + (s?.delta ?? 0)));
    }
    return sec3(at + ref(t));
  };
  const lengthOf = (start: number, d: number) => (d >= b.seconds * 0.8 ? Math.max(0.2, out - (start - at)) : d);
  const caption = captionsOf(b);
  const captions: DnaCaptionPlan | null =
    caption && mode === 'talk' && parts.has('texts')
      ? {
          style: {
            font: (KEO_FONTS as readonly string[]).includes(caption.font) ? caption.font : 'Montserrat',
            sizePct: caption.sizePct,
            weight: caption.weight,
            color: caption.color,
            uppercase: caption.uppercase,
            outline: caption.outline ? 5 : 0,
            box: caption.box,
            shadow: caption.box ? 0 : 10,
          },
          highlight: caption.highlight,
          animIn: caption.animIn,
          maxWords: caption.maxWords,
          y: caption.y,
        }
      : null;
  if (parts.has('texts'))
    for (const x of b.texts) {
      // The reference speaker's own words are not copied: captions are made from the user's speech instead.
      if (caption && (x.role === 'caption' || x.role === 'subtitle')) continue;
      const start = place(x.at);
      ops.push({
        op: 'add_text',
        text: x.text,
        start,
        duration: sec3(Math.min(x.duration, Math.max(0.3, out - (start - at)))),
        style: {
          font: x.font && (KEO_FONTS as readonly string[]).includes(x.font) ? x.font : LETTERING_FONT[x.lettering],
          sizePct: x.sizePct,
          weight: x.weight,
          color: x.color,
          uppercase: x.uppercase,
          letterSpacing: x.letterSpacing,
          box: x.box,
          outline: x.outline ? 5 : 0,
          glow: x.glow ? 24 : 0,
          glowColor: x.color,
          shadow: x.box ? 0 : 10,
        },
        animIn: x.animIn,
        animOut: x.animOut,
        transform: { x: x.x, y: x.y },
      });
    }
  if (parts.has('graphics'))
    for (const g of b.graphics) {
      const start = place(g.at);
      ops.push({ op: 'add_motion', piece: g.piece, text: g.text, ...(g.sub ? { sub: g.sub } : {}), ...(g.items?.length ? { items: g.items } : {}), start, duration: sec3(Math.max(0.2, Math.min(g.duration, out - (start - at)))), place: 'auto' });
    }
  if (parts.has('effects')) {
    for (const e of b.effects) {
      const start = place(e.at);
      ops.push({ op: 'add_adjust', start, duration: sec3(Math.max(0.1, Math.min(lengthOf(start, e.duration), out - (start - at)))), ...(e.effects ? { effects: e.effects } : {}), ...(e.color ? { color: e.color } : {}) });
    }
    if (b.look && Object.keys(b.look).length && out > 0) ops.push({ op: 'add_adjust', start: at, duration: sec3(out), color: b.look, strength: 1 });
  }
  if (mode === 'talk' && b.texts.some((x) => x.role !== 'caption' && x.role !== 'subtitle') && parts.has('texts')) notes.push('Titles keep the reference’s words as placeholders in its style: double-click one to write your own.');
  if (caption && !captions && parts.has('texts')) notes.push('The reference’s captions were its speaker’s words, and your clips have no speech to caption, so they were left out.');
  if (!clips.length && parts.has('shots')) notes.push('No clips were given: only the text, graphics and effects were placed.');
  void project;
  return { ops, notes, seconds: sec3(out), pieces, mode, captions };
}

function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return m ? `${m}:${String(r).padStart(2, '0')}` : `${r} s`;
}

/**
 * The transitions, masks, speed and per-shot colour come as "set" operations on the clips once
 * they exist (their ids are made when the clips are added): the clip ids in time order, with the
 * shot each one rebuilds (default: one clip per shot, in order).
 */
export function blueprintFollowUps(b: Blueprint, clipIds: string[], pieces?: ApplyResult['pieces'], o: { talk?: boolean } = {}): EditOp[] {
  const out: EditOp[] = [];
  clipIds.forEach((clip, k) => {
    const pc = pieces?.[k] ?? { shot: k, first: true };
    const s = b.shots[pc.shot];
    if (!s) return;
    if (k > 0 && pc.first && s.cutIn.kind !== 'cut') out.push({ op: 'set', clip, transition: { kind: s.cutIn.kind, seconds: Math.max(0.15, Math.min(2, s.cutIn.seconds || 0.5)) } });
    if (!o.talk) {
      if (s.mask) out.push({ op: 'set', clip, cut: s.mask });
      if (s.ramp?.length) out.push({ op: 'set', clip, speedCurve: s.ramp });
      else if (Math.abs(s.speed - 1) > 0.04) out.push({ op: 'set', clip, speed: s.speed });
    }
    if (s.look && Object.keys(s.look).length) out.push({ op: 'set', clip, color: s.look });
  });
  return out;
}

/** Combines parts of several blueprints: the shots (timing, transitions, camera) of one, the text of another, the graphics and effects of a third. */
export function combineBlueprints(parts: { shots: Blueprint; texts?: Blueprint; graphics?: Blueprint; effects?: Blueprint }, name: string, now: string): Blueprint {
  const base = parts.shots;
  const scale = (src: Blueprint) => base.seconds / Math.max(0.1, src.seconds);
  const fit = <T extends { at: number; duration: number }>(list: T[], src: Blueprint): T[] => list.map((x) => ({ ...x, at: Math.min(base.seconds - 0.2, x.at * scale(src)), duration: Math.max(0.2, Math.min(x.duration, base.seconds)) }));
  const out: Blueprint = {
    ...base,
    id: `dna_${now.replace(/\D/g, '').slice(-12)}mix`,
    version: 1,
    name,
    description: `Shots from ${base.name}${parts.texts ? `, text from ${parts.texts.name}` : ''}${parts.graphics ? `, graphics from ${parts.graphics.name}` : ''}${parts.effects ? `, effects from ${parts.effects.name}` : ''}.`.slice(0, 400),
    texts: parts.texts ? fit(parts.texts.texts, parts.texts) : base.texts,
    graphics: parts.graphics ? fit(parts.graphics.graphics, parts.graphics) : base.graphics,
    effects: parts.effects ? fit(parts.effects.effects, parts.effects) : base.effects,
    history: [{ version: 1, at: now, note: 'Combined from other blueprints.' }],
    related: [parts.texts?.id, parts.graphics?.id, parts.effects?.id].filter((x): x is string => !!x),
    favorite: false,
    createdAt: now,
    updatedAt: now,
  };
  out.fingerprint = fingerprintOf(out, []);
  out.capabilities = capabilitiesOf(out);
  return Blueprint.parse(out);
}

/** The Studio capabilities a blueprint needs (what Keo checks before applying it). */
export function capabilitiesOf(b: Pick<Blueprint, 'shots' | 'texts' | 'graphics' | 'effects'>): string[] {
  const set = new Set<string>();
  for (const s of b.shots) {
    if (s.cutIn.kind !== 'cut') set.add(`transition:${s.cutIn.kind}`);
    if (Math.abs(s.camera.zoomTo - s.camera.zoomFrom) > 0.015 || s.camera.panX || s.camera.panY) set.add('keyframes:zoom');
    if (Math.abs(s.speed - 1) > 0.04) set.add('speed');
    if (s.look) set.add('color:grade');
  }
  if (b.texts.length) set.add('text');
  for (const g of b.graphics) set.add(`motion:${g.piece}`);
  for (const e of b.effects) for (const k of Object.keys(e.effects ?? {})) set.add(`effect:${k}`);
  return [...set].sort();
}

// ---------------------------------------------------------------- analysis jobs

export const DNA_STAGES = [
  ['ingest', 'Checking the reference'],
  ['scenes', 'Finding every shot'],
  ['transitions', 'Reading each transition'],
  ['motion', 'Measuring camera moves'],
  ['paths', 'Following camera paths and speed'],
  ['audio', 'Listening for beats and speech'],
  ['vision', 'Looking at the frames'],
  ['details', 'Text animation, fonts and tracking'],
  ['reconstruct', 'Rebuilding the edit'],
  ['compare', 'Checking the rebuild against the reference'],
  ['match', 'Searching your Edit DNA'],
  ['save', 'Saving the blueprint'],
] as const;
export type DnaStage = (typeof DNA_STAGES)[number][0];

export interface DnaJob {
  id: string;
  projectId: string;
  assetId: string;
  name: string;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';
  stages: Array<{ id: DnaStage; label: string; state: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; detail: string }>;
  progress: number;
  error: string | null;
  blueprintId: string | null;
  /** The match found in the library before saving (same / similar / related), if any. */
  matched: { id: string; name: string; level: string; score: number } | null;
  startedAt: string;
  finishedAt: string | null;
  /** Each finished stage's result (so a stopped job resumes where it was). */
  data: Partial<Record<DnaStage, unknown>>;
  /** The picture-capable AI model the user chose to read the frames (null: the current model). */
  visionModel?: DnaVisionModel | null;
}

/** A model that can see pictures, from one of the user's own providers. */
export interface DnaVisionModel {
  provider: string;
  model: string;
  label?: string;
}

/** A job's stages in today's order, keeping what an older job already finished. */
export function stagesOf(j: Pick<DnaJob, 'stages'>): DnaJob['stages'] {
  return DNA_STAGES.map(([id, label]) => j.stages.find((s) => s.id === id) ?? { id, label, state: 'waiting' as const, detail: '' });
}

/** A blueprint in the shared library, as listed. */
export interface SharedDna {
  id: string;
  name: string;
  category: string;
  tags: string[];
  description: string;
  seconds: number;
  shots: number;
  aspect: 'vertical' | 'square' | 'landscape';
  rights: 'own' | 'licensed' | 'technique-only';
  saves: number;
  mine: boolean;
  publishedAt: string;
}
