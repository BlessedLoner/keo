import { describe, expect, it } from 'vitest';
import { viralPlan } from '../src/shared/studioViral';

/** Words spread over time, a sentence per string (each ends with a full stop). */
function talk(lines: string[]) {
  const out: Array<{ text: string; start: number; end: number }> = [];
  let t = 0.5;
  for (const line of lines) {
    for (const w of line.split(' ')) {
      out.push({ text: w, start: t, end: t + 0.3 });
      t += 0.35;
    }
    t += 1.2;
  }
  return out;
}

describe('Viral templates', () => {
  it('numbered list: each counted point gets its own numbered scene, then a recap', () => {
    const words = talk(['Here are three ways to grow your channel.', 'First, post every single day.', 'Second, reply to every comment.', 'Third, study your best videos.', 'Do this and you will grow.']);
    const p = viralPlan('listicle', words);
    const scenes = p.beats.filter((b) => b.kind === 'scene');
    expect(scenes.map((b) => b.sub)).toEqual(['#1', '#2', '#3']);
    expect(scenes[0]!.text).toContain('post');
    expect(p.beats.find((b) => b.kind === 'frame')!.items).toHaveLength(3);
    expect(p.hook).toBeTruthy();
    expect(p.note).toBeUndefined();
  });

  it('myth vs fact: the belief on a dark scene, the truth on a light one', () => {
    const words = talk(['Most people think AI video is expensive.', 'It is actually cheap when you test first.', 'So start small.']);
    const p = viralPlan('myth-fact', words);
    const scenes = p.beats.filter((b) => b.kind === 'scene');
    expect(scenes.map((b) => [b.sub, b.tone])).toEqual([['MYTH', 'dark'], ['FACT', 'light']]);
  });

  it('falls back to hook → payoff and says why when the structure is not in the words', () => {
    const p = viralPlan('listicle', talk(['I want to tell you about my week.', 'It was a long one.']));
    expect(p.note).toMatch(/numbered points/);
    expect(p.energy).toBe('normal');
  });

  it('uses the user’s own opening line, and story time stays calm and dark', () => {
    expect(viralPlan('hook-payoff', talk(['Hello there friends.', 'Today is big.']), { hook: 'Nobody tells you this' }).hook).toBe('Nobody tells you this');
    const s = viralPlan('story-time', talk(['It was raining that night.', 'I opened the door.']));
    expect(s).toMatchObject({ energy: 'calm', look: 'dark' });
    expect(s.hook).toMatch(/^Story time/);
  });
});
