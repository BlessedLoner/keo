import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Aspect, cutInto, DirectionOp, editLabel, TRANSITIONS, totalSeconds } from '../video/recipe';
import { AUDIO_EXT, VIDEO_EXT, type VideoProject, type VideoStudio } from '../video/studio';
import type { CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability, type CapabilityContext } from './types';

export interface VideoDeps extends CapabilityDeps {
  studio: VideoStudio;
  /** Keo's own file/folder picker (absent in tests unless injected). */
  pick?: (what: 'template' | 'clips_folder' | 'music') => Promise<string | null>;
  /** Shows the preview window. */
  showPreview: () => void;
  /** Where finished videos go (for the approval card). */
  outputRoot: () => string;
  /** Who would see the frames / the clips' sound (for the approval card). */
  visionDestination: () => string;
  /** The user's own recent messages in a conversation (never the model's, never page content). */
  userTexts: (conversationId: string) => string[];
}

/** The user wrote this path or name (any case, either slash), as a whole name, not inside another word. */
export function mentions(texts: string[], needle: string): boolean {
  const norm = (t: string) => t.toLowerCase().replace(/\//g, '\\').replace(/[“”]/g, '"');
  const n = norm(needle.trim());
  if (n.length < 3) return false;
  return texts.some((t) => {
    const h = norm(t);
    for (let at = h.indexOf(n); at >= 0; at = h.indexOf(n, at + 1)) {
      const before = at === 0 ? '' : h[at - 1]!;
      const after = h[at + n.length] ?? '';
      if (!/[\p{L}\p{N}_.-]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    }
    return false;
  });
}

const ProjectId = z.string().regex(/^vp_[a-z0-9]{6,20}$/).describe('Video project id from an earlier video__ result; omit for the current project');
const FilePath = z.string().trim().min(4).max(500);

const fail = (code: string, message: string) => new CapabilityError(code, message, { dispatched: 'no' });

/**
 * A path the model proposes is used only when the user chose it in Keo's picker or wrote it (or
 * its file/folder name) in this conversation — never a file some page or document mentioned.
 */
function trusted(d: VideoDeps, p: string, ctx: CapabilityContext, what: string, folder = false): string {
  if (!path.isAbsolute(p)) throw fail('not_absolute', `Give the full path of the ${what} (like C:\\Users\\you\\Videos\\clip.mp4), or use video__choose so the user can pick it. Nothing was read.`);
  const full = path.resolve(p);
  if (d.studio.wasPicked(full)) return full;
  // A file name with its extension is specific enough; a folder name ("clips") is not, so a folder needs its full path.
  const name = path.basename(full);
  const texts = ctx.conversationId ? d.userTexts(ctx.conversationId) : [];
  const said = mentions(texts, full) || mentions(texts, p.trim().replace(/[\\/]+$/, '')) || (!folder && mentions(texts, name));
  if (!said) throw fail('not_named', `Keo uses only files the user named or picked. Ask the user to pick the ${what} (video__choose) or to type its ${folder ? 'full path' : 'name'}. Nothing was read.`);
  return full;
}

function mustExist(full: string, kind: 'file' | 'dir', exts: readonly string[] | null, what: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    throw fail('not_found', `There is no ${what} at ${full}. Nothing was read.`);
  }
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) throw fail('wrong_kind', `${full} is not a ${kind === 'dir' ? 'folder' : 'file'}. Nothing was read.`);
  if (exts && !exts.includes(path.extname(full).toLowerCase())) throw fail('wrong_type', `${path.basename(full)} is not a ${what} Keo can use (${exts.join(' ')}). Nothing was read.`);
}

function summary(p: VideoProject) {
  const r = p.recipe!;
  return {
    projectId: p.id,
    title: r.title,
    aspect: r.aspect,
    totalSec: totalSeconds(r),
    shots: r.shots.map((s, i) => ({ index: i, clipId: s.clipId, inSec: s.inSec, durationSec: s.durationSec, speed: s.speed, cutIn: cutInto(r, i).kind, edit: editLabel(r, i), why: s.why ?? null })),
    texts: r.texts.map((t, i) => ({ index: i, text: t.text, startSec: t.startSec, endSec: t.endSec })),
    captions: { enabled: r.captions.enabled, sizePct: r.captions.sizePct, position: r.captions.position },
    transition: r.transition.kind,
    style: r.style,
    beats: r.beats.length,
    music: r.music ? path.basename(r.music.path) : null,
    notes: r.notes,
  };
}

const Summary = z.object({
  projectId: z.string(),
  title: z.string(),
  aspect: z.string(),
  totalSec: z.number(),
  shots: z.array(
    z.object({ index: z.number(), clipId: z.string(), inSec: z.number(), durationSec: z.number(), speed: z.number(), cutIn: z.string(), edit: z.string(), why: z.string().nullable() }),
  ),
  texts: z.array(z.object({ index: z.number(), text: z.string(), startSec: z.number(), endSec: z.number() })),
  captions: z.object({ enabled: z.boolean(), sizePct: z.number(), position: z.string() }),
  transition: z.string(),
  style: z.string(),
  beats: z.number(),
  music: z.string().nullable(),
  notes: z.array(z.string()),
});

export function videoCapabilities(d: VideoDeps): AnyCapability[] {
  const check = defineCapability({
    id: 'video.check_tools',
    version: '1.0.0',
    title: 'Check video tools',
    description: 'Check whether Keo can edit videos on this PC (ffmpeg found, which encoder, whether captions can be drawn). Keo never installs or downloads ffmpeg itself; if it is missing, tell the user how to get it.',
    input: z.object({}).strict(),
    output: z.object({ found: z.boolean(), encoder: z.string().nullable(), captions: z.boolean(), message: z.string() }),
    risk: 'read',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 30_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Check video tools', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    execute: (_i, ctx) => d.studio.status(ctx.signal),
  });

  const choose = defineCapability({
    id: 'video.choose',
    version: '1.0.0',
    title: 'Ask the user to pick a video file or folder',
    description: 'Open Keo’s file picker so the user can choose the template video, the folder of clips, or a music file from their PC. Use it whenever the user has not typed the full path.',
    input: z.object({ what: z.enum(['template', 'clips_folder', 'music']) }).strict(),
    output: z.object({ path: z.string().nullable() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The user chooses in Windows’ own dialog; null means they cancelled.',
    unavailableReason: () => (d.pick ? null : 'The file picker is available only in the Keo app.'),
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Ask you to pick the ${i.what === 'clips_folder' ? 'clips folder' : i.what === 'music' ? 'music file' : 'template video'}`, target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ what: i.what }),
    async execute(i) {
      const p = await d.pick!(i.what);
      if (p) d.studio.notePicked(p);
      return { path: p };
    },
  });

  const analyzeTemplate = defineCapability({
    id: 'video.analyze_template',
    version: '1.0.0',
    title: 'Analyse a template video',
    description:
      'Analyse the template video the user wants to copy: its length, format, shot list (cuts), beat timing, and — when allowed — its look (text on screen, caption style, colours, hook, pacing) from a few frames. Locally with ffmpeg; only the frames go to the model. Then analyse the clips (video__analyze_clips) and plan the edit (video__plan_edit).',
    input: z.object({ templatePath: FilePath.describe('Full path of the template video the user named or picked'), projectId: ProjectId.optional(), lookAtFrames: z.boolean().default(true) }).strict(),
    output: z.object({
      projectId: z.string(),
      durationSec: z.number(),
      aspect: z.string(),
      shots: z.number(),
      shotLengths: z.array(z.number()),
      tempoBpm: z.number().nullable(),
      beats: z.number(),
      style: z.unknown(),
      styleNote: z.string().nullable(),
    }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 6 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only: the template is read, never changed.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Analyse the template ${path.basename(i.templatePath)}`, target: i.templatePath, consequences: [], dataExport: i.lookAtFrames ? `Up to 6 frames are sent to ${d.visionDestination()} (only if screen-content export to it is allowed).` : null }),
    auditView: (i) => ({ ext: path.extname(i.templatePath).toLowerCase(), lookAtFrames: i.lookAtFrames }),
    async execute(i, ctx) {
      const file = trusted(d, i.templatePath, ctx, 'template video');
      mustExist(file, 'file', VIDEO_EXT, 'video');
      const { project, template } = await d.studio.analyzeTemplate(file, { ...(i.projectId ? { projectId: i.projectId } : {}), conversationId: ctx.conversationId, useVision: i.lookAtFrames, signal: ctx.signal });
      return {
        projectId: project.id,
        durationSec: template.durationSec,
        aspect: template.aspect,
        shots: template.shots.length,
        shotLengths: template.shots.slice(0, 60).map((s) => s.durationSec),
        tempoBpm: template.tempoBpm,
        beats: template.beats.length,
        style: template.style,
        styleNote: template.styleNote,
      };
    },
  });

  const analyzeClips = defineCapability({
    id: 'video.analyze_clips',
    version: '1.0.0',
    title: 'Analyse a folder of clips',
    description:
      'Look at every video clip in the folder the user named or picked: length, format, the liveliest moments, and (when the user allowed it in Settings → Video) the spoken words for captions. Clips get ids c1, c2, … used by video__plan_edit and video__direct.',
    input: z.object({ folder: FilePath.describe('Full path of the clips folder'), projectId: ProjectId.optional(), captions: z.boolean().default(true), lookAtClips: z.boolean().default(true) }).strict(),
    output: z.object({
      projectId: z.string(),
      clips: z.array(z.object({ id: z.string(), name: z.string(), durationSec: z.number(), width: z.number(), height: z.number(), hasAudio: z.boolean(), words: z.number(), description: z.string().nullable() })),
      skipped: z.array(z.object({ name: z.string(), reason: z.string() })),
      captionsNote: z.string().nullable(),
    }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 20 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only: the clips are read, never changed.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({
      summary: `Analyse the clips in ${path.basename(i.folder)}`,
      target: i.folder,
      consequences: [],
      dataExport: [i.captions ? 'The clips’ sound is sent to OpenAI for captions (only if allowed in Settings → Video).' : null, i.lookAtClips ? `One frame per clip is sent to ${d.visionDestination()} (only if screen-content export to it is allowed).` : null].filter(Boolean).join(' ') || null,
    }),
    auditView: (i) => ({ captions: i.captions, lookAtClips: i.lookAtClips }),
    async execute(i, ctx) {
      const folder = trusted(d, i.folder, ctx, 'clips folder', true);
      mustExist(folder, 'dir', null, 'folder');
      const r = await d.studio.analyzeClips(folder, { ...(i.projectId ? { projectId: i.projectId } : {}), conversationId: ctx.conversationId, transcribe: i.captions, look: i.lookAtClips, signal: ctx.signal });
      return {
        projectId: r.project.id,
        clips: r.clips.map((c) => ({ id: c.id, name: c.name, durationSec: c.durationSec, width: c.width, height: c.height, hasAudio: c.hasAudio, words: c.words?.length ?? 0, description: c.description })),
        skipped: r.skipped,
        captionsNote: r.captionsNote,
      };
    },
  });

  const plan = defineCapability({
    id: 'video.plan_edit',
    version: '1.0.0',
    title: 'Plan the video edit',
    description:
      'Make the edit recipe from the analysed template and clips: the template’s rhythm scaled to the length, cuts on the music’s beat, the best clip moments, captions and an optional hook text and music file the user chose. Keo edits each cut like a short-form editor: mostly hard cuts, a stylised transition only where the template’s style fits, punch-ins on beats or spoken words, slow pushes on long shots, one speed ramp, and J/L cuts where speech crosses a cut. The result lists each shot’s cut and edit with why, and the overall style; tell the user the style in a sentence. Keo then renders a quick preview and opens the preview window, where the user can direct changes (video__direct). Nothing is saved to the user’s folders until video__render_final.',
    input: z
      .object({
        projectId: ProjectId.optional(),
        title: z.string().trim().min(1).max(120).optional(),
        targetSeconds: z.number().min(3).max(180).optional().describe('Default: the template’s length'),
        aspect: Aspect.optional().describe('Default: the template’s format'),
        captions: z.boolean().optional(),
        hook: z.string().trim().min(1).max(120).optional().describe('Text shown on screen for the first seconds, only if the user gave it or agreed to it'),
        transition: z.enum(TRANSITIONS).optional().describe('Only when the user asked for one look on every cut; omit it so Keo chooses per cut (mostly hard cuts)'),
        musicPath: FilePath.optional().describe('A music file on this PC that the user named or picked (their own or licensed). Never a downloaded song.'),
        clipVolume: z.number().min(0).max(2).optional(),
      })
      .strict(),
    output: Summary,
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 3 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The recipe is checked against its schema; the preview is made in Keo’s own folder.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Plan the video${i.title ? ` “${i.title}”` : ''}`, target: null, consequences: ['Makes a low-resolution preview in Keo’s own folder.'], dataExport: null }),
    auditView: (i) => ({ targetSeconds: i.targetSeconds ?? null, aspect: i.aspect ?? null, music: !!i.musicPath, hook: !!i.hook }),
    async execute(i, ctx) {
      let musicPath: string | null = null;
      if (i.musicPath) {
        musicPath = trusted(d, i.musicPath, ctx, 'music file');
        mustExist(musicPath, 'file', AUDIO_EXT, 'music file');
      }
      const { projectId, musicPath: _m, ...opts } = i;
      const p = await d.studio.plan({ ...opts, ...(projectId ? { projectId } : {}), musicPath, conversationId: ctx.conversationId, signal: ctx.signal });
      d.showPreview();
      return summary(p);
    },
  });

  const direct = defineCapability({
    id: 'video.direct',
    version: '1.0.0',
    title: 'Change the video',
    description:
      'Apply the user’s live instructions to the current edit as exact changes, then Keo re-renders the preview. Examples: "shorter intro" → trim_start; "bigger captions" → captions with a larger sizePct (current × 1.3); "make it 20 seconds" → set_length; "use clip 3 for the second shot" → swap_clip index 1 clipId c3; "whip into the third shot" → transition kind whip index 2; "punch in on shot 2" → zoom index 1 kind punch; "slow-mo the jump" → speed_ramp; "let the talking carry over" → audio_cut kind l; "cut on the beat" → beat_sync. Shot and text indexes start at 0; a cut is named by the shot it leads into. If any change cannot be applied, nothing is changed.',
    input: z.object({ projectId: ProjectId.optional(), changes: z.array(DirectionOp).min(1).max(20) }).strict(),
    output: Summary.extend({ changes: z.array(z.string()) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Each change is validated; the whole set applies or none does.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Change the video (${i.changes.map((c) => c.op).join(', ')})`, target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ ops: i.changes.map((c) => c.op) }),
    async execute(i, ctx) {
      const r = d.studio.direct(i.changes, { ...(i.projectId ? { projectId: i.projectId } : {}), conversationId: ctx.conversationId });
      d.showPreview();
      return { ...summary(r.project), changes: r.changes };
    },
  });

  const undo = defineCapability({
    id: 'video.undo',
    version: '1.0.0',
    title: 'Undo the last video change',
    description: 'Go back to the previous version of the edit and re-render the preview.',
    input: z.object({ projectId: ProjectId.optional() }).strict(),
    output: Summary,
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Restores the previous recipe exactly.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Undo the last video change', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i, ctx) {
      return summary(d.studio.undo({ ...(i.projectId ? { projectId: i.projectId } : {}), conversationId: ctx.conversationId }));
    },
  });

  const final = defineCapability({
    id: 'video.render_final',
    version: '1.0.0',
    title: 'Make the finished video',
    description: 'Render the current edit at full size into the user’s Videos\\Keo folder (a new file; existing files are never replaced) and check the result (length, size, sound, pictures).',
    input: z.object({ projectId: ProjectId.optional(), name: z.string().trim().min(1).max(60).optional().describe('File name without extension; default: the video title') }).strict(),
    output: z.object({ file: z.string(), durationSec: z.number(), width: z.number(), height: z.number(), notes: z.array(z.string()) }),
    risk: 'low',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 35 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'ffprobe checks the length, picture size and sound; frames at 10 %, 50 % and 90 % must decode.',
    // A new file in Keo's own output folder; nothing is replaced or sent anywhere.
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => {
      const p = d.studio.get(i.projectId);
      return {
        summary: `Save the video${p?.recipe ? ` “${p.recipe.title}” (${totalSeconds(p.recipe).toFixed(0)} s, ${p.recipe.aspect})` : ''}`,
        target: d.outputRoot(),
        consequences: ['Creates a new MP4 file; existing files are never replaced.'],
        dataExport: null,
      };
    },
    auditView: (i) => ({ named: !!i.name }),
    async execute(i, ctx) {
      const r = await d.studio.renderFinal({ ...(i.projectId ? { projectId: i.projectId } : {}), ...(i.name ? { name: i.name } : {}), conversationId: ctx.conversationId, signal: ctx.signal });
      return { file: r.file, durationSec: r.durationSec, width: r.width, height: r.height, notes: r.notes };
    },
    async verify(_i, o, ctx) {
      const v = await d.studio.verify(o.file, o, ctx.signal);
      return { verified: v.ok, detail: v.detail };
    },
  });

  return [check, choose, analyzeTemplate, analyzeClips, plan, direct, undo, final];
}
