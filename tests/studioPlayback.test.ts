import { describe, expect, it } from 'vitest';
import { keepUp } from '../src/shared/studioPlayback';

describe('Studio preview keeps video in step without jumping', () => {
  it('a video a little behind plays a little faster, a little ahead a little slower, with no seek', () => {
    const behind = { currentTime: 9.8, paused: false };
    expect(keepUp(behind, 10, 1)).toBeCloseTo(1.08, 5);
    expect(behind.currentTime).toBe(9.8);
    const ahead = { currentTime: 10.1, paused: false };
    expect(keepUp(ahead, 10, 1)).toBeCloseTo(0.95, 5);
    expect(ahead.currentTime).toBe(10.1);
    // Within a frame or two: the clip's own speed.
    expect(keepUp({ currentTime: 10.02, paused: false }, 10, 2)).toBe(2);
  });

  it('far off (a cut or a click elsewhere) it jumps to the moment; a video not started yet sooner', () => {
    const far = { currentTime: 3, paused: false };
    expect(keepUp(far, 10, 1)).toBe(1);
    expect(far.currentTime).toBe(10);
    const starting = { currentTime: 9.7, paused: true };
    keepUp(starting, 10, 1);
    expect(starting.currentTime).toBe(10);
  });
});
