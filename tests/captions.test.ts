import { describe, expect, it } from 'vitest';
import { captionLines, pieces, readWav, spreadWords, voicedSpans, wavOf } from '../src/main/studio/captions';
import { applyEdits, newProject } from '../src/shared/studio';
import { speechLike } from './fakeSpeechSound';

describe('Studio captions', () => {
  it('reads back the WAV it writes', () => {
    const s = speechLike(1, [[0.2, 0.6]]);
    const w = readWav(wavOf(s, 16000, 0.25, 0.75));
    expect(w.rate).toBe(16000);
    expect(w.samples.length).toBe(8000);
    expect(w.samples[0]).toBe(s[4000]);
  });

  it('finds the stretches of speech and joins short gaps', () => {
    const s = speechLike(6, [
      [0.5, 1.5],
      [1.65, 2.2],
      [3.5, 4.4],
    ]);
    const spans = voicedSpans(s, 16000);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBeCloseTo(0.45, 1);
    expect(spans[0]!.end).toBeCloseTo(2.28, 1);
    expect(spans[1]!.start).toBeCloseTo(3.45, 1);
    // Pieces for text-only transcription stay short and split at the pauses.
    expect(pieces(spans, 2).map((g) => g.length)).toEqual([1, 1]);
    expect(pieces(spans, 14)).toHaveLength(1);
  });

  it('silence has no speech', () => {
    expect(voicedSpans(speechLike(2, []), 16000)).toEqual([]);
  });

  it('spreads a transcript over the voiced time, skipping the pauses', () => {
    const words = spreadWords('Hello there, my friend', [
      { start: 1, end: 2 },
      { start: 5, end: 6 },
    ]);
    expect(words.map((w) => w.text)).toEqual(['Hello', 'there,', 'my', 'friend']);
    expect(words[0]!.start).toBeCloseTo(1, 2);
    expect(words.at(-1)!.end).toBeCloseTo(6, 2);
    // No word lands inside the pause.
    for (const w of words) expect(w.start < 2.001 || w.start >= 5).toBe(true);
    for (let i = 1; i < words.length; i++) expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
  });

  it('makes short caption lines that break at sentences and pauses', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end });
    const lines = captionLines([w('So', 0, 0.2), w('today', 0.25, 0.5), w('we', 0.55, 0.7), w('edit.', 0.75, 1), w('Watch', 1.1, 1.3), w('this', 2.5, 2.8)], { maxWords: 3 });
    expect(lines.map((l) => l.text)).toEqual(['So today we', 'edit.', 'Watch', 'this']);
    expect(lines[0]!.end).toBeLessThanOrEqual(lines[1]!.start);
    expect(lines[0]!.words).toHaveLength(3);
    expect(lines.at(-1)!.end).toBeCloseTo(3.2, 2);
  });

  it('adds the lines on one Captions track and replaces earlier auto-captions', () => {
    let n = 0;
    const rand = () => `r${String(++n).padStart(7, '0')}`;
    const p0 = newProject({ name: 'C', rand });
    const lines = [
      { text: 'Hello there', start: 0, end: 1, words: [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'there', start: 0.5, end: 1 }] },
      { text: 'friend', start: 1, end: 1.6 },
    ];
    let p = applyEdits(p0, [{ op: 'add_captions', lines, replace: true }], { rand }).project;
    const tr = p.tracks.find((t) => t.name === 'Captions')!;
    expect(tr.kind).toBe('text');
    expect(p.tracks.at(-1)!.id).toBe(tr.id);
    expect(tr.clips).toHaveLength(2);
    const first = tr.clips[0]!;
    expect(first.type === 'text' && first.words?.length).toBe(2);
    expect(first.type === 'text' && first.highlight).toBe('#FFD400');
    expect(first.type === 'text' && first.style.uppercase).toBe(true);
    p = applyEdits(p, [{ op: 'add_captions', lines: [lines[1]!], replace: true, style: { color: '#00FF00' } }], { rand }).project;
    const again = p.tracks.filter((t) => t.name === 'Captions');
    expect(again).toHaveLength(1);
    expect(again[0]!.clips).toHaveLength(1);
    expect(again[0]!.clips[0]!.type === 'text' && again[0]!.clips[0]!.style.color).toBe('#00FF00');
  });
});
