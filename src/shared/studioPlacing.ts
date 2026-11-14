/** Placing a layer by hand on the preview: what a drag, resize or turn becomes as an edit. */
import { keyValue, type Clip, type EditOp, type Key, type KeyProp } from './studio';

export type Base = { x: number; y: number; scale: number; rotation: number; maxWidth: number };
export type Moved = { x?: number; y?: number; scale?: number; rotation?: number };

/** A layer's position, scale and rotation as it is at this moment of the clip (its keyframes included). */
export function baseOf(clip: Clip, rt: number): Base {
  const c = clip as Exclude<Clip, { type: 'audio' | 'adjust' }>;
  const at = (k: 'x' | 'y' | 'scale' | 'rotation') => (c.keys?.[k]?.length ? keyValue(c.keys[k]!, rt) : c.transform[k]);
  return { x: at('x'), y: at('y'), scale: at('scale'), rotation: at('rotation'), maxWidth: c.type === 'text' ? c.style.maxWidth : 0 };
}

/**
 * The edit that puts a layer's position, scale or rotation at these values. An animated property:
 * on one of its keyframes, that keyframe changes; anywhere else the whole animation moves with it
 * (so the layer stays where it was put, instead of sliding back to the old keyframes).
 */
export function placeOps(clip: Clip, rt: number, fps: number, v: Moved, base: Base, maxWidth?: number): EditOp[] {
  if (clip.type === 'audio' || clip.type === 'adjust') return [];
  const keys: Partial<Record<KeyProp, Key[]>> = {};
  const transform: Record<string, number> = {};
  const r4 = (n: number) => Math.round(n * 10000) / 10000;
  for (const [k, val] of Object.entries(v) as Array<['x' | 'y' | 'scale' | 'rotation', number | undefined]>) {
    if (val === undefined) continue;
    const list = clip.keys?.[k];
    if (!list?.length) {
      transform[k] = r4(val);
      continue;
    }
    const on = list.findIndex((x) => Math.abs(x.at - rt) < 0.5 / fps);
    if (on >= 0) keys[k] = list.map((x, i) => (i === on ? { ...x, value: r4(val) } : x));
    else if (k === 'scale') {
      const ratio = val / Math.max(1e-4, base.scale);
      keys[k] = list.map((x) => ({ ...x, value: r4(x.value * ratio) }));
    } else {
      const by = val - base[k];
      keys[k] = list.map((x) => ({ ...x, value: r4(x.value + by) }));
    }
  }
  const op: EditOp = {
    op: 'set',
    clip: clip.id,
    ...(Object.keys(transform).length ? { transform } : {}),
    ...(Object.keys(keys).length ? { keys } : {}),
    ...(maxWidth !== undefined && clip.type === 'text' ? { style: { maxWidth: Math.round(maxWidth * 1000) / 1000 } } : {}),
  };
  return Object.keys(op).length > 2 ? [op] : [];
}
