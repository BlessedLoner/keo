import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { characterPicturePrompt, CharacterPictureJob, nearestAspect } from '../src/shared/studioCharacterPictures';
import type { Asset } from '../src/shared/studio';
import { makeHarness, passthroughImages, type Harness } from './helpers';

describe('My character in my pictures: the request', () => {
  it('keeps each picture’s own shape', () => {
    expect(nearestAspect(1080, 1920)).toBe('9:16');
    expect(nearestAspect(1080, 1350)).toBe('4:5');
    expect(nearestAspect(1200, 1200)).toBe('1:1');
    expect(nearestAspect(1920, 1080)).toBe('16:9');
    expect(nearestAspect(3000, 2000)).toBe('3:2');
  });

  it('asks for the same pose, place and light, and keeps or changes the clothes', () => {
    const keep = characterPicturePrompt('Kira', 2, {});
    expect(keep).toContain('the first 2 pictures');
    expect(keep).toMatch(/pose.*background.*lighting/);
    expect(keep).toContain('Keep the clothes');
    const cute = characterPicturePrompt('Kira', 1, { outfit: 'a soft pink knit cardigan and a pleated skirt', person: 'the woman on the left' });
    expect(cute).toContain('dress Kira in a soft pink knit cardigan and a pleated skirt');
    expect(cute).not.toContain('Keep the clothes');
    expect(cute).toContain('the woman on the left in the last picture');
    expect(cute).toContain('Leave everyone else');
    expect(CharacterPictureJob.safeParse({ assetId: 'as_photo0001', outfit: 'x' }).success).toBe(false);
  });

  it('keeps everything that makes the character who they are, and takes other changes in the user’s words', () => {
    const p = characterPicturePrompt('Kira', 3, { outfit: 'cute', change: 'sitting on the bed, smiling' });
    expect(p).toMatch(/body shape and proportions/);
    expect(p).toMatch(/every tattoo, piercing, birthmark/);
    expect(p).toContain('never copy the face, body, skin, tattoos or hair of the person in the last picture');
    expect(p).toContain('cute, feminine outfit');
    expect(p).toContain('Also change, as asked: sitting on the bed, smiling');
    expect(p).not.toContain('Keep everything else in the last picture the same: the pose');
    expect(CharacterPictureJob.safeParse({ assetId: 'as_photo0001', outfit: 'cute', change: 'hand on hip' }).success).toBe(true);
  });
});

describe('My character in my pictures: making them (fake picture model)', () => {
  let h: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    h = null;
  });

  it('makes one picture per photo from the character’s photos, keeps it in Pictures\\Keo, and lays it over the original', async () => {
    h = makeHarness({ deps: { imageTools: { ...passthroughImages, jpeg: (f: string) => fs.readFileSync(f) } } });
    (h.services as unknown as { picturesDir: string }).picturesDir = path.join(h.dir, 'Pictures');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reaching into services in a test
    const svc = h.services as unknown as Record<string, any>;
    const dir = h.dir;
    const file = (name: string) => {
      const f = path.join(dir, name);
      fs.writeFileSync(f, `jpeg-${name}`);
      return f;
    };
    // Kira, with two photos.
    const kira = svc.studio.saveCharacter({ name: 'Kira', look: 'AI-made', voice: 'female', pictures: [file('kira1.jpg'), file('kira2.jpg')] });
    // A project with two saved pictures, one of them on the timeline.
    const p = svc.studio.create('Photos', 'vertical');
    const A = (id: string, name: string, w: number, hgt: number): Asset => ({ id, kind: 'image', path: file(name), name, duration: 0, width: w, height: hgt, hasAudio: false });
    svc.studio.save({ ...svc.studio.get(p.id), assets: [A('as_beach001', 'beach.jpg', 1080, 1350), A('as_cafe0001', 'cafe.jpg', 1080, 1920)] });
    svc.studio.edit(p.id, [{ op: 'add_media', assetId: 'as_beach001', start: 0, duration: 3, fit: 'cover' }]);
    // The picture model and the import are stand-ins: nothing leaves the PC, nothing is paid.
    const asked: Array<{ refs: number; aspect: string; prompt: string }> = [];
    svc.aiVideo.frame = async (r: { references: Buffer[]; aspect: string; prompt: string }) => {
      asked.push({ refs: r.references.length, aspect: r.aspect, prompt: r.prompt });
      return { file: file(`made-${asked.length}.png`), cached: false };
    };
    let n = 0;
    svc.studio.importFiles = async (id: string, files: string[]) => {
      const proj = svc.studio.get(id);
      const added = files.map((f) => ({ id: `as_made000${++n}`, kind: 'image', path: f, name: path.basename(f), duration: 0, width: 1080, height: 1350, hasAudio: false }));
      svc.studio.save({ ...proj, assets: [...proj.assets, ...added] });
      return { project: svc.studio.get(id), added, skipped: [] };
    };
    svc.aiAfford = async () => undefined;
    const r = await svc.studioCharacterPictures(p.id, { character: kira.id, pictures: [{ assetId: 'as_beach001' }, { assetId: 'as_cafe0001', outfit: 'a pastel sundress' }] }, new AbortController().signal);
    expect(r.failed).toEqual([]);
    expect(r.made).toHaveLength(2);
    expect(asked.map((a) => a.refs)).toEqual([3, 3]); // both of Kira's photos, then the picture
    expect(asked.map((a) => a.aspect).sort()).toEqual(['4:5', '9:16']);
    expect(asked.some((a) => a.prompt.includes('pastel sundress'))).toBe(true);
    expect(r.made.every((m: { file: string }) => fs.existsSync(m.file) && m.file.includes(path.join('Keo', 'Kira pictures')))).toBe(true);
    // The beach picture was on the timeline: the new one lies over it; the café one was not.
    const beach = r.made.find((m: { from: string }) => m.from === 'as_beach001');
    expect(beach.clip).toMatch(/^cl_/);
    expect(r.made.find((m: { from: string }) => m.from === 'as_cafe0001').clip).toBeNull();
    expect(svc.studio.get(p.id).tracks.some((t: { name: string }) => t.name === 'Kira pictures')).toBe(true);
  });
});
