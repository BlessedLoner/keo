import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { musicCost, sfxCost } from '../src/shared/aiPrices';
import { FalVideo, MUSIC_MODEL, SFX_MODEL } from '../src/main/studio/aiVideo';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** A fake fal.ai for one model: answers the queue, then an MP3. */
function fakeFal(endpoint: string) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const base = 'https://queue.fal.run/elevenlabs/requests/m1';
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) });
  const fetch = async (url: string, init?: { method?: string; body?: string | Uint8Array }) => {
    calls.push({ url, method: init?.method ?? 'GET', ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (url === `https://queue.fal.run/${endpoint}`) return json(200, { request_id: 'm1', status_url: `${base}/status`, response_url: base, cancel_url: `${base}/cancel` });
    if (url === `${base}/status`) return json(200, { status: 'COMPLETED' });
    if (url === base) return json(200, { audio: { url: 'https://v3.fal.media/files/out.mp3' } });
    if (url === 'https://v3.fal.media/files/out.mp3') return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new Uint8Array(3000).fill(9).buffer };
    return json(404, {});
  };
  return { fetch, calls };
}

describe('AI music and sound effects (a fake fal.ai: nothing is paid)', () => {
  it('prices: music by each started minute, sound effects by the second', () => {
    expect(musicCost(30)).toBe(0.6);
    expect(musicCost(60)).toBe(0.6);
    expect(musicCost(61)).toBe(1.2);
    expect(sfxCost(3)).toBe(0.006);
    expect(sfxCost(0.5)).toBe(0.002);
  });

  it('asks for instrumental music as long as the video, and keeps the MP3', async () => {
    const f = fakeFal(MUSIC_MODEL.endpoint);
    const fal = new FalVideo({ key: () => 'fal-test-key', dir: tempDir('keo-music-'), fetch: f.fetch, log, sleep: async () => undefined });
    const r = await fal.music({ prompt: 'calm lo-fi, 85 BPM', seconds: 42 }, new AbortController().signal);
    expect(r.file.endsWith('.mp3')).toBe(true);
    expect(fs.readFileSync(r.file).length).toBe(3000);
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ prompt: 'calm lo-fi, 85 BPM', music_length_ms: 42000, force_instrumental: true, output_format: 'mp3_48000_192' });
    const n = f.calls.length;
    expect((await fal.music({ prompt: 'calm lo-fi, 85 BPM', seconds: 42 }, new AbortController().signal)).cached).toBe(true);
    expect(f.calls.length).toBe(n);
  });

  it('asks for a sound effect of the given length (and loop)', async () => {
    const f = fakeFal(SFX_MODEL.endpoint);
    const fal = new FalVideo({ key: () => 'fal-test-key', dir: tempDir('keo-sfx-'), fetch: f.fetch, log, sleep: async () => undefined });
    await fal.soundEffect({ prompt: 'rain on a tin roof', seconds: 12, loop: true }, new AbortController().signal);
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ text: 'rain on a tin roof', duration_seconds: 12, loop: true, prompt_influence: 0.4, output_format: 'mp3_44100_128' });
  });

  it('AI music lands on the Music track, quieter under speech; a sound on the Effects track', async () => {
    const dir = tempDir('keo-ai-audio-');
    const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'audio', duration: 40, width: 0, height: 0, hasAudio: true }), changed: () => undefined });
    const p = s.create('Music', 'vertical');
    const song = path.join(dir, 'ai-shot-abc.mp3');
    fs.writeFileSync(song, 'x');
    const r = await s.addAiClip(p.id, song, { at: 0, seconds: 40, about: 'AI music', trackName: 'Music', volume: 0.3, duck: -14 });
    const music = s.get(p.id).tracks.find((t) => t.name === 'Music')!;
    expect(music.kind).toBe('audio');
    expect(music.clips[0]).toMatchObject({ id: r.clip, type: 'audio', volume: 0.3, duck: -14, start: 0, duration: 40 });
    const boom = path.join(dir, 'ai-shot-def.mp3');
    fs.writeFileSync(boom, 'y');
    await s.addAiClip(p.id, boom, { at: 5, seconds: 3, about: 'AI sound', trackName: 'Effects', volume: 0.8 });
    expect(s.get(p.id).tracks.find((t) => t.name === 'Effects')!.clips[0]).toMatchObject({ type: 'audio', start: 5, volume: 0.8 });
  });
});
