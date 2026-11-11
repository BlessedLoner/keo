// The player's profile and the garage: cars to buy, upgrades, paint, gadgets. Saved in the browser.
// Car names are made up on purpose: real brands need a licence before a game is sold.

import { normalSpec } from './vehicle.js';

export const CARS = [
  { id: 'vanta-gt', name: 'Vanta GT', style: 'sports', price: 0, color: '#a3101b', spec: { power: 9000, topSpeed: 72, grip: 3.1, mass: 1350 }, blurb: 'A balanced street car. Your first ride.' },
  { id: 'stallion-v8', name: 'Stallion V8', style: 'muscle', price: 28000, color: '#0f2a5c', spec: { power: 11800, topSpeed: 76, grip: 2.9, mass: 1600 }, blurb: 'Big American V8: brutal pull, loose rear end.' },
  { id: 'atlas-x', name: 'Atlas X', style: 'suv', price: 24000, color: '#1c1d20', spec: { power: 10500, topSpeed: 64, grip: 3.3, mass: 2100, armor: 0.3 }, blurb: 'Heavy and armoured: police cars bounce off it.' },
  { id: 'raptor-rs', name: 'Raptor RS', style: 'super', price: 62000, color: '#f2c200', spec: { power: 12800, topSpeed: 84, grip: 3.6, mass: 1400 }, blurb: 'Mid-engine track weapon with a big wing.' },
  { id: 'specter', name: 'Specter Hyper', style: 'super', price: 140000, color: '#e5e7eb', spec: { power: 15500, topSpeed: 96, grip: 3.9, mass: 1380 }, blurb: 'The fastest car in the city. Nothing catches it.' },
];

/** Upgrade levels 0–4: what each level multiplies or adds, and its price. */
export const UPGRADES = {
  engine: { label: 'Engine', blurb: 'More power', base: 4000, apply: (s, l) => ({ power: s.power * (1 + 0.12 * l) }) },
  turbo: { label: 'Accelerator / turbo', blurb: 'Higher top speed', base: 5000, apply: (s, l) => ({ topSpeed: s.topSpeed * (1 + 0.06 * l) }) },
  tires: { label: 'Tyres', blurb: 'More grip in corners', base: 2500, apply: (s, l) => ({ grip: s.grip * (1 + 0.08 * l) }) },
  brakes: { label: 'Brakes', blurb: 'Stop shorter', base: 2000, apply: (s, l) => ({ brake: s.brake * (1 + 0.18 * l) }) },
  nitro: { label: 'Nitro', blurb: 'Bigger, longer boost', base: 3500, apply: (s, l) => ({ nitroForce: s.nitroForce * (1 + 0.15 * l), nitroSeconds: s.nitroSeconds + l }) },
  armor: { label: 'Armour', blurb: 'Takes less damage', base: 4500, apply: (s, l) => ({ armor: Math.min(0.8, (s.armor ?? 0) + 0.14 * l) }) },
};

export const PAINTS = {
  colors: ['#a3101b', '#0a0a0b', '#f4f4f2', '#0f2a5c', '#0a6cff', '#16a34a', '#f2c200', '#f97316', '#7c3aed', '#ec4899', '#6b7280', '#14b8a6'],
  finishes: { gloss: 0, metallic: 1500, matte: 2500, pearl: 4000, chrome: 9000 },
  price: 1000,
};

export const GADGETS = {
  shield: { label: 'Shield', blurb: '6 seconds without damage', price: 1500, key: '1' },
  emp: { label: 'EMP blast', blurb: 'Stops nearby police cars for a few seconds', price: 3000, key: '2' },
  refill: { label: 'Nitro refill', blurb: 'A full tank, right now', price: 800, key: '3' },
  repair: { label: 'Repair kit', blurb: 'Fixes the car on the spot', price: 1200, key: '4' },
};

export class Profile {
  constructor(gameId = 'keo-drive', startMoney = 15000) {
    this.key = `${gameId}:profile`;
    const fresh = { money: startMoney, owned: ['vanta-gt'], current: 'vanta-gt', upgrades: {}, paint: {}, gadgets: { shield: 1, emp: 0, refill: 1, repair: 0 }, stats: { races: 0, wins: 0, escapes: 0, busted: 0, best: {} } };
    try {
      this.data = { ...fresh, ...(JSON.parse(localStorage.getItem(this.key) ?? 'null') ?? {}) };
    } catch {
      this.data = fresh;
    }
  }
  save() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
    } catch {
      /* private mode: progress lasts until the page closes */
    }
  }
  get money() {
    return this.data.money;
  }
  add(n) {
    this.data.money = Math.max(0, this.data.money + n);
    this.save();
  }
  spend(n) {
    if (this.data.money < n) return false;
    this.data.money -= n;
    this.save();
    return true;
  }
  /** Makes the save fit this game's cars: the first car is owned, and the current one exists. */
  fit(catalog = CARS) {
    if (!catalog.length) return;
    const ids = new Set(catalog.map((c) => c.id));
    this.data.owned = this.data.owned.filter((id) => ids.has(id));
    const first = catalog.find((c) => !c.price) ?? catalog[0];
    if (!this.data.owned.includes(first.id)) this.data.owned.unshift(first.id);
    if (!this.data.owned.includes(this.data.current)) this.data.current = this.data.owned[0];
    this.save();
  }
  car(id = this.data.current, catalog = CARS) {
    return catalog.find((c) => c.id === id) ?? catalog[0];
  }
  level(carId, up) {
    return this.data.upgrades[carId]?.[up] ?? 0;
  }
  /** The car's specs with its upgrades. */
  spec(carId = this.data.current, catalog = CARS, base = {}) {
    let s = normalSpec({ ...base, ...this.car(carId, catalog).spec });
    for (const [k, u] of Object.entries(UPGRADES)) {
      const l = this.level(carId, k);
      if (l) s = { ...s, ...u.apply(s, l) };
    }
    return s;
  }
  paintOf(carId = this.data.current, catalog = CARS) {
    return this.data.paint[carId] ?? { color: this.car(carId, catalog).color, finish: 'gloss' };
  }
  buyCar(car) {
    if (this.data.owned.includes(car.id)) return true;
    if (!this.spend(car.price)) return false;
    this.data.owned.push(car.id);
    this.save();
    return true;
  }
  buyUpgrade(carId, up) {
    const l = this.level(carId, up);
    if (l >= 4) return false;
    if (!this.spend(UPGRADES[up].base * (l + 1))) return false;
    this.data.upgrades[carId] = { ...(this.data.upgrades[carId] ?? {}), [up]: l + 1 };
    this.save();
    return true;
  }
  buyPaint(carId, color, finish) {
    if (!this.spend(PAINTS.price + (PAINTS.finishes[finish] ?? 0))) return false;
    this.data.paint[carId] = { color, finish };
    this.save();
    return true;
  }
  buyGadget(id) {
    if (!this.spend(GADGETS[id].price)) return false;
    this.data.gadgets[id] = (this.data.gadgets[id] ?? 0) + 1;
    this.save();
    return true;
  }
  useGadget(id) {
    if (!this.data.gadgets[id]) return false;
    this.data.gadgets[id]--;
    this.save();
    return true;
  }
}
