import { z } from 'zod';
import { CAPTION_STYLE, FORMATS, LOOKS, type EditOp, type FormatId, type LookId, type Project, type Span, type TextStyle, type Zoom } from './studio';
import { CharacterId, speakerOf, type Character } from './studioCharacters';

/**
 * The faceless creator: a storyboard (narration and a picture per scene) becomes a finished
 * video — a voice reading each scene, its picture moving (push-ins, pans), transitions, a title
 * where the scene has one, word-by-word captions, music under the voice and sound effects on the
 * cuts. The storyboard is turned into ordinary Studio edits, so everything can be changed after.
 */

const AssetRef = z.string().regex(/^as_[A-Za-z0-9]{4,24}$/);

export const SceneMotion = z.enum(['push-in', 'pull-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down', 'still']);
export const SceneCut = z.enum(['cut', 'fade', 'whip', 'flash', 'zoom', 'slide']);

export const Scene = z
  .object({
    /** What the voice says in this scene. */
    narration: z.string().trim().min(1).max(1500),
    /** The picture: made with AI from this description, or media of the project. Default: made from the narration. */
    picture: z.union([z.object({ prompt: z.string().trim().min(5).max(2000) }).strict(), z.object({ assetId: AssetRef }).strict()]).optional(),
    /** Big text on screen at the start of the scene (a hook, a number, a heading). */
    title: z.string().trim().min(1).max(80).optional(),
    motion: SceneMotion.optional(),
    /** How this scene comes in after the one before. */
    transition: SceneCut.optional(),
    /** Seconds of picture after the narration ends. */
    hold: z.number().min(0).max(5).default(0.35),
    /** The character who says this line (their voice, and their picture when the scene has none). */
    speaker: CharacterId.optional(),
  })
  .strict();
export type Scene = z.infer<typeof Scene>;

export const Storyboard = z
  .object({
    title: z.string().trim().min(1).max(120),
    format: z.enum(Object.keys(FORMATS) as [FormatId, ...FormatId[]]).default('vertical'),
    /** Keo's voices (female, male), or an OpenAI voice name with the user's own key. */
    voice: z.string().regex(/^[a-z]{2,20}$/).default('female'),
    /** Added to every picture description so the pictures look like one set (e.g. "cinematic photo, moody light"). */
    pictureStyle: z.string().trim().max(300).default(''),
    captions: z.enum(['bold', 'clean', 'karaoke', 'none']).default('bold'),
    look: z.enum([...(Object.keys(LOOKS) as [LookId, ...LookId[]]), 'off']).default('off'),
    /** Background music: a sound file of the project (the user's own or licensed). */
    music: AssetRef.optional(),
    musicVolume: z.number().min(0).max(1).default(0.25),
    soundEffects: z.boolean().default(true),
    /** The characters in this video (lines starting with their name are theirs). */
    cast: z.array(CharacterId).max(12).optional(),
    scenes: z.array(Scene).min(1).max(60),
  })
  .strict();
export type Storyboard = z.infer<typeof Storyboard>;

/**
 * A storyboard from plain text: one scene per paragraph ("[picture: …]" lines describe the picture);
 * a paragraph starting with a cast member's name ("Kira: …") is their line.
 */
export function scenesFromScript(script: string, cast: Array<Pick<Character, 'id' | 'name'>> = []): Scene[] {
  const paras = script
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return paras.slice(0, 60).map((para) => {
    const pic = /^\s*\[(?:picture|image|visual)\s*:\s*([^\]]+)\]\s*$/im.exec(para);
    const title = /^\s*\[title\s*:\s*([^\]]+)\]\s*$/im.exec(para);
    const narration = para
      .replace(/^\s*\[(?:picture|image|visual|title)\s*:[^\]]*\]\s*$/gim, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1500);
    const said = cast.length ? speakerOf(narration, cast) : null;
    return Scene.parse({ narration: (said?.text ?? narration) || title?.[1]?.trim() || 'Scene', ...(pic ? { picture: { prompt: pic[1]!.trim() } } : {}), ...(title ? { title: title[1]!.trim().slice(0, 80) } : {}), ...(said ? { speaker: said.character } : {}) });
  });
}

/** The picture size to ask the AI for, by video format. */
export function pictureSize(format: FormatId): '1024x1536' | '1536x1024' | '1024x1024' {
  return format === 'landscape' ? '1536x1024' : format === 'square' ? '1024x1024' : '1024x1536';
}

/** What was made for each scene: its picture and its voice (with where the voice speaks, from 0). */
export interface SceneMedia {
  pictureId: string;
  voiceId: string;
  voiceSeconds: number;
  speech: Span[];
}

const MOTIONS: Array<z.infer<typeof SceneMotion>> = ['push-in', 'pan-right', 'pull-out', 'pan-left', 'push-in', 'pan-up'];
const CUTS: Array<z.infer<typeof SceneCut>> = ['fade', 'whip', 'zoom', 'flash', 'slide', 'whip'];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** A picture's slow movement over d seconds, as zoom keyframes. */
function moveFor(m: z.infer<typeof SceneMotion>, d: number): Zoom[] | undefined {
  const k = (scale: number, x = 0.5, y = 0.5) => ({ scale, x, y });
  const ramp = (a: ReturnType<typeof k>, b: ReturnType<typeof k>): Zoom[] => [
    { at: 0, ...a, ease: 'cut' },
    { at: r3(d), ...b, ease: 'ramp' },
  ];
  switch (m) {
    case 'push-in':
      return ramp(k(1), k(1.16));
    case 'pull-out':
      return ramp(k(1.16), k(1));
    case 'pan-left':
      return ramp(k(1.18, 0.62), k(1.18, 0.38));
    case 'pan-right':
      return ramp(k(1.18, 0.38), k(1.18, 0.62));
    case 'pan-up':
      return ramp(k(1.18, 0.5, 0.62), k(1.18, 0.5, 0.38));
    case 'pan-down':
      return ramp(k(1.18, 0.5, 0.38), k(1.18, 0.5, 0.62));
    case 'still':
      return undefined;
  }
}

/** Words of a narration spread over where the voice speaks (by their length). */
function wordsOver(text: string, spans: Span[], offset: number): Array<{ text: string; start: number; end: number }> {
  const words = text.split(/\s+/).filter(Boolean);
  const total = spans.reduce((t, s) => t + (s.end - s.start), 0);
  if (!words.length || total <= 0) return [];
  const weight = (w: string) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1.5;
  const sum = words.reduce((t, w) => t + weight(w), 0);
  const at = (pos: number) => {
    let left = pos;
    for (const s of spans) {
      if (left <= s.end - s.start) return s.start + left;
      left -= s.end - s.start;
    }
    return spans.at(-1)!.end;
  };
  let pos = 0;
  return words.map((w) => {
    const len = (weight(w) / sum) * total;
    const out = { text: w, start: r3(offset + at(pos + 0.001)), end: r3(offset + at(pos + len)) };
    pos += len;
    return out;
  });
}

/** Caption lines of up to `max` words (a new line after a sentence ends). */
function lines(words: Array<{ text: string; start: number; end: number }>, max: number): Array<{ text: string; start: number; end: number; words: typeof words }> {
  const out: Array<{ text: string; start: number; end: number; words: typeof words }> = [];
  let cur: typeof words = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map((w) => w.text).join(' '), start: cur[0]!.start, end: cur.at(-1)!.end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (cur.length >= max || /[.!?…]$/.test(prev.text) || w.start - prev.end > 0.45)) flush();
    cur.push(w);
  }
  flush();
  for (let i = 0; i < out.length; i++) out[i]!.end = r3(out[i + 1] ? Math.min(out[i + 1]!.start, out[i]!.end + 0.25) : out[i]!.end + 0.3);
  return out;
}

const CAPTION_LOOKS: Record<'bold' | 'clean' | 'karaoke', { style: Partial<TextStyle>; highlight: string | null; maxWords: number }> = {
  bold: { style: { ...CAPTION_STYLE }, highlight: '#FFD400', maxWords: 3 },
  karaoke: { style: { ...CAPTION_STYLE, sizePct: 6.4, color: '#FFFFFF', outline: 8 }, highlight: '#35F2C2', maxWords: 2 },
  clean: { style: { sizePct: 4.2, weight: 'bold', color: '#FFFFFF', outline: 0, shadow: 6, uppercase: false, box: true, boxColor: '#000000A6', maxWidth: 0.84 }, highlight: null, maxWords: 6 },
};

/**
 * The edits that build the video from the storyboard and what was made for it. `sfx`: Keo's
 * whoosh sound (a sound asset of the project) for the cuts, when sound effects are on.
 */
export function facelessOps(p: Project, board: Storyboard, media: SceneMedia[], o: { sfx?: string } = {}): { ops: EditOp[]; duration: number } {
  const f = FORMATS[board.format];
  const ops: EditOp[] = [{ op: 'set_project', name: board.title, width: f.width, height: f.height, background: '#000000', loudness: 'social' }];
  const captionWords: Array<{ text: string; start: number; end: number }> = [];
  let t = 0;
  board.scenes.forEach((scene, i) => {
    const m = media[i]!;
    const d = r3(Math.max(1.5, m.voiceSeconds + scene.hold));
    const cut = i === 0 ? null : (scene.transition ?? CUTS[(i - 1) % CUTS.length]!);
    const enter =
      cut === 'fade' ? { kind: 'fade' as const, seconds: 0.4 } : cut === 'whip' ? { kind: 'whip' as const, seconds: 0.3 } : cut === 'flash' ? { kind: 'flash' as const, seconds: 0.3 } : cut === 'zoom' ? { kind: 'zoom-out' as const, seconds: 0.35 } : cut === 'slide' ? { kind: 'slide-left' as const, seconds: 0.35 } : undefined;
    const zooms = moveFor(scene.motion ?? MOTIONS[i % MOTIONS.length]!, d);
    ops.push({ op: 'add_media', assetId: m.pictureId, start: r3(t), duration: d, fit: 'cover', ...(zooms ? { zooms } : {}), ...(enter ? { enter } : {}) });
    ops.push({ op: 'add_audio', assetId: m.voiceId, trackName: 'Voice', start: r3(t), duration: r3(Math.min(m.voiceSeconds, d)) });
    if (scene.title)
      ops.push({
        op: 'add_text',
        text: scene.title,
        start: r3(t + 0.1),
        duration: r3(Math.min(2.6, d - 0.1)),
        animIn: 'letters',
        animOut: 'fade',
        animSeconds: 0.45,
        style: { sizePct: board.format === 'landscape' ? 9 : 7.5, weight: 'black', color: '#FFFFFF', color2: '#FFD400', glow: 16, glowColor: '#000000', uppercase: true, shadow: 16 },
        transform: { y: 0.3 },
      });
    if (cut && cut !== 'cut' && board.soundEffects && o.sfx) ops.push({ op: 'add_audio', assetId: o.sfx, trackName: 'Effects', start: r3(Math.max(0, t - 0.15)), volume: 0.45 });
    if (board.captions !== 'none') captionWords.push(...wordsOver(scene.narration, m.speech.length ? m.speech : [{ start: 0, end: m.voiceSeconds }], t));
    t += d;
  });
  if (board.captions !== 'none' && captionWords.length) {
    const look = CAPTION_LOOKS[board.captions];
    ops.push({ op: 'add_captions', lines: lines(captionWords, look.maxWords), replace: true, style: look.style, highlight: look.highlight, animIn: 'pop' });
  }
  if (board.music) {
    const song = p.assets.find((a) => a.id === board.music);
    if (song && song.kind === 'audio' && song.duration > 0.5) {
      // The song again after it ends, until the video ends.
      for (let at = 0; at < t - 0.2; at += song.duration) ops.push({ op: 'add_audio', assetId: song.id, trackName: 'Music', start: r3(at), duration: r3(Math.min(song.duration, t - at)), volume: board.musicVolume, duck: -14 });
    }
  }
  return { ops, duration: r3(t) };
}

/** The look of every picture of the video (a second edit, so it can be undone on its own). */
export function lookOps(p: Project, look: LookId | 'off'): EditOp[] {
  if (look === 'off') return [];
  return p.tracks.flatMap((tr) => tr.clips.filter((c) => c.type === 'media').map((c) => ({ op: 'set' as const, clip: c.id, color: { ...LOOKS[look] } })));
}
