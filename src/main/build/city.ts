/**
 * Real cities for games: the streets, buildings, parks and water of a real place, from
 * OpenStreetMap (© OpenStreetMap contributors, ODbL — the game must show that credit). Keo
 * downloads them while building and saves a compact city.json in the build, in metres around
 * the centre (x east, z south), so the finished game works offline.
 */

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';
export const OSM_LICENSE_URL = 'https://www.openstreetmap.org/copyright';

/** No e-mail or personal data: just what the app is (OpenStreetMap asks apps to name themselves). */
const USER_AGENT = 'Keo-desktop-builder/1.0 (+https://cloud.heykeo.com)';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
/** Waits before each try: the free servers turn away apps that ask again too soon. */
const WAITS = [0, 5000, 15000, 30000];

export type RoadKind = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'residential' | 'service';
export interface CityRoad {
  kind: RoadKind;
  name: string;
  /** Carriageway width in metres. */
  width: number;
  lanes: number;
  oneway: boolean;
  bridge: boolean;
  pts: Array<[number, number]>;
}
export interface CityBuilding {
  /** Height in metres. */
  h: number;
  kind: string;
  pts: Array<[number, number]>;
}
export interface CityData {
  name: string;
  center: { lat: number; lon: number };
  radius: number;
  attribution: string;
  license: string;
  roads: CityRoad[];
  buildings: CityBuilding[];
  parks: Array<Array<[number, number]>>;
  water: Array<Array<[number, number]>>;
  /** Where a car can start: on a big road near the centre, facing along it. */
  spawn: { x: number; z: number; heading: number };
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

const ROAD_KIND: Record<string, RoadKind> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  unclassified: 'residential',
  residential: 'residential',
  living_street: 'residential',
  service: 'service',
};
const DEFAULT_LANES: Record<RoadKind, number> = { motorway: 4, trunk: 4, primary: 4, secondary: 2, tertiary: 2, residential: 2, service: 1 };

/** Finds a place by name (a city, district, street or landmark). */
type Hit = { lat: string; lon: string; display_name?: string; category?: string; class?: string; type?: string; addresstype?: string };

/** "Downtown Los Angeles" is an area, not the first school or shop with "California" in its name. */
const isArea = (h: Hit) =>
  (h.category ?? h.class) === 'place' || (h.category ?? h.class) === 'boundary' || /^(city|town|village|suburb|neighbourhood|quarter|city_district|borough|district|hamlet)$/.test(h.addresstype ?? '');

/** The same place said a few ways ("Downtown Los Angeles, California" → "Downtown, Los Angeles"). */
export function placeVariants(place: string): string[] {
  const p = place.replace(/\s+/g, ' ').trim();
  const parts = p.split(',').map((x) => x.trim()).filter(Boolean);
  const first = parts[0] ?? p;
  const out = [p];
  const area = /^(downtown|midtown|uptown|old town|central|centre|center)\s+(.+)$/i.exec(first);
  if (area) out.push(`${area[1]}, ${area[2]}`);
  if (parts.length > 1) out.push(first);
  return [...new Set(out)];
}

/** Finds a place by name (a city, district, street or landmark), preferring areas over single buildings. */
export async function geocode(place: string, fetchFn: Fetch, signal?: AbortSignal): Promise<{ lat: number; lon: number; name: string }> {
  let firstHit: Hit | null = null;
  const variants = placeVariants(place);
  for (const [i, q] of variants.entries()) {
    // The map search allows about one request a second.
    if (i > 0 && fetchFn === (globalThis.fetch as unknown)) await new Promise((res) => setTimeout(res, 1100));
    const r = await fetchFn(`${NOMINATIM}?format=jsonv2&limit=8&q=${encodeURIComponent(q)}`, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, ...(signal ? { signal } : {}) });
    if (!r.ok) throw new Error(`The map search did not answer (${r.status}). Try again in a minute.`);
    const hits = (await r.json()) as Hit[];
    firstHit ??= hits[0] ?? null;
    const area = hits.find(isArea);
    if (area) return { lat: Number(area.lat), lon: Number(area.lon), name: (area.display_name ?? q).split(',').slice(0, 3).join(',').trim() };
  }
  if (!firstHit) throw new Error(`No place called “${place}” was found on the map. Try a fuller name, like “Downtown Los Angeles, California”.`);
  return { lat: Number(firstHit.lat), lon: Number(firstHit.lon), name: (firstHit.display_name ?? place).split(',').slice(0, 3).join(',').trim() };
}

export function overpassQuery(lat: number, lon: number, radius: number): string {
  const around = `(around:${Math.round(radius)},${lat.toFixed(6)},${lon.toFixed(6)})`;
  return `[out:json][timeout:90];(way["highway"~"^(${Object.keys(ROAD_KIND).join('|')})$"]${around};way["building"]${around};way["leisure"~"^(park|garden|pitch)$"]${around};way["landuse"~"^(grass|recreation_ground)$"]${around};way["natural"="water"]${around};);out geom;`;
}

interface OsmWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Metres from a tag like "45", "45 m", "150'". */
function metres(v: string | undefined): number | null {
  if (!v) return null;
  const n = parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /'|ft|feet/i.test(v) ? n * 0.3048 : n;
}

/** A stable pseudo-random number from an id (the same city always looks the same). */
function hash01(id: number): number {
  let x = id | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function buildingHeight(w: OsmWay, area: number, distance: number, radius: number): number {
  const t = w.tags ?? {};
  const h = metres(t.height) ?? (t['building:levels'] ? Number(t['building:levels']) * 3.3 + (Number(t['roof:levels'] ?? 0) * 2) : null);
  if (h && Number.isFinite(h)) return Math.min(450, Math.max(3, h));
  const kind = t.building ?? 'yes';
  const rnd = hash01(w.id);
  if (/^(house|detached|semidetached_house|bungalow|garage|garages|shed|hut|cabin|roof|carport)$/.test(kind)) return 4 + rnd * 4;
  if (/^(commercial|office|hotel|retail|apartments|public|civic|government|hospital|university)$/.test(kind) || area > 1500) {
    // Big footprints near the centre are the tall downtown blocks.
    const central = 1 - Math.min(1, distance / Math.max(1, radius));
    return 12 + rnd * 25 + central * central * 90 * (area > 800 ? 1 : 0.4);
  }
  return 7 + rnd * 9;
}

function polygonArea(pts: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j]![0] + pts[i]![0]) * (pts[j]![1] - pts[i]![1]);
  return Math.abs(a / 2);
}

/** Drops points that add nothing (closer than `tol` metres to the line through their neighbours). */
function simplify(pts: Array<[number, number]>, tol = 0.6, keep: (i: number) => boolean = () => false): Array<[number, number]> {
  if (pts.length < 3) return pts;
  const out: Array<[number, number]> = [pts[0]!];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1]!;
    const b = pts[i]!;
    if (keep(i)) {
      out.push(b);
      continue;
    }
    const c = pts[i + 1]!;
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz) || 1;
    const dist = Math.abs(dx * (a[1] - b[1]) - (a[0] - b[0]) * dz) / len;
    if (dist > tol) out.push(b);
  }
  out.push(pts[pts.length - 1]!);
  return out;
}

/** OpenStreetMap ways → Keo's compact city (metres around the centre). */
export function toCity(ways: OsmWay[], center: { lat: number; lon: number }, radius: number, name: string): CityData {
  const kx = 111_320 * Math.cos((center.lat * Math.PI) / 180);
  const kz = 110_540;
  const project = (g: { lat: number; lon: number }): [number, number] => [r1((g.lon - center.lon) * kx), r1((center.lat - g.lat) * kz)];
  const roads: CityRoad[] = [];
  const buildings: CityBuilding[] = [];
  const parks: Array<Array<[number, number]>> = [];
  const water: Array<Array<[number, number]>> = [];
  // Where streets meet (a point used by more than one street) must stay: traffic and police find their way through them.
  const key = (g: { lat: number; lon: number }) => `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
  const uses = new Map<string, number>();
  for (const w of ways) if (w.tags?.highway && w.geometry) for (const g of w.geometry) uses.set(key(g), (uses.get(key(g)) ?? 0) + 1);
  for (const w of ways) {
    if (w.type !== 'way' || !w.geometry || w.geometry.length < 2) continue;
    const t = w.tags ?? {};
    const geo = w.geometry;
    const pts = simplify(geo.map(project), 0.6, t.highway ? (i) => (uses.get(key(geo[i]!)) ?? 0) > 1 : undefined);
    if (t.highway && ROAD_KIND[t.highway]) {
      if (t.area === 'yes' || t.access === 'private' || /^(parking_aisle|driveway)$/.test(t.service ?? '')) continue;
      const kind = ROAD_KIND[t.highway]!;
      const lanes = Math.max(1, Math.min(8, Number.parseInt(t.lanes ?? '', 10) || DEFAULT_LANES[kind]));
      const width = metres(t.width) ?? lanes * 3.4 + (kind === 'service' ? 0.5 : 1);
      roads.push({ kind, name: t.name ?? t.ref ?? '', width: r1(Math.min(40, width)), lanes, oneway: t.oneway === 'yes' || t.junction === 'roundabout' || kind === 'motorway', bridge: t.bridge === 'yes', pts });
    } else if (t.building && pts.length >= 4) {
      // Roofs, canopies and building bridges stand over the street: not walls a car can hit.
      if (/^(roof|canopy|carport|bridge|construction|ruins)$/.test(t.building) || Number(t.layer ?? 0) > 0 || t.location === 'underground') continue;
      const ring = pts.slice(0, -1);
      const area = polygonArea(ring);
      if (area < 12) continue;
      const cx = ring.reduce((n, p) => n + p[0], 0) / ring.length;
      const cz = ring.reduce((n, p) => n + p[1], 0) / ring.length;
      const distance = Math.hypot(cx, cz);
      if (distance > radius * 1.05) continue;
      buildings.push({ h: r1(buildingHeight(w, area, distance, radius)), kind: t.building, pts: ring });
    } else if ((t.leisure || t.landuse) && pts.length >= 4) parks.push(pts.slice(0, -1));
    else if (t.natural === 'water' && pts.length >= 4) water.push(pts.slice(0, -1));
  }
  // Big roads first (they are drawn on top), and a start on the biggest road near the centre.
  const rank: RoadKind[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'residential', 'service'];
  roads.sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind));
  let spawn = { x: 0, z: 0, heading: 0 };
  let best = Infinity;
  for (const r of roads.filter((x) => x.kind !== 'service' && x.kind !== 'motorway' && !x.bridge)) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const [ax, az] = r.pts[i]!;
      const [bx, bz] = r.pts[i + 1]!;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const score = Math.hypot(mx, mz) + rank.indexOf(r.kind) * 60 - Math.min(40, Math.hypot(bx - ax, bz - az));
      if (score < best) {
        best = score;
        spawn = { x: r1(mx), z: r1(mz), heading: Math.round(Math.atan2(bx - ax, bz - az) * 1000) / 1000 };
      }
    }
  }
  return {
    name,
    center: { lat: Math.round(center.lat * 1e6) / 1e6, lon: Math.round(center.lon * 1e6) / 1e6 },
    radius,
    attribution: OSM_ATTRIBUTION,
    license: OSM_LICENSE_URL,
    roads: roads.slice(0, 4000),
    buildings: buildings.slice(0, 9000),
    parks: parks.slice(0, 600),
    water: water.slice(0, 200),
    spawn,
  };
}

/** Downloads a real place as a city for a game. */
export async function fetchCity(o: { place: string; radius: number }, fetchFn: Fetch, signal?: AbortSignal): Promise<CityData> {
  const radius = Math.max(250, Math.min(1500, Math.round(o.radius)));
  const at = await geocode(o.place, fetchFn, signal);
  const body = `data=${encodeURIComponent(overpassQuery(at.lat, at.lon, radius))}`;
  let lastError = '';
  // The free map servers are busy at times: each is tried, then once more after a pause.
  for (const [i, url] of [...OVERPASS, ...OVERPASS].entries()) {
    if (i && fetchFn === (globalThis.fetch as unknown)) await new Promise((res) => setTimeout(res, WAITS[i] ?? 30000));
    try {
      const r = await fetchFn(url, { method: 'POST', headers: { 'user-agent': USER_AGENT, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, ...(signal ? { signal } : {}) });
      if (!r.ok) {
        lastError = `the map server answered ${r.status}`;
        continue;
      }
      const data = (await r.json()) as { elements?: OsmWay[] };
      const city = toCity(data.elements ?? [], at, radius, at.name);
      if (!city.roads.length) throw new Error(`No streets were found around “${o.place}”. Choose a place in a town or city.`);
      return city;
    } catch (e) {
      if (signal?.aborted) throw e;
      if (e instanceof Error && e.message.startsWith('No streets')) throw e;
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`The map data could not be downloaded (${lastError}). Try again in a minute, or a smaller area.`);
}
