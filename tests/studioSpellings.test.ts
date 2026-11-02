import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, replaceWords, type TextClip } from '../src/shared/studio';
import { patchBrand, respell } from '../src/shared/studioBrand';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

describe('Fixing misheard words', () => {
  it('replaces whole words, any case, keeping punctuation', () => {
    expect(replaceWords('Meet KUI, your AI. kui is smart', 'kui', 'Keo')).toEqual({ text: 'Meet Keo, your AI. Keo is smart', at: [1, 4] });
    expect(replaceWords('quick quirk', 'kui', 'Keo')).toBeNull();
    expect(replaceWords('the K U I app', 'K U I', 'Keo')!.text).toBe('the Keo app');
  });

  it('replace_words fixes captions and their timed words in one edit', () => {
    n = 0;
    let p = applyEdits(newProject({ name: 'S', rand }), [
      {
        op: 'add_captions',
        replace: true,
        lines: [
          { text: 'about KUI and', start: 0, end: 2, words: [{ text: 'about', start: 0, end: 0.5 }, { text: 'KUI', start: 0.5, end: 1.1 }, { text: 'and', start: 1.1, end: 1.5 }] },
        ],
      },
      { op: 'add_text', text: 'Meet KUI', start: 0, duration: 2 },
    ], { rand }).project;
    p = applyEdits(p, [{ op: 'replace_words', find: 'kui', replace: 'Keo AI' }], { rand }).project;
    const texts = p.tracks.flatMap((t) => t.clips).filter((c): c is TextClip => c.type === 'text');
    expect(texts.map((c) => c.text).sort()).toEqual(['Meet Keo AI', 'about Keo AI and']);
    const cap = texts.find((c) => c.words)!;
    expect(cap.words!.map((w) => [w.text, w.start, w.end])).toEqual([
      ['about', 0, 0.5],
      ['Keo', 0.5, 0.8],
      ['AI', 0.8, 1.1],
      ['and', 1.1, 1.5],
    ]);
    expect(() => applyEdits(p, [{ op: 'replace_words', find: 'nothing here', replace: 'x' }], { rand })).toThrow(/not in any text/);
  });

  it('brand kit spellings respell the transcript, keeping times', () => {
    const b = patchBrand({}, { spellings: [{ heard: 'KUI', say: 'Keo' }] });
    const words = [{ text: 'about', start: 0, end: 0.5 }, { text: 'kui,', start: 0.5, end: 1 }];
    expect(respell(words, b.spellings)).toEqual([{ text: 'about', start: 0, end: 0.5 }, { text: 'Keo,', start: 0.5, end: 1 }]);
    expect(respell(words, undefined)).toBe(words);
  });
});
