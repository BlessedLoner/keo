/* heykeo.com — motion and the early-access form. Everything is drawn here; no libraries. */
(() => {
  // ?shot: everything shown at once (for full-page screenshots).
  if (/[?&]shot\b/.test(location.search)) document.documentElement.classList.add('shot');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  /** Runs `tick` every frame only while `el` is on screen (and never with reduced motion: one frame). */
  function whileVisible(el, tick) {
    if (!el) return;
    let on = false;
    let raf = 0;
    const t0 = performance.now();
    const loop = (now) => {
      tick((now - t0) / 1000);
      if (on) raf = requestAnimationFrame(loop);
    };
    if (reduced) {
      tick(6);
      return;
    }
    new IntersectionObserver(([e]) => {
      on = e.isIntersecting;
      cancelAnimationFrame(raf);
      if (on) raf = requestAnimationFrame(loop);
    }, { threshold: 0.05 }).observe(el);
  }

  // ---------------------------------------------------------------- top bar
  const top = $('#top');
  const onScroll = () => top && top.classList.toggle('scrolled', scrollY > 12);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---------------------------------------------------------------- headings appear word by word
  for (const el of $$('.split')) {
    let i = 0;
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const frag = document.createDocumentFragment();
          for (const part of child.textContent.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) frag.append(part);
            else {
              const s = document.createElement('span');
              s.className = 'wd';
              s.style.transitionDelay = `${i++ * 0.06}s`;
              s.textContent = part;
              frag.append(s);
            }
          }
          child.replaceWith(frag);
        } else if (child.nodeType === 1) walk(child);
      }
    };
    walk(el);
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries)
      if (e.isIntersecting) {
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  $$('.reveal, .split').forEach((el) => io.observe(el));

  // ---------------------------------------------------------------- the hero: a spotlight, and Keo's face looking at you
  const hero = $('.hero');
  const face = $('#face');
  const eyes = face ? $$('.eye', face) : [];
  let px = innerWidth / 2;
  let py = innerHeight * 0.35;
  let pointerAt = 0;
  addEventListener('pointermove', (e) => {
    px = e.clientX;
    py = e.clientY;
    pointerAt = performance.now();
    if (hero) {
      const r = hero.getBoundingClientRect();
      hero.style.setProperty('--mx', `${e.clientX - r.left}px`);
      hero.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
  }, { passive: true });

  if (face && !reduced) {
    let lx = 0;
    let ly = 0;
    whileVisible(face, (t) => {
      const r = face.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      // No pointer lately (phones, or a still mouse): Keo looks around by itself.
      const idle = performance.now() - pointerAt > 2500;
      const tx = idle ? Math.sin(t * 0.5) * 0.7 : Math.max(-1, Math.min(1, (px - cx) / (innerWidth / 2)));
      const ty = idle ? Math.sin(t * 0.37 + 1) * 0.4 : Math.max(-1, Math.min(1, (py - cy) / (innerHeight / 2)));
      lx += (tx - lx) * 0.08;
      ly += (ty - ly) * 0.08;
      face.style.transform = `rotateY(${lx * 14}deg) rotateX(${-ly * 12}deg)`;
      face.style.setProperty('--gx', `${-lx * 20}px`);
      face.style.setProperty('--gy', `${-ly * 20}px`);
      const w = r.width;
      for (const e of eyes) {
        e.style.setProperty('--ex', `${lx * w * 0.075}px`);
        e.style.setProperty('--ey', `${ly * w * 0.06}px`);
      }
    });
    // A blink every few seconds (sometimes two).
    const blink = () => {
      for (const e of eyes) e.style.setProperty('--blink', '0.08');
      setTimeout(() => eyes.forEach((e) => e.style.setProperty('--blink', '1')), 130);
      if (Math.random() < 0.25) setTimeout(blink, 320);
    };
    (function loop() {
      setTimeout(() => {
        blink();
        loop();
      }, 2600 + Math.random() * 3600);
    })();
  }

  // Things people ask, orbiting the face.
  const chipsEl = $('#chips');
  const CHIPS = [
    ['✂︎', 'Cut the pauses'],
    ['◐', 'Build my bakery site'],
    ['✦', 'How does a jet engine work?'],
    ['↗', 'Reply to John'],
    ['▤', 'Sort my downloads'],
    ['▶', 'Make a 30s TikTok'],
  ];
  if (chipsEl && !reduced) {
    const chips = CHIPS.map(([i, t]) => {
      const c = document.createElement('span');
      c.className = 'chip';
      c.innerHTML = `<i>${i}</i>`;
      c.append(t);
      chipsEl.append(c);
      return c;
    });
    whileVisible(chipsEl, (t) => {
      const r = chipsEl.getBoundingClientRect();
      chips.forEach((c, k) => {
        const a = t * 0.16 + (k / chips.length) * Math.PI * 2;
        const x = Math.cos(a) * r.width * 0.36;
        const y = Math.sin(a) * r.height * 0.22;
        const depth = (Math.sin(a) + 1) / 2; // 0 behind, 1 in front
        c.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(${0.82 + depth * 0.22})`;
        c.style.opacity = String(0.18 + depth * 0.82);
        c.style.zIndex = depth > 0.5 ? '3' : '0';
      });
    });
  }

  // ---------------------------------------------------------------- the logo film (Keo's face becomes the o of keo)
  const film = $('#film');
  if (film) {
    const x = film.getContext('2d');
    const W = film.width;
    const H = film.height;
    const D = 6.2;
    const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
    const seg = (t, a, b) => clamp((t - a) / (b - a));
    const expo = (p) => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
    const inOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    const back = (p) => { const s = 1.7; const y = p - 1; return 1 + (s + 1) * y * y * y + s * y * y; };
    const lerp = (a, b, p) => a + (b - a) * p;
    const U = H / 100;
    const FONT = 30 * U;
    const XH = FONT * 0.49;
    let keWidth = FONT * 0.985;
    const INK = '#050506';
    const face = (cx, cy, size, open, look, rot, glow) => {
      x.save();
      x.translate(cx, cy);
      x.rotate(rot);
      x.shadowColor = `rgba(255,255,255,${0.25 * glow})`;
      x.shadowBlur = 60 * glow;
      const g = x.createLinearGradient(-size / 2, -size / 2, size / 2, size / 2);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(1, '#cfd2d8');
      x.fillStyle = g;
      x.beginPath();
      x.roundRect(-size / 2, -size / 2, size, size, Math.max(0, size * 0.242));
      x.fill();
      x.shadowBlur = 0;
      const ew = size * 0.137;
      const eh = Math.max(size * 0.02, size * 0.227 * open);
      x.fillStyle = INK;
      for (const ex of [-size * 0.121, size * 0.121]) {
        x.beginPath();
        x.roundRect(ex - ew / 2 + look * size * 0.06, -size * 0.023 - eh / 2, ew, eh, Math.max(0, Math.min(ew, eh) * 0.42));
        x.fill();
      }
      x.restore();
    };
    const draw = (t) => {
      x.clearRect(0, 0, W, H);
      const total = keWidth + FONT * 0.075 + XH;
      const left = W / 2 - total / 2;
      const base = H / 2 + XH * 0.42;
      const oX = left + keWidth + FONT * 0.075 + XH / 2;
      const oY = base - XH / 2;
      const pop = back(seg(t, 0.1, 0.8));
      const move = inOut(seg(t, 2.1, 2.9));
      const size = lerp(34 * U * pop, XH, move);
      let open = expo(seg(t, 0.75, 1.1));
      const blink = (at) => { const p = seg(t, at, at + 0.2); return p > 0 && p < 1 ? 1 - Math.sin(p * Math.PI) * 0.95 : 1; };
      open *= blink(1.5) * blink(4.6);
      const look = Math.sin(seg(t, 1.75, 2.4) * Math.PI);
      if (t > 2.3) {
        x.save();
        x.font = `700 ${FONT}px Outfit`;
        x.letterSpacing = `${-0.045 * FONT}px`;
        x.fillStyle = '#f4f4f2';
        const kW = x.measureText('k').width - 0.045 * FONT;
        [['k', 0], ['e', 1]].forEach(([ch, i]) => {
          const p = expo(seg(t, 2.4 + i * 0.12, 3.05 + i * 0.12));
          if (p <= 0) return;
          const lx = left + (i ? kW : 0);
          x.save();
          x.beginPath();
          x.rect(lx - FONT * 0.1, base - FONT * 0.95, FONT * 0.8, FONT * 1.0);
          x.clip();
          x.globalAlpha = p;
          x.fillText(ch, lx, base + (1 - p) * FONT * 0.55);
          x.restore();
        });
        x.restore();
      }
      face(lerp(W / 2, oX, move), lerp(H / 2, oY, move), size, open, look * (1 - move * 0.6), (1 - expo(seg(t, 0.1, 0.95))) * -0.22, 1 - move * 0.7);
      const tag = expo(seg(t, 3.2, 3.95));
      if (tag > 0) {
        x.save();
        x.globalAlpha = tag;
        const ts = 3.1 * U;
        x.font = `500 ${ts}px Outfit`;
        x.letterSpacing = `${lerp(0.7, 0.42, tag) * ts}px`;
        x.textAlign = 'center';
        x.fillStyle = '#9a9ea8';
        x.fillText('KNOW   ·   OWN   ·   EXECUTE', W / 2 + lerp(0.7, 0.42, tag) * ts / 2, base + FONT * 0.42 + (1 - tag) * 1.5 * U);
        x.restore();
      }
      const out = seg(t, D - 0.45, D);
      if (out > 0) {
        x.save();
        x.globalAlpha = out;
        x.globalCompositeOperation = 'destination-out';
        x.fillRect(0, 0, W, H);
        x.restore();
      }
    };
    const time = $('#film-time');
    const start = () => {
      x.font = `700 ${FONT}px Outfit`;
      x.letterSpacing = `${-0.045 * FONT}px`;
      keWidth = x.measureText('ke').width;
      whileVisible(film, (t) => {
        const tt = reduced ? 4.2 : t % (D + 0.6);
        draw(Math.min(tt, D));
        if (time) time.textContent = `00:0${Math.floor(Math.min(tt, D))}`;
      });
    };
    if (document.fonts && document.fonts.load) document.fonts.load(`700 40px Outfit`).then(start, start);
    else start();
  }

  // ---------------------------------------------------------------- Studio: the playhead and the words that pop
  const tl = $('#tl');
  if (tl) {
    const heads = $$('.head', tl);
    const words = $$('.caption span', tl);
    whileVisible(tl, (t) => {
      const p = (t % 6) / 6;
      heads.forEach((h) => h.style.setProperty('--ph', `${p * 100}%`));
      words.forEach((w, i) => {
        const on = p > 0.08 + i * 0.13;
        w.classList.toggle('on', on);
        w.classList.toggle('pop', on && w.classList.contains('pop-me'));
      });
    });
  }

  // ---------------------------------------------------------------- Builder: lines typed, then checked
  const code = $('#code');
  if (code) {
    const lines = $$('.ln', code);
    const ok = $('.ok', code);
    whileVisible(code, (t) => {
      const c = t % 7;
      lines.forEach((l, i) => {
        const p = clamp01((c - i * 0.7) / 0.6);
        l.style.width = p >= 1 ? 'auto' : `${p * 100}%`;
      });
      ok.classList.toggle('on', c > lines.length * 0.7 + 0.4);
    });
  }
  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  // ---------------------------------------------------------------- 3D: a turning wireframe with labels
  const three = $('#three');
  if (three) {
    const cv = $('canvas', three);
    const g = cv.getContext('2d');
    const labels = $$('.label', three);
    // An icosahedron.
    const f = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, f, 0], [1, f, 0], [-1, -f, 0], [1, -f, 0], [0, -1, f], [0, 1, f], [0, -1, -f], [0, 1, -f], [f, 0, -1], [f, 0, 1], [-f, 0, -1], [-f, 0, 1]];
    const E = [];
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++) {
      const d = Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]);
      if (Math.abs(d - 2) < 0.01) E.push([i, j]);
    }
    whileVisible(three, (t) => {
      const r = three.getBoundingClientRect();
      const dpr = Math.min(2, devicePixelRatio || 1);
      if (cv.width !== Math.round(r.width * dpr)) {
        cv.width = Math.round(r.width * dpr);
        cv.height = Math.round(r.height * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, r.width, r.height);
      const a = t * 0.45;
      const b = 0.5 + Math.sin(t * 0.3) * 0.2;
      const s = Math.min(r.width, r.height) * 0.22;
      const P = V.map(([vx, vy, vz]) => {
        const x1 = vx * Math.cos(a) - vz * Math.sin(a);
        const z1 = vx * Math.sin(a) + vz * Math.cos(a);
        const y1 = vy * Math.cos(b) - z1 * Math.sin(b);
        const z2 = vy * Math.sin(b) + z1 * Math.cos(b);
        const k = 4 / (4 + z2);
        return [r.width / 2 + x1 * s * k, r.height / 2 + y1 * s * k, z2];
      });
      for (const [i, j] of E) {
        const z = (P[i][2] + P[j][2]) / 2;
        g.strokeStyle = `rgba(255,255,255,${0.12 + (1 - (z + 2) / 4) * 0.55})`;
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(P[i][0], P[i][1]);
        g.lineTo(P[j][0], P[j][1]);
        g.stroke();
      }
      for (const p of P) {
        g.fillStyle = `rgba(255,255,255,${0.35 + (1 - (p[2] + 2) / 4) * 0.6})`;
        g.beginPath();
        g.arc(p[0], p[1], 2.2, 0, Math.PI * 2);
        g.fill();
      }
      const step = Math.floor(t / 1.6) % (labels.length + 1);
      labels.forEach((l, i) => l.classList.toggle('on', i < step));
    });
  }

  // ---------------------------------------------------------------- apps: the cursor goes to Send, Keo asks first
  const apps = $('#apps');
  if (apps) {
    const cur = $('.cursor', apps);
    const ask = $('.approve', apps);
    let phase = -1;
    whileVisible(apps, (t) => {
      const r = apps.getBoundingClientRect();
      const ph = Math.floor((t % 6) / 1.5);
      if (ph === phase) return;
      phase = ph;
      const at = [
        [r.width * 0.2, r.height * 0.3],
        [r.width * 0.55, r.height * 0.45],
        [r.width - 70, r.height - 52],
        [r.width - 70, r.height - 52],
      ][ph];
      cur.style.setProperty('--x', `${at[0]}px`);
      cur.style.setProperty('--y', `${at[1]}px`);
      ask.classList.toggle('on', ph === 3);
    });
  }

  // ---------------------------------------------------------------- voice bars
  const bars = $('#bars');
  if (bars) {
    for (let i = 0; i < 28; i++) {
      const b = document.createElement('i');
      const h = 14 + Math.round(Math.abs(Math.sin(i * 0.7)) * 62 + Math.random() * 14);
      b.style.setProperty('--h', `${h}px`);
      b.style.animationDelay = `${(i % 7) * -0.17}s`;
      b.style.animationDuration = `${0.9 + (i % 5) * 0.13}s`;
      bars.append(b);
    }
  }

  // ---------------------------------------------------------------- card glow follows the pointer
  for (const card of $$('[data-glow]'))
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--cx', `${e.clientX - r.left}px`);
      card.style.setProperty('--cy', `${e.clientY - r.top}px`);
    });

  // ---------------------------------------------------------------- the requests marquee
  const ASKS = [
    'Cut the long pauses and add captions',
    'Build a landing page for my bakery',
    'Explain how a plane takes off',
    'Reply to Ada and keep the chat going',
    'Find the three best laptops under ₦900,000',
    'Make this a 30-second TikTok',
    'Sort my downloads by type',
    'Copy the style of this video onto my clips',
    'Draft an email to my landlord',
    'Make a racing game on my city’s streets',
    'What’s on my calendar tomorrow?',
    'Turn these notes into a presentation',
    'How does a jet engine work, in 3D?',
    'Study apple.com and redesign my site in that spirit',
  ];
  const fill = (row, list) => {
    if (!row) return;
    const items = [...list, ...list].map((q) => {
      const s = document.createElement('span');
      s.className = 'q';
      s.textContent = q;
      return s;
    });
    row.append(...items);
  };
  fill($('#row1'), ASKS.slice(0, 7));
  fill($('#row2'), ASKS.slice(7));

  // ---------------------------------------------------------------- the manifesto lights up as you read (scroll)
  const man = $('#manifesto');
  if (man) {
    const words = man.textContent.split(/\s+/).filter(Boolean);
    man.textContent = '';
    const spans = words.map((w) => {
      const s = document.createElement('span');
      s.className = 'w';
      s.textContent = w + ' ';
      man.append(s);
      return s;
    });
    const light = () => {
      const r = man.getBoundingClientRect();
      const p = reduced ? 1 : Math.min(1, Math.max(0, (innerHeight * 0.85 - r.top) / (r.height + innerHeight * 0.35)));
      const n = Math.round(p * spans.length);
      spans.forEach((s, i) => s.classList.toggle('lit', i < n));
    };
    addEventListener('scroll', light, { passive: true });
    light();
  }

  // ---------------------------------------------------------------- numbers count up when seen
  const counters = $$('[data-count]');
  const cio = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      cio.unobserve(e.target);
      const el = e.target;
      const to = Number(el.dataset.count);
      const suffix = el.textContent.replace(/[\d,]/g, '');
      if (reduced || !to) continue;
      const t0 = performance.now();
      const step = (now) => {
        const p = Math.min(1, (now - t0) / 1400);
        const v = Math.round(to * (1 - Math.pow(1 - p, 3)));
        el.textContent = v.toLocaleString('en-US') + suffix;
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.5 });
  counters.forEach((c) => cio.observe(c));

  // ---------------------------------------------------------------- early access
  const form = $('#wl');
  const note = $('#wl-note');
  for (const b of $$('[data-platform]'))
    b.addEventListener('click', () => {
      const r = $(`input[name="platform"][value="${b.dataset.platform}"]`);
      if (r) r.checked = true;
      const email = $('#wl-email');
      document.getElementById('access').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
      setTimeout(() => email && email.focus({ preventScroll: true }), reduced ? 0 : 600);
    });
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = String(new FormData(form).get('email') || '').trim();
      const company = String(new FormData(form).get('company') || '');
      const platform = ($('input[name="platform"]:checked') || {}).value || 'windows';
      const say = (text, kind) => {
        note.textContent = text;
        note.className = `form-note ${kind || ''}`;
      };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return say('Please enter a valid email address.', 'bad');
      const btn = $('button[type="submit"]', form);
      btn.disabled = true;
      say('Adding you…');
      try {
        const r = await fetch('https://cloud.heykeo.com/v1/waitlist', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, platform, source: document.body.dataset.page || 'home', company }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error((j.error && j.error.message) || 'Something went wrong. Please try again.');
        form.reset();
        say('You’re on the list. We’ll email you when your invite is ready.', 'ok');
      } catch (err) {
        say(err instanceof TypeError ? 'Could not reach Keo just now. Please try again.' : err.message, 'bad');
      } finally {
        btn.disabled = false;
      }
    });
  }
})();
