import { describe, expect, it } from 'vitest';
import { dragCrop, featherCut, moveCut, newCut, sizeCut, toLayer, turnCut } from '../src/shared/studioMaskCrop';

const box = { cx: 500, cy: 400, w: 400, h: 200, rotation: 0 };

describe('Mask and crop by hand on the preview', () => {
  it('reads the pointer in the layer’s own frame, turn included', () => {
    expect(toLayer(box, 700, 400)).toEqual({ u: 0.5, v: 0 });
    const turned = { ...box, rotation: 90 };
    // Turned a quarter: a point below the middle is along the layer's width.
    const p = toLayer(turned, 500, 600);
    expect(p.u).toBeCloseTo(0.5, 5);
    expect(p.v).toBeCloseTo(0, 5);
  });

  it('moves, resizes (also keeping proportions), turns and softens a mask', () => {
    const c = newCut('circle');
    expect(moveCut(c, 0.2, -0.1)).toMatchObject({ x: 0.2, y: -0.1 });
    expect(moveCut(c, 5, 0).x).toBe(1);
    // Corner at (0.4, 0.25) of the box: 2 × 0.4 wide, 2 × 0.25 high.
    expect(sizeCut(c, box, 0.4, 0.25)).toMatchObject({ w: 0.8, h: 0.5 });
    const kept = sizeCut(c, box, 0.6, 0.1, true);
    expect(kept.w / kept.h).toBeCloseTo(1, 3);
    // Pointer to the right of the middle: turned a quarter (its handle is above it at 0°).
    expect(turnCut(c, box, 0.3, 0).angle).toBe(90);
    expect(turnCut(c, box, 0.3, 0.01).angle).toBe(90);
    expect(featherCut(c, 0, 60).feather).toBe(0.5);
    expect(featherCut(c, 0.9, 60).feather).toBe(1);
  });

  it('crops from an edge or a corner, scaled to the whole picture, never more than 0.45 a side', () => {
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    expect(dragCrop(none, 'l', 0.1, 0)).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 });
    expect(dragCrop(none, 'br', -0.2, -0.1)).toEqual({ left: 0, top: 0, right: 0.2, bottom: 0.1 });
    // Already half cropped: a drag across the visible part counts for half as much of the whole.
    expect(dragCrop({ left: 0.25, top: 0, right: 0.25, bottom: 0 }, 'l', 0.2, 0).left).toBe(0.35);
    expect(dragCrop(none, 't', 0, 0.9).top).toBe(0.45);
    // Dragging back out never goes below nothing.
    expect(dragCrop({ left: 0.1, top: 0, right: 0, bottom: 0 }, 'l', -0.5, 0).left).toBe(0);
  });
});
