import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { talkCost } from '../src/shared/aiPrices';
import { audioSeconds, mp3Seconds, speakingSeconds, wavSeconds } from '../src/shared/audioLength';
import { wavOf } from '../src/main/studio/captions';
import { FalVideo, TALK_MODEL } from '../src/main/studio/aiVideo';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined };

/** n MPEG-1 Layer III frames at 128 kbps, 44.1 kHz (each 417 bytes, 1152 samples). */
function mp3(frames: number, o: { id3?: boolean; xing?: number } = {}): Uint8Array {
  const frame = new Uint8Array(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  const parts: Uint8Array[] = [];
  if (o.id3) {
    const tag = new Uint8Array(10 + 300);
    tag.set([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 2, 0x2c]); // "ID3", size 300 (7-bit bytes)
    parts.push(tag);
  }
  if (o.xing !== undefined) {
    // A first frame holding a Xing header (stereo: after 32 bytes of side information).
    const first = new Uint8Array(417);
    first.set([0xff, 0xfb, 0x90, 0x64]);
    first.set([0x58, 0x69, 0x6e, 0x67], 36);
    new DataView(first.buffer).setUint32(40, 1);
    new DataView(first.buffer).setUint32(44, o.xing);
    parts.push(first);
  }
  for (let i = 0; i < frames; i++) parts.push(frame);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('the length of a voice recording, read from its bytes', () => {
  it('reads WAV files', () => {
    const wav = wavOf(new Int16Array(16000 * 7), 16000);
    expect(wavSeconds(wav)).toBeCloseTo(7, 3);
    // Only the header in hand, the size known from elsewhere (the gateway reads the first bytes).
    expect(wavSeconds(wav.subarray(0, 200), wav.length)).toBeCloseTo(7, 3);
  });

  it('reads MP3 files: constant bit rate, after an ID3 tag, and a Xing frame count', () => {
    // 100 frames × 417 bytes at 128 kbps ≈ 2.61 s.
    expect(mp3Seconds(mp3(100))).toBeCloseTo((100 * 417 * 8) / 128000, 2);
    expect(mp3Seconds(mp3(100, { id3: true }))).toBeCloseTo((100 * 417 * 8) / 128000, 2);
    // A Xing header says 2000 frames (variable bit rate): 2000 × 1152 / 44100 ≈ 52.2 s.
    expect(mp3Seconds(mp3(10, { xing: 2000 }))).toBeCloseTo((2000 * 1152) / 44100, 2);
    expect(audioSeconds(new Uint8Array(500).fill(7))).toBeNull();
  });

  it('estimates how long a script takes to say, and the price', () => {
    expect(speakingSeconds('one two three four five six seven eight nine ten eleven twelve thirteen')).toBeCloseTo(5.6, 1);
    // 10 s Pro = $1.15; with a new picture +$0.15.
    expect(talkCost(10, 'pro')).toBe(1.15);
    expect(talkCost(10, 'pro', { picture: true })).toBe(1.3);
    expect(talkCost(10, 'standard')).toBe(0.57);
  });
});

describe('a talking character through fal.ai (a fake fal.ai: nothing is paid)', () => {
  function fakeFal() {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const base = 'https://queue.fal.run/fal-ai/kling-video/requests/t1';
    const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
    let n = 0;
    const fetch = async (url: string, init?: { method?: string; body?: string | Uint8Array }) => {
      calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
      if (url.startsWith('https://rest.fal.ai/storage/upload/initiate')) {
        n++;
        return json(200, { upload_url: `https://upload.fal.media/put/${n}`, file_url: `https://v3.fal.media/files/up-${n}` });
      }
      if (url.startsWith('https://upload.fal.media/put/')) return json(200, {});
      if (url === `https://queue.fal.run/${TALK_MODEL.endpoints.pro}`) return json(200, { request_id: 't1', status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
      if (url === `${base}/status`) return json(200, { status: 'COMPLETED' });
      if (url === base) return json(200, { video: { url: 'https://v3.fal.media/files/talk.mp4' }, duration: 6 });
      if (url === 'https://v3.fal.media/files/talk.mp4') return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(4000).fill(3).buffer };
      return json(404, {});
    };
    return { fetch, calls };
  }

  it('uploads the picture and the voice, asks for the lip-sync, keeps the clip, and never pays twice', async () => {
    const f = fakeFal();
    const fal = new FalVideo({ key: () => 'fal-test-key', dir: tempDir('keo-talk-'), fetch: f.fetch, log, sleep: async () => undefined });
    const request = { image: Buffer.from('jpeg'), audio: wavOf(new Int16Array(16000 * 6), 16000), audioType: 'audio/wav' as const, seconds: 6, quality: 'pro' as const, prompt: 'smiling' };
    const r = await fal.talk(request, new AbortController().signal);
    expect(fs.readFileSync(r.file).length).toBe(4000);
    const submit = f.calls.find((c) => c.url === `https://queue.fal.run/${TALK_MODEL.endpoints.pro}`)!;
    expect(submit.body).toEqual({ image_url: 'https://v3.fal.media/files/up-1', audio_url: 'https://v3.fal.media/files/up-2', prompt: 'smiling' });
    const n = f.calls.length;
    expect((await fal.talk(request, new AbortController().signal)).cached).toBe(true);
    expect(f.calls.length).toBe(n);
  });

  it('refuses a voice over a minute before anything is sent', async () => {
    const f = fakeFal();
    const fal = new FalVideo({ key: () => 'fal-test-key', dir: tempDir('keo-talk-'), fetch: f.fetch, log, sleep: async () => undefined });
    await expect(fal.talk({ image: Buffer.from('jpeg'), audio: Buffer.from('x'), audioType: 'audio/wav', seconds: 75, quality: 'pro' }, new AbortController().signal)).rejects.toThrow(/up to 60 seconds/);
    expect(f.calls).toHaveLength(0);
  });
});
