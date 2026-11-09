import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioService } from '../src/main/studio/studioService';
import { episodeName } from '../src/shared/studioSeries';
import { tempDir } from './helpers';

const log = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never;
const studio = () => {
  const dir = tempDir('keo-series-');
  return new StudioService({ dir: path.join(dir, 'studio'), log, exportsDir: () => path.join(dir, 'Videos') });
};

describe('Series and episodes', () => {
  it('names episodes with their number and title', () => {
    expect(episodeName('Keo Diaries', 3)).toBe('Keo Diaries · Ep 3');
    expect(episodeName('Keo Diaries', 4, ' The launch ')).toBe('Keo Diaries · Ep 4: The launch');
  });

  it('keeps episodes in order, numbers them in the project list, and a project is in one series at a time', async () => {
    const s = studio();
    const a = s.create('Pilot', 'vertical');
    const b = s.create('Second', 'vertical');
    const se = s.createSeries('Keo Diaries', { projects: [a.id] });
    s.addToSeries(se.id, b.id);
    const list = s.list();
    expect(list.find((p) => p.id === a.id)!.series).toEqual({ id: se.id, name: 'Keo Diaries', episode: 1 });
    expect(list.find((p) => p.id === b.id)!.series!.episode).toBe(2);
    // Moved to another series: it leaves the first one.
    const other = s.createSeries('Shorts', { projects: [b.id] });
    expect(s.seriesList().find((x) => x.id === se.id)!.projects).toEqual([a.id]);
    expect(s.seriesList().find((x) => x.id === other.id)!.projects).toEqual([b.id]);
    expect(() => s.createSeries('keo diaries')).toThrow(/already a series/);
    // A deleted episode drops out; the next episode is numbered after the rest.
    s.removeFromSeries(b.id);
    const ep = await s.newEpisode(se.id, [], 'Launch day');
    expect(ep.episode).toBe(2);
    expect(ep.project.name).toBe('Keo Diaries · Ep 2: Launch day');
    expect(ep.project.height).toBeGreaterThan(ep.project.width);
    expect(s.seriesList().find((x) => x.id === se.id)!.projects).toEqual([a.id, ep.project.id]);
    s.delete(a.id);
    expect(s.seriesList().find((x) => x.id === se.id)!.projects).toEqual([ep.project.id]);
  });
});
