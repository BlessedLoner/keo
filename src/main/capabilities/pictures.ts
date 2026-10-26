import path from 'node:path';
import { z } from 'zod';
import { AnimateSpec } from '../pictures/animate';
import { EditOp } from '../pictures/edit';
import { PictureError, type PictureStudio } from '../pictures/studio';
import { ProviderError } from '../providers/types';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

/**
 * Editing, animating and (optionally) making pictures. Edits and animations run on the user's PC
 * with ffmpeg and are free; making a picture, changing one with AI or removing a background goes to
 * the user's OpenAI account, costs money, and always asks first. Every result is a new file; the
 * source picture is never changed.
 */
export interface PictureDeps {
  studio: PictureStudio;
  /** Whether Keo may use this picture (the user's allowed folders, Documents\Keo, Keo's attachment copies). */
  allowed(p: string): boolean;
  openPath(p: string): Promise<boolean>;
  aiModel(): string;
  aiQuality(): 'low' | 'medium' | 'high';
}

const Source = z.string().trim().min(3).max(1000).describe('Full path of the picture (from an attachment, files__search or a picture Keo made)');
const Name = z.string().trim().min(1).max(120).optional().describe('File name for the result (without extension)');
const Folder = z.string().trim().min(3).max(500).optional().describe('Full path of a folder the user named; omit for Documents\\Keo');

const fail = (e: unknown): never => {
  if (e instanceof PictureError) throw new CapabilityError(e.code, e.message, { dispatched: e.code === 'render_failed' ? 'unknown' : 'no' });
  // OpenAI refused before doing anything (no key, no access, a bad request, no credit): nothing was made.
  if (e instanceof ProviderError && ['unconfigured', 'auth', 'bad_request', 'quota', 'rate_limit', 'refusal'].includes(e.kind))
    throw new CapabilityError(`openai_${e.kind}`, `${e.message} Nothing was made or charged for this request.`, { dispatched: 'no' });
  throw e;
};

export function pictureCapabilities(d: PictureDeps): AnyCapability[] {
  const where = (src: string, folder?: string) => {
    if (!path.isAbsolute(src)) return 'Give the full path of the picture.';
    if (!d.allowed(src)) return 'That picture is outside the folders Keo may use (Settings → Files).';
    if (folder && (!path.isAbsolute(folder) || !d.allowed(folder))) return 'That folder is outside the folders Keo may use. Omit folder to save in Documents\\Keo.';
    return null;
  };
  const baseName = (src: string, suffix: string) => `${path.parse(src).name} ${suffix}`;

  const edit = defineCapability({
    id: 'picture.edit',
    version: '1.0.0',
    title: 'Edit a picture',
    description:
      'Make an edited copy of a picture on this PC (free, nothing is uploaded): add text in a Windows font with colour, glow, outline or shadow; crop; resize; extend the canvas (e.g. extend right: 1 to make room for text beside a logo, then put the text at x≈0.75); pad to a square; rotate; flip; adjust brightness/contrast/saturation; grayscale; blur; sharpen; overlay another picture (a logo on a photo); rounded corners; a border. Operations run in order; positions and sizes are fractions (0–1) of the picture at that point. Look at the picture first when you need positions. The result is a new file (Documents\\Keo unless the user named a folder) and opens by default. For moving pictures, use picture__animate on the result.',
    input: z
      .object({
        source: Source,
        operations: z.array(EditOp).min(1).max(20),
        name: Name,
        format: z.enum(['png', 'jpg']).default('png'),
        folder: Folder,
        open: z.boolean().default(false).describe('Also open it in its usual app (it is shown in the chat either way)'),
      })
      .strict(),
    output: z.object({ path: z.string(), width: z.number(), height: z.number(), opened: z.boolean() }),
    risk: 'low',
    approval: 'always',
    autonomy: () => ({ tier: 'routine' }),
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 150_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'ffmpeg wrote the new picture; the source is untouched.',
    precheck: (i) => where(i.source, i.folder) ?? i.operations.flatMap((o) => (o.op === 'overlay' ? [where(o.image)] : [])).find(Boolean) ?? null,
    preview: (i) => ({
      summary: `Edit ${path.basename(i.source)}: ${i.operations.map((o) => (o.op === 'text' ? `add “${o.text.slice(0, 40)}”` : o.op.replace('_', ' '))).join(', ')}`,
      target: i.source,
      consequences: ['Makes a new picture file; the original is not changed.', i.open ? 'Opens the new picture.' : 'Does not open it.'],
      dataExport: null,
    }),
    auditView: (i) => ({ ops: i.operations.map((o) => o.op), format: i.format }),
    async execute(i, ctx) {
      try {
        const r = await d.studio.edit(i.source, i.operations, { name: i.name ?? baseName(i.source, 'edited'), format: i.format, ...(i.folder ? { folder: i.folder } : {}) }, ctx.signal);
        const opened = i.open ? await d.openPath(r.path).catch(() => false) : false;
        return { ...r, opened };
      } catch (e) {
        return fail(e);
      }
    },
  });

  const animate = defineCapability({
    id: 'picture.animate',
    version: '1.0.0',
    title: 'Animate a picture',
    description:
      'Turn a picture into a short looping animation on this PC (free): a motion for the picture (zoom = slow push in, float = gentle up and down, pulse = breathing brightness, spin, none), optional text that slides, fades or pulses in (with glow), and a fade from black. MP4 (plays everywhere) or GIF. These are motion effects, not frame-by-frame animation of parts of the picture — say so if the user expects that. Tip: for “text beside a logo that moves”, first picture__edit with extend right, then animate that result with the text here (so the text moves), or animate the edited picture with motion only.',
    input: AnimateSpec.extend({ source: Source, name: Name, folder: Folder, open: z.boolean().default(false).describe('Also open it in its usual app (it is shown in the chat either way)') }).strict(),
    output: z.object({ path: z.string(), width: z.number(), height: z.number(), seconds: z.number(), format: z.enum(['mp4', 'gif']), opened: z.boolean() }),
    risk: 'low',
    approval: 'always',
    autonomy: () => ({ tier: 'routine' }),
    permissions: [],
    consequential: false,
    idempotent: false,
    timeoutMs: 330_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'ffmpeg wrote the animation; the source is untouched.',
    precheck: (i) => where(i.source, i.folder),
    preview: (i) => ({
      summary: `Animate ${path.basename(i.source)} (${i.motion}${i.text ? `, text “${i.text.text.slice(0, 40)}” ${i.text.entrance}` : ''}, ${i.seconds} s ${i.format.toUpperCase()})`,
      target: i.source,
      consequences: ['Makes a new animation file; the original is not changed.', i.open ? 'Opens it.' : 'Does not open it.'],
      dataExport: null,
    }),
    auditView: (i) => ({ motion: i.motion, format: i.format, seconds: i.seconds, text: !!i.text }),
    async execute(i, ctx) {
      const { source, name, folder, open, ...spec } = i;
      try {
        const r = await d.studio.animate(source, spec, { name: name ?? baseName(source, 'animated'), ...(folder ? { folder } : {}) }, ctx.signal);
        const opened = open ? await d.openPath(r.path).catch(() => false) : false;
        return { ...r, opened };
      } catch (e) {
        return fail(e);
      }
    },
  });

  const Size = z.enum(['1024x1024', '1536x1024', '1024x1536', 'auto']).default('1024x1024');
  const cost = (q: string) => `Costs money on the user’s OpenAI account (${q} quality; more for high quality).`;
  const aiOff = () => (d.studio.aiAvailable() ? null : 'Making or changing pictures with AI needs an OpenAI API key (Settings → Providers → OpenAI). Local edits (picture__edit, picture__animate) work without it.');

  const generate = defineCapability({
    id: 'picture.generate',
    version: '1.0.0',
    title: 'Make a new picture with AI',
    description:
      'Create a brand-new picture from a description with the user’s OpenAI image model (a logo, an illustration, a product shot…). It costs money on their OpenAI account and always asks first. Write a vivid, specific prompt (subject, style, colours, composition, text to include). For changes to an existing picture use picture__edit (free) or picture__ai_edit.',
    input: z.object({ prompt: z.string().trim().min(5).max(4000), size: Size, background: z.enum(['auto', 'transparent', 'opaque']).default('auto'), name: Name, folder: Folder, open: z.boolean().default(false).describe('Also open it in its usual app (it is shown in the chat either way)') }).strict(),
    output: z.object({ path: z.string(), opened: z.boolean() }),
    risk: 'medium',
    approval: 'always',
    autonomy: () => ({ tier: 'always_ask', reason: 'Making a picture costs money on your OpenAI account.' }),
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 300_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'OpenAI returned the picture and Keo saved it.',
    unavailableReason: () => aiOff(),
    precheck: (i) => (i.folder && (!path.isAbsolute(i.folder) || !d.allowed(i.folder)) ? 'That folder is outside the folders Keo may use. Omit folder to save in Documents\\Keo.' : null),
    preview: (i) => ({ summary: `Make a picture: “${i.prompt.slice(0, 160)}”`, target: null, consequences: [cost(d.aiQuality()), 'Saves it as a new PNG.'], dataExport: `The description goes to OpenAI (${d.aiModel()}).` }),
    auditView: (i) => ({ promptLength: i.prompt.length, size: i.size, model: d.aiModel() }),
    async execute(i, ctx) {
      try {
        const r = await d.studio.generate(i.prompt, { name: i.name ?? 'Keo picture', size: i.size, quality: d.aiQuality(), background: i.background, ...(i.folder ? { folder: i.folder } : {}) }, ctx.signal);
        const opened = i.open ? await d.openPath(r.path).catch(() => false) : false;
        return { ...r, opened };
      } catch (e) {
        return fail(e);
      }
    },
  });

  const aiEdit = defineCapability({
    id: 'picture.ai_edit',
    version: '1.0.0',
    title: 'Change a picture with AI',
    description:
      'Change an existing picture with the user’s OpenAI image model when local edits cannot do it: redesign or restyle it, change colours of objects, add or remove objects, remove the background (background: transparent, instruction “remove the background”), extend the scene. The picture is sent to OpenAI, it costs money, and it always asks first. The result is a new PNG; the original is not changed.',
    input: z.object({ source: Source, instruction: z.string().trim().min(3).max(4000), size: Size, background: z.enum(['auto', 'transparent', 'opaque']).default('auto'), name: Name, folder: Folder, open: z.boolean().default(false).describe('Also open it in its usual app (it is shown in the chat either way)') }).strict(),
    output: z.object({ path: z.string(), opened: z.boolean() }),
    risk: 'medium',
    approval: 'always',
    autonomy: () => ({ tier: 'always_ask', reason: 'The picture goes to OpenAI and it costs money on your account.' }),
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 300_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'OpenAI returned the changed picture and Keo saved it as a new file.',
    unavailableReason: () => aiOff(),
    precheck: (i) => where(i.source, i.folder),
    preview: (i) => ({
      summary: `Change ${path.basename(i.source)} with AI: “${i.instruction.slice(0, 140)}”`,
      target: i.source,
      consequences: [cost(d.aiQuality()), 'Saves a new PNG; the original is not changed.'],
      dataExport: `The picture and the instruction go to OpenAI (${d.aiModel()}).`,
    }),
    auditView: (i) => ({ instructionLength: i.instruction.length, background: i.background, model: d.aiModel() }),
    async execute(i, ctx) {
      try {
        const r = await d.studio.aiEdit(i.source, i.instruction, { name: i.name ?? baseName(i.source, i.background === 'transparent' ? 'no background' : 'AI edit'), size: i.size, quality: d.aiQuality(), background: i.background, ...(i.folder ? { folder: i.folder } : {}) }, ctx.signal);
        const opened = i.open ? await d.openPath(r.path).catch(() => false) : false;
        return { ...r, opened };
      } catch (e) {
        return fail(e);
      }
    },
  });

  return [edit, animate, generate, aiEdit];
}
