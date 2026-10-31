import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;

async function setup() {
  const dir = tempDir('keo-versions-');
  const s = new StudioService({ dir: path.join(dir, 'studio'), log, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'video', duration: 20, width: 720, height: 1280, hasAudio: true }), changed: () => undefined });
  const file = path.join(dir, 'talk.mp4');
  fs.writeFileSync(file, 'x');
  const p = s.create('Versions', 'vertical');
  const vid = (await s.importFiles(p.id, [file])).added[0]!;
  s.edit(p.id, [{ op: 'add_media', assetId: vid.id, start: 0 }]);
  return { s, p, dir };
}
const texts = (s: StudioService, id: string) => s.get(id).tracks.flatMap((t) => t.clips).filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);

describe('Versions of an edit', () => {
  it('saves, lists newest first, restores as one undoable step', async () => {
    const { s, p } = await setup();
    s.edit(p.id, [{ op: 'add_text', text: 'Frame look', start: 0, duration: 2 }]);
    const a = s.saveVersion(p.id, 'Podcast frame');
    s.edit(p.id, [{ op: 'add_text', text: 'Doc look', start: 3, duration: 2 }]);
    s.saveVersion(p.id, 'Documentary');
    expect(s.versions(p.id).map((v) => v.name)).toEqual(['Documentary', 'Podcast frame']);
    s.restoreVersion(p.id, a.id);
    expect(texts(s, p.id)).toEqual(['Frame look']);
    s.undoEdit(p.id);
    expect(texts(s, p.id)).toEqual(['Frame look', 'Doc look']);
  });

  it('keeps the project’s name and media, refuses unknown versions, and goes with the project', async () => {
    const { s, p, dir } = await setup();
    const v = s.saveVersion(p.id, 'First');
    s.edit(p.id, [{ op: 'set_project', name: 'Renamed' }]);
    expect(s.restoreVersion(p.id, v.id).name).toBe('Renamed');
    expect(() => s.restoreVersion(p.id, 'vr_missing01')).toThrow(/not saved/);
    s.deleteVersion(p.id, v.id);
    expect(s.versions(p.id)).toEqual([]);
    s.saveVersion(p.id, 'Again');
    s.delete(p.id);
    expect(fs.existsSync(path.join(dir, 'studio', 'versions', p.id))).toBe(false);
  });
});
