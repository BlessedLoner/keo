/**
 * A 3D explanation as a Studio clip: the same scene Keo shows in the chat, drawn frame-exact at any
 * moment of the clip so it previews and exports like any other layer. One viewer is kept per clip.
 */
import { stepStates, VisualScene } from '@shared/scene';
import type { MotionClip } from '@shared/studio';
import { invoke } from '../lib/api';

type ViewerModule = typeof import('../../../../kits/scene/viewer');
type Viewer = InstanceType<ViewerModule['SceneViewer']>;

let viewerModule: ViewerModule | null = null;
let loading: Promise<ViewerModule> | null = null;

interface Entry {
  key: string;
  viewer: Viewer;
  holder: HTMLDivElement;
  scene: VisualScene;
  /** Models still arriving (the picture shows a stand-in until they do). */
  pending: Promise<unknown>[];
}
const viewers = new Map<string, Entry>();

const bytes = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};

/** Loads the 3D viewer (once). Call before drawing; frames drawn earlier show a plain placeholder. */
export function loadSceneViewer(): Promise<ViewerModule> {
  return (loading ??= import('../../../../kits/scene/viewer').then((m) => (viewerModule = m)));
}

function entryFor(c: MotionClip): Entry | null {
  if (!viewerModule || !c.visual) return null;
  const key = JSON.stringify(c.visual);
  const had = viewers.get(c.id);
  if (had?.key === key) return had;
  if (had) {
    had.viewer.dispose();
    had.holder.remove();
  }
  const parsed = VisualScene.safeParse(c.visual);
  if (!parsed.success) return null;
  const scene = parsed.data;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-20000px;top:0;width:1280px;height:720px;pointer-events:none';
  document.body.appendChild(holder);
  const pending: Promise<unknown>[] = [];
  const viewer = new viewerModule.SceneViewer(holder, scene, stepStates(scene), {
    controls: false,
    labels: false,
    still: true,
    dim: true,
    loadModel: (name) => {
      const p = invoke('visual:file', { kind: 'model', name }).then((r) => bytes(r.dataBase64));
      pending.push(p.catch(() => undefined));
      return p;
    },
  });
  const e = { key, viewer, holder, scene, pending };
  viewers.set(c.id, e);
  // Keep only the clips in use: a project rarely has more than a few.
  while (viewers.size > 4) {
    const [oldId, old] = viewers.entries().next().value!;
    old.viewer.dispose();
    old.holder.remove();
    viewers.delete(oldId);
  }
  return e;
}

/** Makes every 3D clip of a project ready (viewer loaded, models arrived) — before an export starts. */
export async function prepareScenes(clips: MotionClip[]): Promise<void> {
  const mine = clips.filter((c) => c.piece === 'scene3d' && c.visual);
  if (!mine.length) return;
  await loadSceneViewer();
  for (const c of mine) {
    const e = entryFor(c);
    // Give the models a moment to be asked for, then wait for them.
    await new Promise((r) => setTimeout(r, 50));
    if (e) await Promise.all(e.pending);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, px: number): void {
  ctx.font = `600 ${px}px "Plus Jakarta Sans", "Inter", "Segoe UI", sans-serif`;
  const w = ctx.measureText(text).width + px * 1.4;
  const h = px * 1.9;
  ctx.fillStyle = 'rgba(14,18,28,0.86)';
  ctx.strokeStyle = 'rgba(127,160,255,0.7)';
  ctx.lineWidth = Math.max(1, px * 0.07);
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - h * 1.35, w, h, h / 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y - h * 1.35 + h / 2);
}

/**
 * Draws the clip's scene at `seconds` into the clip, filling the frame. The explanation is fitted
 * to the clip's length (a longer clip plays it slower), so trimming never cuts a step off.
 */
export function drawScene3d(ctx: CanvasRenderingContext2D, c: MotionClip, seconds: number, W: number, H: number): void {
  if (!viewerModule) {
    void loadSceneViewer();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#10141c';
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    return;
  }
  const e = entryFor(c);
  if (!e) return;
  const total = e.scene.steps.reduce((n, s) => n + s.seconds, 0);
  const at = Math.max(0, Math.min(total, (seconds / Math.max(0.2, c.duration)) * total));
  // Drawn at the frame's own size, up to full HD across (bigger frames are scaled up from that).
  const k = Math.min(1, 1920 / Math.max(W, H));
  const canvas = e.viewer.seek(at, Math.round(W * k), Math.round(H * k));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(canvas, 0, 0, W, H);
  // Labels and the caption are drawn here so they are part of the video.
  const U = Math.min(W, H) / 100;
  for (const l of e.viewer.labelPoints()) pill(ctx, l.text, l.x * W, l.y * H, 2.1 * U);
  const info = e.viewer.info();
  if (c.sub !== '-' && info.say) {
    const px = 2.6 * U;
    ctx.font = `600 ${px}px "Plus Jakarta Sans", "Inter", "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The caption, wrapped to at most three lines on a soft band at the bottom.
    const words = info.say.split(/\s+/);
    const lines: string[] = [];
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (ctx.measureText(next).width > W * 0.84 && line) {
        lines.push(line);
        line = w;
      } else line = next;
    }
    if (line) lines.push(line);
    const shown = lines.slice(0, 3);
    const lh = px * 1.4;
    const top = H - 5 * U - shown.length * lh;
    const g = ctx.createLinearGradient(0, top - 6 * U, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, top - 6 * U, W, H - top + 6 * U);
    ctx.fillStyle = '#ffffff';
    shown.forEach((t, i) => ctx.fillText(t, W / 2, top + i * lh + lh / 2));
  }
  ctx.restore();
}
