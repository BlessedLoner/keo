import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FalVideo, type AiVideoRequest } from '../src/main/studio/aiVideo';
import { StudioService } from '../src/main/studio/studioService';
import { Project } from '../src/shared/studio';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const req: AiVideoRequest = { model: 'kling-3-pro', image: Buffer.from('jpeg-bytes'), prompt: 'she smiles', seconds: 5, audio: false, aspect: '9:16' };

describe('redo and extend one AI shot', () => {
  it('a new take is a new request; the first take keeps the id clips made before have', () => {
    const fal = new FalVideo({ key: () => 'k', dir: tempDir('keo-take-'), fetch: async () => ({ ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) }), log });
    // The id an older Keo gave this request (before takes existed).
    const picture = crypto.createHash('sha256').update(req.image).digest('hex');
    const before = crypto.createHash('sha256').update(JSON.stringify(['fal-ai/kling-video/v3/pro/image-to-video', req.prompt, picture, 5, false, '9:16'])).digest('hex').slice(0, 24);
    expect(fal.hashOf(req)).toBe(before);
    expect(fal.hashOf({ ...req, take: 0 })).toBe(before);
    expect(fal.hashOf({ ...req, take: 1 })).not.toBe(before);
    expect(fal.hashOf({ ...req, take: 2 })).not.toBe(fal.hashOf({ ...req, take: 1 }));
  });

  it('keeps how a shot was made, and a new take goes in the old clip’s place (timing and effects kept)', async () => {
    const dir = tempDir('keo-redo-');
    const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'video', duration: 5, width: 720, height: 1280, hasAudio: false }), changed: () => undefined });
    const p = s.create('Shots', 'vertical');
    const frame = path.join(dir, 'frame.png');
    fs.writeFileSync(frame, 'png');
    const recipe = { model: 'kling-3-pro', prompt: 'she smiles', frame, seconds: 5, audio: false, aspect: '9:16' as const, take: 0 };
    const first = path.join(dir, 'ai-shot-one.mp4');
    fs.writeFileSync(first, 'a');
    const r1 = await s.addAiClip(p.id, first, { at: 2, seconds: 5, about: 'AI shot 1', recipe });
    expect(s.get(p.id).assets.find((a) => a.id === r1.asset.id)!.aiRecipe).toEqual(recipe);
    // The user moved it and gave it a zoom: a new take keeps that.
    s.edit(p.id, [{ op: 'set', clip: r1.clip, zooms: [{ at: 0, scale: 1.2, x: 0.5, y: 0.5, ease: 'smooth' }] }]);
    const second = path.join(dir, 'ai-shot-two.mp4');
    fs.writeFileSync(second, 'b');
    const r2 = await s.addAiClip(p.id, second, { at: 2, seconds: 5, about: 'AI shot 1, take 2', recipe: { ...recipe, take: 1 }, replace: r1.clip });
    expect(r2.clip).toBe(r1.clip);
    const now = s.get(p.id);
    const clips = now.tracks.flatMap((t) => t.clips);
    expect(clips).toHaveLength(1);
    expect(clips[0]).toMatchObject({ id: r1.clip, assetId: r2.asset.id, start: 2, duration: 5 });
    expect((clips[0] as { zooms?: unknown[] }).zooms).toHaveLength(1);
    // The old take is still in the media; the new one knows it is take 2.
    expect(now.assets.map((a) => a.id)).toContain(r1.asset.id);
    expect(now.assets.find((a) => a.id === r2.asset.id)!.aiRecipe!.take).toBe(1);
    expect(Project.parse(JSON.parse(JSON.stringify(now)))).toEqual(now);
  });
});
