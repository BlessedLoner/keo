# Keo's driving game kit — the whole API on one page

Read this page only. Do not read the kit's other files: everything you can use is here.

## The complete game

```html
<script type="module">
  import { createDriveGame } from '/lib/drive/index.js';
  const game = (window.game = await createDriveGame({
    title: 'NIGHT RUN', subtitle: 'Downtown Los Angeles · real streets',
    city: '/assets/city.json',            // one city (from build__city) …
    // cities: [ … ],                     // … or a world of several (see "A world of cities")
    time: 'night',                        // 'night' | 'dusk' | 'day'
    rain: false, traffic: 26, startMoney: 15000,
    police: { patrols: 3, maxCops: 6 },
    cars: [ … ],                          // see "Cars"; leave out for the 5 built-in cars
    races: [{ name: 'Downtown Sprint', length: 1200, rivals: 3, difficulty: 1, reward: 4000 }],
    jobs: { offers: 4, baseFare: 350, perKm: 1500, tip: 0.35 },   // passengers; false turns them off
    onReady(game) {}, onEvent(e, game) {},
  }));
</script>
```

The kit draws everything itself: loading screen, main menu (Drive, Street races, Travel, Garage,
Settings), HUD with speedometer and minimap, pause, the "© OpenStreetMap contributors" credit,
keyboard, gamepad and touch controls, sound, and saving in the browser. Do not rebuild those.
Your page needs only an empty body, the fonts stylesheet and the script above.

Keep `window.game`: it is how the game is tested. Prove it drives with build__check and
`actions: [{do:"click",text:"Drive"},{do:"keys",keys:["KeyW"],holdSeconds:4},{do:"measure",expression:"Math.round(window.game.player.mph)"}]`
— the speed must be above zero. A passenger ride or a race can be measured the same way
(`window.game.jobs.offers.length`, `window.game.profile.money`).

## Cars

```js
{ id: 'raptor-rs', name: 'Raptor RS', style: 'super',   // 'super' | 'sports' | 'muscle' | 'suv'
  price: 62000,                                        // the first car must have price: 0
  color: '#f2c200', blurb: 'Mid-engine track weapon.',
  model: '/assets/cars/raptor.glb',                    // optional: a realistic model from build__model
  spec: { power: 12800, topSpeed: 84, grip: 3.6, mass: 1400, armor: 0 } }
```

Spec units — use these numbers, not 0–1 ratings:

| field | unit | slow car | normal | fastest |
| --- | --- | --- | --- | --- |
| power | newtons at the wheels | 8000 | 10000–12000 | 16000 |
| topSpeed | metres per second (×2.24 = mph) | 60 | 72–84 | 100 |
| grip | tyre friction | 2.8 | 3.2 | 4.0 |
| mass | kg | 1100 | 1350–1600 | 2200 |
| armor | 0–0.9 share of crash damage absorbed | 0 | 0 | 0.4 |

Make the brand and car names up (real brands need a licence).

## A world of cities (travelling between cities and countries)

Download each place with build__city into its own file (`path: "assets/cities/los-angeles.json"`),
then list them. The player starts in the first; "Travel" in the main menu (or `game.travelTo(id)`)
pays the cost, saves, and loads the other city. Money, cars and upgrades come along.

```js
cities: [
  { id: 'la',     name: 'Los Angeles', country: 'USA',            file: '/assets/cities/los-angeles.json', cost: 0 },
  { id: 'tokyo',  name: 'Tokyo',       country: 'Japan',          file: '/assets/cities/tokyo.json',       cost: 6000, blurb: 'Tight streets, neon' },
  { id: 'london', name: 'London',      country: 'United Kingdom', file: '/assets/cities/london.json',      cost: 5000 },
]
```

Each city is a real district up to 3 km across (radius 1500 m). A whole country as one seamless
map is not possible; a world is a set of such cities. `game.place` is the current city, `game.cities` the list.

## Passengers (taxi and delivery jobs)

On in "Drive" unless `jobs: false`. People wait at the kerb (green rings, green dots on the
minimap) and wave; stopping beside one picks them up, a yellow marker shows where they want to
go, and the fare (by road distance) plus a tip for a quick ride is paid on arrival.
`game.setJobs(true|false)`; `game.jobs.done` counts finished rides. Events: `pickup`, `dropoff`
(`{ name, fare, tip, late, total }`), `job_failed`. For a delivery game, change the words in your
own onEvent messages and pass `jobs: { names: ['Pizza order', 'Parcel'] }`.

## The game object

- `game.player` — the car: `.speed` (m/s), `.mph`, `.health` 0–1, `.nitro` 0–1, `.position`, `.heading`, `.recover({ x, z, heading })`
- `game.profile` — `.money`, `.add(n)`, `.spend(n)`, `.data.stats` ({ races, wins, escapes, busted, rides, trips }), `.data` is saved with `.save()` (put your own story progress in `game.profile.data.story`)
- `game.addMoney(n, 'why')`, `game.message('BIG TEXT', 'small text', ms)`, `game.toast('text')`
- `game.startRace({ name, length, rivals, difficulty, reward })`, `game.openGarage()`, `game.setTime('day')`
- `game.police` — `.addHeat(1, 'why')`, `.heat`, `.pursuit`, `.reset()`
- `game.city` — `.graph` (roads), `.roadAt(x, z)` nearest road point, `.spawn`, `.bounds`
- `game.world` — `.scene`, `.camera` (three.js: add your own objects to the scene)
- `game.state` — 'menu' | 'play'

## Events (onEvent)

`crash` { force, cop, traffic } · `heat` { heat } · `busted` · `escaped` { bounty } · `checkpoint`
· `finish` { place, reward } · `wrecked` · `pickup` · `dropoff` · `job_failed` · `travel` { from, to }

Missions and story: your own js file with a list of steps, advanced from onEvent (for example
"win a race", "escape heat 3", "drive 5 passengers", "travel to Tokyo"), saved in
`game.profile.data.story`, shown with `game.message`.

## Controls (already built in)

W/S or ↑/↓ drive · A/D steer · Space drift · Shift nitro · C camera · R back on the road ·
1 shield · 2 EMP · 3 nitro refill · 4 repair · P pause · gamepad and touch buttons.

## Pieces for a different kind of driving game

`createWorld, buildCity, createCarModel, loadCarModel, Vehicle, normalSpec, ChaseCamera, Controls,
Traffic, Police, Race, Jobs, createPerson, Hud, GameAudio, Effects, Profile` — all from
`/lib/drive/index.js`. Prefer `createDriveGame` and build on the game object.
