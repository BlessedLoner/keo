import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, TextStyle } from '../src/shared/studio';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const service = (dir: string) => new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined });

describe('Keo Studio workspace upgrade', () => {
  it('moves a track one layer up or down, and keeps the order of the others', () => {
    let p = newProject({ name: 'Layers', format: 'landscape' });
    p = applyEdits(p, [{ op: 'add_track', kind: 'video', name: 'A' }, { op: 'add_track', kind: 'video', name: 'B' }, { op: 'add_track', kind: 'text', name: 'C' }]).project;
    const names = () => p.tracks.map((t) => t.name).filter((n) => ['A', 'B', 'C'].includes(n));
    expect(names()).toEqual(['A', 'B', 'C']);
    const a = p.tracks.find((t) => t.name === 'A')!.id;
    p = applyEdits(p, [{ op: 'set_track', track: a, position: 'up' }]).project;
    expect(names()).toEqual(['B', 'A', 'C']);
    p = applyEdits(p, [{ op: 'set_track', track: a, position: 'down' }]).project;
    expect(names()).toEqual(['A', 'B', 'C']);
  });

  it('text can be italic, and older projects without it still open', () => {
    expect(TextStyle.parse({}).italic).toBe(false);
    expect(TextStyle.parse({ italic: true }).italic).toBe(true);
  });

  it('undo and redo survive closing Keo and opening it again', () => {
    const dir = tempDir();
    const a = service(dir);
    const p = a.create('Undo test', 'vertical');
    a.edit(p.id, [{ op: 'add_text', text: 'First', start: 0, duration: 2 }]);
    a.edit(p.id, [{ op: 'add_text', text: 'Second', start: 2, duration: 2 }]);
    a.undoEdit(p.id);
    a.flushHistory();
    // A new service on the same folder: as after a restart.
    const b = service(dir);
    expect(b.canUndo(p.id)).toMatchObject({ undo: true, redo: true });
    const back = b.undoEdit(p.id);
    expect(back.tracks.flatMap((t) => t.clips)).toHaveLength(0);
    const again = b.redoEdit(p.id);
    expect(again.tracks.flatMap((t) => t.clips)).toHaveLength(1);
    b.delete(p.id);
    expect(service(dir).canUndo(p.id).undo).toBe(false);
  });
});

describe('Studio phase 4: MOV, presets and the brand kit', () => {
  it('a MOV export is the same tracks labelled for QuickTime', async () => {
    const fs = await import('node:fs');
    const { Mp4Writer, Mp4Reader } = await import('../src/main/studio/mp4');
    const AVCC = Buffer.from([1, 0x42, 0xe0, 0x33, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x42, 0xe0, 0x33, 0x01, 0x00, 0x02, 0x68, 0xce]);
    const file = path.join(tempDir(), 'out.mov');
    const w = new Mp4Writer(file, { width: 1280, height: 720, avcC: AVCC }, null, true);
    for (let i = 0; i < 10; i++) w.writeVideo(Buffer.alloc(40, i), i * 100_000, 100_000, i === 0);
    w.finish();
    expect(fs.readFileSync(file).subarray(4, 12).toString('latin1')).toBe('ftypqt  ');
    expect(Mp4Reader.open(file)!.video()).toMatchObject({ width: 1280, height: 720 });
  });

  it('platform presets are valid export settings', async () => {
    const { EXPORT_PRESETS, ExportOptions } = await import('../src/shared/studio');
    for (const p of EXPORT_PRESETS) expect(ExportOptions.safeParse(p.options).success, p.id).toBe(true);
  });

  it('the brand kit keeps a logo, intro and outro, and puts them into a video', async () => {
    const fs = await import('node:fs');
    const dir = tempDir();
    const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined, probe: async () => ({ kind: 'image', duration: 0, width: 1, height: 1, hasAudio: false }) });
    const png = path.join(dir, 'logo.png');
    // A 1×1 PNG.
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
    expect(() => s.setBrandFile('logo', path.join(dir, 'song.mp3'))).toThrow(/picture/);
    expect(s.setBrandFile('logo', png).logo).toBe('brand-logo.png');
    expect(s.setBrandFile('intro', png).intro).toBe('brand-intro.png');
    const p = s.create('Brand test', 'vertical');
    s.edit(p.id, [{ op: 'add_text', text: 'Hello', start: 0, duration: 3 }]);
    await s.useBrand(p.id, 'intro');
    const after = s.get(p.id);
    const text = after.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text')!;
    expect(text.start).toBeCloseTo(2.5);
    await s.useBrand(p.id, 'logo');
    expect(s.get(p.id).tracks.find((t) => t.name === 'Logo')?.clips).toHaveLength(1);
    await expect(s.useBrand(p.id, 'outro')).rejects.toThrow(/no outro/);
  });
});
