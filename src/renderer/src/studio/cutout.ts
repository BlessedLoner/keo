import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision';
import type { Drawable } from './engine';

/**
 * AI background removal (no green screen): Google's MediaPipe selfie segmenter finds the people
 * in each frame, on this PC (its WebAssembly and the small model ship with Keo; nothing is sent
 * anywhere). Everything that is not a person is made transparent, with soft edges.
 */

let segmenter: ImageSegmenter | null = null;
let loading: Promise<boolean> | null = null;

/** Starts the segmenter (once); true when it is ready. */
export function loadCutout(): Promise<boolean> {
  if (segmenter) return Promise.resolve(true);
  loading ??= (async () => {
    const base = location.protocol === 'app:' ? 'app://keo' : location.origin;
    // The WebAssembly comes from Keo's own app:// protocol (the installed package's files).
    const files = await FilesetResolver.forVisionTasks('app://keo/mediapipe');
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        segmenter = await ImageSegmenter.createFromOptions(files, {
          baseOptions: { modelAssetPath: `${base}/models/selfie_segmenter.tflite`, delegate },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        });
        return true;
      } catch (e) {
        console.warn(`cutout: ${delegate} did not start: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return false;
  })().catch((e: unknown) => {
    console.error(`cutout: could not start: ${e instanceof Error ? e.message : String(e)}`);
    loading = null;
    return false;
  });
  return loading;
}

export const cutoutReady = () => !!segmenter;

const SEG = 256;
let input: OffscreenCanvas | null = null;
let mask: OffscreenCanvas | null = null;
const outs = new Map<string, OffscreenCanvas>();

/**
 * The picture with everything but its people made transparent (w × h, its own size), or null
 * while the segmenter is not ready.
 */
export function cutout(src: Drawable, w: number, h: number): OffscreenCanvas | null {
  if (!segmenter) return null;
  // The segmenter looks at a small copy; its mask is then laid over the full picture.
  const k = SEG / Math.max(w, h);
  const iw = Math.max(16, Math.round(w * k));
  const ih = Math.max(16, Math.round(h * k));
  if (!input || input.width !== iw || input.height !== ih) input = new OffscreenCanvas(iw, ih);
  const ictx = input.getContext('2d', { willReadFrequently: true })!;
  ictx.drawImage(src as CanvasImageSource, 0, 0, iw, ih);
  const result = segmenter.segment(input);
  try {
    const masks = result.confidenceMasks ?? [];
    // Two masks: background, then person; one mask: the person.
    const person = masks.length > 1 ? masks[1]! : masks[0];
    if (!person) return null;
    const conf = person.getAsFloat32Array();
    const mw = person.width;
    const mh = person.height;
    if (!mask || mask.width !== mw || mask.height !== mh) mask = new OffscreenCanvas(mw, mh);
    const mctx = mask.getContext('2d')!;
    const img = mctx.createImageData(mw, mh);
    for (let i = 0; i < conf.length; i++) {
      // A soft edge: fully kept above 0.65, gone below 0.35.
      const v = Math.max(0, Math.min(1, (conf[i]! - 0.35) / 0.3));
      img.data[i * 4 + 3] = Math.round(v * v * (3 - 2 * v) * 255);
    }
    mctx.putImageData(img, 0, 0);
    const key = `${w}x${h}`;
    let out = outs.get(key);
    if (!out) {
      out = new OffscreenCanvas(w, h);
      outs.set(key, out);
    }
    const o = out.getContext('2d')!;
    o.globalCompositeOperation = 'source-over';
    o.clearRect(0, 0, w, h);
    o.drawImage(src as CanvasImageSource, 0, 0, w, h);
    o.globalCompositeOperation = 'destination-in';
    o.imageSmoothingQuality = 'high';
    o.filter = `blur(${Math.max(0.5, Math.max(w, h) / 600).toFixed(1)}px)`;
    o.drawImage(mask, 0, 0, w, h);
    o.filter = 'none';
    o.globalCompositeOperation = 'source-over';
    return out;
  } finally {
    result.close();
  }
}
