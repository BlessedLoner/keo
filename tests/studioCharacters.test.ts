import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { speakerOf } from '../src/shared/studioCharacters';
import { scenesFromScript } from '../src/shared/studioFaceless';
import { makeHarness, tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const service = (dir = tempDir('keo-chars-')) => ({ s: new StudioService({ dir: path.join(dir, 'studio'), log, exportsDir: () => path.join(dir, 'Videos'), probe: async () => ({ kind: 'image', duration: 0, width: 800, height: 800, hasAudio: false }), changed: () => undefined }), dir });

describe('Characters', () => {
  it('are added, changed and removed, with their pictures kept in Keo’s folder', () => {
    const { s, dir } = service();
    const kira = s.saveCharacter({ name: 'Kira', look: 'long blonde hair, black dress', voice: 'nova' });
    expect(kira.id).toMatch(/^ch_/);
    expect(() => s.saveCharacter({ name: 'kira' })).toThrow(/already a character called kira/);
    const photo = path.join(dir, 'kira.jpg');
    fs.writeFileSync(photo, 'jpeg');
    const withPic = s.addCharacterPicture(kira.id, photo);
    expect(withPic.pictures).toHaveLength(1);
    expect(withPic.pictures[0]).not.toBe(photo);
    // Moving the original does not lose the character's picture.
    fs.rmSync(photo);
    expect(s.character(kira.id).pictures).toHaveLength(1);
    expect(() => s.addCharacterPicture(kira.id, path.join(dir, 'notes.txt'))).toThrow(/Choose a picture/);
    s.saveCharacter({ id: kira.id, voice: 'shimmer' });
    expect(s.character(kira.id)).toMatchObject({ name: 'Kira', voice: 'shimmer', look: 'long blonde hair, black dress' });
    const keep = s.character(kira.id).pictures[0]!;
    s.removeCharacterPicture(kira.id, keep);
    expect(fs.existsSync(keep)).toBe(false);
    s.deleteCharacter(kira.id);
    expect(s.characters()).toEqual([]);
  });

  it('a script paragraph starting with a character’s name is their line', () => {
    const cast = [{ id: 'ch_kira00001', name: 'Kira' }];
    expect(speakerOf('Kira: Welcome back!', cast)).toEqual({ character: 'ch_kira00001', text: 'Welcome back!' });
    expect(speakerOf('Note: this is not a character', cast)).toBeNull();
    const scenes = scenesFromScript('Kira: Welcome back!\n[picture: a neon city]\n\nThe city never sleeps.', cast);
    expect(scenes.map((s) => [s.speaker ?? null, s.narration])).toEqual([
      ['ch_kira00001', 'Welcome back!'],
      [null, 'The city never sleeps.'],
    ]);
  });

  it('a character’s scenes without a picture show their own picture (no AI picture needed)', async () => {
    const h = makeHarness();
    try {
      const kira = h.services.studio.saveCharacter({ name: 'Kira', voice: 'nova' });
      const photo = path.join(h.dir, 'kira.png');
      fs.writeFileSync(photo, 'png');
      h.services.studio.addCharacterPicture(kira.id, photo);
      const scenes = scenesFromScript('Kira: Hi there.\n\nKira: Watch this.\n[picture: a sunset over the sea]\n\nAnd that is the story.', h.services.studio.characters());
      const plan = h.services.facelessPlan({ title: 'T', format: 'vertical', voice: 'female', pictureStyle: '', captions: 'bold', look: 'off', musicVolume: 0.25, soundEffects: true, scenes, cast: [kira.id] });
      // Scene 1 uses Kira's picture; scene 2 (its own picture description) and 3 need AI pictures.
      expect(plan.aiPictures).toBe(2);
    } finally {
      await h.close();
    }
  });
});
