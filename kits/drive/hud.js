// The heads-up display: speedometer, nitro and health, wanted level, money, minimap, race info,
// messages and the map credit. Plain DOM over the canvas; styles are injected once.

const CSS = `
.kd-hud{position:fixed;inset:0;pointer-events:none;font-family:"Plus Jakarta Sans","Inter",system-ui,sans-serif;color:#fff;z-index:5;user-select:none}
.kd-speedo{position:absolute;right:28px;bottom:26px;width:210px;height:210px}
.kd-speedo canvas{width:210px;height:210px}
.kd-speed{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-top:34px}
.kd-speed b{font:800 52px/1 "Orbitron","Inter",sans-serif;letter-spacing:1px;text-shadow:0 0 18px rgba(0,200,255,.35)}
.kd-speed span{font-size:12px;opacity:.7;letter-spacing:3px}
.kd-bars{position:absolute;right:28px;bottom:244px;width:210px;display:grid;gap:7px}
.kd-bar{height:8px;border-radius:5px;background:rgba(255,255,255,.12);overflow:hidden}
.kd-bar i{display:block;height:100%;border-radius:5px;transition:width .15s}
.kd-bar.nos i{background:linear-gradient(90deg,#00c6ff,#7a5cff)}
.kd-bar.hp i{background:linear-gradient(90deg,#ff3d3d,#ffb000,#39d353)}
.kd-label{font-size:10px;letter-spacing:2px;opacity:.65;margin-bottom:-4px}
.kd-top{position:absolute;top:18px;left:50%;transform:translateX(-50%);display:flex;gap:14px;align-items:center}
.kd-stars{font-size:26px;letter-spacing:4px;color:rgba(255,255,255,.18)}
.kd-stars .on{color:#ff2a2a;text-shadow:0 0 12px #ff2a2a}
.kd-stars.flash .on{animation:kdflash .5s infinite alternate}
@keyframes kdflash{to{color:#2a5bff;text-shadow:0 0 12px #2a5bff}}
.kd-money{position:absolute;top:18px;right:28px;font:700 22px "Orbitron","Inter",sans-serif;text-shadow:0 2px 8px rgba(0,0,0,.6)}
.kd-money small{display:block;font:500 11px "Inter",sans-serif;opacity:.7;letter-spacing:2px;text-align:right}
.kd-map{position:absolute;left:24px;bottom:30px;width:200px;height:200px;border-radius:50%;overflow:hidden;border:2px solid rgba(255,255,255,.25);box-shadow:0 8px 30px rgba(0,0,0,.6);background:rgba(8,10,16,.75)}
.kd-map canvas{width:200px;height:200px}
.kd-race{position:absolute;top:70px;left:24px;font-size:14px;background:rgba(0,0,0,.45);border-radius:10px;padding:10px 14px;min-width:170px;backdrop-filter:blur(6px)}
.kd-race b{font:800 30px "Orbitron",sans-serif;display:block}
.kd-race div{opacity:.85;margin-top:2px}
.kd-race .me{color:#ffcf3d;font-weight:700}
.kd-msg{position:absolute;top:24%;left:50%;transform:translate(-50%,-50%);text-align:center;font:900 64px/1 "Bebas Neue","Orbitron",sans-serif;letter-spacing:4px;text-shadow:0 6px 30px rgba(0,0,0,.7);opacity:0;transition:opacity .25s,transform .25s}
.kd-msg.show{opacity:1;transform:translate(-50%,-50%) scale(1.04)}
.kd-msg small{display:block;font:600 18px "Inter",sans-serif;letter-spacing:1px;margin-top:10px;opacity:.9}
.kd-toast{position:absolute;bottom:40px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.15);padding:9px 16px;border-radius:10px;font-size:15px;opacity:0;transition:opacity .25s;backdrop-filter:blur(6px)}
.kd-toast.show{opacity:1}
.kd-credit{position:absolute;left:8px;bottom:4px;font-size:10px;opacity:.55}
.kd-credit a{color:#fff;pointer-events:auto}
.kd-touch{position:fixed;inset:auto 0 0 0;height:190px;z-index:6;pointer-events:none}
.kd-tbtn{position:absolute;pointer-events:auto;border:0;border-radius:50%;width:76px;height:76px;font:800 13px "Inter",sans-serif;color:#fff;background:rgba(255,255,255,.14);backdrop-filter:blur(4px);touch-action:none}
.kd-tbtn:active{background:rgba(255,255,255,.3)}
.kd-tbtn.left{left:18px;bottom:40px}.kd-tbtn.right{left:106px;bottom:40px}
.kd-tbtn.gas{right:18px;bottom:96px;width:88px;height:88px;background:rgba(40,200,90,.35)}
.kd-tbtn.brake{right:116px;bottom:30px;background:rgba(230,60,60,.35)}
.kd-tbtn.drift{right:18px;bottom:2px;width:64px;height:64px}
.kd-tbtn.nos{right:200px;bottom:60px;background:rgba(60,120,255,.4)}
@media (max-width:700px){.kd-speedo{transform:scale(.7);transform-origin:right bottom;bottom:200px}.kd-bars{bottom:360px;width:150px}.kd-map{width:130px;height:130px;bottom:auto;top:70px}.kd-map canvas{width:130px;height:130px}.kd-msg{font-size:42px}}
`;

export class Hud {
  constructor(city, opts = {}) {
    if (!document.getElementById('kd-css')) {
      const s = document.createElement('style');
      s.id = 'kd-css';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    const el = (this.el = document.createElement('div'));
    el.className = 'kd-hud';
    el.innerHTML = `
      <div class="kd-top"><div class="kd-stars">★★★★★</div></div>
      <div class="kd-money"><small>${opts.currency ?? 'CASH'}</small><span>$0</span></div>
      <div class="kd-race" hidden></div>
      <div class="kd-map"><canvas width="400" height="400"></canvas></div>
      <div class="kd-bars"><div class="kd-label">NITRO</div><div class="kd-bar nos"><i style="width:100%"></i></div><div class="kd-label">CAR</div><div class="kd-bar hp"><i style="width:100%"></i></div></div>
      <div class="kd-speedo"><canvas width="420" height="420"></canvas><div class="kd-speed"><b>0</b><span>${opts.units === 'kmh' ? 'KM/H' : 'MPH'}</span></div></div>
      <div class="kd-msg"></div>
      <div class="kd-toast"></div>
      <div class="kd-credit">Map data ${city.attribution ?? '© OpenStreetMap contributors'} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">openstreetmap.org/copyright</a></div>`;
    document.body.appendChild(el);
    this.units = opts.units ?? 'mph';
    this.q = (s) => el.querySelector(s);
    this.speedo = this.q('.kd-speedo canvas').getContext('2d');
    this.mapCtx = this.q('.kd-map canvas').getContext('2d');
    this.mapImage = this.drawMap(city);
    this.lastSpeed = -1;
  }

  /** The streets drawn once (big roads brighter), for the minimap. */
  drawMap(city) {
    const R = city.bounds;
    const size = 2048;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    const k = size / (R * 2.2);
    x.translate(size / 2, size / 2);
    x.lineCap = x.lineJoin = 'round';
    const roads = [...new Set(city.graph.edges.map((e) => e.road))];
    for (const pass of [0, 1]) {
      for (const r of roads) {
        const big = ['motorway', 'trunk', 'primary'].includes(r.kind);
        if ((pass === 1) !== big) continue;
        x.strokeStyle = big ? 'rgba(255,214,120,.95)' : 'rgba(220,226,235,.55)';
        x.lineWidth = Math.max(2.5, r.width * k * 0.9);
        x.beginPath();
        r.pts.forEach((p, i) => (i ? x.lineTo(p[0] * k, p[1] * k) : x.moveTo(p[0] * k, p[1] * k)));
        x.stroke();
      }
    }
    return { canvas: c, k, size };
  }

  set(o) {
    if (o.speed !== undefined) {
      const v = Math.round(this.units === 'kmh' ? o.speed * 3.6 : o.speed * 2.23694);
      if (v !== this.lastSpeed) {
        this.q('.kd-speed b').textContent = v;
        this.drawSpeedo(v, o.topSpeed ?? 90, o.boost);
        this.lastSpeed = v;
      }
    }
    if (o.nitro !== undefined) this.q('.kd-bar.nos i').style.width = `${o.nitro * 100}%`;
    if (o.health !== undefined) this.q('.kd-bar.hp i').style.width = `${o.health * 100}%`;
    if (o.heat !== undefined) {
      const s = this.q('.kd-stars');
      s.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span class="${i <= o.heat ? 'on' : ''}">★</span>`).join('');
      s.classList.toggle('flash', !!o.pursuit);
    }
    if (o.money !== undefined) this.q('.kd-money span').textContent = `$${Math.round(o.money).toLocaleString('en-US')}`;
  }

  drawSpeedo(v, top, boost) {
    const x = this.speedo;
    const max = Math.ceil((top * (this.units === 'kmh' ? 3.6 : 2.23694)) / 20) * 20;
    x.clearRect(0, 0, 420, 420);
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    x.lineCap = 'round';
    x.lineWidth = 16;
    x.strokeStyle = 'rgba(255,255,255,.12)';
    x.beginPath();
    x.arc(210, 210, 180, a0, a1);
    x.stroke();
    const f = Math.min(1, v / max);
    const g = x.createLinearGradient(0, 420, 420, 0);
    g.addColorStop(0, boost ? '#7a5cff' : '#00c6ff');
    g.addColorStop(1, f > 0.85 ? '#ff3d3d' : boost ? '#00e5ff' : '#7af0ff');
    x.strokeStyle = g;
    x.shadowColor = boost ? '#7a5cff' : '#00c6ff';
    x.shadowBlur = 18;
    x.beginPath();
    x.arc(210, 210, 180, a0, a0 + (a1 - a0) * f);
    x.stroke();
    x.shadowBlur = 0;
    x.fillStyle = 'rgba(255,255,255,.6)';
    x.font = '600 20px Inter, sans-serif';
    x.textAlign = 'center';
    for (let i = 0; i <= 8; i++) {
      const a = a0 + ((a1 - a0) * i) / 8;
      x.fillText(String(Math.round((max * i) / 8)), 210 + Math.cos(a) * 142, 216 + Math.sin(a) * 142);
    }
  }

  /** Minimap: the streets around the player, turned so ahead is up; dots for police, rivals, goals. */
  map(player, marks = []) {
    const { canvas, k, size } = this.mapImage;
    const x = this.mapCtx;
    const p = player.body.translation();
    const h = player.heading;
    x.save();
    x.clearRect(0, 0, 400, 400);
    x.fillStyle = 'rgba(8,10,16,.9)';
    x.fillRect(0, 0, 400, 400);
    x.translate(200, 230);
    x.rotate(h + Math.PI);
    const zoom = 1.6;
    x.scale(zoom, zoom);
    x.drawImage(canvas, -(size / 2 + p.x * k), -(size / 2 + p.z * k));
    for (const m of marks) {
      x.fillStyle = m.color;
      x.beginPath();
      x.arc((m.x - p.x) * k, (m.z - p.z) * k, m.r ?? 7, 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
    x.fillStyle = '#ffcf3d';
    x.beginPath();
    x.moveTo(200, 214);
    x.lineTo(210, 242);
    x.lineTo(200, 236);
    x.lineTo(190, 242);
    x.closePath();
    x.fill();
  }

  race(rows, gate, of) {
    const box = this.q('.kd-race');
    if (!rows) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const me = rows.findIndex((r) => r.player) + 1;
    box.innerHTML = `<b>${me}/${rows.length}</b><div>Checkpoint ${gate}/${of}</div>${rows.map((r, i) => `<div class="${r.player ? 'me' : ''}">${i + 1}. ${r.name}</div>`).join('')}`;
  }

  big(text, sub = '', ms = 2600) {
    const m = this.q('.kd-msg');
    m.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    m.classList.add('show');
    clearTimeout(this.bigT);
    this.bigT = setTimeout(() => m.classList.remove('show'), ms);
  }

  toast(text, ms = 2400) {
    const t = this.q('.kd-toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastT);
    this.toastT = setTimeout(() => t.classList.remove('show'), ms);
  }

  show(on) {
    this.el.style.display = on ? '' : 'none';
  }
}
