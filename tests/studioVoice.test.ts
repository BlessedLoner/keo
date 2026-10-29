import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readWav, wavOf } from '../src/main/studio/captions';
import type { AudioClip } from '../src/shared/studio';
import { speechLike } from './fakeSpeechSound';
import { makeHarness, tempDir, type Harness } from './helpers';

/** Read aloud and recorded voice-overs (a test voice; nothing leaves the PC). */

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

function setup() {
  const spoken: string[] = [];
  h = makeHarness({
    dir: path.join(tempDir('keo-voice-'), 'profile'),
    deps: {
      studioNarrate: async (text) => {
        spoken.push(text);
        return { audio: wavOf(speechLike(2, [[0.1, 1.9]]), 16000), mimeType: 'audio/wav' };
      },
      studioProbe: async (file) => ({ kind: 'audio', duration: readWav(fs.readFileSync(file)).samples.length / 16000, width: 0, height: 0, hasAudio: true }),
    },
  });
  return { spoken };
}

describe('Studio voices', () => {
  it('reads a text clip aloud onto the Voice track, once per text', async () => {
    const v = setup();
    const s = h!.services;
    const p = s.studio.create('Voice', 'vertical');
    const clip = s.studio.edit(p.id, [{ op: 'add_text', text: 'Welcome back', start: 1.5, duration: 3 }]).project.tracks.find((t) => t.kind === 'text')!.clips[0]!;
    const r = await s.studioReadAloud(p.id, clip.id, 'female');
    expect(r.seconds).toBeCloseTo(2, 2);
    const voice = s.studio.get(p.id).tracks.find((t) => t.name === 'Voice')!.clips[0] as AudioClip;
    expect(voice.start).toBe(1.5);
    expect(v.spoken).toEqual(['Welcome back']);
    // The same text again: no new voice is made.
    await s.studioReadAloud(p.id, clip.id, 'female');
    expect(v.spoken).toHaveLength(1);
    await expect(s.studioReadAloud(p.id, voice.id, 'female')).rejects.toThrow(/Pick a text clip/);
  });

  it('saves a recorded voice-over at the playhead where recording started', async () => {
    setup();
    const s = h!.services;
    const p = s.studio.create('Rec', 'vertical');
    const r = await s.studio.saveRecording(p.id, wavOf(speechLike(3, [[0.2, 2.8]]), 16000), 4);
    expect(r.seconds).toBeCloseTo(3, 2);
    const voice = s.studio.get(p.id).tracks.find((t) => t.name === 'Voice')!.clips[0] as AudioClip;
    expect(voice.start).toBe(4);
    expect(fs.existsSync(s.studio.get(p.id).assets[0]!.path)).toBe(true);
    await expect(s.studio.saveRecording(p.id, Buffer.from('not a wav file at all, just text that is long enough'), 0)).rejects.toThrow(/could not be read/);
  });
});

describe('Studio projects', () => {
  it('copies a project, and the list shows a cover picture', async () => {
    setup();
    const s = h!.services.studio;
    const p = s.create('Original', 'vertical');
    const copy = s.duplicate(p.id);
    expect(copy.id).not.toBe(p.id);
    expect(copy.name).toBe('Original (copy)');
    const list = s.list();
    expect(list.map((x) => x.name).sort()).toEqual(['Original', 'Original (copy)']);
    expect(list[0]!.cover).toBeNull();
  });
});

describe('Undo history', () => {
  it('names each change, newest first, and moves names between undo and redo', () => {
    setup();
    const s = h!.services.studio;
    const p = s.create('History', 'vertical');
    s.edit(p.id, [{ op: 'add_text', text: 'First', start: 0, duration: 2 }]);
    s.edit(p.id, [{ op: 'add_text', text: 'Second', start: 2, duration: 2 }]);
    let hist = s.canUndo(p.id);
    expect(hist.undoLabels).toEqual(['Added text “Second” at 2s', 'Added text “First” at 0s']);
    s.undoEdit(p.id);
    hist = s.canUndo(p.id);
    expect(hist.undoLabels).toEqual(['Added text “First” at 0s']);
    expect(hist.redoLabels).toEqual(['Added text “Second” at 2s']);
    s.redoEdit(p.id);
    expect(s.canUndo(p.id).undoLabels[0]).toBe('Added text “Second” at 2s');
  });
});
