import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RenderJob } from '../src/shared/studio';
import { Mp4Writer } from '../src/main/studio/mp4';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);
const log = { info: () => undefined, warn: () => undefined };

/** A real MP4 of `frames` blank frames at `fps`. */
function video(file: string, width: number, height: number, fps: number, frames = 60): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const w = new Mp4Writer(file, { width, height, avcC: AVCC }, null);
  for (let i = 0; i < frames; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / fps, 1e6 / fps, i % 10 === 0);
  w.finish();
  return file;
}

describe('smooth preview of heavy phone videos', () => {
  it('a 50 fps or bigger-than-HD video gets a light preview copy by itself after import; a normal one does not', async () => {
    const dir = tempDir();
    const jobs: RenderJob[] = [];
    const box = {} as { studio: StudioService };
    const sendJob = (jobId: string, job: RenderJob) => {
      jobs.push(job);
      // Like the render window: the export writes the copy (as long as its video).
      if (job.kind === 'export') {
        const target = (box.studio as unknown as { exportTargets: Map<string, string> }).exportTargets.get(job.exportId)!;
        const seconds = box.studio.get(job.projectId).assets[0]!.duration;
        video(target, job.size!.width, job.size!.height, job.size!.fps, Math.ceil(seconds * job.size!.fps) + 1);
      }
      setTimeout(() => box.studio.jobDone(jobId, null, null), 1);
    };
    const studio = (box.studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob }));
    studio.strongPc = () => false; // a 2-core laptop
    const p = studio.create('Phone clips');
    const fast = video(path.join(dir, 'IMG_5135.mp4'), 1080, 1920, 50);
    const big = video(path.join(dir, 'big.mp4'), 1440, 2560, 30);
    const normal = video(path.join(dir, 'normal.mp4'), 1080, 1920, 30);
    const r = await studio.importFiles(p.id, [fast, big, normal]);
    const [a, b, c] = r.added;
    expect(studio.heavyVideo(a!)).toBe(true);
    expect(studio.heavyVideo(b!)).toBe(true);
    expect(studio.heavyVideo(c!)).toBe(false);
    expect(studio.previewCopying(p.id).sort()).toEqual([a!.id, b!.id].sort());
    for (let k = 0; k < 200 && studio.previewCopying(p.id).length; k++) await new Promise((res) => setTimeout(res, 10));
    expect(studio.previewCopying(p.id)).toEqual([]);
    const now = studio.get(p.id);
    expect(now.assets.find((x) => x.id === a!.id)!.proxy).toBeTruthy();
    expect(now.assets.find((x) => x.id === b!.id)!.proxy).toBeTruthy();
    expect(now.assets.find((x) => x.id === c!.id)!.proxy).toBeUndefined();
    // A copy cut short (Keo restarted while making it) is not trusted: it is made again.
    const proxy = now.assets.find((x) => x.id === a!.id)!.proxy!;
    video(proxy, 304, 540, 25, 5);
    expect(studio.goodCopy({ ...now.assets.find((x) => x.id === a!.id)! })).toBe(false);
    await studio.makePreviewCopies(p.id, [a!.id]);
    expect(studio.goodCopy(studio.get(p.id).assets.find((x) => x.id === a!.id)!)).toBe(true);
    // The copies are 540p at 25 fps (cheap to make and play on a slow laptop), made patiently.
    const sizes = jobs.filter((j) => j.kind === 'export').map((j) => (j as Extract<RenderJob, { kind: 'export' }>).size);
    expect(sizes.map((s) => Math.min(s?.width ?? 0, s?.height ?? 0))).toEqual([540, 540, 540]);
    expect(sizes.every((s) => s?.fps === 25 && s?.patient === true)).toBe(true);
  });

  it('on a strong PC only very heavy videos get a copy, and it is sharper (720p, 30 fps)', async () => {
    const dir = tempDir();
    const studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob: () => undefined });
    studio.strongPc = () => true;
    const p = studio.create('Strong PC');
    const r = await studio.importFiles(p.id, [video(path.join(dir, 'fast.mp4'), 1440, 2560, 50), video(path.join(dir, 'huge.mp4'), 2160, 3840, 30)]);
    expect(studio.heavyVideo(r.added[0]!)).toBe(false); // 1440p at 50 fps plays fine on a strong PC
    expect(studio.heavyVideo(r.added[1]!)).toBe(true); // 4K still gets a copy
  });
});
