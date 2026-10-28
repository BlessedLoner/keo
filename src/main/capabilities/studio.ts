import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { EditOp, FORMATS, projectDuration, TextStyle, type FormatId, type Project } from '../../shared/studio';
import { Mp4Reader } from '../studio/mp4';
import { kindOfFile, StudioError, type StudioService } from '../studio/studioService';
import { errorMessage } from '../util/errors';
import { CapabilityError, defineCapability, type AnyCapability, type CapabilityContext } from './types';
import { mentions } from './video';

/**
 * Keo Studio for Keo itself: the same projects the user edits by hand in the Studio page, edited
 * through the same all-or-nothing operations (each one can be undone, by Keo or the user), checked
 * by looking at the drawn frames, and exported only after the user approves.
 */
export interface StudioToolDeps {
  studio: StudioService;
  /** Windows' file picker for media (absent in tests unless injected). */
  pick?: () => Promise<string[]>;
  /** Brings Keo's window forward on the Studio page. */
  showStudio: () => void;
  /** Where exported videos go (for the approval card). */
  outputRoot: () => string;
  /** Why the model may not look at frames (null: it may), and who would see them. */
  visionBlocked: () => string | null;
  visionDestination: () => string;
  askVision: (pngs: Buffer[], prompt: string, signal: AbortSignal) => Promise<string>;
  /** The user's own recent messages in a conversation (never the model's, never page content). */
  userTexts: (conversationId: string) => string[];
  /** Where captions' sound goes (null: no speech-to-text available). */
  captionSource: () => { destination: string; exact: boolean } | null;
  captions: (projectId: string, o: { maxWords: number; style?: Partial<TextStyle>; highlight?: string | null; signal: AbortSignal }) => Promise<{ lines: Array<{ text: string; start: number; end: number }>; words: number; exact: boolean }>;
  /** Shows Keo's step list in the Studio page. */
  checklist: (projectId: string, steps: Step[]) => void;
}

const Step = z.object({ label: z.string().trim().min(1).max(80), status: z.enum(['pending', 'running', 'done', 'skipped', 'failed']), note: z.string().trim().max(160).optional() }).strict();
type Step = z.infer<typeof Step>;

const ProjectId = z.string().regex(/^pr_[A-Za-z0-9]{4,24}$/).describe('Studio project id; omit for the project open in Studio');
const fail = (code: string, message: string) => new CapabilityError(code, message, { dispatched: 'no' });

/** StudioService errors are the model's to fix (wrong id, impossible edit): nothing happened. */
function run<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof StudioError) throw fail('studio', e.message);
    throw e;
  }
}

function state(s: StudioService, p: Project) {
  return { projectId: p.id, durationSec: projectDuration(p), timeline: s.describe(p.id), history: s.canUndo(p.id) };
}
const State = z.object({ projectId: z.string(), durationSec: z.number(), timeline: z.string(), history: z.object({ undo: z.boolean(), redo: z.boolean() }) });

const OPS_HELP =
  'Operations (all apply or none do): add_media {assetId, start (seconds or "end"), in, duration, track, fit, transform}; add_text {text, start, duration, style, transform, animIn, animOut}; add_audio {assetId, start, in, duration, volume}; move {clip, start, track}; trim {clip, trimStart (seconds cut from its start, the end stays), duration}; split {clip, at}; delete {clip, ripple}; cut_range {from, to} (removes that time from every track and closes the gap: use it for silences, filler words and retakes); set {clip, text, style, transform, volume, speed, fadeIn, fadeOut, fit, animIn, animOut, animSeconds, highlight}; add_track {kind}; set_track {track, hidden, muted, name}; delete_track {track}; set_project {name, width, height, fps, background}. ' +
  'Positions are fractions of the frame (x 0.5, y 0.5 = centre; captions sit near y 0.75); text size is a percentage of the frame height (captions 5–7, titles 8–12); colours are #RRGGBB. Text animations in: fade, pop, slide-up, typewriter, blur-in, words (word by word); out: fade, pop, slide-down, blur-out. Style: font, sizePct, weight normal|bold|black, color, color2 (gradient), outline, outlineColor, shadow, glow, glowColor, box, boxColor, uppercase, letterSpacing. Later tracks are drawn on top.';

export function studioCapabilities(d: StudioToolDeps): AnyCapability[] {
  const s = d.studio;

  const open = defineCapability({
    id: 'studio.open',
    version: '1.0.0',
    title: 'Open Keo Studio',
    description:
      'Open a Keo Studio project (the video editor inside Keo, where the user can watch and edit along) or create a new one, and show it to the user. Returns the timeline: media ids (as_…), tracks (tr_…) and clips (cl_…) with their times. Use Studio for any video the user wants made or edited in Keo; then add media (studio__add_media) and edit (studio__edit).',
    input: z
      .object({
        projectId: ProjectId.optional(),
        create: z.object({ name: z.string().trim().min(1).max(120), format: z.enum(Object.keys(FORMATS) as [FormatId, ...FormatId[]]).default('vertical') }).strict().optional().describe('Make a new project: vertical 9:16 for TikTok/Reels/Shorts, landscape 16:9 for YouTube, square, portrait 4:5'),
        show: z.boolean().default(true),
      })
      .strict(),
    output: State.extend({ projects: z.array(z.object({ id: z.string(), name: z.string(), durationSec: z.number() })) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Projects live in Keo’s own folder; nothing outside it changes.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: i.create ? `Make a Studio project “${i.create.name}”` : 'Open Keo Studio', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ create: !!i.create, format: i.create?.format ?? null }),
    async execute(i) {
      const p = run(() => (i.create ? s.create(i.create.name, i.create.format) : i.projectId ? s.open(i.projectId) : s.current ? s.resolve() : null));
      if (i.show) d.showStudio();
      const projects = s.list().slice(0, 20).map((x) => ({ id: x.id, name: x.name, durationSec: x.duration }));
      if (!p) return { projectId: '', durationSec: 0, timeline: 'No project is open. Create one with create {name, format}, or open one of these projects.', history: { undo: false, redo: false }, projects };
      return { ...state(s, p), projects };
    },
  });

  const addMedia = defineCapability({
    id: 'studio.add_media',
    version: '1.0.0',
    title: 'Add videos, pictures or sound to Studio',
    description:
      'Add media files to the Studio project. Without paths, Windows’ file picker opens and the user chooses (best when the user has not typed a full path). With paths, only files the user named in this conversation (full path, or the file name with its extension) are used. placeOnTimeline puts each one after the last clip (videos and pictures on the video track, sound on an audio track). Returns the media ids to use in studio__edit.',
    input: z
      .object({
        projectId: ProjectId.optional(),
        paths: z.array(z.string().trim().min(4).max(500)).min(1).max(50).optional(),
        placeOnTimeline: z.boolean().default(false),
      })
      .strict(),
    output: State.extend({ added: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string(), durationSec: z.number(), width: z.number(), height: z.number(), hasAudio: z.boolean() })), skipped: z.array(z.string()) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The files are read, never changed; each one is measured before it is added.',
    unavailableReason: () => null,
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: i.paths ? `Add ${i.paths.length} file${i.paths.length === 1 ? '' : 's'} to the video` : 'Ask you to pick videos, pictures or sound', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ files: i.paths?.length ?? 0, picker: !i.paths, place: i.placeOnTimeline }),
    async execute(i, ctx) {
      const p = run(() => s.resolve(i.projectId));
      let files: string[];
      if (i.paths) files = i.paths.map((x) => trusted(d, x, ctx));
      else {
        if (!d.pick) throw fail('no_picker', 'The file picker is available only in the Keo app. Ask the user for the full path of each file.');
        files = await d.pick();
        if (!files.length) throw fail('cancelled', 'The user closed the picker without choosing anything. Nothing was added.');
      }
      for (const f of files) {
        let st: fs.Stats;
        try {
          st = fs.statSync(f);
        } catch {
          throw fail('not_found', `There is no file at ${f}. Nothing was added.`);
        }
        if (!st.isFile()) throw fail('wrong_kind', `${f} is not a file. Nothing was added.`);
        if (!kindOfFile(f)) throw fail('wrong_type', `${path.basename(f)} is not a video, picture or sound file Keo Studio can use. Nothing was added.`);
      }
      const r = await s.importFiles(p.id, files).catch((e: unknown) => {
        throw e instanceof StudioError ? fail('studio', e.message) : e;
      });
      let project = r.project;
      if (i.placeOnTimeline && r.added.length) {
        const ops: EditOp[] = r.added.map((a) => (a.kind === 'audio' ? { op: 'add_audio', assetId: a.id, start: 'end' } : { op: 'add_media', assetId: a.id, start: 'end' }));
        project = run(() => s.edit(p.id, ops)).project;
      }
      return { ...state(s, project), added: r.added.map((a) => ({ id: a.id, kind: a.kind, name: a.name, durationSec: a.duration, width: a.width, height: a.height, hasAudio: a.hasAudio })), skipped: r.skipped };
    },
  });

  const edit = defineCapability({
    id: 'studio.edit',
    version: '1.0.0',
    title: 'Edit the video in Studio',
    description: `Change the Studio timeline with exact operations; the user sees each change live and can undo it. ${OPS_HELP} Times are seconds on the timeline. After a few edits, look at the result (studio__look) before telling the user it is done.`,
    input: z.object({ projectId: ProjectId.optional(), ops: z.array(EditOp).min(1).max(200) }).strict(),
    output: State.extend({ changes: z.array(z.string()) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Every operation is checked; the whole set applies or none does, and it can be undone.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Edit the video (${[...new Set(i.ops.map((o) => o.op))].join(', ')})`, target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ ops: i.ops.map((o) => o.op) }),
    async execute(i) {
      const p = run(() => s.resolve(i.projectId));
      const r = run(() => s.edit(p.id, i.ops));
      return { ...state(s, r.project), changes: r.changes };
    },
  });

  const undo = defineCapability({
    id: 'studio.undo',
    version: '1.0.0',
    title: 'Undo or redo a Studio change',
    description: 'Undo the last change to the Studio project (Keo’s or the user’s), or redo it.',
    input: z.object({ projectId: ProjectId.optional(), redo: z.boolean().default(false) }).strict(),
    output: State,
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 15_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Restores the previous version exactly.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: i.redo ? 'Redo the Studio change' : 'Undo the last Studio change', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ redo: i.redo }),
    async execute(i) {
      const p = run(() => s.resolve(i.projectId));
      return state(s, run(() => (i.redo ? s.redoEdit(p.id) : s.undoEdit(p.id))));
    },
  });

  const look = defineCapability({
    id: 'studio.look',
    version: '1.0.0',
    title: 'Look at the video',
    description:
      'Draw frames of the Studio timeline at the given seconds (exactly as the export will look) and have them described, to check your own work: is the text readable and inside the frame, does it cover faces, are captions in sync, is anything black or cut off. Ask a specific question.',
    input: z.object({ projectId: ProjectId.optional(), times: z.array(z.number().min(0).max(86400)).min(1).max(6), question: z.string().trim().min(3).max(400).default('Describe each frame and point out anything that looks wrong for a finished video.') }).strict(),
    output: z.object({ times: z.array(z.number()), answer: z.string() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 3 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only: frames are drawn in Keo’s own render window.',
    unavailableReason: () => d.visionBlocked(),
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Look at ${i.times.length} frame${i.times.length === 1 ? '' : 's'} of the video`, target: null, consequences: [], dataExport: `The frames are sent to ${d.visionDestination()}.` }),
    auditView: (i) => ({ frames: i.times.length }),
    async execute(i, ctx) {
      const blocked = d.visionBlocked();
      if (blocked) throw fail('vision_blocked', blocked);
      const p = run(() => s.resolve(i.projectId));
      const end = projectDuration(p);
      if (end === 0) throw fail('empty', 'The timeline is empty: there is nothing to look at yet.');
      const times = [...new Set(i.times.map((t) => Math.min(Math.max(0, t), Math.max(0, end - 0.02))))];
      const frames = await s.frames(p.id, times, 512).catch((e: unknown) => {
        throw fail('render', `The frames could not be drawn: ${errorMessage(e).slice(0, 200)}`);
      });
      const prompt = `These are ${frames.length} frames of a ${p.width}x${p.height} video being edited, at ${frames.map((f) => `${f.time.toFixed(2)} s`).join(', ')}. ${i.question} Reply as JSON: {"frames":[{"time":seconds,"description":"..."}],"problems":["..."]}.`;
      const answer = await d.askVision(
        frames.map((f) => f.png),
        prompt,
        ctx.signal,
      );
      return { times: frames.map((f) => f.time), answer: answer.slice(0, 4000) };
    },
  });

  const checklist = defineCapability({
    id: 'studio.checklist',
    version: '1.0.0',
    title: 'Show Keo’s editing steps',
    description:
      'Show the user your plan for a longer edit as a checklist in the Studio page (for example: Find silences, Transcribe, Find filler words, Cut retakes, Clean the audio, Colour, Captions, B-roll, Music), then update it as each step runs, is done, is skipped or fails. Send the whole list each time.',
    input: z.object({ projectId: ProjectId.optional(), steps: z.array(Step).min(1).max(20) }).strict(),
    output: z.object({ shown: z.boolean() }),
    risk: 'read',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 5_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Only shows a list in Keo’s window.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Show the editing steps', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ steps: i.steps.length }),
    async execute(i) {
      const p = run(() => s.resolve(i.projectId));
      d.checklist(p.id, i.steps);
      return { shown: true };
    },
  });

  const captions = defineCapability({
    id: 'studio.captions',
    version: '1.0.0',
    title: 'Add captions',
    description:
      'Transcribe the speech in the Studio timeline and add word-by-word captions (the spoken word lights up) on the Captions track, replacing earlier auto-captions. One edit: it can be undone. maxWords: words per line (2–3 for short-form videos, 5–7 for longer ones). After it, look at a frame or two (studio__look) and fix wrong words with studio__edit set {clip, text}.',
    input: z
      .object({
        projectId: ProjectId.optional(),
        maxWords: z.number().int().min(1).max(8).default(3),
        style: TextStyle.partial().optional().describe('Caption look; default bold white capitals with a black outline'),
        highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional().describe('Colour of the word being spoken (null: none); default yellow'),
      })
      .strict(),
    output: z.object({ lines: z.number(), words: z.number(), exactTiming: z.boolean(), firstLines: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })) }),
    risk: 'low',
    // The video's sound leaves the PC (to the speech-to-text service): the user approves each time.
    approval: 'always',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 30 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The captions are added in one edit that can be undone.',
    unavailableReason: () => (d.captionSource() ? null : 'Captions need speech-to-text: the user signs in to their Keo account, or adds an OpenAI API key in Settings → Providers.'),
    autonomy: () => ({ tier: 'important', reason: 'the video’s sound is sent to a speech-to-text service' }),
    preview: () => {
      const src = d.captionSource();
      return { summary: 'Add captions to the video', target: null, consequences: ['Adds caption lines on the Captions track (can be undone).'], dataExport: `The video’s sound is sent to ${src?.destination ?? 'the speech-to-text service'} to turn the speech into text.` };
    },
    auditView: (i) => ({ maxWords: i.maxWords }),
    async execute(i, ctx) {
      const p = run(() => s.resolve(i.projectId));
      const r = await d.captions(p.id, { maxWords: i.maxWords, ...(i.style ? { style: i.style } : {}), ...(i.highlight !== undefined ? { highlight: i.highlight } : {}), signal: ctx.signal }).catch((e: unknown) => {
        throw e instanceof StudioError ? fail('studio', e.message) : e;
      });
      return { lines: r.lines.length, words: r.words, exactTiming: r.exact, firstLines: r.lines.slice(0, 8).map((l) => ({ text: l.text, start: l.start, end: l.end })) };
    },
  });

  const exportVideo = defineCapability({
    id: 'studio.export',
    version: '1.0.0',
    title: 'Export the video',
    description: 'Make the finished MP4 (H.264 with AAC sound) from the Studio project into the user’s Videos\\Keo folder (a new file; existing files are never replaced) and check it. Look at the video (studio__look) before exporting.',
    input: z.object({ projectId: ProjectId.optional() }).strict(),
    output: z.object({ file: z.string(), durationSec: z.number(), frames: z.number(), bytes: z.number() }),
    risk: 'low',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 6 * 3600_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The saved file is read back: its video track, length and frame count must match the timeline.',
    // A new file in Keo's own output folder; nothing is replaced or sent anywhere.
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => {
      let what = '';
      try {
        const p = s.resolve(i.projectId);
        what = ` “${p.name}” (${projectDuration(p).toFixed(1)} s, ${p.width}×${p.height})`;
      } catch {
        // No project: the action fails with its own message.
      }
      return { summary: `Save the video${what}`, target: d.outputRoot(), consequences: ['Creates a new MP4 file; existing files are never replaced.'], dataExport: null };
    },
    auditView: () => ({}),
    async execute(i) {
      const p = run(() => s.resolve(i.projectId));
      if (projectDuration(p) === 0) throw fail('empty', 'The timeline is empty: add media first.');
      return await s.exportVideo(p.id).catch((e: unknown) => {
        throw e instanceof StudioError ? fail('studio', e.message) : e;
      });
    },
    verify: (_i, o) => Promise.resolve(checkExport(o)),
  });

  return [open, addMedia, edit, undo, look, checklist, captions, exportVideo];
}

/** A path the model proposes is used only when the user wrote it (or the file's name) in this conversation. */
function trusted(d: StudioToolDeps, p: string, ctx: CapabilityContext): string {
  if (!path.isAbsolute(p)) throw fail('not_absolute', `Give the full path of the file (like C:\\Users\\you\\Videos\\clip.mp4), or call studio__add_media without paths so the user can pick it. Nothing was added.`);
  const full = path.resolve(p);
  const texts = ctx.conversationId ? d.userTexts(ctx.conversationId) : [];
  if (mentions(texts, full) || mentions(texts, p.trim()) || mentions(texts, path.basename(full))) return full;
  throw fail('not_named', 'Keo adds only files the user named or picked. Call studio__add_media without paths so the user can pick them. Nothing was added.');
}

/** The saved file read back: a video track with every frame of the timeline. */
function checkExport(o: { file: string; durationSec: number; frames: number }): { verified: boolean; detail: string } {
  const r = Mp4Reader.open(o.file);
  try {
    const v = r?.video();
    const ok = !!v && v.samples.length === o.frames && o.frames > 0;
    return { verified: ok, detail: ok ? `${o.frames} frames, ${o.durationSec.toFixed(1)} s${r?.audio() ? ', with sound' : ''}` : 'The saved file does not have the expected video track.' };
  } finally {
    r?.close();
  }
}
