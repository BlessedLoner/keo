import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { describeBrand, patchBrand } from '../src/shared/studioBrand';
import type { TextClip } from '../src/shared/studio';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

describe('Brand kit', () => {
  it('sets, keeps and forgets values', () => {
    const b = patchBrand({}, { handle: '@keo.ai', accent: '#E53935' });
    expect(patchBrand(b, { name: 'Keo' })).toEqual({ handle: '@keo.ai', accent: '#E53935', name: 'Keo' });
    expect(patchBrand(b, { handle: null })).toEqual({ accent: '#E53935' });
    expect(() => patchBrand(b, { accent: 'red' as never })).toThrow();
    expect(describeBrand(b)).toBe('handle "@keo.ai", accent colour #E53935');
    expect(describeBrand({})).toBe('');
  });

  it('is saved on this PC and used by styles when the user did not say otherwise', async () => {
    const dir = tempDir('keo-brand-');
    const s = new StudioService({ dir: path.join(dir, 'studio'), log, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'video', duration: 20, width: 720, height: 1280, hasAudio: true }), changed: () => undefined });
    s.setBrand({ handle: '@keo.ai', endText: 'Follow Keo' });
    expect(s.brand()).toEqual({ handle: '@keo.ai', endText: 'Follow Keo' });
    const file = path.join(dir, 'talk.mp4');
    fs.writeFileSync(file, 'x');
    const p = s.create('Brand', 'vertical');
    const vid = (await s.importFiles(p.id, [file])).added[0]!;
    s.edit(p.id, [{ op: 'add_media', assetId: vid.id, start: 0 }]);
    const texts = () => s.get(p.id).tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.type === 'text');
    s.applyStyle(p.id, 'podcast-frame', { sfx: {} });
    expect(texts().at(-1)!.text).toBe('Follow Keo\n@keo.ai');
    s.undoEdit(p.id);
    s.applyStyle(p.id, 'podcast-frame', { sfx: {}, handle: '@other' });
    expect(texts().at(-1)!.text).toBe('Follow Keo\n@other');
  });
});
