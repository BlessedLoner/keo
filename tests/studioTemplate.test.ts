import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaClip, TextClip } from '../src/shared/studio';
import { makeHarness, tempDir, type Harness } from './helpers';

/** Replace media, templates and saving a frame (fake render window, nothing leaves the PC). */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function setup() {
  const dir = tempDir('keo-template-');
  const files = ['a.png', 'b.png', 'c.png', 'mine1.png', 'mine2.png'].map((n) => {
    const f = path.join(dir, n);
    fs.writeFileSync(f, 'x');
    return f;
  });
  h = makeHarness({
    dir: path.join(dir, 'profile'),
    deps: {
      videosDir: path.join(dir, 'Videos'),
      studioProbe: async () => ({ kind: 'image', duration: 0, width: 1080, height: 1920, hasAudio: false }),
      studioJob: (jobId, job) => setTimeout(() => h!.services.studio.jobDone(jobId, job.kind === 'frames' ? job.times.map((time) => ({ time, pngBase64: PNG_1PX })) : null, job.kind === 'frames' ? null : 'not in this test'), 5),
    },
  });
  return { dir, files };
}

describe('Replace media and templates', () => {
  it('replaces a clip’s picture and keeps its timing, motion and look', async () => {
    const { files } = setup();
    const s = h!.services.studio;
    const p = s.create('R', 'vertical');
    const [a, b] = (await s.importFiles(p.id, files.slice(0, 2))).added;
    const clip = s.edit(p.id, [{ op: 'add_media', assetId: a!.id, start: 1, duration: 2, enter: { kind: 'pop', seconds: 0.4 } }]).project.tracks[0]!.clips[0]!;
    s.edit(p.id, [{ op: 'set', clip: clip.id, color: { contrast: 0.3 } }]);
    s.edit(p.id, [{ op: 'replace_media', clip: clip.id, assetId: b!.id }]);
    const c = s.get(p.id).tracks[0]!.clips[0] as MediaClip;
    expect(c).toMatchObject({ assetId: b!.id, start: 1, duration: 2, enter: { kind: 'pop' } });
    expect(c.color?.contrast).toBe(0.3);
  });

  it('makes a new project with the same edit and my clips in its slots', async () => {
    const { files } = setup();
    const s = h!.services.studio;
    const tpl = s.create('Promo template', 'vertical');
    const added = (await s.importFiles(tpl.id, files.slice(0, 3))).added;
    s.edit(tpl.id, [
      ...added.map((a) => ({ op: 'add_media' as const, assetId: a.id, start: 'end' as const, duration: 1.5 })),
      { op: 'add_text', text: 'SALE', start: 0, duration: 4, animIn: 'pop' },
    ]);
    const r = await s.fromTemplate(tpl.id, files.slice(3));
    expect(r).toMatchObject({ filled: 2, slots: 3 });
    expect(r.project.name).toBe('Promo template — my version');
    const clips = r.project.tracks[0]!.clips as MediaClip[];
    const nameOf = (id: string) => r.project.assets.find((a) => a.id === id)!.name;
    expect(clips.map((c) => [c.start, c.duration, nameOf(c.assetId)])).toEqual([
      [0, 1.5, 'mine1.png'],
      [1.5, 1.5, 'mine2.png'],
      [3, 1.5, 'c.png'],
    ]);
    expect((r.project.tracks.find((t) => t.kind === 'text')!.clips[0] as TextClip).text).toBe('SALE');
    // The template itself is untouched, and the new project is the one open.
    expect((s.get(tpl.id).tracks[0]!.clips[0] as MediaClip).assetId).toBe(added[0]!.id);
    expect(s.current).toBe(r.project.id);
  });

  it('saves the frame at the playhead as a picture next to the exports', async () => {
    const { dir, files } = setup();
    const s = h!.services.studio;
    const p = s.create('Cover', 'vertical');
    const a = (await s.importFiles(p.id, files.slice(0, 1))).added[0]!;
    s.edit(p.id, [{ op: 'add_media', assetId: a.id, start: 0, duration: 2 }]);
    const file = await s.saveFrame(p.id, 1);
    expect(path.basename(file)).toBe('Cover cover.png');
    expect(file.startsWith(path.join(dir, 'Videos'))).toBe(true);
    expect(fs.readFileSync(file).subarray(1, 4).toString()).toBe('PNG');
    expect(path.basename(await s.saveFrame(p.id, 1))).toBe('Cover cover (2).png');
  });
});
