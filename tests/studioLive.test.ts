import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { actionOf, showSteps } from '../src/shared/studioLive';
import { applyEdits, newProject, type Project } from '../src/shared/studio';
import { tempDir } from './helpers';

/** Watching Keo edit: Keo's changes land one visible step at a time (no render window needed). */

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

async function setup(pace = { before: 0, after: 0 }) {
  const dir = tempDir('keo-live-');
  const changed: Project[] = [];
  const actions: Array<{ kind: string; label?: string; at?: number; index: number; total: number }> = [];
  const shown: string[] = [];
  const s = new StudioService({
    dir: path.join(dir, 'studio'),
    log,
    exportsDir: () => path.join(dir, 'Videos'),
    probe: async () => ({ kind: 'video', duration: 30, width: 1080, height: 1920, hasAudio: true }),
    changed: (p) => changed.push(p),
    keoAction: (a) => actions.push(a),
    showProject: (id) => shown.push(id),
    livePace: pace,
  });
  const file = path.join(dir, 'talk.mp4');
  fs.writeFileSync(file, 'x');
  const p = s.create('Live', 'vertical');
  const vid = (await s.importFiles(p.id, [file])).added[0]!;
  s.edit(p.id, [{ op: 'add_media', assetId: vid.id, start: 0 }]);
  changed.length = 0;
  return { s, p, changed, actions, shown };
}

describe('Watching Keo edit', () => {
  it('shows each cut as its own step, left to right, with the real timeline after each', async () => {
    const { s, p, changed, actions } = await setup();
    s.watch(p.id, true);
    const cuts = [
      { from: 2, to: 3 },
      { from: 10, to: 12 },
      { from: 20, to: 21 },
    ];
    await s.asKeo(() => s.edit(p.id, [{ op: 'cut_ranges', ranges: cuts }]));
    expect(actions.map((a) => [a.kind, a.at, a.index, a.total])).toEqual([
      ['cut', 2, 1, 3],
      ['cut', 9, 2, 3],
      ['cut', 17, 3, 3],
      ['done', undefined, 3, 3],
    ]);
    const lengths = changed.map((x) => x.tracks.find((t) => t.kind === 'video')!.clips.reduce((n, c) => n + c.duration, 0));
    // 30 s, then 1, 2 and 1 s less, and the final state once more at the end.
    expect(lengths).toEqual([29, 27, 26, 26]);
    // The final state on screen is exactly the saved edit (same clip ids), and it undoes in one step.
    expect(changed.at(-1)).toEqual(s.get(p.id));
    s.undoEdit(p.id);
    expect(s.get(p.id).tracks.find((t) => t.kind === 'video')!.clips).toHaveLength(1);
  });

  it('not watched, turned off, or the user’s own edit: all at once, as before', async () => {
    const { s, p, changed, actions } = await setup();
    await s.asKeo(() => s.edit(p.id, [{ op: 'cut_range', from: 1, to: 2 }]));
    expect(actions).toHaveLength(0);
    expect(changed).toHaveLength(1);
    s.watch(p.id, true);
    s.edit(p.id, [{ op: 'cut_range', from: 1, to: 2 }]);
    expect(actions).toHaveLength(0);
    s.liveEdits = false;
    await s.asKeo(() => s.edit(p.id, [{ op: 'cut_range', from: 1, to: 2 }]));
    expect(actions).toHaveLength(0);
    s.liveEdits = true;
    expect(s.liveEdits).toBe(true);
  });

  it('Keo waits for the steps to be shown; Skip shows the rest at once', async () => {
    const { s, p, changed, actions } = await setup({ before: 200, after: 200 });
    s.watch(p.id, true);
    const t0 = Date.now();
    const run = s.asKeo(() => s.edit(p.id, [{ op: 'cut_ranges', ranges: [{ from: 1, to: 2 }, { from: 5, to: 6 }, { from: 9, to: 10 }, { from: 14, to: 15 }] }]));
    await new Promise((r) => setTimeout(r, 300));
    s.skipShow(p.id);
    await run;
    expect(Date.now() - t0).toBeLessThan(1200);
    expect(actions.at(-1)!.kind).toBe('done');
    expect(changed.at(-1)).toEqual(s.get(p.id));
  });

  it('Keo working on another project brings it on screen first', async () => {
    const { s, p, shown } = await setup();
    s.watch(p.id, true);
    const other = s.create('Other', 'vertical');
    s.open(p.id);
    setTimeout(() => s.watch(other.id, true), 50);
    await s.asKeo(() => s.edit(other.id, [{ op: 'add_text', text: 'Hi', start: 0, duration: 1 }]), other.id);
    expect(shown).toEqual([other.id]);
    expect(s.current).toBe(other.id);
  });

  it('describes steps in plain words', () => {
    const p = applyEdits(newProject({ name: 'D' }), [{ op: 'add_text', text: 'Hello there', start: 3, duration: 2 }]).project;
    const id = p.tracks.find((t) => t.kind === 'text')!.clips[0]!.id;
    expect(actionOf({ op: 'cut_range', from: 62.5, to: 64 }, p).label).toBe('Cutting 1:02.5–1:04.0');
    expect(actionOf({ op: 'set', clip: id, style: { sizePct: 9 } }, p)).toMatchObject({ kind: 'change', label: 'Changing text style', at: 3, clips: [id] });
    const lines = Array.from({ length: 10 }, (_, i) => ({ text: `Line ${i}`, start: i, end: i + 1 }));
    const steps = showSteps([{ op: 'add_captions', lines, replace: true }]);
    expect(steps.map((x) => (x.op === 'add_captions' ? [x.lines.length, x.replace] : null))).toEqual([
      [4, true],
      [4, false],
      [2, false],
    ]);
  });
});
