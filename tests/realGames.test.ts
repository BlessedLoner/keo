import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchCity, geocode, placeVariants, toCity } from '../src/main/build/city';
import { BUILD_LIBRARIES, withNeeds } from '../src/main/build/libraries';
import { BuildProjects } from '../src/main/build/projects';
import { buildCapabilities } from '../src/main/capabilities/build';
import { tempDir } from './helpers';

const log = { info: () => undefined };
const modules = path.join(__dirname, '..', 'node_modules');
const projects = () => {
  const root = tempDir('keo-builds-');
  return new BuildProjects({ root: () => root, modules: () => modules, log });
};

// A tiny piece of a city as OpenStreetMap gives it: a cross of two streets and two buildings.
const LAT = 34.05;
const LON = -118.25;
const g = (dx: number, dz: number) => ({ lat: LAT - dz / 110_540, lon: LON + dx / (111_320 * Math.cos((LAT * Math.PI) / 180)) });
const WAYS = [
  { type: 'way', id: 1, tags: { highway: 'primary', name: 'Main St', lanes: '4' }, geometry: [g(-100, 0), g(-50, 0.1), g(0, 0), g(50, 0), g(100, 0)] },
  { type: 'way', id: 2, tags: { highway: 'residential', name: '5th St', oneway: 'yes' }, geometry: [g(0, -100), g(0, 0), g(0, 100)] },
  { type: 'way', id: 3, tags: { building: 'office', height: '120' }, geometry: [g(20, 20), g(60, 20), g(60, 60), g(20, 60), g(20, 20)] },
  { type: 'way', id: 4, tags: { building: 'yes', 'building:levels': '5' }, geometry: [g(-60, 20), g(-20, 20), g(-20, 50), g(-60, 50), g(-60, 20)] },
  { type: 'way', id: 5, tags: { building: 'roof' }, geometry: [g(-5, -5), g(5, -5), g(5, 5), g(-5, 5), g(-5, -5)] },
  { type: 'way', id: 6, tags: { leisure: 'park' }, geometry: [g(-90, -90), g(-40, -90), g(-40, -40), g(-90, -40), g(-90, -90)] },
];

describe('real cities from OpenStreetMap', () => {
  it('turns map data into a compact city in metres: streets keep their junctions, real heights, no roofs over the road', () => {
    const c = toCity(WAYS as never, { lat: LAT, lon: LON }, 300, 'Test town');
    expect(c.attribution).toBe('© OpenStreetMap contributors');
    const main = c.roads.find((r) => r.name === 'Main St')!;
    expect(main.lanes).toBe(4);
    // The junction with 5th St (in the middle of a straight line) is kept; other straight points go.
    expect(main.pts).toContainEqual([0, 0]);
    expect(main.pts).not.toContainEqual([-50, 0.1]);
    expect(c.roads.find((r) => r.name === '5th St')!.oneway).toBe(true);
    expect(c.buildings.map((b) => b.h).sort((a, b) => a - b)).toEqual([16.5, 120]);
    expect(c.parks).toHaveLength(1);
    // The start is on the big road near the centre.
    expect(Math.abs(c.spawn.z)).toBeLessThan(1);
  });

  it('finds the area, not a building with the same words in its name', async () => {
    expect(placeVariants('Downtown Los Angeles, California')).toEqual(['Downtown Los Angeles, California', 'Downtown, Los Angeles', 'Downtown Los Angeles']);
    const asked: string[] = [];
    const fetchFn = async (url: string) => {
      asked.push(decodeURIComponent(url.split('q=')[1]!));
      const hits = asked.length === 1 ? [{ lat: '1', lon: '1', category: 'amenity', display_name: 'An Architecture School' }] : [{ lat: '34.05', lon: '-118.25', category: 'place', addresstype: 'suburb', display_name: 'Downtown, Los Angeles, Los Angeles County, California' }];
      return { ok: true, status: 200, json: async () => hits, text: async () => '' };
    };
    const at = await geocode('Downtown Los Angeles, California', fetchFn);
    expect(at).toMatchObject({ lat: 34.05, lon: -118.25, name: 'Downtown, Los Angeles, Los Angeles County' });
    expect(asked).toEqual(['Downtown Los Angeles, California', 'Downtown, Los Angeles']);
  });

  it('downloads a place (fake map servers: nothing real is fetched)', async () => {
    const fetchFn = async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('nominatim') ? [{ lat: String(LAT), lon: String(LON), category: 'place', addresstype: 'city', display_name: 'Test town' }] : { elements: WAYS }),
      text: async () => '',
    });
    const c = await fetchCity({ place: 'Test town', radius: 99999 }, fetchFn);
    expect(c.radius).toBe(1500);
    expect(c.roads).toHaveLength(2);
    // A place with no streets is said plainly.
    const empty = async (url: string) => ({ ok: true, status: 200, json: async () => (url.includes('nominatim') ? [{ lat: '0', lon: '0', category: 'place', display_name: 'Sea' }] : { elements: [] }), text: async () => '' });
    await expect(fetchCity({ place: 'Sea', radius: 500 }, empty)).rejects.toThrow(/No streets/);
  });
});

describe('the driving game kit in the builder', () => {
  it('comes with three.js, Rapier and the fonts; every file is installed', () => {
    expect(withNeeds(['drive'])).toEqual(['three', 'rapier', 'fonts', 'drive']);
    for (const [from] of BUILD_LIBRARIES.drive.files) expect(fs.existsSync(path.join(modules, from))).toBe(true);
    const p = projects();
    const m = p.create({ title: 'Night Run', kind: 'game', libraries: ['drive'] });
    expect(m.libraries).toEqual(['three', 'rapier', 'fonts', 'drive']);
    for (const f of ['lib/drive/index.js', 'lib/drive/game.js', 'lib/drive/city.js', 'lib/three/three.module.min.js', 'lib/rapier/rapier.es.js', 'lib/fonts/fonts.css']) expect(fs.existsSync(path.join(p.dir(m.id), f)), f).toBe(true);
    // Pages get the import map the kit needs.
    p.write(m.id, [{ path: 'index.html', content: '<html><head></head><body></body></html>' }]);
    expect(p.read(m.id, 'index.html')).toContain('"@dimforge/rapier3d-compat":"/lib/rapier/rapier.es.js"');
  });

  it('build__city saves the real place in the game; build__model saves a 3D car (fake makers, nothing paid)', async () => {
    const p = projects();
    const m = p.create({ title: 'Night Run', kind: 'game', libraries: ['drive'] });
    let made = 0;
    const caps = buildCapabilities({
      projects: p,
      host: null,
      city: async (place, radius) => {
        const c = toCity(WAYS as never, { lat: LAT, lon: LON }, radius, place);
        return { json: JSON.stringify(c), name: c.name, roads: c.roads.length, buildings: c.buildings.length, attribution: c.attribution };
      },
      model3d: { make: async () => (made++, Buffer.from('glTF fake model bytes')), unavailable: () => null, costLabel: 'about 100 Studio credits' },
    });
    const ctx = { signal: new AbortController().signal } as never;
    const city = caps.find((c) => c.id === 'build.city')!;
    const r = (await city.execute(city.input.parse({ build: m.id, place: 'Test town' }) as never, ctx)) as { path: string; roads: number };
    expect(r).toMatchObject({ path: 'assets/city.json', roads: 2 });
    expect(JSON.parse(fs.readFileSync(path.join(p.dir(m.id), 'assets/city.json'), 'utf8')).name).toBe('Test town');
    const model = caps.find((c) => c.id === 'build.model')!;
    // Costs credits: the user approves each one, and it says what it costs.
    expect(model.approval).toBe('always');
    expect(model.preview(model.input.parse({ build: m.id, path: 'assets/cars/raptor.glb', prompt: 'a low two-door supercar, matte black' }) as never).consequences[0]).toContain('100 Studio credits');
    const out = (await model.execute(model.input.parse({ build: m.id, path: 'assets/cars/raptor.glb', prompt: 'a low two-door supercar, matte black' }) as never, ctx)) as { path: string };
    expect(out.path).toBe('assets/cars/raptor.glb');
    expect(made).toBe(1);
    expect(model.input.safeParse({ build: m.id, path: '../evil.glb', prompt: 'a car that is long enough' }).success).toBe(false);
    // Car games are told to use the kit, never to start from scratch.
    expect(caps.find((c) => c.id === 'build.start')!.description).toContain('ALWAYS the "drive" library');
  });

  it('without Keo Cloud or a fal.ai key, 3D models say how to turn them on', () => {
    const caps = buildCapabilities({ projects: projects(), host: null, model3d: { make: async () => Buffer.alloc(0), unavailable: () => 'Making 3D models needs your Keo account (sign in) or your own fal.ai key.', costLabel: '' } });
    expect(caps.find((c) => c.id === 'build.model')!.unavailableReason?.({} as never)).toContain('Keo account');
  });
});
