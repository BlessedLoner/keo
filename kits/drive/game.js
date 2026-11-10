// A complete driving game in one call: createDriveGame({ city: '/assets/city.json' }).
// Free roam in a real city, police pursuits, street races, a garage with cars, upgrades, paint and
// gadgets, money and saving. Everything is reachable through the returned api for custom missions.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { createWorld } from './world.js';
import { buildCity } from './city.js';
import { createCarModel, loadCarModel } from './car.js';
import { Vehicle } from './vehicle.js';
import { ChaseCamera, Controls } from './controls.js';
import { Police, Race, Traffic } from './ai.js';
import { Hud } from './hud.js';
import { GameAudio } from './audio.js';
import { Effects } from './effects.js';
import { CARS, GADGETS, PAINTS, Profile, UPGRADES } from './garage.js';

const MENU_CSS = `
.kd-menu{position:fixed;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 30% 20%,rgba(10,20,40,.55),rgba(0,0,0,.82));font-family:"Plus Jakarta Sans","Inter",system-ui,sans-serif;color:#fff}
.kd-menu[hidden]{display:none}
.kd-panel{width:min(980px,94vw);max-height:90vh;overflow:auto;padding:34px 38px;border-radius:22px;background:rgba(12,14,22,.78);border:1px solid rgba(255,255,255,.1);box-shadow:0 30px 80px rgba(0,0,0,.6);backdrop-filter:blur(14px)}
.kd-title{font:400 76px/0.9 "Bebas Neue","Orbitron",sans-serif;letter-spacing:6px;margin:0;background:linear-gradient(90deg,#fff,#7af0ff);-webkit-background-clip:text;color:transparent}
.kd-sub{opacity:.7;margin:10px 0 26px;font-size:15px}
.kd-btns{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.kd-btn{pointer-events:auto;cursor:pointer;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);color:#fff;padding:16px 18px;border-radius:14px;text-align:left;font:600 16px "Plus Jakarta Sans",sans-serif;transition:transform .12s,background .12s,border-color .12s}
.kd-btn:hover{transform:translateY(-2px);background:rgba(122,240,255,.12);border-color:rgba(122,240,255,.5)}
.kd-btn small{display:block;font-weight:400;opacity:.65;margin-top:4px;font-size:13px}
.kd-btn.primary{background:linear-gradient(135deg,#00b4ff,#7a5cff);border:0}
.kd-btn[disabled]{opacity:.4;pointer-events:none}
.kd-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:8px 0}
.kd-h{font:600 13px "Inter",sans-serif;letter-spacing:3px;opacity:.6;margin:22px 0 10px;text-transform:uppercase}
.kd-swatch{width:34px;height:34px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer}
.kd-swatch.on{border-color:#fff;box-shadow:0 0 0 3px rgba(122,240,255,.6)}
.kd-chip{padding:8px 12px;border-radius:999px;border:1px solid rgba(255,255,255,.18);cursor:pointer;font-size:13px;background:transparent;color:#fff}
.kd-chip.on{background:#fff;color:#000}
.kd-lv{display:inline-flex;gap:3px;margin-left:8px}.kd-lv i{width:14px;height:6px;border-radius:2px;background:rgba(255,255,255,.2)}.kd-lv i.on{background:#7af0ff}
.kd-money-big{font:700 26px "Orbitron",sans-serif;float:right}
.kd-close{float:right;margin-left:12px}
`;

/**
 * opts: {
 *   city: url of the city JSON (Keo's build__city) — required,
 *   title, subtitle, gameId (save slot), startMoney,
 *   time: 'night' | 'dusk' | 'day', rain: false, quality,
 *   cars: catalogue (defaults to garage.js CARS; a car may have model: '/assets/cars/x.glb'),
 *   traffic: 26, police: { patrols: 3, maxCops: 6 },
 *   races: [{ name, length, rivals, difficulty, reward }],
 *   onReady(api), onEvent(event, api)
 * }
 */
export async function createDriveGame(opts = {}) {
  await RAPIER.init();
  const canvas = opts.canvas ?? Object.assign(document.body.appendChild(document.createElement('canvas')), { style: 'position:fixed;inset:0;width:100vw;height:100vh;display:block' });
  if (!document.getElementById('kd-menu-css')) {
    const s = document.createElement('style');
    s.id = 'kd-menu-css';
    s.textContent = MENU_CSS;
    document.head.appendChild(s);
  }
  const loading = menuLayer();
  loading.innerHTML = `<div class="kd-panel"><h1 class="kd-title">${esc(opts.title ?? 'Night Run')}</h1><p class="kd-sub">Loading the city…</p></div>`;
  loading.hidden = false;

  const data = typeof opts.city === 'string' ? await (await fetch(opts.city)).json() : opts.city;
  const world = createWorld(canvas, { time: opts.time ?? 'night', quality: opts.quality });
  const physics = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  physics.timestep = 1 / 60;
  const events = new RAPIER.EventQueue(true);
  const ctx = { scene: world.scene, physics: { world: physics, RAPIER } };
  const city = buildCity(world, data, { physics: ctx.physics });
  const catalog = opts.cars ?? CARS;
  const profile = new Profile(opts.gameId ?? `drive:${(opts.title ?? 'game').toLowerCase().replace(/\W+/g, '-')}`, opts.startMoney ?? 15000);
  const hud = new Hud(city);
  const audio = new GameAudio();
  const fx = new Effects(world.scene);
  const cam = new ChaseCamera(world.camera);
  const controls = new Controls();
  if (opts.rain) fx.setRain(true, world.camera);

  async function makeModel(car) {
    const paint = profile.paintOf(car.id, catalog);
    if (car.model) {
      try {
        return await loadCarModel(car.model, { style: car.style, length: car.length, turn: car.turn, ownWheels: car.ownWheels });
      } catch (e) {
        console.warn('Car model did not load, using the built-in one:', e);
      }
    }
    return createCarModel({ style: car.style, color: paint.color, finish: paint.finish });
  }

  let player = null;
  async function spawnPlayer(at) {
    const car = profile.car(undefined, catalog);
    const where = at ?? (player ? { x: player.body.translation().x, z: player.body.translation().z, heading: player.heading } : city.spawn);
    if (player) player.remove();
    const model = await makeModel(car);
    player = new Vehicle(ctx, model, profile.spec(car.id, catalog), where);
    player.kind = 'player';
    // Real headlight beams on the road ahead.
    const beam = new THREE.SpotLight('#eef3ff', 140, 90, 0.42, 0.55, 1.4);
    beam.position.set(0, 0.75, model.size.length / 2);
    beam.target.position.set(0, 0, model.size.length / 2 + 25);
    model.group.add(beam, beam.target);
    player.beam = beam;
    world.onTime((t) => (beam.visible = t.name !== 'day'));
    api.player = player;
    cam.first = true;
  }

  const traffic = new Traffic(ctx, city, { count: opts.traffic ?? 26 });
  const police = new Police(ctx, city, opts.police ?? {});
  let race = null;
  let state = 'menu';
  let empUntil = 0;
  let driftCash = 0;
  let time = 0;

  const api = {
    world,
    city,
    physics: ctx.physics,
    profile,
    hud,
    audio,
    fx,
    police,
    traffic,
    player: null,
    get state() {
      return state;
    },
    /** Starts a street race (opts: { length, rivals, difficulty, reward, name }). */
    startRace(o = {}) {
      race?.end();
      race = new Race(ctx, city, { start: { x: player.body.translation().x, z: player.body.translation().z }, ...o });
      player.recover(race.startAt);
      hud.big(o.name ?? 'STREET RACE', `${race.gates.length} checkpoints · $${race.reward.toLocaleString('en-US')}`);
      race.countdown = 3;
      state = 'play';
      menus.hidden = true;
    },
    openGarage: () => showGarage(),
    addMoney(n, why) {
      profile.add(n);
      hud.set({ money: profile.money });
      if (why) hud.toast(`${n >= 0 ? '+' : ''}$${Math.round(n).toLocaleString('en-US')} · ${why}`);
    },
    setTime: (t) => world.setTime(t),
    message: (t, sub, ms) => hud.big(t, sub, ms),
    toast: (t) => hud.toast(t),
    emit: (e) => opts.onEvent?.(e, api),
  };

  await spawnPlayer(city.spawn);
  const menus = menuLayer();

  // Menus ---------------------------------------------------------------------------------------
  function showMain() {
    state = 'menu';
    menus.hidden = false;
    menus.innerHTML = `<div class="kd-panel">
      <span class="kd-money-big">$${profile.money.toLocaleString('en-US')}</span>
      <h1 class="kd-title">${esc(opts.title ?? 'Night Run')}</h1>
      <p class="kd-sub">${esc(opts.subtitle ?? `${data.name ?? 'The city'} · real streets`)}</p>
      <div class="kd-btns">
        <button class="kd-btn primary" data-a="drive">Drive<small>Free roam. Outrun the police, drift for cash.</small></button>
        <button class="kd-btn" data-a="races">Street races<small>Checkpoint races through real streets.</small></button>
        <button class="kd-btn" data-a="garage">Garage<small>Cars, upgrades, paint and gadgets.</small></button>
        <button class="kd-btn" data-a="settings">Settings<small>Time of day, weather, quality, sound.</small></button>
      </div>
      <p class="kd-sub" style="margin-top:22px;font-size:13px">W/S or ↑/↓ drive · A/D steer · Space drift · Shift nitro · C camera · R back on the road · 1 shield · 2 EMP · 3 nitro refill · 4 repair · P pause</p>
    </div>`;
    on(menus, 'drive', () => play());
    on(menus, 'races', showRaces);
    on(menus, 'garage', showGarage);
    on(menus, 'settings', showSettings);
  }
  function showRaces() {
    const list = opts.races ?? [
      { name: 'Downtown Sprint', length: 1200, rivals: 3, difficulty: 1, reward: 4000 },
      { name: 'Midnight Run', length: 2200, rivals: 4, difficulty: 2, reward: 9000 },
      { name: 'City Legend', length: 3200, rivals: 5, difficulty: 3, reward: 20000 },
    ];
    menus.innerHTML = `<div class="kd-panel"><button class="kd-btn kd-close" data-a="back">Back</button><h1 class="kd-title" style="font-size:54px">Street races</h1>
      <div class="kd-btns" style="margin-top:20px">${list.map((r, i) => `<button class="kd-btn" data-a="race${i}">${esc(r.name)}<small>${(r.length / 1000).toFixed(1)} km · ${r.rivals} rivals · win $${r.reward.toLocaleString('en-US')}</small></button>`).join('')}</div></div>`;
    on(menus, 'back', showMain);
    list.forEach((r, i) => on(menus, `race${i}`, () => api.startRace(r)));
  }
  function showSettings() {
    const t = world.time.name;
    menus.innerHTML = `<div class="kd-panel"><button class="kd-btn kd-close" data-a="back">Back</button><h1 class="kd-title" style="font-size:54px">Settings</h1>
      <div class="kd-h">Time of day</div><div class="kd-row">${['night', 'dusk', 'day'].map((x) => `<button class="kd-chip ${x === t ? 'on' : ''}" data-a="t-${x}">${x}</button>`).join('')}</div>
      <div class="kd-h">Weather</div><div class="kd-row"><button class="kd-chip ${fx.rain ? 'on' : ''}" data-a="rain">Rain</button></div>
      <div class="kd-h">Sound</div><div class="kd-row"><button class="kd-chip ${audio.muted ? '' : 'on'}" data-a="sound">Sound on</button></div></div>`;
    on(menus, 'back', showMain);
    for (const x of ['night', 'dusk', 'day']) on(menus, `t-${x}`, () => (world.setTime(x), showSettings()));
    on(menus, 'rain', () => (fx.setRain(!fx.rain, world.camera), showSettings()));
    on(menus, 'sound', () => (audio.mute(!audio.muted), showSettings()));
  }
  function showGarage(tab = 'cars') {
    state = 'menu';
    menus.hidden = false;
    const cur = profile.car(undefined, catalog);
    const lv = (n) => `<span class="kd-lv">${[1, 2, 3, 4].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`;
    const paint = profile.paintOf();
    let body = '';
    if (tab === 'cars')
      body = `<div class="kd-btns">${catalog
        .map((c) => {
          const owned = profile.data.owned.includes(c.id);
          return `<button class="kd-btn ${c.id === cur.id ? 'primary' : ''}" data-a="car-${c.id}">${esc(c.name)}<small>${esc(c.blurb ?? '')}<br>${owned ? (c.id === cur.id ? 'Driving it' : 'Owned · drive it') : `$${c.price.toLocaleString('en-US')}`}</small></button>`;
        })
        .join('')}</div>`;
    if (tab === 'upgrades')
      body = `<div class="kd-btns">${Object.entries(UPGRADES)
        .map(([k, u]) => {
          const l = profile.level(cur.id, k);
          return `<button class="kd-btn" data-a="up-${k}" ${l >= 4 ? 'disabled' : ''}>${u.label}${lv(l)}<small>${u.blurb} · ${l >= 4 ? 'maxed' : `$${(u.base * (l + 1)).toLocaleString('en-US')}`}</small></button>`;
        })
        .join('')}</div>`;
    if (tab === 'paint')
      body = `<div class="kd-h">Colour</div><div class="kd-row">${PAINTS.colors.map((c) => `<span class="kd-swatch ${c === paint.color ? 'on' : ''}" style="background:${c}" data-a="col-${c.slice(1)}"></span>`).join('')}</div>
        <div class="kd-h">Finish</div><div class="kd-row">${Object.entries(PAINTS.finishes).map(([f, p]) => `<button class="kd-chip ${f === paint.finish ? 'on' : ''}" data-a="fin-${f}">${f} · $${(PAINTS.price + p).toLocaleString('en-US')}</button>`).join('')}</div>`;
    if (tab === 'gadgets')
      body = `<div class="kd-btns">${Object.entries(GADGETS)
        .map(([k, g]) => `<button class="kd-btn" data-a="gad-${k}">${g.label} ×${profile.data.gadgets[k] ?? 0}<small>${g.blurb} · key ${g.key} · $${g.price.toLocaleString('en-US')}</small></button>`)
        .join('')}</div>`;
    menus.innerHTML = `<div class="kd-panel"><button class="kd-btn kd-close" data-a="back">Back</button><span class="kd-money-big">$${profile.money.toLocaleString('en-US')}</span>
      <h1 class="kd-title" style="font-size:54px">Garage</h1><p class="kd-sub">${esc(cur.name)}</p>
      <div class="kd-row">${['cars', 'upgrades', 'paint', 'gadgets'].map((t) => `<button class="kd-chip ${t === tab ? 'on' : ''}" data-a="tab-${t}">${t}</button>`).join('')}</div>
      <div style="margin-top:18px">${body}</div></div>`;
    on(menus, 'back', showMain);
    for (const t of ['cars', 'upgrades', 'paint', 'gadgets']) on(menus, `tab-${t}`, () => showGarage(t));
    for (const c of catalog)
      on(menus, `car-${c.id}`, async () => {
        if (!profile.buyCar(c)) return hud.toast('Not enough cash yet.');
        profile.data.current = c.id;
        profile.save();
        audio.blip(660);
        await spawnPlayer();
        showGarage('cars');
      });
    for (const k of Object.keys(UPGRADES))
      on(menus, `up-${k}`, () => {
        if (!profile.buyUpgrade(cur.id, k)) return hud.toast('Not enough cash yet.');
        player.applySpec(profile.spec(cur.id, catalog));
        audio.blip(990);
        showGarage('upgrades');
      });
    let pick = paint.color;
    for (const c of PAINTS.colors) on(menus, `col-${c.slice(1)}`, () => ((pick = c), player.model.setPaint(c, paint.finish)));
    for (const f of Object.keys(PAINTS.finishes))
      on(menus, `fin-${f}`, () => {
        if (!profile.buyPaint(cur.id, pick, f)) return hud.toast('Not enough cash yet.');
        player.model.setPaint(pick, f);
        audio.blip(880);
        showGarage('paint');
      });
    for (const k of Object.keys(GADGETS))
      on(menus, `gad-${k}`, () => {
        if (!profile.buyGadget(k)) return hud.toast('Not enough cash yet.');
        audio.blip(770);
        showGarage('gadgets');
      });
  }
  function play() {
    state = 'play';
    menus.hidden = true;
    hud.show(true);
  }
  function pause() {
    if (state !== 'play') return;
    state = 'menu';
    menus.hidden = false;
    menus.innerHTML = `<div class="kd-panel"><h1 class="kd-title" style="font-size:60px">Paused</h1><div class="kd-btns" style="margin-top:18px">
      <button class="kd-btn primary" data-a="resume">Resume</button><button class="kd-btn" data-a="garage" ${police.pursuit ? 'disabled' : ''}>Garage<small>${police.pursuit ? 'Lose the police first' : ''}</small></button><button class="kd-btn" data-a="menu">Main menu</button></div></div>`;
    on(menus, 'resume', play);
    on(menus, 'garage', showGarage);
    on(menus, 'menu', () => (race?.end(), (race = null), hud.race(null), showMain()));
  }

  // Keys ----------------------------------------------------------------------------------------
  controls.onKey((code) => {
    if (code === 'Escape' || code === 'KeyP') return state === 'play' ? pause() : state === 'menu' && menus.innerHTML.includes('Paused') ? play() : null;
    if (state !== 'play') return;
    if (code === 'KeyC') cam.cycle();
    if (code === 'KeyR') {
      const r = city.roadAt(player.body.translation().x, player.body.translation().z);
      if (r) player.recover(r);
    }
    if (code === 'KeyM') audio.mute(!audio.muted);
    if (code === 'Digit1' && profile.useGadget('shield')) {
      player.shield = 6;
      hud.toast('Shield up');
    }
    if (code === 'Digit2' && profile.useGadget('emp')) {
      empUntil = time + 6;
      fx.spark(player.position.add(new THREE.Vector3(0, 1, 0)), 80);
      hud.toast('EMP: police cars nearby are down');
    }
    if (code === 'Digit3' && profile.useGadget('refill')) {
      player.nitro = 1;
      hud.toast('Nitro full');
    }
    if (code === 'Digit4' && profile.useGadget('repair')) {
      player.health = 1;
      hud.toast('Car repaired');
    }
  });

  // Loop ----------------------------------------------------------------------------------------
  const clock = new THREE.Clock();
  let acc = 0;
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    time += dt;
    if (state === 'play') {
      if (race?.countdown > 0) {
        race.countdown -= dt;
        hud.big(String(Math.ceil(race.countdown)), '', 600);
        player.input = { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
        if (race.countdown <= 0) hud.big('GO!', '', 900);
      } else player.input = controls.read();
      acc += dt;
      while (acc >= 1 / 60) {
        acc -= 1 / 60;
        player.update(1 / 60, time);
        traffic.update(1 / 60, player, police.cops);
        if (time > empUntil) police.update(1 / 60, player, time);
        else
          for (const c of police.cops) {
            // EMP: police cars stand still until it wears off.
            c.input = { throttle: 0, brake: 1, steer: 0, handbrake: false, nitro: false };
            c.update(1 / 60, time);
          }
        if (race && !(race.countdown > 0)) race.update(1 / 60, player, time);
        physics.step(events);
        events.drainContactForceEvents((e) => crash(e));
      }
      // Drift cash: a long, fast slide pays.
      if (player.slip > 0.3 && Math.abs(player.speed) > 12) driftCash += player.slip * Math.abs(player.speed) * dt * 6;
      else if (driftCash > 0) {
        if (driftCash > 60) api.addMoney(Math.round(driftCash), 'drift');
        driftCash = 0;
      }
      fx.skid(player);
      fx.nitro(player, player.boosting);
      handleEvents();
      if (player.health <= 0) wrecked();
    }
    cam.update(dt, player);
    world.follow(player.position);
    fx.update(dt);
    const near = police.pursuit ? Math.min(...police.cops.map((c) => c.position.distanceTo(player.position)), Infinity) : Infinity;
    audio.update({ speed: player.speed, throttle: player.input.throttle, topSpeed: player.spec.topSpeed, slip: player.slip, siren: near, boost: player.boosting });
    hud.set({ speed: Math.abs(player.speed), topSpeed: player.spec.topSpeed, nitro: player.nitro, health: player.health, heat: Math.floor(police.heat), pursuit: police.pursuit, money: profile.money, boost: player.boosting });
    hud.map(player, [...police.cops.map((c) => ({ ...xz(c), color: police.pursuit ? '#ff3030' : '#3a6cff' })), ...(race ? race.rivals.map((r) => ({ ...xz(r), color: '#ffffff', r: 5 })) : []), ...(race && race.gates[race.next] ? [{ x: race.gates[race.next].x, z: race.gates[race.next].z, color: '#ffb000', r: 10 }] : [])]);
    if (race) hud.race(race.standings(player), race.next, race.gates.length);
    world.render();
    requestAnimationFrame(frame);
  }

  function crash(e) {
    const h1 = e.collider1();
    const h2 = e.collider2();
    const force = e.totalForceMagnitude();
    const mine = h1 === player.collider.handle || h2 === player.collider.handle;
    if (!mine) return;
    const other = h1 === player.collider.handle ? h2 : h1;
    const dmg = player.hit(force);
    if (dmg > 0.01) {
      audio.crash(Math.min(1, dmg * 4));
      cam.shake(Math.min(1, dmg * 6));
      fx.spark(player.position.add(new THREE.Vector3(0, 0.6, 0)), 30);
    }
    const cop = police.isCop(other);
    if (cop) police.addHeat(1, 'hit a police car');
    const car = traffic.carOf(other);
    if (car) {
      traffic.knock(car);
      if (police.cops.some((c) => c.position.distanceTo(player.position) < 80)) police.addHeat(0.5, 'crash');
    }
    api.emit({ type: 'crash', force, cop: !!cop, traffic: !!car });
  }

  function handleEvents() {
    for (const e of police.events.splice(0)) {
      if (e.type === 'heat') hud.toast(e.heat >= 3 ? `Heat level ${e.heat}: more units are coming` : `Police pursuit · heat ${e.heat}`);
      if (e.type === 'escaped') {
        hud.big('ESCAPED', `Bounty $${e.bounty.toLocaleString('en-US')}`);
        api.addMoney(e.bounty);
        profile.data.stats.escapes++;
        profile.save();
        audio.blip(1200, 300);
      }
      if (e.type === 'busted') {
        const fine = Math.round(profile.money * 0.15);
        hud.big('BUSTED', `Fine $${fine.toLocaleString('en-US')}`);
        profile.add(-fine);
        profile.data.stats.busted++;
        profile.save();
        race?.end();
        race = null;
        hud.race(null);
        player.recover(city.spawn);
      }
      api.emit(e);
    }
    if (race)
      for (const e of race.events.splice(0)) {
        if (e.type === 'checkpoint') audio.blip(1100, 90);
        if (e.type === 'finish') {
          hud.big(e.place === 1 ? 'YOU WIN' : `${ordinal(e.place)} PLACE`, `+$${e.reward.toLocaleString('en-US')}`, 3500);
          api.addMoney(e.reward);
          profile.data.stats.races++;
          if (e.place === 1) profile.data.stats.wins++;
          profile.save();
          setTimeout(() => {
            race?.end();
            race = null;
            hud.race(null);
          }, 3500);
        }
        api.emit(e);
      }
    for (const e of player.events.splice(0)) api.emit(e);
  }

  function wrecked() {
    const cost = 1500;
    hud.big('WRECKED', `Repairs $${cost.toLocaleString('en-US')}`);
    profile.add(-cost);
    player.health = 1;
    const r = city.roadAt(player.body.translation().x, player.body.translation().z);
    player.recover(r ?? city.spawn);
    api.emit({ type: 'wrecked' });
  }

  loading.remove();
  showMain();
  requestAnimationFrame(frame);
  opts.onReady?.(api);
  return api;
}

function menuLayer() {
  const m = document.createElement('div');
  m.className = 'kd-menu';
  m.hidden = true;
  document.body.appendChild(m);
  return m;
}
function on(root, action, fn) {
  root.querySelectorAll(`[data-a="${action}"]`).forEach((b) => b.addEventListener('click', fn));
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function xz(v) {
  const p = v.body.translation();
  return { x: p.x, z: p.z };
}
function ordinal(n) {
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10 > 3 || Math.floor(n / 10) === 1 ? 0 : n % 10]}`;
}
