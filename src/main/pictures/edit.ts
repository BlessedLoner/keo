import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Picture editing with ffmpeg, on the user's PC: every edit is a step in one filter graph, the
 * result is a new file (never the original). Positions and sizes are fractions of the picture
 * (0–1), so the model can use what it saw without knowing pixel sizes. Text is written from a
 * file (never inside the filter string), in a real Windows font.
 */

const frac = z.number().min(0).max(1);
const Color = z
  .string()
  .trim()
  .regex(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|[a-zA-Z]{3,20})$/, 'A colour as #RRGGBB, #RRGGBBAA or a name like white')
  .describe('#RRGGBB, #RRGGBBAA (with transparency) or a colour name');

export const FONTS = {
  'Segoe UI': 'segoeui.ttf',
  'Segoe UI Bold': 'segoeuib.ttf',
  'Segoe UI Semibold': 'seguisb.ttf',
  'Segoe UI Black': 'seguibl.ttf',
  'Segoe UI Light': 'segoeuil.ttf',
  Bahnschrift: 'bahnschrift.ttf',
  Arial: 'arial.ttf',
  'Arial Bold': 'arialbd.ttf',
  Impact: 'impact.ttf',
  Georgia: 'georgia.ttf',
  'Georgia Bold': 'georgiab.ttf',
  Consolas: 'consola.ttf',
  Calibri: 'calibri.ttf',
  'Calibri Bold': 'calibrib.ttf',
  Verdana: 'verdana.ttf',
  'Trebuchet MS': 'trebuc.ttf',
  'Times New Roman': 'times.ttf',
  'Comic Sans MS': 'comic.ttf',
  'Segoe Script': 'segoesc.ttf',
  'Segoe Print': 'segoeprb.ttf',
} as const;
export type FontName = keyof typeof FONTS;

export const TextSpec = z
  .object({
    text: z.string().min(1).max(200),
    /** Where the text's anchor goes, as fractions of the picture. */
    x: frac.default(0.5),
    y: frac.default(0.5),
    /** Which point of the text sits at (x, y). */
    anchor: z.enum(['center', 'left', 'right']).default('center'),
    /** Text height as a fraction of the picture's height. */
    size: z.number().min(0.01).max(0.6).default(0.1),
    font: z.enum(Object.keys(FONTS) as [FontName, ...FontName[]]).default('Segoe UI Bold'),
    color: Color.default('#ffffff'),
    /** A soft light around the letters (e.g. a neon look). */
    glow: Color.optional(),
    outline: z.object({ color: Color, width: z.number().min(1).max(20).default(3) }).strict().optional(),
    shadow: z.boolean().default(false),
    /** 0–1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();
export type TextSpec = z.infer<typeof TextSpec>;

export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('crop'), x: frac, y: frac, width: z.number().min(0.02).max(1), height: z.number().min(0.02).max(1) }).strict(),
  z.object({ op: z.literal('resize'), width: z.number().int().min(16).max(8192).optional(), height: z.number().int().min(16).max(8192).optional() }).strict(),
  z
    .object({
      op: z.literal('extend'),
      left: z.number().min(0).max(4).default(0),
      right: z.number().min(0).max(4).default(0),
      top: z.number().min(0).max(4).default(0),
      bottom: z.number().min(0).max(4).default(0),
      color: Color.default('#000000'),
    })
    .strict()
    .describe('Adds room around the picture (fractions of its width/height), e.g. right: 1 doubles the width for text beside it'),
  z.object({ op: z.literal('square'), color: Color.default('#000000') }).strict().describe('Pads to a square'),
  z.object({ op: z.literal('rotate'), degrees: z.number().min(-360).max(360) }).strict(),
  z.object({ op: z.literal('flip'), direction: z.enum(['horizontal', 'vertical']) }).strict(),
  z
    .object({
      op: z.literal('adjust'),
      brightness: z.number().min(-1).max(1).default(0),
      contrast: z.number().min(0).max(3).default(1),
      saturation: z.number().min(0).max(3).default(1),
      gamma: z.number().min(0.1).max(5).default(1),
    })
    .strict(),
  z.object({ op: z.literal('grayscale') }).strict(),
  z.object({ op: z.literal('blur'), radius: z.number().min(1).max(60).default(6) }).strict(),
  z.object({ op: z.literal('sharpen'), amount: z.number().min(0.1).max(3).default(1) }).strict(),
  z.object({ op: z.literal('text') }).merge(TextSpec).strict(),
  z
    .object({ op: z.literal('overlay'), image: z.string().min(3).max(1000).describe('Full path of another picture'), x: frac.default(0.5), y: frac.default(0.5), width: z.number().min(0.02).max(1).default(0.3), opacity: z.number().min(0).max(1).default(1) })
    .strict(),
  z.object({ op: z.literal('round_corners'), radius: z.number().min(0.01).max(0.5).default(0.12) }).strict(),
  z.object({ op: z.literal('border'), width: z.number().int().min(1).max(200).default(12), color: Color.default('#ffffff') }).strict(),
]);
export type EditOp = z.infer<typeof EditOp>;

/** ffmpeg colour from #RRGGBB(AA) or a name. */
export function ffColor(c: string): string {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(c);
  if (!m) return c.toLowerCase();
  return `0x${m[1]}${m[2] ? `@${(parseInt(m[2], 16) / 255).toFixed(3)}` : ''}`;
}

/** A path inside a filter argument: forward slashes, the drive colon and quotes escaped. */
export function filterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function fontFile(name: FontName, fontsDir: string): string {
  const f = path.join(fontsDir, FONTS[name]);
  return fs.existsSync(f) ? f : path.join(fontsDir, 'arial.ttf');
}

export interface Size {
  width: number;
  height: number;
}

/** The size after each operation (the filter graph needs real numbers for text and corners). */
export function sizeAfter(s: Size, op: EditOp): Size {
  switch (op.op) {
    case 'crop': {
      const c = cropBox(s, op);
      return { width: c.w, height: c.h };
    }
    case 'resize': {
      const w = op.width ?? (op.height ? Math.round((s.width * op.height) / s.height) : s.width);
      const h = op.height ?? (op.width ? Math.round((s.height * op.width) / s.width) : s.height);
      return { width: even(w), height: even(h) };
    }
    case 'extend':
      return { width: even(s.width * (1 + op.left + op.right)), height: even(s.height * (1 + op.top + op.bottom)) };
    case 'square': {
      const m = Math.max(s.width, s.height);
      return { width: even(m), height: even(m) };
    }
    case 'rotate': {
      const a = ((op.degrees % 360) + 360) % 360;
      if (a === 90 || a === 270) return { width: s.height, height: s.width };
      if (a === 0 || a === 180) return s;
      const r = (a * Math.PI) / 180;
      return { width: even(Math.abs(s.width * Math.cos(r)) + Math.abs(s.height * Math.sin(r))), height: even(Math.abs(s.width * Math.sin(r)) + Math.abs(s.height * Math.cos(r))) };
    }
    case 'border':
      return { width: s.width + op.width * 2, height: s.height + op.width * 2 };
    default:
      return s;
  }
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const floorEven = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

/** A crop in pixels that always fits inside the picture (even sizes, rounded down). */
export function cropBox(s: Size, op: { x: number; y: number; width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const x = Math.min(Math.max(0, Math.round(op.x * s.width)), s.width - 2);
  const y = Math.min(Math.max(0, Math.round(op.y * s.height)), s.height - 2);
  return { x, y, w: Math.min(floorEven(op.width * s.width), floorEven(s.width - x)), h: Math.min(floorEven(op.height * s.height), floorEven(s.height - y)) };
}

export interface TextAsset {
  /** The file that holds this text (ffmpeg reads it; the words never go into the filter string). */
  file: string;
}

/**
 * drawtext for one text spec on a picture of size `s`. `t` (seconds) may be used in x/alpha
 * expressions by the animation builder; for stills it is plain numbers.
 */
export function drawText(spec: TextSpec, s: Size, textFile: string, fontsDir: string, opts: { x?: string; alpha?: string; colorOverride?: string } = {}): string {
  const px = Math.max(8, Math.round(spec.size * s.height));
  const ax = Math.round(spec.x * s.width);
  const ay = Math.round(spec.y * s.height);
  const x = opts.x ?? (spec.anchor === 'left' ? `${ax}` : spec.anchor === 'right' ? `${ax}-tw` : `${ax}-tw/2`);
  const parts = [
    `fontfile='${filterPath(fontFile(spec.font, fontsDir))}'`,
    `textfile='${filterPath(textFile)}'`,
    `fontsize=${px}`,
    `fontcolor=${ffColor(opts.colorOverride ?? spec.color)}`,
    // Quoted: animated positions are expressions with commas.
    `x='${x}'`,
    `y='${ay}-th/2'`,
  ];
  const alpha = opts.alpha ?? (spec.opacity < 1 ? `${spec.opacity}` : null);
  if (alpha) parts.push(`alpha='${alpha}'`);
  if (spec.outline && !opts.colorOverride) parts.push(`borderw=${spec.outline.width}`, `bordercolor=${ffColor(spec.outline.color)}`);
  // The glow layer: thicker letters, so the blurred light is strong enough to see.
  if (opts.colorOverride) parts.push(`borderw=${Math.max(2, Math.round(px / 10))}`, `bordercolor=${ffColor(opts.colorOverride)}`);
  if (spec.shadow && !opts.colorOverride) parts.push(`shadowcolor=black@0.55`, `shadowx=${Math.max(2, Math.round(px / 18))}`, `shadowy=${Math.max(2, Math.round(px / 18))}`);
  return `drawtext=${parts.join(':')}`;
}

/** A soft glow behind text: the text in the glow colour on a transparent layer, blurred, then laid under. */
export function glowLayer(label: string, spec: TextSpec, s: Size, textFile: string, fontsDir: string, extra: { x?: string; alpha?: string } = {}): { source: string; blurred: string } {
  const r = Math.max(4, Math.round(spec.size * s.height * 0.22));
  return {
    source: `color=c=black@0:s=${s.width}x${s.height}:d=1,format=rgba,${drawText(spec, s, textFile, fontsDir, { ...extra, colorOverride: spec.glow! })},boxblur=${r}:2[${label}]`,
    blurred: label,
  };
}

export interface BuiltGraph {
  /** Extra inputs after the source picture (overlays), in order. */
  inputs: string[];
  /** The -filter_complex value; its result is [out]. */
  graph: string;
  size: Size;
  /** Text files to write before running (path → text). */
  texts: Array<{ file: string; text: string }>;
}

/** One filter graph for all the operations, in order. */
export function buildEditGraph(ops: EditOp[], start: Size, opts: { fontsDir: string; workDir: string }): BuiltGraph {
  const inputs: string[] = [];
  const texts: Array<{ file: string; text: string }> = [];
  const chains: string[] = [];
  let cur = '0:v';
  let s = start;
  let n = 0;
  const next = () => `s${++n}`;
  const step = (filter: string) => {
    const out = next();
    chains.push(`[${cur}]${filter}[${out}]`);
    cur = out;
  };
  step('format=rgba');
  for (const op of ops) {
    switch (op.op) {
      case 'crop': {
        const c = cropBox(s, op);
        step(`crop=${c.w}:${c.h}:${c.x}:${c.y}`);
        break;
      }
      case 'resize': {
        const t = sizeAfter(s, op);
        step(`scale=${t.width}:${t.height}:flags=lanczos`);
        break;
      }
      case 'extend': {
        const t = sizeAfter(s, op);
        step(`pad=${t.width}:${t.height}:${Math.round(op.left * s.width)}:${Math.round(op.top * s.height)}:color=${ffColor(op.color)}`);
        break;
      }
      case 'square': {
        const t = sizeAfter(s, op);
        step(`pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:color=${ffColor(op.color)}`);
        break;
      }
      case 'rotate': {
        const a = ((op.degrees % 360) + 360) % 360;
        if (a === 90) step('transpose=1');
        else if (a === 270) step('transpose=2');
        else if (a === 180) step('hflip,vflip');
        else if (a !== 0) {
          const t = sizeAfter(s, op);
          step(`rotate=${((a * Math.PI) / 180).toFixed(6)}:ow=${t.width}:oh=${t.height}:c=black@0`);
        }
        break;
      }
      case 'flip':
        step(op.direction === 'horizontal' ? 'hflip' : 'vflip');
        break;
      case 'adjust':
        step(`eq=brightness=${op.brightness}:contrast=${op.contrast}:saturation=${op.saturation}:gamma=${op.gamma}`);
        break;
      case 'grayscale':
        step('hue=s=0');
        break;
      case 'blur':
        step(`gblur=sigma=${op.radius}`);
        break;
      case 'sharpen':
        step(`unsharp=5:5:${op.amount}:5:5:0`);
        break;
      case 'text': {
        const file = path.join(opts.workDir, `text${texts.length + 1}.txt`);
        texts.push({ file, text: op.text });
        if (op.glow) {
          const g = glowLayer(`g${n}`, op, s, file, opts.fontsDir);
          chains.push(g.source);
          const out = next();
          chains.push(`[${cur}][${g.blurred}]overlay=0:0[${out}]`);
          cur = out;
        }
        step(drawText(op, s, file, opts.fontsDir));
        break;
      }
      case 'overlay': {
        inputs.push(op.image);
        const idx = inputs.length;
        const w = even(op.width * s.width);
        const lay = `o${idx}`;
        chains.push(`[${idx}:v]format=rgba,scale=${w}:-2,colorchannelmixer=aa=${op.opacity}[${lay}]`);
        const out = next();
        chains.push(`[${cur}][${lay}]overlay=x=${Math.round(op.x * s.width)}-w/2:y=${Math.round(op.y * s.height)}-h/2[${out}]`);
        cur = out;
        break;
      }
      case 'round_corners': {
        const r = Math.max(2, Math.round(op.radius * Math.min(s.width, s.height)));
        step(
          `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(gt(abs(W/2-X),W/2-${r})*gt(abs(H/2-Y),H/2-${r}),if(lte(hypot(${r}-(W/2-abs(W/2-X)),${r}-(H/2-abs(H/2-Y))),${r}),alpha(X,Y),0),alpha(X,Y))'`,
        );
        break;
      }
      case 'border':
        step(`pad=${s.width + op.width * 2}:${s.height + op.width * 2}:${op.width}:${op.width}:color=${ffColor(op.color)}`);
        break;
    }
    s = sizeAfter(s, op);
  }
  chains.push(`[${cur}]null[out]`);
  return { inputs, graph: chains.join(';'), size: s, texts };
}
