import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SoundLibrary } from '../src/main/studio/soundLibrary';
import { findSounds, guessSound } from '../src/shared/studioSounds';
import { tempDir } from './helpers';

/** The user's sound library: music and sound effects for every project. */

describe('Sound library', () => {
  it('guesses what a sound is from its name and length', () => {
    expect(guessSound('Burna Boy style afrobeat instrumental.mp3', 180)).toEqual({ kind: 'music', genre: 'afrobeats' });
    expect(guessSound('trap beat 2.mp3', 140)).toEqual({ kind: 'music', genre: 'hip-hop' });
    expect(guessSound('whoosh fast.wav', 0.8)).toEqual({ kind: 'effect', genre: 'whoosh' });
    expect(guessSound('untitled.wav', 3)).toEqual({ kind: 'effect', genre: 'other' });
    expect(guessSound('untitled.mp3', 95)).toEqual({ kind: 'music', genre: 'other' });
  });

  it('copies sounds in once, sorts and finds them, and keeps Keo’s own effects', async () => {
    const dir = tempDir('keo-sounds-');
    const a = path.join(dir, 'Amapiano log drum groove.mp3');
    const b = path.join(dir, 'cash register ding.wav');
    const notSound = path.join(dir, 'notes.txt');
    fs.writeFileSync(a, 'song-bytes');
    fs.writeFileSync(b, 'ding-bytes');
    fs.writeFileSync(notSound, 'x');
    const lib = new SoundLibrary({ dir: path.join(dir, 'library'), measure: async (f) => (f.includes('groove') ? 200 : 1.2) });
    const r = await lib.add([a, b, notSound]);
    expect(r.added.map((s) => [s.name, s.kind, s.genre])).toEqual([
      ['Amapiano log drum groove', 'music', 'amapiano'],
      ['cash register ding', 'effect', 'ding'],
    ]);
    expect(r.skipped).toHaveLength(1);
    // The same file again is not added twice (even under another name).
    fs.copyFileSync(a, path.join(dir, 'copy.mp3'));
    expect((await lib.add([path.join(dir, 'copy.mp3')])).skipped[0]).toMatch(/already/);
    // Copied into Keo's folder: it stays when the original goes.
    fs.rmSync(a);
    const music = lib.list({ kind: 'music' });
    expect(music).toHaveLength(1);
    expect(fs.existsSync(lib.file(music[0]!.id)!)).toBe(true);
    expect(lib.list({ kind: 'effect' }).map((s) => s.name)).toEqual(['cash register ding', 'Whoosh (Keo)', 'Pop (Keo)', 'Click (Keo)', 'Ding (Keo)', 'Riser (Keo)', 'Boom (Keo)', 'Swipe (Keo)']);
    expect(lib.list({ query: 'log drum' }).map((s) => s.name)).toEqual(['Amapiano log drum groove']);
    expect(lib.list({ kind: 'effect', genre: 'impact' }).map((s) => s.name)).toEqual(['Boom (Keo)']);
    // Re-sorted by the user.
    const moved = lib.update(music[0]!.id, { genre: 'house', tags: ['Party', 'party', 'night'] });
    expect([moved.genre, moved.tags]).toEqual(['house', ['party', 'night']]);
    expect(() => lib.update(music[0]!.id, { genre: 'whoosh' })).toThrow(/not a music genre/);
    expect(() => lib.update('sfx_whoosh', { name: 'x' })).toThrow(/cannot be changed/);
    lib.remove(music[0]!.id);
    expect(lib.list({ kind: 'music' })).toHaveLength(0);
  });

  it('search matches names, genres and tags', () => {
    const base = { tags: [] as string[], duration: 1, addedAt: '2026-01-01' };
    const all = [
      { ...base, id: 'sn_1aaaa', name: 'Night drive', kind: 'music' as const, genre: 'electronic' as const, tags: ['synthwave'] },
      { ...base, id: 'sn_2aaaa', name: 'Boom bap loop', kind: 'music' as const, genre: 'hip-hop' as const },
    ];
    expect(findSounds(all, { query: 'synthwave' }).map((s) => s.name)).toEqual(['Night drive']);
    expect(findSounds(all, { query: 'hip hop' }).map((s) => s.name)).toEqual(['Boom bap loop']);
  });
});
