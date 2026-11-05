import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { wavOf } from '../src/main/studio/captions';
import { StudioService } from '../src/main/studio/studioService';
import { speechLike } from './fakeSpeechSound';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** A project with one talking video: four bursts of speech far apart (so four pieces of speech). */
async function talkingProject() {
  const dir = tempDir('keo-stt-retry-');
  const sound = wavOf(speechLike(80, [[1, 6], [21, 26], [41, 46], [61, 66]]), 16000).toString('base64');
  const warned: string[] = [];
  const s: StudioService = new StudioService({
    dir: path.join(dir, 'studio'),
    log: { ...log, warn: (e: string) => void warned.push(e) } as never,
    exportsDir: () => path.join(dir, 'Videos'),
    probe: async () => ({ kind: 'video', duration: 80, width: 1080, height: 1920, hasAudio: true }),
    changed: () => undefined,
    retryDelayMs: 0,
    sendJob: (jobId, job) => setTimeout(() => s.jobDone(jobId, job.kind === 'asset_audio' ? { wavBase64: sound } : null, null), 0),
  });
  const p = s.create('Talk', 'vertical');
  const file = path.join(dir, 'talk.mp4');
  fs.writeFileSync(file, 'x');
  const { added } = await s.importFiles(p.id, [file]);
  await s.edit(p.id, [{ op: 'add_media', assetId: added[0]!.id, start: 0, duration: 80 }]);
  return { s, id: p.id, warned };
}

describe('Studio speech-to-text when the speech service fails on a piece', () => {
  it('tries a failing piece again, and skips a piece that keeps failing instead of losing the video', async () => {
    const { s, id, warned } = await talkingProject();
    let call = 0;
    const r = await s.transcribe(
      id,
      {
        text: async () => {
          call++;
          // Piece 1 fails once then works; piece 2 always fails; pieces 3 and 4 work.
          if (call === 1) throw new Error('Provider returned error');
          if (call >= 3 && call <= 5) throw new Error('Provider returned error');
          return 'hello there everyone';
        },
      },
      { signal: new AbortController().signal },
    );
    expect(call).toBe(7); // 2 for piece 1, 3 for piece 2, then 1 each
    expect(r.skipped).toBe(1);
    expect(r.words).toBe(9);
    expect(warned).toContain('studio.transcribe_piece_skipped');
    const words = s.get(id).assets[0]!.words!;
    expect(words.length).toBe(9);
  });

  it('still fails plainly when no piece at all comes back', async () => {
    const { s, id } = await talkingProject();
    await expect(s.transcribe(id, { text: async () => { throw new Error('Provider returned error'); } }, { signal: new AbortController().signal })).rejects.toThrow(/Speech-to-text did not work/);
  });

  it('stopping is not retried', async () => {
    const { s, id } = await talkingProject();
    const stop = new AbortController();
    let call = 0;
    await expect(
      s.transcribe(id, { text: async () => { call++; stop.abort(); throw new Error('aborted'); } }, { signal: stop.signal }),
    ).rejects.toThrow();
    expect(call).toBe(1);
  });
});
