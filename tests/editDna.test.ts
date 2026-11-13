import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyEdits, newProject, type RenderJob } from '../src/shared/studio';
import { Blueprint, blueprintFollowUps, blueprintOps, findMatches, fingerprintOf, matchLevel, searchBlueprints, similarity, type DnaShot } from '../src/shared/editDna';
import { classifyTransition, estimateMotion } from '../src/shared/editDnaMotion';
import { Mp4Writer } from '../src/main/studio/mp4';
import { StudioService } from '../src/main/studio/studioService';
import { EditDnaService, parseVision } from '../src/main/studio/editDna';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);

/** A textured picture (so a move can be measured), greyscale. */
function picture(w: number, h: number, zoom = 1, dx = 0, dy = 0): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = (x - w / 2 - dx) / zoom + w / 2;
      const sy = (y - h / 2 - dy) / zoom + h / 2;
      out[y * w + x] = Math.round(128 + 60 * Math.sin(sx * 0.31) * Math.cos(sy * 0.23) + 50 * Math.sin((sx + sy) * 0.11));
    }
  return out;
}
const bin = (i: number) => {
  const s = new Array<number>(64).fill(0);
  s[i] = 1;
  return s;
};
const mix = (a: number[], b: number[], k: number) => a.map((v, i) => v * (1 - k) + (b[i] ?? 0) * k);

describe('Edit DNA — measuring', () => {
  it('measures a camera push-in and a pan between two frames', () => {
    const w = 96;
    const h = 54;
    const m = estimateMotion(picture(w, h), picture(w, h, 1.08, 0, 0), w, h);
    expect(m.zoom).toBeGreaterThan(1.05);
    expect(m.zoom).toBeLessThan(1.11);
    const p = estimateMotion(picture(w, h), picture(w, h, 1, 6, 0), w, h);
    expect(p.dx).toBeCloseTo(6 / w, 1);
    expect(Math.abs(p.zoom - 1)).toBeLessThan(0.02);
    const still = estimateMotion(picture(w, h), picture(w, h), w, h);
    expect(still).toMatchObject({ zoom: 1, dx: 0, dy: 0 });
  });

  it('tells a hard cut from a dissolve, a flash and a dip', () => {
    const a = bin(5);
    const b = bin(42);
    const step = 0.8 / 12;
    expect(classifyTransition([...Array(6).fill(a), ...Array(7).fill(b)], step).kind).toBe('cut');
    expect(classifyTransition(Array.from({ length: 13 }, (_, i) => mix(a, b, i / 12)), step)).toMatchObject({ kind: 'crossfade' });
    const white = bin(63);
    expect(classifyTransition([a, a, a, a, mix(a, white, 0.6), white, white, mix(white, b, 0.5), b, b, b, b, b], step).kind).toBe('flash');
    const black = bin(0);
    const da = bin(21);
    expect(classifyTransition([da, da, da, da, mix(da, black, 0.6), black, black, mix(black, b, 0.5), b, b, b, b, b], step).kind).toBe('dip');
  });

  it('reads the AI model’s answer safely, dropping what does not fit', () => {
    const r = parseVision('Sure! {"frames":[{"about":"a model on a beach","role":"opening","texts":[{"text":"SUMMER","x":0.5,"y":2,"size":"huge","lettering":"display","color":"#ffd400","uppercase":true}],"graphics":[{"kind":"lower third","text":"Ada"}],"effects":["Cinema Bars"],"look":{"warm":0.6}}],"overall":{"name":"Golden Glide","category":"Luxury","tags":["fashion"],"description":"Slow pushes."}}');
    expect(r.frames[0]).toMatchObject({ role: 'opening', texts: [{ text: 'SUMMER', y: 1, sizePct: 12, lettering: 'display', color: '#FFD400', uppercase: true }], graphics: [{ kind: 'lower_third' }], effects: ['cinema bars'] });
    expect(r.overall).toMatchObject({ name: 'Golden Glide', category: 'Luxury' });
    expect(parseVision('not json at all')).toEqual({ frames: [], overall: null });
  });
});

/** A blueprint made by hand (the shape the analysis produces). */
function sample(name: string, cuts: number[], o: Partial<Blueprint> = {}): Blueprint {
  const edges = [0, ...cuts, 8];
  const shots: DnaShot[] = edges.slice(0, -1).map((s, i) => ({ id: `s${i + 1}`, start: s, end: edges[i + 1]!, role: i === 0 ? 'opening' : i === edges.length - 2 ? 'ending' : 'main', kind: 'camera', cutIn: i === 2 ? { kind: 'crossfade', seconds: 0.5 } : { kind: 'cut', seconds: 0 }, camera: i === 0 ? { zoomFrom: 1, zoomTo: 1.1, panX: 0, panY: 0 } : { zoomFrom: 1, zoomTo: 1, panX: 0, panY: 0 }, speed: 1, onBeat: false, about: '', energy: 0.2, confidence: 0.8 }));
  const base = { schema: 1 as const, id: `dna_${name.replace(/\W/g, '').slice(0, 10).padEnd(6, 'x')}`, version: 1, name, description: '', category: 'Luxury', tags: ['elegant'], source: { fileName: 'ref.mp4', seconds: 8, width: 1080, height: 1920, hasAudio: false }, aspect: 'vertical' as const, seconds: 8, shots, texts: [{ id: 't1', at: 0.2, duration: 2, text: 'SUMMER', role: 'title' as const, x: 0.5, y: 0.3, sizePct: 9, lettering: 'display' as const, weight: 'black' as const, color: '#FFFFFF', uppercase: true, box: false, outline: false, glow: false, letterSpacing: 0, animIn: 'fade' as const, animOut: 'fade' as const, confidence: 0.6 }], graphics: [], effects: [], audio: { voice: false, music: false, bpm: null, beats: [], whooshOnCuts: false }, capabilities: [], report: [], status: 'ready' as const, favorite: false, sharing: { state: 'private' as const, rights: null }, history: [], related: [], origin: 'reference' as const, createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', ...o };
  return Blueprint.parse({ ...base, fingerprint: fingerprintOf(base) });
}

describe('Edit DNA — blueprints', () => {
  it('knows the same edit, a similar one and a different one, by structure', () => {
    const a = sample('Glide A', [2, 4, 6]);
    const same = sample('Glide B', [2.05, 4, 6.02]);
    const other = sample('Rapid', [0.4, 0.8, 1.2, 1.6, 2, 2.4, 2.8, 3.2, 3.6, 4, 4.4]);
    const s1 = similarity(a.fingerprint, same.fingerprint).score;
    expect(matchLevel(s1, a.fingerprint, same.fingerprint)).toBe('same');
    const s2 = similarity(a.fingerprint, other.fingerprint).score;
    expect(s2).toBeLessThan(s1);
    expect(matchLevel(s2, a.fingerprint, other.fingerprint)).not.toBe('same');
    expect(findMatches(a.fingerprint, [other, same])[0]!.id).toBe(same.id);
  });

  it('rebuilds the edit with the user’s clips: timing, transitions, camera move and text, all editable', () => {
    const b = sample('Glide', [2, 4, 6]);
    let p = newProject({ name: 'Mine', format: 'vertical' });
    p = { ...p, assets: [{ id: 'as_vid001', kind: 'video', name: 'beach.mp4', path: 'C:/beach.mp4', duration: 30, width: 1080, height: 1920, hasAudio: false }, { id: 'as_pic001', kind: 'image', name: 'logo.png', path: 'C:/logo.png', duration: 5, width: 800, height: 800, hasAudio: false }] as never };
    const built = blueprintOps(b, p, [{ assetId: 'as_vid001', kind: 'video', duration: 30 }, { assetId: 'as_pic001', kind: 'image', duration: 3600 }], { at: 0, roles: { s4: 'as_pic001' } });
    let r = applyEdits(p, built.ops).project;
    const clips = r.tracks.find((t) => t.name === 'Edit DNA')!.clips.filter((c) => c.type === 'media').sort((x, y) => x.start - y.start);
    expect(clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 2],
      [2, 2],
      [4, 2],
      [6, 2],
    ]);
    // The same video used again: its moments are spread through it (no repeated picture).
    expect(clips.filter((c) => c.type === 'media' && c.assetId === 'as_vid001').map((c) => (c as { in: number }).in)).toEqual([0, 14, 28]);
    expect(clips[3]).toMatchObject({ assetId: 'as_pic001' });
    expect((clips[0] as { zooms?: unknown[] }).zooms).toHaveLength(2);
    r = applyEdits(r, blueprintFollowUps(b, clips.map((c) => c.id))).project;
    const after = r.tracks.find((t) => t.name === 'Edit DNA')!.clips.sort((x, y) => x.start - y.start);
    expect(after[2]).toMatchObject({ transition: { kind: 'crossfade' } });
    expect(r.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text')).toMatchObject({ text: 'SUMMER', style: { font: 'Anton', uppercase: true } });
    // A clip too short for its shot shortens the shot and says so.
    const short = blueprintOps(b, p, [{ assetId: 'as_vid001', kind: 'video', duration: 1 }]);
    expect(short.notes.join(' ')).toMatch(/shorter/);
  });

  it('talking footage: the speech plays whole and in order, the reference’s rhythm repeats over it, captions in its style', () => {
    const b = { ...sample('Talk', [1.5, 4, 6.5, 9]), texts: [{ id: 't1', at: 0.5, duration: 1, text: 'BEST advice', role: 'caption' as const, x: 0.5, y: 0.62, sizePct: 9, lettering: 'display' as const, weight: 'black' as const, color: '#FFFFFF', uppercase: true, box: false, outline: true, glow: false, letterSpacing: 0, animIn: 'pop' as const, animOut: 'fade' as const, font: 'Anton', confidence: 0.6 }, { id: 't2', at: 2, duration: 1, text: 'is', role: 'caption' as const, x: 0.5, y: 0.62, sizePct: 9, lettering: 'display' as const, weight: 'black' as const, color: '#FFD400', uppercase: true, box: false, outline: true, glow: false, letterSpacing: 0, animIn: 'pop' as const, animOut: 'fade' as const, font: 'Anton', confidence: 0.6 }] };
    b.shots = b.shots.map((x) => ({ ...x, speed: 1, ramp: [{ x: 0, speed: 0.4 }, { x: 1, speed: 1 }] }));
    b.shots[1] = { ...b.shots[1]!, subject: { x: 0.5, y: 0.4, size: 0.6 } };
    b.shots[0] = { ...b.shots[0]!, subject: { x: 0.5, y: 0.4, size: 0.4 } };
    const p = newProject({ name: 'Mine', format: 'vertical' });
    // Two minutes of someone talking, with a long pause at 40–44 s and silence after 110 s.
    const speech = [{ start: 1, end: 20 }, { start: 20.3, end: 40 }, { start: 44, end: 110 }];
    const built = blueprintOps(b, p, [{ assetId: 'as_talk01', kind: 'video', duration: 120, speech }], { at: 0 });
    expect(built.mode).toBe('talk');
    const media = built.ops.filter((o) => o.op === 'add_media') as Array<{ start: number; in: number; duration: number; zooms?: Array<{ scale: number }> }>;
    // Back to back from 0:00, the source read in order with nothing repeated, and every spoken second kept.
    expect(media[0]!.start).toBe(0);
    for (let k = 1; k < media.length; k++) {
      expect(media[k]!.start).toBeCloseTo(media[k - 1]!.start + media[k - 1]!.duration, 2);
      expect(media[k]!.in).toBeGreaterThanOrEqual(media[k - 1]!.in + media[k - 1]!.duration - 1e-3);
    }
    const kept = media.reduce((n, m) => n + m.duration, 0);
    expect(kept).toBeGreaterThan(105);
    expect(kept).toBeLessThan(110);
    // The long pause is cut (a jump cut), the dead air at the ends goes.
    expect(media.some((m) => m.in < 40.5 && m.in + m.duration > 43.5)).toBe(false);
    expect(media[0]!.in).toBeCloseTo(0.88, 2);
    // The reference's 4 shots repeat across the 2 minutes; the closer shot is framed closer (a punch-in).
    expect(built.pieces.length).toBeGreaterThan(20);
    expect(built.pieces[0]).toEqual({ shot: 0, first: true });
    expect(built.pieces.at(-1)!.shot).toBe(3);
    expect(built.pieces.filter((x) => x.shot === 1).length).toBeGreaterThan(3);
    expect(media.find((_, k) => built.pieces[k]!.shot === 1)!.zooms![0]!.scale).toBe(1.5);
    // No speed changes on speech; transitions only where a shot begins.
    const follow = blueprintFollowUps(b, media.map((_, k) => `cl_x${String(k).padStart(4, '0')}`), built.pieces, { talk: true });
    expect(follow.some((f) => f.op === 'set' && ('speedCurve' in f || 'speed' in f))).toBe(false);
    expect(built.notes.join(' ')).toMatch(/speed changes were left out/);
    // Captions are the user's own words in the reference's style (its words are not copied).
    expect(built.ops.some((o) => o.op === 'add_text' && /BEST/.test(o.text))).toBe(false);
    expect(built.captions).toMatchObject({ style: { font: 'Anton', uppercase: true, weight: 'black' }, highlight: '#FFD400', animIn: 'pop', y: 0.62 });
    // As long as the reference: whole stretches of speech, stopping near its length.
    const phrases = [{ start: 1, end: 4.2 }, { start: 4.5, end: 9.6 }, { start: 9.9, end: 20 }, { start: 20.3, end: 40 }];
    const shortEdit = blueprintOps(b, p, [{ assetId: 'as_talk01', kind: 'video', duration: 120, speech: phrases }], { at: 0, length: 'reference' });
    // It stops at the end of a phrase near the reference's 8 s (9.6 s into the clip), not mid-word.
    const last = shortEdit.ops.filter((o) => o.op === 'add_media').at(-1) as { in: number; duration: number };
    expect(last.in + last.duration).toBeCloseTo(9.85, 2);
    expect(shortEdit.notes.join(' ')).not.toMatch(/middle of a sentence/);
  });

  it('montage: a long clip gives each shot a different moment, and “all my footage” repeats the middle shots', () => {
    const b = sample('Glide', [2, 4, 6]);
    const p = newProject({ name: 'Mine', format: 'vertical' });
    const clips = [{ assetId: 'as_vid001', kind: 'video' as const, duration: 30 }];
    const ref = blueprintOps(b, p, clips, { at: 0 });
    expect(ref.mode).toBe('montage');
    expect(ref.seconds).toBe(8);
    const all = blueprintOps(b, p, clips, { at: 0, length: 'footage' });
    expect(all.seconds).toBeCloseTo(30, 0);
    expect(all.pieces[0]!.shot).toBe(0);
    expect(all.pieces.at(-1)!.shot).toBe(3);
    expect(all.pieces.filter((x) => x.shot === 1).length).toBeGreaterThan(2);
    expect(all.notes.join(' ')).toMatch(/middle shots repeat/);
  });

  it('finds a blueprint from a description in plain words', () => {
    const lux = sample('Quiet Luxury Glide', [2, 4, 6]);
    const game = sample('Arcade Rush', [1, 2, 3], { category: 'Gaming', tags: ['retro', 'fast'] });
    expect(searchBlueprints('a luxury elegant promo for my fashion brand', [game, lux])[0]!.id).toBe(lux.id);
  });
});

describe('Edit DNA — the whole pipeline on a real video', () => {
  it('analyses a reference, saves it privately, merges the same edit as a new version, applies it, and can be stopped and resumed', async () => {
    const dir = tempDir();
    // A real 6-second MP4 (blank frames: the render window below reports what the frames show).
    const file = path.join(dir, 'reference.mp4');
    const w = new Mp4Writer(file, { width: 1080, height: 1920, avcC: AVCC }, null);
    for (let i = 0; i < 60; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / 10, 1e6 / 10, i % 10 === 0);
    w.finish();
    // What the frames look like: three shots (cuts at 2 s and, as a dissolve, around 4 s).
    const sigAt = (t: number) => (t < 2 ? bin(5) : t < 3.7 ? bin(21) : t > 4.3 ? bin(42) : mix(bin(21), bin(42), (t - 3.7) / 0.6));
    const box = {} as { studio: StudioService };
    const jobs: string[] = [];
    const sendJob = (jobId: string, job: RenderJob) =>
      setTimeout(() => {
        let result: unknown = null;
        if (job.kind === 'signatures') result = job.times.map(sigAt);
        // Shot 1 pushes in; the last shot starts in slow motion (the picture changes slowly) and then speeds up.
        else if (job.kind === 'motion') result = job.pairs.map(([a, b]) => (b - a < 0.1 ? { zoom: 1, dx: 0, dy: 0, residual: 0.01, energy: a >= 3.9 && a < 5 ? 0.008 : 0.05, brightness: 0 } : a < 2 ? { zoom: 1.04, dx: 0, dy: 0, residual: 0.02, energy: 0.1, brightness: 0 } : { zoom: 1, dx: 0, dy: 0, residual: 0.01, energy: 0.02, brightness: 0 }));
        else if (job.kind === 'frames') result = job.times.map((t) => ({ time: t, pngBase64: 'iVBORw0KGgo=' }));
        else if (job.kind === 'track') result = job.times.map((_, k) => ({ x: 0.4 + k * 0.01, y: 0.35 }));
        else if (job.kind === 'compare') result = job.times.map(() => ({ picture: 0.92, colour: 0.85 }));
        else if (job.kind === 'timeline_motion') result = job.pairs.map(() => ({ zoom: 1.04, dx: 0, dy: 0, residual: 0.02, energy: 0.1, brightness: 0 }));
        jobs.push(job.kind);
        box.studio.jobDone(jobId, result, null);
      }, 1);
    const studio = (box.studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob }));
    let asked = 0;
    const dna = new EditDnaService({
      dir: path.join(dir, 'studio'),
      studio,
      log,
      vision: {
        blocked: () => null,
        ask: async (pngs, prompt) => {
          asked += pngs.length;
          if (/How does that text come in/.test(prompt)) return '{"in":"slide-up","pinned":true}';
          return JSON.stringify({ frames: pngs.map((_, i) => ({ about: i === 0 ? 'a model walking on a beach' : 'close-up of fabric', role: i === 0 ? 'opening' : 'detail', texts: i === 0 ? [{ text: 'NEW SEASON', x: 0.5, y: 0.2, size: 'large', lettering: 'serif', weight: 'normal', color: '#FFFFFF', uppercase: true, spaced: true, font: 'Playfair Display' }] : [], graphics: [], effects: ['cinema bars'], look: { warm: 0.5 }, mask: i === 1 ? { shape: 'split', x: 0.5, y: 0.5, w: 1, h: 1, angle: 90 } : null, subject: { x: 0.45, y: 0.4, w: 0.3, h: 0.5 } })), overall: { name: 'Golden Glide', category: 'Luxury', tags: ['fashion', 'slow'], description: 'Slow push-ins with a soft dissolve.' } });
        },
      },
    });
    const p = studio.create('Mine', 'vertical');
    const imported = await studio.importFiles(p.id, [file]);
    const ref = imported.added[0]!;
    expect(ref.kind).toBe('video');
    const job = await dna.wait(dna.analyze(p.id, ref.id).id, 60_000);
    expect(job.status).toBe('done');
    expect(job.stages.map((s) => s.state)).toEqual(Array(12).fill('done'));
    expect(jobs).toEqual(expect.arrayContaining(['track', 'compare', 'timeline_motion']));
    expect(asked).toBeGreaterThan(0);
    const b = dna.get(job.blueprintId!);
    expect(b).toMatchObject({ name: 'Golden Glide', category: 'Luxury', status: 'ready', sharing: { state: 'private' } });
    expect(b.shots.length).toBe(3);
    expect(b.shots[0]!.camera.zoomTo).toBeGreaterThan(1.03);
    expect(b.shots[2]!.cutIn.kind).toBe('crossfade');
    // The camera's path through shot 1 (zooming in step by step), and the speed ramp of the last shot.
    expect(b.shots[0]!.path!.at(-1)!.zoom).toBeGreaterThan(1.1);
    expect(b.shots[0]!.ramp).toBeUndefined();
    expect(b.shots[2]!.ramp![0]!.speed).toBeLessThan(0.3);
    expect(b.shots[2]!.ramp!.at(-1)!.speed).toBe(1);
    expect(b.shots.some((s) => s.mask?.shape === 'linear')).toBe(true);
    expect(b.shots[0]!.subject).toMatchObject({ x: 0.45, y: 0.4, size: 0.5 });
    expect(b.texts[0]).toMatchObject({ text: 'NEW SEASON', lettering: 'serif', uppercase: true, font: 'Playfair Display', animIn: 'slide-up', pinned: true });
    expect(b.effects.some((e) => e.effects?.letterbox)).toBe(true);
    // The rebuild was measured against the reference.
    expect(b.quality).toMatchObject({ cuts: 1, camera: 1 });
    expect(b.quality!.score).toBeGreaterThan(0.8);
    expect(b.report.map((r) => r.status)).toEqual(expect.arrayContaining(['native', 'approximated']));
    expect(b.report.map((r) => r.status)).not.toContain('unsupported');
    expect(b.report.map((r) => r.element)).toEqual(expect.arrayContaining(['Speed changes', 'Masks and split screens', 'Tracking', 'Rebuild checked against the reference']));
    // Nothing of the reference's file is kept: no path.
    expect(JSON.stringify(b)).not.toContain(dir.replace(/\\/g, '\\\\'));
    // The same reference again: a new version of the same entry, not a duplicate.
    const again = await dna.wait(dna.analyze(p.id, ref.id).id, 60_000);
    expect(again.matched?.level).toBe('same');
    expect(dna.list()).toHaveLength(1);
    expect(dna.get(b.id).version).toBe(2);
    // The reference alone is refused: its footage is never used.
    await expect(dna.apply(p.id, b.id, { assets: [ref.id] })).rejects.toThrow(/never uses a reference/);
    // The user's own clip (and the reference) are on the timeline.
    const mineFile = path.join(dir, 'my clip.mp4');
    fs.copyFileSync(file, mineFile);
    const mine = (await studio.importFiles(p.id, [mineFile])).added[0]!;
    studio.edit(p.id, [
      { op: 'add_media', assetId: ref.id, start: 0 },
      { op: 'add_media', assetId: mine.id, start: 6 },
    ]);
    // Applied to the user's own clips: an editable timeline (one undo takes it all back).
    const beforeP = studio.get(p.id);
    const before = beforeP.tracks.flatMap((t) => t.clips).length;
    const applied = await dna.apply(p.id, b.id, { assets: [ref.id, mine.id] });
    expect(applied.clips).toBe(3);
    expect(applied.clipIds).toHaveLength(3);
    expect(applied.start).toBe(0);
    expect(applied.notes[0]).toMatch(/reference.mp4 is a reference video and was left out/);
    expect(applied.notes.join(' ')).toMatch(/1 text now follows/);
    expect(applied.notes.join(' ')).toMatch(/still in Media/);
    const after = studio.get(p.id);
    const all = after.tracks.flatMap((t) => t.clips);
    // Only the user's clip, from 0:00; the originals left the timeline; the new track is the main one (bottom).
    const media = all.filter((c) => c.type === 'media');
    expect(media.every((c) => c.type === 'media' && c.assetId === mine.id)).toBe(true);
    expect(media).toHaveLength(3);
    expect(Math.min(...media.map((c) => c.start))).toBe(0);
    expect(after.tracks.filter((t) => t.kind === 'video')[0]!.name).toBe(applied.track);
    expect(all.some((c) => c.type === 'media' && c.transition?.kind === 'crossfade')).toBe(true);
    expect(all.some((c) => c.type === 'media' && c.speedCurve?.length)).toBe(true);
    expect(all.some((c) => c.type === 'media' && c.cut?.shape === 'linear')).toBe(true);
    expect(all.find((c) => c.type === 'media' && c.id === applied.clipIds[0])).toMatchObject({ zooms: expect.arrayContaining([expect.objectContaining({ ease: 'ramp' })]) });
    const title = all.find((c) => c.type === 'text');
    expect(title).toMatchObject({ animIn: 'slide-up', style: { font: 'Playfair Display' } });
    expect((title as { keys?: { x?: unknown[] } }).keys?.x?.length).toBeGreaterThan(2);
    studio.undoEdit(p.id);
    expect(studio.get(p.id).tracks.flatMap((t) => t.clips).length).toBe(before);
    expect(studio.get(p.id).tracks.flatMap((t) => t.clips).some((c) => c.type === 'media' && c.assetId === ref.id)).toBe(true);
    // Talking clips: the speech stays whole and captions of the user's words come in the reference's style (fake speech-to-text).
    const capCalls: unknown[] = [];
    const dnaTalk = new EditDnaService({
      dir: path.join(dir, 'studio'),
      studio,
      log,
      captions: async (projectId, o) => {
        capCalls.push(o);
        studio.edit(projectId, [{ op: 'add_captions', lines: [{ text: 'hello there', start: 0.2, end: 1 }], replace: true, style: o.style, highlight: o.highlight, animIn: o.animIn, transform: o.transform }]);
        return { lines: 1 };
      },
    });
    const capped = { ...dna.get(b.id), captions: { font: 'Anton', sizePct: 9, color: '#FFFFFF', highlight: '#FFD400', y: 0.6, uppercase: true, weight: 'black' as const, outline: true, box: false, maxWords: 2, animIn: 'pop' as const, confidence: 0.5 } };
    fs.writeFileSync(path.join(dir, 'studio', 'dna', `${b.id}.json`), JSON.stringify(capped));
    const spy = vi.spyOn(studio, 'speechOf').mockResolvedValue({ [mine.id]: [{ start: 0.3, end: 2.5 }, { start: 2.7, end: 5.8 }] });
    const talked = await dnaTalk.apply(p.id, b.id, { assets: [mine.id] });
    spy.mockRestore();
    expect(talked.mode).toBe('talk');
    expect(talked.captions).toBe(1);
    expect(capCalls[0]).toMatchObject({ maxWords: 2, highlight: '#FFD400', animIn: 'pop', style: { font: 'Anton' }, transform: { y: 0.6 } });
    const tp = studio.get(p.id);
    expect(tp.tracks.flatMap((t) => t.clips).some((c) => c.type === 'media' && (c.speed !== 1 || c.speedCurve?.length))).toBe(false);
    expect(tp.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media').every((c) => c.type === 'media' && c.assetId === mine.id)).toBe(true);
    // One undo takes the edit and its captions back.
    studio.undoEdit(p.id);
    expect(studio.get(p.id).tracks.flatMap((t) => t.clips).length).toBe(before);
    // Stopped at once and resumed: it finishes without redoing finished stages.
    const j2 = dna.analyze(p.id, ref.id);
    dna.cancel(j2.id);
    expect(dna.job(j2.id).status).toBe('cancelled');
    const resumed = await dna.wait(dna.resume(j2.id).id, 60_000);
    expect(resumed.status).toBe('done');
    // Sharing needs the user's reason.
    expect(() => dna.update(b.id, { sharing: { state: 'shareable', rights: null } })).toThrow(/say whether/);
    const shared = dna.update(b.id, { sharing: { state: 'shareable', rights: 'own' } });
    expect(shared.sharing).toEqual({ state: 'shareable', rights: 'own' });
    // A file round trip lands on the same entry (same edit).
    const text = dna.exportFile(b.id);
    expect(text).not.toContain('reference.mp4"' + ',"path');
    dna.importFile(text);
    expect(dna.list()).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('without a model that sees pictures, it still measures the edit and says what it could not read', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'ref.mp4');
    const w = new Mp4Writer(file, { width: 1920, height: 1080, avcC: AVCC }, null);
    for (let i = 0; i < 40; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / 10, 1e6 / 10, i % 10 === 0);
    w.finish();
    const box = {} as { studio: StudioService };
    const sendJob = (jobId: string, job: RenderJob) =>
      setTimeout(() => {
        const result =
          job.kind === 'signatures'
            ? job.times.map((t) => (t < 2 ? bin(5) : bin(42)))
            : job.kind === 'motion'
              ? job.pairs.map(() => ({ zoom: 1, dx: 0, dy: 0, residual: 0.01, energy: 0.02, brightness: 0 }))
              : job.kind === 'frames'
                ? job.times.map((t) => ({ time: t, pngBase64: 'iVBORw0KGgo=' }))
                : job.kind === 'compare'
                  ? job.times.map(() => ({ picture: 0.8, colour: 0.9 }))
                  : null;
        box.studio.jobDone(jobId, result, null);
      }, 1);
    const studio = (box.studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob }));
    const chosen = { provider: 'openrouter', model: 'vision-model', label: 'OpenRouter · Vision model' };
    const used: Array<string | null> = [];
    const dna = new EditDnaService({
      dir: path.join(dir, 'studio'),
      studio,
      log,
      vision: {
        blocked: (pick) => (pick?.model === chosen.model ? null : 'Your AI model cannot see pictures.'),
        ask: async (pngs, prompt, _signal, pick) => {
          used.push(pick?.model ?? null);
          if (/How does that text come in/.test(prompt)) return '{"in":"pop"}';
          return JSON.stringify({ frames: pngs.map(() => ({ about: 'a city at night', role: 'main', texts: [{ text: 'NIGHT', x: 0.5, y: 0.5, size: 'huge', lettering: 'display' }], graphics: [], effects: [], look: {} })), overall: { name: 'Night Pulse', category: 'Cinematic', tags: ['city'], description: 'Hard cuts.' } });
        },
        models: () => [chosen],
      },
    });
    const p = studio.create('Wide', 'landscape');
    const ref = (await studio.importFiles(p.id, [file])).added[0]!;
    const job = await dna.wait(dna.analyze(p.id, ref.id).id, 60_000);
    expect(job.status).toBe('done');
    expect(job.stages.find((s) => s.id === 'vision')).toMatchObject({ state: 'skipped' });
    const b = dna.get(job.blueprintId!);
    expect(b.status).toBe('partial');
    expect(b.shots).toHaveLength(2);
    expect(b.report.some((r) => r.status === 'low-confidence' && /could not look/.test(r.note))).toBe(true);
    expect(used).toEqual([]);
    // Read again with the model the user chose: the same blueprint, a new version, now complete.
    expect(dna.visionModels()).toEqual([chosen]);
    const again = await dna.wait(dna.reread(b.id, chosen).id, 60_000);
    expect(again.status).toBe('done');
    expect(again.stages.find((s) => s.id === 'vision'), JSON.stringify(again.stages)).toMatchObject({ state: 'done' });
    expect(used.every((m) => m === chosen.model)).toBe(true);
    expect(dna.list()).toHaveLength(1);
    const b2 = dna.get(b.id);
    expect(b2).toMatchObject({ version: 2, status: 'ready', name: 'Night Pulse', category: 'Cinematic' });
    expect(b2.texts[0]).toMatchObject({ text: 'NIGHT', animIn: 'pop' });
    expect(b2.history.at(-1)!.note).toMatch(/Read again with OpenRouter · Vision model/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Edit DNA — a reference from a link, and the shared library', () => {
  const setup = (o: { fetch?: typeof fetch; cloud?: { call: (path: string, body: unknown, signal: AbortSignal) => Promise<unknown> } } = {}) => {
    const dir = tempDir();
    const studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob: () => undefined });
    const dna = new EditDnaService({ dir: path.join(dir, 'studio'), studio, log, referencesDir: () => path.join(dir, 'refs'), ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.cloud ? { cloud: o.cloud } : {}) });
    return { dir, studio, dna, p: studio.create('Mine', 'vertical') };
  };
  const signal = new AbortController().signal;

  it('downloads only direct video files on https, never social pages or this PC, and adds them to the project', async () => {
    const mp4 = (() => {
      const d = tempDir();
      const f = path.join(d, 'clip.mp4');
      const w = new Mp4Writer(f, { width: 1080, height: 1920, avcC: AVCC }, null);
      for (let i = 0; i < 20; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / 10, 1e6 / 10, i % 10 === 0);
      w.finish();
      return fs.readFileSync(f);
    })();
    const asked: string[] = [];
    const fake = (async (u: URL | string) => {
      const url = String(u);
      asked.push(url);
      if (url.endsWith('/page')) return new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
      return new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': String(mp4.length) } });
    }) as unknown as typeof fetch;
    const { dir, dna, p } = setup({ fetch: fake });
    await expect(dna.importUrl(p.id, 'http://example.com/a.mp4', signal)).rejects.toThrow(/https/);
    await expect(dna.importUrl(p.id, 'https://www.youtube.com/watch?v=x', signal)).rejects.toThrow(/youtube\.com, not a video file/);
    await expect(dna.importUrl(p.id, 'https://vm.tiktok.com/abc', signal)).rejects.toThrow(/tiktok\.com/);
    await expect(dna.importUrl(p.id, 'https://localhost/a.mp4', signal)).rejects.toThrow(/private network/);
    await expect(dna.importUrl(p.id, 'https://192.168.1.4/a.mp4', signal)).rejects.toThrow(/private network/);
    await expect(dna.importUrl(p.id, 'https://example.com/page', signal)).rejects.toThrow(/not a video file/);
    expect(asked).toEqual(['https://example.com/page']);
    const a = await dna.importUrl(p.id, 'https://cdn.example.com/media/brand%20promo.mp4', signal);
    expect(a).toMatchObject({ kind: 'video', name: 'brand promo.mp4' });
    expect(a.path.startsWith(path.join(dir, 'refs'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'refs'))).toEqual(['brand promo.mp4']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishes only what the user made shareable, without the file name, and saves shared ones privately', async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const cloud = {
      call: async (p: string, body: unknown) => {
        calls.push({ path: p, body: body as Record<string, unknown> });
        if (p === '/dna/publish') return { id: 'shAbc123' };
        if (p === '/dna/get') return { blueprint: { ...(calls.find((c) => c.path === '/dna/publish')!.body.blueprint as object), name: 'From Ben' } };
        if (p === '/dna/list') return { items: [{ id: 'shAbc123', name: 'Glide', category: 'Luxury', tags: ['slow'], seconds: 8, shots: 4, aspect: 'vertical', rights: 'own', saves: 3, mine: true, published_at: 'x' }, { nonsense: true }] };
        return {};
      },
    };
    const { dir, dna } = setup({ cloud });
    const b = dna.importFile(JSON.stringify({ blueprint: sample('Glide', [2, 4, 6], { source: { fileName: 'C:/secret/client.mp4', seconds: 8, width: 1080, height: 1920, hasAudio: false } }) }));
    await expect(dna.publish(b.id, signal)).rejects.toThrow(/why you may share/);
    expect(calls).toHaveLength(0);
    dna.update(b.id, { sharing: { state: 'shareable', rights: 'technique-only' } });
    const pub = await dna.publish(b.id, signal);
    expect(pub.sharing.published?.id).toBe('shAbc123');
    const sent = JSON.stringify(calls[0]!.body);
    expect(sent).not.toContain('secret');
    expect(calls[0]!.body).toMatchObject({ rights: 'technique-only', sharedId: null });
    expect(await dna.sharedList({ query: 'glide' }, signal)).toEqual([expect.objectContaining({ id: 'shAbc123', mine: true, saves: 3 })]);
    const off = await dna.unpublish(b.id, signal);
    expect(off.sharing.published).toBeNull();
    expect(calls.at(-1)).toMatchObject({ path: '/dna/unpublish', body: { id: 'shAbc123' } });
    // Saving a shared one: the same edit already here becomes a new version, kept private.
    const saved = await dna.saveShared('shAbc123', signal);
    expect(saved).toMatchObject({ id: b.id, origin: 'shared', sharing: { state: 'private', rights: null } });
    expect(dna.list()).toHaveLength(1);
    // Without a Keo account there is no shared library.
    await expect(setup().dna.sharedList({}, signal)).rejects.toThrow(/Keo account/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
