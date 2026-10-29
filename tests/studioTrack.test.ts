import { describe, expect, it } from 'vitest';
import { frameShift, smooth, trackBox, videoPlacement, type Gray } from '../src/shared/studioTrack';
import { MediaClip } from '../src/shared/studio';

const W = 160;
const H = 90;
/** A textured grey scene, the same for the same (x, y). */
const tex = (x: number, y: number) => ((x * 73856093) ^ (y * 19349663)) & 0x7f;

/** A frame with a bright patterned square whose top-left is at (sx, sy), on the texture shifted by (ox, oy). */
function frame(sx: number, sy: number, ox = 0, oy = 0): Gray {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const inSq = x >= sx && x < sx + 16 && y >= sy && y < sy + 16;
      px[y * W + x] = inSq ? 150 + (((x - sx) * 7 + (y - sy) * 3) % 100) : tex(x - ox, y - oy);
    }
  return { w: W, h: H, px };
}

describe('Motion tracking', () => {
  it('follows a moving thing frame by frame', () => {
    const frames = Array.from({ length: 30 }, (_, i) => frame(20 + i * 3, 30 + Math.round(Math.sin(i / 4) * 10)));
    const path = trackBox(frames, { x: 20, y: 30, w: 16, h: 16 });
    path.forEach((p, i) => {
      expect(p.x * W).toBeCloseTo(20 + i * 3 + 8, 0);
      expect(p.y * H).toBeCloseTo(30 + Math.round(Math.sin(i / 4) * 10) + 8, 0);
      expect(p.lost).toBe(false);
    });
  });

  it('measures how the whole picture shakes', () => {
    expect(frameShift(frame(200, 200), frame(200, 200, 3, -2), 8)).toEqual({ dx: 3, dy: -2 });
    expect(frameShift(frame(200, 200), frame(200, 200), 8)).toEqual({ dx: 0, dy: 0 });
  });

  it('smooths a shaky path', () => {
    expect(smooth([0, 10, 0, 10, 0], 1).map((v) => Math.round(v * 10) / 10)).toEqual([5, 3.3, 6.7, 3.3, 5]);
  });

  it('maps a point of the video into the frame and back', () => {
    const c = MediaClip.parse({ id: 'cl_aaaa', type: 'media', assetId: 'as_aaaa', start: 0, duration: 2, fit: 'contain' });
    // A landscape video shown whole in a vertical frame: it fills the width, centred.
    const m = videoPlacement(c, { id: 'as_aaaa', kind: 'video', path: 'x', name: 'x', duration: 2, width: 1920, height: 1080, hasAudio: false }, 1080, 1920);
    const f = m.toFrame(0.5, 0);
    expect(f.x).toBeCloseTo(0.5);
    expect(f.y).toBeCloseTo((1920 - 607.5) / 2 / 1920, 3);
    const back = m.toVideo(f.x, f.y);
    expect([back.x, back.y].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.5, 0]);
  });
});
