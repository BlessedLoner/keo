import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyEdits, newProject, type MediaClip } from '../src/shared/studio';
import { DnaStyle, phrasesOf, readStyle, styleEditOps, type StyleFrame } from '../src/shared/editDnaStyle';
import { Blueprint, fingerprintOf } from '../src/shared/editDna';
import { Mp4Writer } from '../src/main/studio/mp4';
import { StudioService } from '../src/main/studio/studioService';
import { EditDnaService, parseVision } from '../src/main/studio/editDna';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);

type W = StyleFrame['words'][number];
const small = (text: string, y = 0.3, color = '#FFFFFF'): W => ({ text, sizePct: 2.2, font: 'Montserrat', italic: false, weight: 'bold', color, uppercase: false, outline: false, x: 0.5, y });
const big = (text: string, color: string, y = 0.33): W => ({ text, sizePct: 8, font: 'Montserrat', italic: true, weight: 'black', color, uppercase: false, outline: false, x: 0.5, y });
const frame = (t: number, o: Partial<StyleFrame>): StyleFrame => ({ t, kind: 'speaker', layout: 'full', boxes: [], background: null, bw: false, bug: 'bl', instagram: false, labels: [], words: [], ...o });

/** Like IMG_4811: full picture, phrases building word by word with one huge coloured italic word, black text cards, a corner mark, a black end card. */
function kineticFrames(): StyleFrame[] {
  const f: StyleFrame[] = [];
  const phrases: Array<[string[], string, string]> = [
    [['Always'], 'grow', '#8BE9FF'],
    [['Best'], 'advice', '#FFD23F'],
    [['what you love'], 'Do', '#FF4D6D'],
    [['be willing'], 'Always', '#FF7EB6'],
    [['past mistakes'], 'acknowledging', '#FFE66D'],
    [['growing and'], 'And', '#8BE9FF'],
  ];
  let t = 0;
  phrases.forEach(([rest, key, color], k) => {
    const card = k === 2;
    // Each phrase seen three times as it builds: the key word, then the rest joins it.
    f.push(frame(t, { kind: card ? 'card' : 'speaker', background: card ? '#000000' : null, words: [big(key, color)] }));
    f.push(frame(t + 0.33, { kind: card ? 'card' : 'speaker', background: card ? '#000000' : null, words: [big(key, color), small(rest[0]!.split(' ')[0]!)] }));
    f.push(frame(t + 0.66, { kind: card ? 'card' : 'speaker', background: card ? '#000000' : null, words: [big(key, color), small(rest[0]!)] }));
    t += 1;
  });
  for (let i = 0; i < 6; i++) f.push(frame(t + i * 0.33, { kind: 'outro', bug: null, background: '#000000', words: [] }));
  return f.map((x, i) => ({ ...x, t: i * 0.33 }));
}

describe('Edit DNA — reading a style from the frames', () => {
  it('reads a word-by-word kinetic style: build-up, the huge stressed word, its colours, cards, mark and ending', () => {
    const s = readStyle(kineticFrames(), { seconds: 8, flashes: 0, speakerCuts: 0, pace: 2 });
    expect(s.layout.kind).toBe('full');
    expect(s.words).toMatchObject({ on: true, mode: 'build', stress: { italic: true, weight: 'black' }, base: { font: 'Montserrat' } });
    expect(s.words.stress.scale).toBeGreaterThan(3);
    expect(s.words.colors.length).toBeGreaterThanOrEqual(4);
    expect(s.cards.every).toBeGreaterThan(0);
    expect(s.cards.backgrounds).toEqual(['#000000']);
    expect(s.bug).toEqual({ on: true, corner: 'bl' });
    expect(s.outro.kind).toBe('card');
    expect(s.outro.seconds).toBeGreaterThan(1);
  });

  it('reads a raw-beside-edited layout in phone frames on a light background, ending on an Instagram handle', () => {
    const boxes = [
      { x: 0.66, y: 0.56, w: 0.5, h: 0.5 },
      { x: 0.24, y: 0.6, w: 0.36, h: 0.36 },
    ];
    const f: StyleFrame[] = [];
    for (let i = 0; i < 20; i++) f.push(frame(i * 0.5, { layout: 'phones', boxes, background: '#F2F2F2', labels: ['RAW CLIP', 'OUR WORK'], bug: 'tr', words: [small('whatever', 0.6), ...(i % 2 ? [small('reasons', 0.6)] : [])] }));
    for (let i = 0; i < 5; i++) f.push(frame(10 + i * 0.5, { kind: 'outro', layout: 'phones', boxes, background: '#111111', instagram: true, bug: null }));
    const s = readStyle(f, { seconds: 12.5, speakerCuts: 3, closer: 1.2 });
    expect(s.layout).toMatchObject({ kind: 'phones', background: '#F2F2F2', x: 0.66, w: 0.5, raw: { x: 0.24, w: 0.36 }, labels: ['RAW CLIP', 'OUR WORK'], labelColor: '#111111' });
    expect(s.punch).toMatchObject({ scale: 1.2 });
    expect(s.punch.every).toBeGreaterThan(0);
    expect(s.outro).toMatchObject({ kind: 'instagram', background: '#111111' });
    expect(s.bug.corner).toBe('tr');
  });

  it('keeps every finished frame of an answer that was cut off part way (long answers from thinking models)', () => {
    const full = JSON.stringify({ frames: [1, 2, 3, 4].map((i) => ({ i, about: `frame ${i} with a "quote" and a } brace`, kind: 'speaker', texts: [{ text: `word ${i}`, role: 'title', size: 'large' }] })) });
    const cut = full.slice(0, full.indexOf('"i":4') + 12);
    const r = parseVision(cut);
    expect(r.frames.map((f) => f.i)).toEqual([1, 2, 3]);
    expect(r.frames[2]!.texts[0]!.text).toBe('word 3');
  });

  it('reads the new frame fields from the AI model’s answer', () => {
    const r = parseVision(JSON.stringify({ frames: [{ about: 'x', kind: 'card', layout: 'phones', boxes: [{ x: 0.2, y: 0.5, w: 0.3, h: 0.3 }, { x: 0.6, y: 0.5, w: 0.5, h: 0.5 }], background: '#f2f2f2', bw: true, bug: 'tr', instagram: true, labels: ['RAW CLIP', 'OUR WORK', 'x'], texts: [{ text: 'Do', role: 'caption', size: 'huge', italic: true, color: '#ff4d6d' }] }] }));
    expect(r.frames[0]).toMatchObject({ kind: 'card', layout: 'phones', background: '#F2F2F2', bw: true, bug: 'tr', instagram: true, labels: ['RAW CLIP', 'OUR WORK'] });
    expect(r.frames[0]!.boxes![0]!.w).toBe(0.5);
    expect(r.frames[0]!.texts[0]).toMatchObject({ text: 'Do', role: 'caption', sizePct: 12, italic: true });
  });
});

const SAID = 'Most people never start because they wait for the perfect moment. But the perfect moment never comes. You have to build it yourself, one small step at a time.'.split(' ');
function words(from = 0.3) {
  let t = from;
  return SAID.map((w) => {
    const d = 0.2 + w.length * 0.03;
    const out = { text: w, start: Math.round(t * 100) / 100, end: Math.round((t + d) * 100) / 100 };
    t += d + (/[.,]$/.test(w) ? 0.5 : 0.05);
    return out;
  });
}

describe('Edit DNA — rebuilding a style on the user’s talking video', () => {
  const kinetic = (): DnaStyle => readStyle(kineticFrames(), { seconds: 8, pace: 2 });
  const setup = () => {
    let p = { ...newProject({ name: 'Mine', format: 'vertical' }), assets: [{ id: 'as_pod00001', kind: 'video', path: 'C:/x/pod.mp4', name: 'pod.mp4', duration: 120, width: 1080, height: 1920, hasAudio: true }] } as ReturnType<typeof newProject>;
    p = applyEdits(p, [{ op: 'add_media', assetId: 'as_pod00001', start: 0, in: 1, duration: 14, trackName: 'Edit DNA · t' }]).project;
    const c = p.tracks.flatMap((t) => t.clips).find((x): x is MediaClip => x.type === 'media')!;
    return { p, main: [{ id: c.id, assetId: c.assetId, start: c.start, duration: c.duration, in: c.in, speed: c.speed, width: 1080, height: 1920 }] };
  };

  it('puts the user’s own words on screen phrase by phrase, word-timed, the stressed word on its own line in the reference’s typeface and colours, off the face', () => {
    const { p, main } = setup();
    const r = styleEditOps(p, kinetic(), { main, track: 'Edit DNA · t', words: words(), end: 14, handle: '@me' });
    const caps = r.ops.filter((o) => o.op === 'add_captions') as Array<Extract<(typeof r.ops)[number], { op: 'add_captions' }>>;
    const lines = caps.flatMap((c) => c.lines).sort((x, y) => x.start - y.start);
    expect(lines.length).toBe(phrasesOf(words(), kinetic().words.perGroup).length);
    expect(lines.map((l) => l.text.replace(/\n/g, ' ')).join(' ')).toBe(SAID.join(' '));
    expect(lines.every((l) => l.words?.length)).toBe(true);
    const stressed = lines.filter((l) => l.marks?.length);
    expect(stressed.length).toBeGreaterThan(2);
    expect(stressed[0]!.marks![0]).toMatchObject({ italic: true, weight: 'black' });
    expect(stressed.some((l) => l.text.includes('\n'))).toBe(true);
    expect(new Set(stressed.map((l) => l.marks![0]!.color)).size).toBeGreaterThan(1);
    // Never on the face (the upper middle of the picture).
    for (const c of caps) if (c.transform?.x === 0.5 && c.transform?.y !== 0.5) expect(c.transform!.y! < 0.22 || c.transform!.y! > 0.5).toBe(true);
    expect(caps[0]!.animIn).toBe('words');
    // Text cards, the corner mark and the ending on the user's handle.
    expect(r.ops.some((o) => o.op === 'add_shape' && o.style?.fill === '#000000' && o.start > 0 && o.start < 14)).toBe(true);
    expect(r.ops.some((o) => o.op === 'add_text' && o.text === '@me' && o.start === 0)).toBe(true);
    expect(r.ops.some((o) => o.op === 'add_text' && o.text === '@me' && o.start === 14)).toBe(true);
    expect(r.seconds).toBeGreaterThan(14);
    // It applies cleanly.
    expect(() => applyEdits(p, r.ops)).not.toThrow();
  });

  it('frames the video like the reference (rounded card, phones with the raw clip) and punches in inside the frame', () => {
    const { p, main } = setup();
    const s = DnaStyle.parse({ ...kinetic(), layout: { kind: 'phones', background: '#F2F2F2', x: 0.66, y: 0.56, w: 0.5, h: 0.5, radius: 0.08, raw: { x: 0.24, y: 0.6, w: 0.36, h: 0.36 }, labels: ['RAW CLIP', 'OUR WORK'], labelColor: '#111111' }, punch: { every: 3, scale: 1.2 }, outro: { kind: 'instagram', seconds: 3, background: '#000000' } });
    const r = styleEditOps(p, s, { main, track: 'Edit DNA · t', words: words(), end: 14, handle: '@me' });
    const after = applyEdits(p, r.ops).project;
    expect(after.background).toBe('#F2F2F2');
    const edited = after.tracks.find((t) => t.name === 'Edit DNA · t')!.clips as MediaClip[];
    expect(edited.length).toBeGreaterThan(2);
    expect(edited.every((c) => c.mask?.shape === 'rounded' && c.fit === 'contain' && c.transform.x === 0.66)).toBe(true);
    // A punch-in: a tighter crop at a bigger scale, so the frame stays the same size.
    const plain = edited.find((c) => c.transform.scale === Math.min(...edited.map((x) => x.transform.scale)))!;
    const close = edited.find((c) => c.transform.scale > plain.transform.scale)!;
    expect(close.crop!.top).toBeGreaterThan(plain.crop?.top ?? 0);
    // The speech stays continuous across the cuts.
    const sorted = [...edited].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.in).toBeCloseTo(sorted[i - 1]!.in + sorted[i - 1]!.duration, 2);
    const raw = after.tracks.find((t) => t.name === 'Edit DNA · raw')!.clips as MediaClip[];
    expect(raw[0]).toMatchObject({ volume: 0, transform: { x: 0.24 } });
    expect(after.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'text' && /RAW CLIP|OUR WORK/.test(c.text))).toHaveLength(2);
    expect(after.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'shape' && c.start === 14).length).toBeGreaterThanOrEqual(3);
  });
});

describe('Edit DNA — applying a style', () => {
  it('places the speech, puts the user’s words on screen in the reference’s style, frames it and ends on the handle — one undo', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'my talk.mp4');
    const w = new Mp4Writer(file, { width: 1080, height: 1920, avcC: AVCC }, null);
    for (let i = 0; i < 160; i++) w.writeVideo(Buffer.alloc(40, i), (i * 1e6) / 10, 1e6 / 10, i % 10 === 0);
    w.finish();
    const studio = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, sendJob: () => undefined });
    const heard = vi.fn(async () => words(0.5));
    const dna = new EditDnaService({ dir: path.join(dir, 'studio'), studio, log, words: heard });
    const p = studio.create('Mine', 'vertical');
    const mine = (await studio.importFiles(p.id, [file])).added[0]!;
    studio.edit(p.id, [{ op: 'add_media', assetId: mine.id, start: 0 }]);
    studio.setBrand({ handle: '@me' });
    // A blueprint read from a phones-style reference.
    const style = DnaStyle.parse({ ...readStyle(kineticFrames(), { seconds: 8, pace: 2 }), layout: { kind: 'card', background: '#06060A', x: 0.5, y: 0.5, w: 0.92, h: 0.52, radius: 0.06, raw: null, labels: [], labelColor: '#FFFFFF' } });
    const now = '2026-11-13T12:00:00Z';
    const shots = [0, 2, 4, 6].map((s, i) => ({ id: `s${i + 1}`, start: s, end: s + 2, role: 'main' as const, kind: 'camera' as const, cutIn: { kind: 'cut' as const, seconds: 0 }, camera: { zoomFrom: 1, zoomTo: 1, panX: 0, panY: 0 }, speed: 1, onBeat: false, about: '', energy: 0.2, confidence: 0.7 }));
    const b = Blueprint.parse({ schema: 1, id: 'dna_style01', version: 1, name: 'Kinetic', source: { fileName: 'ref.mp4', seconds: 8, width: 1080, height: 1920, hasAudio: true }, aspect: 'vertical', seconds: 8, shots, style, audio: { voice: true, music: false, bpm: null }, fingerprint: fingerprintOf({ shots, seconds: 8, texts: [], graphics: [], aspect: 'vertical' }), status: 'ready', createdAt: now, updatedAt: now });
    fs.mkdirSync(path.join(dir, 'studio', 'dna'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio', 'dna', 'dna_style01.json'), JSON.stringify(b));
    vi.spyOn(studio, 'speechOf').mockResolvedValue({ [mine.id]: [{ start: 0.4, end: 7 }, { start: 7.3, end: 15.5 }] });
    const faced = vi.spyOn(studio, 'faceBand').mockResolvedValue({ y0: 0.3, y1: 0.5 });
    // A wide video saved in a tall frame: black bars above and below.
    vi.spyOn(studio, 'videoBars').mockResolvedValue({ left: 0, right: 0, top: 0.33, bottom: 0.33 });
    const before = studio.get(p.id).tracks.flatMap((t) => t.clips).length;
    const r = await dna.apply(p.id, b.id, { assets: [mine.id] });
    expect(heard).toHaveBeenCalled();
    expect(faced).toHaveBeenCalled();
    // Words never on the measured face (inside the card it sits at 0.24 + 0.52 × 0.3–0.5).
    for (const c of studio.get(p.id).tracks.find((t) => t.name === 'Captions')!.clips) if (c.type === 'text' && c.transform.y !== 0.5) expect(c.transform.y < 0.4 || c.transform.y > 0.5).toBe(true);
    expect(r.mode).toBe('talk');
    expect(r.start).toBe(0);
    const after = studio.get(p.id);
    expect(after.background).toBe('#06060A');
    const caps = after.tracks.find((t) => t.name === 'Captions')!.clips;
    expect(caps.length).toBeGreaterThan(3);
    expect(caps.some((c) => c.type === 'text' && c.marks?.length)).toBe(true);
    const media = after.tracks.flatMap((t) => t.clips).filter((c): c is MediaClip => c.type === 'media');
    expect(media.every((c) => c.assetId === mine.id && c.mask?.shape === 'rounded')).toBe(true);
    expect(Math.min(...media.map((c) => c.start))).toBe(0);
    expect(r.notes.join(' ')).toMatch(/phrases of your own words/);
    expect(r.notes.join(' ')).toMatch(/Black bars baked into your video were cropped away/);
    // The bars are cropped off every piece of the talking video.
    expect(media.every((c) => (c.crop?.top ?? 0) >= 0.33 && (c.crop?.bottom ?? 0) >= 0.33)).toBe(true);
    // One undo takes it all back.
    studio.undoEdit(p.id);
    expect(studio.get(p.id).tracks.flatMap((t) => t.clips).length).toBe(before);
    expect(studio.get(p.id).background).not.toBe('#06060A');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
