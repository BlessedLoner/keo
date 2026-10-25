import path from 'node:path';
import { z } from 'zod';
import { drawText, ffColor, TextSpec, type Size } from './edit';

/**
 * A short looping animation of a picture with ffmpeg: one motion for the picture (a slow zoom, a
 * gentle float, a glow pulse, a spin) and, optionally, text that slides, fades or pulses in.
 * MP4 (H.264, plays everywhere) or GIF.
 */
export const AnimateSpec = z
  .object({
    motion: z.enum(['none', 'zoom', 'float', 'pulse', 'spin']).default('float'),
    text: TextSpec.extend({ entrance: z.enum(['slide_left', 'slide_right', 'slide_up', 'fade', 'pulse', 'none']).default('slide_left') }).optional(),
    /** Fade the whole animation in from black. */
    fadeIn: z.boolean().default(true),
    seconds: z.number().min(1.5).max(15).default(5),
    format: z.enum(['mp4', 'gif']).default('mp4'),
    /** The colour behind the picture when it floats or spins. */
    background: z
      .string()
      .regex(/^(#[0-9a-fA-F]{6}|[a-zA-Z]{3,20})$/)
      .default('#000000'),
  })
  .strict();
export type AnimateSpec = z.infer<typeof AnimateSpec>;

export interface BuiltAnimation {
  args: string[];
  texts: Array<{ file: string; text: string }>;
  size: Size;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** ffmpeg arguments that turn the still `source` (of size `size`) into the animation at `out`. */
export function buildAnimation(source: string, size: Size, spec: AnimateSpec, out: string, opts: { fontsDir: string; workDir: string }): BuiltAnimation {
  // Big pictures are scaled down (an animation of a 4K picture is slow and huge).
  const k = Math.min(1, (spec.format === 'gif' ? 720 : 1280) / Math.max(size.width, size.height));
  const s: Size = { width: even(size.width * k), height: even(size.height * k) };
  const fps = spec.format === 'gif' ? 15 : 30;
  const D = spec.seconds;
  const frames = Math.round(D * fps);
  const bg = ffColor(spec.background);
  const chains: string[] = [];
  const texts: Array<{ file: string; text: string }> = [];
  let cur: string;

  switch (spec.motion) {
    case 'zoom':
      // A slow push in (8 % over the whole animation), centred.
      chains.push(`[0:v]scale=${s.width * 2}:${s.height * 2}:flags=lanczos,zoompan=z='1+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${s.width}x${s.height}:fps=${fps},format=rgba[m]`);
      break;
    case 'float':
      chains.push(`color=c=${bg}:s=${s.width}x${s.height}:r=${fps}:d=${D}[bg]`);
      chains.push(`[0:v]scale=${even(s.width * 0.92)}:${even(s.height * 0.92)}:flags=lanczos,format=rgba[fg]`);
      chains.push(`[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2+${Math.max(3, Math.round(s.height * 0.025))}*sin(2*PI*t/3.2):shortest=1,format=rgba[m]`);
      break;
    case 'pulse':
      chains.push(`[0:v]scale=${s.width}:${s.height}:flags=lanczos,fps=${fps},eq=brightness='0.07*sin(2*PI*t/2.4)':saturation='1+0.15*sin(2*PI*t/2.4)':eval=frame,format=rgba[m]`);
      break;
    case 'spin': {
      const side = even(Math.hypot(s.width, s.height));
      chains.push(`color=c=${bg}:s=${side}x${side}:r=${fps}:d=${D}[bg]`);
      chains.push(`[0:v]scale=${s.width}:${s.height}:flags=lanczos,format=rgba,rotate='2*PI*t/${D}':ow=${side}:oh=${side}:c=black@0[fg]`);
      chains.push(`[bg][fg]overlay=0:0:shortest=1,format=rgba[m]`);
      s.width = side;
      s.height = side;
      break;
    }
    default:
      chains.push(`[0:v]scale=${s.width}:${s.height}:flags=lanczos,fps=${fps},format=rgba[m]`);
  }
  cur = 'm';

  if (spec.text) {
    const t = spec.text;
    const file = path.join(opts.workDir, 'anim-text.txt');
    texts.push({ file, text: t.text });
    const ax = Math.round(t.x * s.width);
    const baseX = t.anchor === 'left' ? `${ax}` : t.anchor === 'right' ? `${ax}-tw` : `${ax}-tw/2`;
    // Entrances last 0.9 s after a short pause; an ease-out cubic.
    const p = `min(1,max(0,(t-0.35)/0.9))`;
    const ease = `(1-pow(1-${p},3))`;
    const x =
      t.entrance === 'slide_left'
        ? `${baseX}-(1-${ease})*${Math.round(s.width * 0.35)}`
        : t.entrance === 'slide_right'
          ? `${baseX}+(1-${ease})*${Math.round(s.width * 0.35)}`
          : baseX;
    const alpha = t.entrance === 'pulse' ? `${t.opacity}*(0.7+0.3*sin(2*PI*t/1.8))` : t.entrance === 'none' ? `${t.opacity}` : `${t.opacity}*${ease}`;
    const spec2 = t.entrance === 'slide_up' ? { ...t } : t;
    const yShift = t.entrance === 'slide_up' ? `+(1-${ease})*${Math.round(s.height * 0.12)}` : '';
    if (t.glow) {
      const r = Math.max(4, Math.round(t.size * s.height * 0.22));
      const glowAlpha = t.entrance === 'pulse' ? `0.55+0.45*sin(2*PI*t/1.8)` : alpha;
      chains.push(`color=c=black@0:s=${s.width}x${s.height}:r=${fps}:d=${D},format=rgba,${withY(drawText(spec2, s, file, opts.fontsDir, { x, alpha: glowAlpha, colorOverride: t.glow }), yShift)},boxblur=${r}:2[glow]`);
      chains.push(`[${cur}][glow]overlay=0:0:shortest=1[mg]`);
      cur = 'mg';
    }
    chains.push(`[${cur}]${withY(drawText(spec2, s, file, opts.fontsDir, { x, alpha }), yShift)}[mt]`);
    cur = 'mt';
  }

  const tail = [spec.fadeIn ? 'fade=t=in:st=0:d=0.6' : null, `trim=duration=${D}`].filter(Boolean).join(',');
  if (spec.format === 'gif') chains.push(`[${cur}]${tail},split[ga][gb];[ga]palettegen=stats_mode=diff[pal];[gb][pal]paletteuse=dither=sierra2_4a[out]`);
  else chains.push(`[${cur}]${tail},format=yuv420p[out]`);

  const codec = spec.format === 'gif' ? ['-loop', '0'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', '-pix_fmt', 'yuv420p'];
  const args = ['-y', '-hide_banner', '-loop', '1', '-framerate', String(fps), '-t', String(D), '-i', source, '-filter_complex', chains.join(';'), '-map', '[out]', '-r', String(fps), ...codec, out];
  return { args, texts, size: s };
}

/** Adds a vertical offset to drawtext's y. */
function withY(filter: string, shift: string): string {
  return shift ? filter.replace(/:y='([^']+)'/, (_m, y: string) => `:y='${y}${shift}'`) : filter;
}
