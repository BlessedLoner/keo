import { describe, expect, it } from 'vitest';
import { dropLoops } from '../src/main/studio/captions';

const w = (s: string) => s.split(' ');
const same = (x: string) => x;

describe('Speech-to-text loops', () => {
  it('keeps one of a phrase the service repeated over and over', () => {
    expect(dropLoops(w('I have got the um, the um, the um, the um, the um, and then'), same).join(' ')).toBe('I have got the um, and then');
  });
  it('keeps real repeats people say', () => {
    expect(dropLoops(w('no, no, no it is very very good'), same).join(' ')).toBe('no, no, no it is very very good');
    expect(dropLoops(w('yes yes yes yes'), same).join(' ')).toBe('yes');
  });
  it('never more words than the speech can hold', () => {
    expect(dropLoops(w('a b c d e f g h i j k l m n o p'), same, 2)).toHaveLength(13);
  });
});
