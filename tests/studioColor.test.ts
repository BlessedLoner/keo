import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits, ColorGrade, Cut, LOOKS, newProject, proGrade, TRANSITIONS } from '../src/shared/studio';
import { curveTable, lutNameOf, parseCube } from '../src/shared/studioLut';
import { StudioService } from '../src/main/studio/studioService';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
/** An identity LUT of size n (every colour maps to itself). */
const identity = (n: number) => {
  const lines = ['TITLE "test"', `LUT_3D_SIZE ${n}`];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
  return lines.join('\n');
};

describe('Studio pro colour, masks and transitions', () => {
  it('reads .cube LUTs and says plainly why a file cannot be used', () => {
    const l = parseCube(identity(3));
    expect(l.size).toBe(3);
    expect([...l.data.slice(0, 6)]).toEqual([0, 0, 0, 0.5, 0, 0]);
    expect(() => parseCube('LUT_1D_SIZE 4\n0 0 0')).toThrow(/1D LUT/);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/should have 8 colours/);
    expect(() => parseCube('hello')).toThrow(/does not say its size/);
    expect(lutNameOf('Teal & Orange v2.CUBE')).toBe('teal orange v2');
  });

  it('a tone curve goes through its points, never overshoots, and the identity curve changes nothing', () => {
    const id = curveTable([[0, 0], [1, 1]]);
    expect(Math.abs(id[128]! - 128 / 255)).toBeLessThan(0.002);
    const s = curveTable([[0, 0], [0.25, 0.15], [0.75, 0.85], [1, 1]]);
    expect(s[64]!).toBeLessThan(64 / 255);
    expect(s[191]!).toBeGreaterThan(191 / 255);
    for (let i = 1; i < 256; i++) expect(s[i]!).toBeGreaterThanOrEqual(s[i - 1]! - 1e-6);
  });

  it('old grades stay plain filters; the new fields switch on the graphics-card grade; every look is valid', () => {
    expect(proGrade(ColorGrade.parse({ exposure: 0.2, contrast: 0.1 }))).toBe(false);
    expect(proGrade(ColorGrade.parse({ hsl: { blue: { hue: 0.2 } } }))).toBe(true);
    expect(proGrade(ColorGrade.parse({ lut: { name: 'teal orange', amount: 0 } }))).toBe(false);
    for (const look of Object.values(LOOKS)) expect(ColorGrade.safeParse(look).success).toBe(true);
  });

  it('a clip takes a cut-out mask and a new transition, and can drop them again', () => {
    let p = newProject({ name: 'Masks', format: 'landscape' });
    p = { ...p, assets: [{ id: 'as_aaaa1', kind: 'image', name: 'a', path: 'C:/a.png', duration: 5, width: 1280, height: 720, hasAudio: false }] as never };
    p = applyEdits(p, [{ op: 'add_media', assetId: 'as_aaaa1', start: 0, duration: 3 }, { op: 'add_media', assetId: 'as_aaaa1', start: 3, duration: 3 }]).project;
    const [a, b] = p.tracks.flatMap((t) => t.clips);
    p = applyEdits(p, [{ op: 'set', clip: a!.id, cut: Cut.parse({ shape: 'heart', feather: 0.3 }) }, { op: 'set', clip: b!.id, transition: { kind: 'iris', seconds: 0.6 } }]).project;
    const [a2, b2] = p.tracks.flatMap((t) => t.clips);
    expect(a2).toMatchObject({ cut: { shape: 'heart', feather: 0.3, invert: false } });
    expect(b2).toMatchObject({ transition: { kind: 'iris' } });
    expect(TRANSITIONS).toEqual(expect.arrayContaining(['iris', 'slide-up', 'wipe-down', 'spin', 'zoom-out']));
    p = applyEdits(p, [{ op: 'set', clip: a!.id, cut: null }]).project;
    expect(p.tracks.flatMap((t) => t.clips)[0]).not.toHaveProperty('cut');
  });

  it('imports a LUT once for every project, refuses a broken one, and reads only by name', () => {
    const dir = tempDir();
    const s = new StudioService({ dir: path.join(dir, 'studio'), log: log as never, exportsDir: () => path.join(dir, 'Videos'), changed: () => undefined });
    const good = path.join(dir, 'Warm Film.cube');
    fs.writeFileSync(good, identity(2));
    expect(s.importLut(good)).toEqual({ name: 'warm film', size: 2 });
    expect(s.luts()).toEqual(['warm film']);
    expect(s.lutText('warm film')).toContain('LUT_3D_SIZE 2');
    const bad = path.join(dir, 'broken.cube');
    fs.writeFileSync(bad, 'LUT_3D_SIZE 2\n1 1 1');
    expect(() => s.importLut(bad)).toThrow(/cannot be used/);
    expect(() => s.lutText('../secrets')).toThrow(/not a LUT name/);
  });
});

describe('Keo as creative director in Studio', () => {
  it('offers directions as cards and the plan as a storyboard of this project’s own media', async () => {
    const { makeHarness } = await import('./helpers');
    const h = makeHarness();
    try {
      const shown: unknown[] = [];
      h.services.setPush(((channel: string, payload: unknown) => channel === 'studio:ask' && shown.push(payload)) as never);
      const p = h.services.studio.create('Brand promo', 'vertical');
      const ask = h.services.registry.get('studio.ask')!;
      const input = ask.input.parse({
        projectId: p.id,
        question: 'Which direction should the promo take?',
        options: ['Quiet Luxury', 'Runway Pulse', 'Mix them'],
        directions: [
          { name: 'Quiet Luxury', about: 'Slow, elegant, warm gold.', motion: 2, pace: 2, impact: 3, accent: '#d9b26f' },
          { name: 'Runway Pulse', about: 'Cut on every beat.', motion: 5, pace: 5, impact: 5 },
        ],
        plan: [{ at: '0:00–0:02', what: 'Logo reveal', asset: 'as_notmine1' }, { at: '0:02–0:05', what: 'Close-up of the fabric' }],
      });
      await ask.execute(input as never, { signal: new AbortController().signal } as never);
      expect(shown).toHaveLength(1);
      const a = shown[0] as { directions: Array<{ name: string }>; plan: Array<{ asset?: string }> };
      expect(a.directions.map((d) => d.name)).toEqual(['Quiet Luxury', 'Runway Pulse']);
      // A frame from media that is not in this project is never shown.
      expect(a.plan[0]).not.toHaveProperty('asset');
      // Ratings out of 5 are rounded and kept in range rather than refused.
      const odd = ask.input.parse({ ...input, directions: [{ name: 'x', about: 'y', motion: 3.6, pace: 9, impact: 0.2 }, { name: 'z', about: 'y', motion: 1, pace: 1, impact: 1 }] }) as { directions: Array<{ motion: number; pace: number; impact: number }> };
      expect(odd.directions[0]).toMatchObject({ motion: 4, pace: 5, impact: 1 });
    } finally {
      h.close();
    }
  });
});

describe('the template gallery', () => {
  it('every template applies cleanly at the playhead, with or without a brand kit, and stays editable clips', async () => {
    const { STARTER_TEMPLATES, TEMPLATE_CATEGORIES } = await import('../src/shared/studioTemplates');
    expect(new Set(STARTER_TEMPLATES.map((t) => t.id)).size).toBe(STARTER_TEMPLATES.length);
    for (const c of TEMPLATE_CATEGORIES) expect(STARTER_TEMPLATES.some((t) => t.category === c), c).toBe(true);
    for (const brand of [{}, { name: 'Maison Ada', handle: '@maisonada', accent: '#C9A227', palette: ['#111111', '#F4F1EA'], endText: 'Shop the collection' }]) {
      for (const t of STARTER_TEMPLATES) {
        const p = newProject({ name: 'T', format: 'vertical' });
        const r = applyEdits(p, t.ops(5, brand));
        const clips = r.project.tracks.flatMap((x) => x.clips);
        expect(clips.length, t.id).toBeGreaterThan(0);
        expect(Math.min(...clips.map((c) => c.start)), t.id).toBeGreaterThanOrEqual(5);
        expect(t.hero, t.id).toBeLessThanOrEqual(t.seconds);
      }
    }
  });
});
