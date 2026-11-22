/**
 * What Keo's visual explanations keep on disk and in mind: realistic 3D models made for scenes,
 * pictures of web pages taken for how-to guides, and the latest explanation to show outside the
 * chat (the results panel, when the user asked by voice or from another app).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { VisualGuide, VisualScene } from '../../shared/scene';

const MODEL_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SHOT_ID = /^gs_[a-z0-9]{6,16}$/;

export interface PageShot {
  id: string;
  url: string;
  title: string;
  /** The part of the picture to point at, as fractions of its width and height; null when the step is about the whole page. */
  box: { x: number; y: number; w: number; h: number } | null;
}

export interface LatestVisual {
  scene?: VisualScene;
  guide?: VisualGuide;
  at: number;
}

export class VisualStore {
  private readonly shots = new Map<string, PageShot>();
  private newest: LatestVisual | null = null;

  /** root: Documents\Keo\Visuals (made when first needed). */
  constructor(private readonly root: () => string) {}

  private dir(sub: 'models' | 'guides' | 'renders'): string {
    const d = path.join(this.root(), sub === 'models' ? 'Models' : sub === 'guides' ? 'Guides' : 'Renders');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  hasModel(name: string): boolean {
    return MODEL_NAME.test(name) && fs.existsSync(path.join(this.dir('models'), `${name}.glb`));
  }

  saveModel(name: string, glb: Buffer): string {
    if (!MODEL_NAME.test(name)) throw new Error('A model name is lower-case letters, digits, - and _.');
    const file = path.join(this.dir('models'), `${name}.glb`);
    fs.writeFileSync(file, glb);
    return file;
  }

  /** The realistic models made so far (the library: reused for free in later explanations). */
  models(): Array<{ name: string; kb: number; made: string }> {
    const dir = this.dir('models');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.glb') && MODEL_NAME.test(f.slice(0, -4)))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f.slice(0, -4), kb: Math.round(st.size / 1024), made: st.mtime.toISOString().slice(0, 10) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** A model's bytes, or null when there is no such model. Never a path from outside. */
  readModel(name: string): Buffer | null {
    if (!MODEL_NAME.test(name)) return null;
    const file = path.join(this.dir('models'), `${name}.glb`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  saveShot(png: Buffer, meta: Omit<PageShot, 'id'>): PageShot {
    const shot: PageShot = { id: `gs_${crypto.randomBytes(5).toString('hex')}`, ...meta };
    fs.writeFileSync(path.join(this.dir('guides'), `${shot.id}.png`), png);
    this.shots.set(shot.id, shot);
    // Only this session's pictures are remembered by id; a guide carries what it needs with it.
    while (this.shots.size > 60) this.shots.delete(this.shots.keys().next().value!);
    return shot;
  }

  /** A photoreal picture of a finished explanation, kept for the user (Documents\Keo\Visuals\Renders); never overwrites one. */
  saveRender(png: Buffer, title: string): string {
    const base = [...title]
      .filter((c) => c.charCodeAt(0) >= 32)
      .join('')
      .replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Keo picture';
    const dir = this.dir('renders');
    let file = path.join(dir, `${base}.png`);
    for (let n = 2; fs.existsSync(file) && n < 1000; n++) file = path.join(dir, `${base} (${n}).png`);
    fs.writeFileSync(file, png);
    return file;
  }

  shot(id: string): PageShot | null {
    return this.shots.get(id) ?? null;
  }

  readShot(id: string): Buffer | null {
    if (!SHOT_ID.test(id)) return null;
    const file = path.join(this.dir('guides'), `${id}.png`);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  /** The explanation to show in the results panel. */
  show(v: Omit<LatestVisual, 'at'>): void {
    this.newest = { ...v, at: Date.now() };
  }

  latest(): LatestVisual | null {
    return this.newest;
  }
}
