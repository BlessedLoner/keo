import { describe, expect, it } from 'vitest';
import { Design, designTime, keyValue, pieceProgress, revealRanks } from '../src/shared/studioDesign';
import { pickVideoDirections, VIDEO_DIRECTIONS, videoDirectionBrief, withDirectionDefaults } from '../src/shared/studioDirections';
import { applyEdits, EditOp, MOTION_PIECES, MotionClip, newProject } from '../src/shared/studio';
import { z } from 'zod';

describe('Keo designs its own motion graphics', () => {
  const design = Design.parse({
    layers: [
      { kind: 'text', text: 'MAKE IT LOUD', font: 'Unbounded', split: 'chars', stagger: 0.05, revealFor: 0.5, leaveAt: -0.5 },
      { kind: 'shape', shape: 'path', path: 'M0 50 C 30 0 70 100 100 50', stroke: '#FFD23F', strokeWidth: 1, fill: null, draw: 0, keys: [{ t: 0.2, draw: 0 }, { t: 1, draw: 1, ease: 'expo' }] },
      { kind: 'particles', motion: 'burst', count: 30 },
      { kind: 'gradient', colors: ['#1A0B3D', '#0A0A0F'], radial: true },
    ],
  });

  it('is a motion piece Keo can add like any other, checked as data (never code)', () => {
    expect(MOTION_PIECES).toContain('design');
    const op = z.array(EditOp).parse([{ op: 'add_motion', piece: 'design', text: 'Title', start: 1, duration: 3, design }]);
    expect((op[0] as { design?: Design }).design?.layers).toHaveLength(4);
    expect(MotionClip.safeParse({ id: 'mo_1', type: 'motion', start: 0, duration: 3, piece: 'design', text: 'x', design: { layers: [{ kind: 'text', text: 'hi', size: 9999 }] } }).success).toBe(false);
    expect(Design.safeParse({ layers: [{ kind: 'script', code: 'alert(1)' }] }).success).toBe(false);
  });

  it('the design is kept on the clip Studio saves, can be changed later, and a design piece needs one', () => {
    const p = newProject({ name: 'Kicklab promo' });
    const ops = z.array(EditOp).parse([{ op: 'add_motion', piece: 'design', text: 'KICKLAB', start: 0, duration: 4, design }]);
    const r = applyEdits(p, ops);
    const clip = r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'motion') as MotionClip;
    expect(clip.design?.layers).toHaveLength(4);
    const smaller = Design.parse({ layers: [{ kind: 'text', text: 'DROP 01' }] });
    const r2 = applyEdits(r.project, z.array(EditOp).parse([{ op: 'set', clip: clip.id, motion: { design: smaller } }]));
    expect((r2.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id) as MotionClip).design?.layers).toHaveLength(1);
    expect(() => applyEdits(p, z.array(EditOp).parse([{ op: 'add_motion', piece: 'design', text: 'x', start: 0, duration: 2 }]))).toThrow(/needs design/);
  });

  it('keyframes ease between values; negative times count back from the end', () => {
    const keys = [{ t: 0, opacity: 0, ease: 'out' as const }, { t: 1, opacity: 1, ease: 'linear' as const }, { t: -0.5, opacity: 1, ease: 'out' as const }, { t: -0.1, opacity: 0, ease: 'linear' as const }];
    expect(keyValue(keys, 'opacity', 0.5, 4, 1)).toBeCloseTo(0.5);
    expect(keyValue(keys, 'opacity', 2, 4, 1)).toBe(1);
    expect(keyValue(keys, 'opacity', 3.9, 4, 1)).toBeCloseTo(0);
    expect(keyValue([], 'scale', 1, 4, 1.5)).toBe(1.5);
    expect(designTime(-0.5, 4)).toBe(3.5);
  });

  it('split text builds piece by piece in the order asked, and leaves again', () => {
    const l = design.layers[0] as Extract<Design['layers'][number], { kind: 'text' }>;
    expect(revealRanks(5, 'end', 1)).toEqual([4, 3, 2, 1, 0]);
    expect(revealRanks(5, 'center', 1)[2]).toBe(0);
    expect(pieceProgress(l, 0, 10, 0.3, 3)).toBeGreaterThan(0.5);
    expect(pieceProgress(l, 9, 10, 0.3, 3)).toBe(0);
    expect(pieceProgress(l, 0, 10, 1.5, 3)).toBeCloseTo(1, 2);
    expect(pieceProgress(l, 0, 10, 3, 3)).toBeLessThan(0.05);
  });
});

describe('video art directions', () => {
  it('suit what the video is about, and never repeat the recent ones', () => {
    expect(pickVideoDirections('a podcast clip about motivation')[0]!.id).toBe('kinetic-type');
    expect(pickVideoDirections('a sneaker drop promo')[0]!.id).toBe('hype-street');
    const picks = pickVideoDirections('a travel vlog', ['warm-vlog']);
    expect(picks.map((d) => d.id)).not.toContain('warm-vlog');
    expect(new Set(picks.map((d) => d.id)).size).toBe(3);
    expect(videoDirectionBrief(VIDEO_DIRECTIONS[0]!)).toMatch(/Fonts: .*Colours: /s);
  });

  it('give their fonts and colours to pieces Keo did not style on purpose', () => {
    const d = VIDEO_DIRECTIONS.find((x) => x.id === 'luxury-editorial')!;
    const ops = withDirectionDefaults(
      [
        { op: 'add_motion', piece: 'headline', text: 'Hi', start: 0, duration: 2 },
        { op: 'add_motion', piece: 'headline', text: 'Mine', start: 0, duration: 2, accent: '#00FF00' },
        { op: 'add_text', text: 'Title', start: 0, duration: 2 },
      ],
      d,
    ) as Array<Record<string, unknown>>;
    expect(ops[0]).toMatchObject({ accent: d.palette.accent, font: d.fonts.display, color: d.palette.text });
    expect(ops[1]!.accent).toBe('#00FF00');
    expect((ops[2]!.style as { font: string }).font).toBe(d.fonts.display);
    // Without a direction nothing changes.
    expect(withDirectionDefaults(ops, undefined)).toBe(ops);
  });
});
