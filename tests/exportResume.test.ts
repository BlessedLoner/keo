import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Mp4Reader, Mp4Writer } from '../src/main/studio/mp4';
import { StudioService } from '../src/main/studio/studioService';
import type { RenderJob } from '../src/shared/studio';
import { tempDir } from './helpers';

const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);
// The same stream with another picture parameter set (a resumed encoder may describe its stream differently).
const AVCC2 = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xcf]);
const ASC = Buffer.from([0x11, 0x90]);
const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const frame = (i: number) => Buffer.alloc(50 + (i % 7), i & 0xff);

describe('Carrying on an export that stopped part way', () => {
  it('the writer keeps the frames up to the last key frame and carries on from there (another stream description too)', () => {
    const dir = tempDir();
    const file = path.join(dir, 'v.mp4.part');
    const journal = path.join(dir, 'v.journal');
    const w = new Mp4Writer(file, { width: 640, height: 360, avcC: AVCC }, { codec: 'aac', sampleRate: 48000, channels: 2, config: ASC }, false, journal);
    for (let i = 0; i < 20; i++) w.writeAudio(Buffer.alloc(12, 3), i * 21_333, 21_333);
    // 100 frames, a key frame every 30; it stops after frame 99 (the last kept key frame is 90).
    for (let i = 0; i < 100; i++) w.writeVideo(frame(i), (i * 1e6) / 30, 1e6 / 30, i % 30 === 0);
    w.suspend();

    const r = Mp4Writer.resume(file, journal)!;
    expect(r.point).toEqual({ frames: 90, timeUs: 3_000_000 });
    r.writer.setVideoDescription(AVCC2);
    for (let i = 90; i < 150; i++) r.writer.writeVideo(frame(i), (i * 1e6) / 30, 1e6 / 30, i === 90 || i % 30 === 0);
    const done = r.writer.finish();
    expect(done.videoFrames).toBe(150);
    expect(done.durationSec).toBeCloseTo(5, 2);
    expect(fs.existsSync(journal)).toBe(false);

    const m = Mp4Reader.open(file)!;
    const v = m.video()!;
    expect(v.samples).toHaveLength(150);
    expect(v.samples.every((s, i) => !i || s.time > v.samples[i - 1]!.time)).toBe(true);
    for (const i of [0, 45, 89, 90, 120, 149]) expect(m.sample(v.samples[i]!)).toEqual(frame(i));
    expect(m.audio()!.samples).toHaveLength(20);
    // Both stream descriptions are in the file.
    const raw = fs.readFileSync(file);
    expect(raw.indexOf(AVCC2)).toBeGreaterThan(0);
    m.close();
  });

  it('nothing to carry on from before the first key frame after the start', () => {
    const dir = tempDir();
    const file = path.join(dir, 'v.mp4.part');
    const journal = path.join(dir, 'v.journal');
    const w = new Mp4Writer(file, { width: 64, height: 64, avcC: AVCC }, null, false, journal);
    for (let i = 0; i < 20; i++) w.writeVideo(frame(i), i * 33_333, 33_333, i === 0);
    w.suspend();
    expect(Mp4Writer.resume(file, journal)).toBeNull();
  });

  it('Studio keeps a stopped export, carries it on to a whole file, and throws one the user stopped away', async () => {
    const dir = tempDir('keo-resume-');
    const videos = path.join(dir, 'Videos');
    let failAt: number | null = 70;
    let userStops = false;
    const jobs: Array<{ from: number }> = [];
    const s: StudioService = new StudioService({
      dir: path.join(dir, 'studio'),
      log: log as never,
      exportsDir: () => videos,
      probe: async () => ({ kind: 'video', duration: 4, width: 1080, height: 1920, hasAudio: true }),
      changed: () => undefined,
      // A fake render window: the sound first (only when starting), then frames with a key frame every second.
      sendJob: (jobId, job: RenderJob) =>
        setTimeout(() => {
          if (job.kind !== 'export') return s.jobDone(jobId, null, null);
          const from = job.size?.from ?? 0;
          jobs.push({ from });
          try {
            s.beginExport(job.exportId, job.projectId, { width: 1080, height: 1920, codec: 'h264', avcC: AVCC }, from ? null : { codec: 'aac', sampleRate: 48000, channels: 2, config: ASC });
            if (!from) for (let i = 0; i < 40; i++) s.exportChunk(job.exportId, 'audio', Buffer.alloc(10, 1), i * 100_000, 100_000, true);
            for (let i = from; i < 120; i++) {
              if (failAt !== null && i === failAt) {
                if (userStops) s.cancelExport(job.projectId);
                s.abortExport(job.exportId);
                return s.jobDone(jobId, null, 'The video encoder stopped answering.');
              }
              s.exportChunk(job.exportId, 'video', frame(i), (i * 1e6) / 30, 1e6 / 30, i === from || i % 30 === 0);
            }
            s.jobDone(jobId, s.endExport(job.exportId), null);
          } catch (e) {
            s.jobDone(jobId, null, String(e));
          }
        }, 0),
    });
    const p = s.create('Long one', 'vertical');
    const src = path.join(dir, 'clip.mp4');
    fs.writeFileSync(src, 'x');
    const { added } = await s.importFiles(p.id, [src]);
    await s.edit(p.id, [{ op: 'add_media', assetId: added[0]!.id, start: 0, duration: 4 }]);

    // It stops at frame 70: the part up to the key frame at 60 is kept.
    await expect(s.exportVideo(p.id, { name: 'Long one' })).rejects.toThrow(/kept: Resume carries on/);
    expect(s.resumable(p.id)).toMatchObject({ done: 60, total: 120, name: 'Long one.mp4', changed: false });
    expect(fs.readdirSync(videos)).toEqual(['Long one.mp4.part']);

    // Resume: only frames 60 on are made again; the finished file is whole.
    failAt = null;
    const r = await s.resumeExport(p.id);
    expect(jobs.map((j) => j.from)).toEqual([0, 60]);
    expect(r.file).toBe(path.join(videos, 'Long one.mp4'));
    expect(r.frames).toBe(120);
    expect(fs.readdirSync(videos)).toEqual(['Long one.mp4']);
    expect(s.resumable(p.id)).toBeNull();
    const m = Mp4Reader.open(r.file)!;
    expect(m.audio()!.samples).toHaveLength(40);
    expect(m.sample(m.video()!.samples[100]!)).toEqual(frame(100));
    m.close();

    // A changed video cannot carry on a stopped export.
    failAt = 70;
    await expect(s.exportVideo(p.id, { name: 'Second' })).rejects.toThrow();
    await s.edit(p.id, [{ op: 'add_media', assetId: added[0]!.id, start: 4, duration: 1 }]);
    expect(s.resumable(p.id)?.changed).toBe(true);
    await expect(s.resumeExport(p.id)).rejects.toThrow(/changed/);
    s.discardResume(p.id);
    expect(fs.readdirSync(videos)).toEqual(['Long one.mp4']);

    // Stopped by the user: nothing is kept.
    userStops = true;
    await expect(s.exportVideo(p.id, { name: 'Third' })).rejects.toThrow();
    expect(s.resumable(p.id)).toBeNull();
    expect(fs.readdirSync(videos)).toEqual(['Long one.mp4']);
  });
});
