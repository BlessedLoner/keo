/**
 * Keo's effects kit (library "fx"): working, tested code for the moves that make a site feel crafted
 * — film grain, WebGL shader backgrounds, kinetic text, a custom cursor, magnetic buttons, marquees,
 * tilt, parallax, counters, a scroll bar and page transitions — so a build uses them in one line each
 * instead of half-writing them every time. Plain script (window.fx), no other library needed; every
 * effect steps aside for prefers-reduced-motion and touch screens where it makes sense.
 * (Written without backticks or "${", so it can live in this string.)
 */
export const FX_JS = String.raw`/* Keo effects kit (fx) — made by Keo for this site. */
(function () {
  'use strict';
  var reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var touch = window.matchMedia && matchMedia('(hover: none)').matches;
  var all = function (sel) { return typeof sel === 'string' ? Array.prototype.slice.call(document.querySelectorAll(sel)) : sel instanceof Element ? [sel] : Array.prototype.slice.call(sel || []); };
  var css = '';
  var style = null;
  function addCss(text) {
    css += text;
    if (!style) { style = document.createElement('style'); style.setAttribute('data-fx', ''); document.head.appendChild(style); }
    style.textContent = css;
  }
  function onVisible(el, fn, once) {
    if (!('IntersectionObserver' in window)) { fn(el); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { fn(e.target); if (once !== false) io.unobserve(e.target); } });
    }, { threshold: 0.15 });
    io.observe(el);
  }
  function hex(c) {
    var h = String(c || '#000').replace('#', '');
    if (h.length === 3) h = h.split('').map(function (x) { return x + x; }).join('');
    var n = parseInt(h, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  /* Film grain over the whole page. */
  function grain(o) {
    o = o || {};
    var c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483000;opacity:' + (o.opacity == null ? 0.06 : o.opacity) + ';mix-blend-mode:' + (o.blend || 'overlay');
    document.body.appendChild(c);
    var x = c.getContext('2d');
    var size = 160;
    c.width = size; c.height = size;
    var frames = [];
    for (var f = 0; f < 6; f++) {
      var img = x.createImageData(size, size);
      for (var i = 0; i < img.data.length; i += 4) { var v = Math.random() * 255; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255; }
      frames.push(img);
    }
    c.style.imageRendering = 'pixelated';
    var k = 0;
    x.putImageData(frames[0], 0, 0);
    if (!reduced) setInterval(function () { k = (k + 1) % frames.length; x.putImageData(frames[k], 0, 0); }, 1000 / (o.fps || 10));
    return c;
  }

  /* A custom cursor: a dot and a ring that grows over links and buttons. */
  function cursor(o) {
    o = o || {};
    if (touch) return null;
    var color = o.color || '#fff';
    addCss('.fx-cursor,.fx-ring{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483001;border-radius:50%;transform:translate(-50%,-50%);mix-blend-mode:' + (o.blend || 'difference') + '}' +
      '.fx-cursor{width:6px;height:6px;background:' + color + '}' +
      '.fx-ring{width:' + (o.size || 34) + 'px;height:' + (o.size || 34) + 'px;border:1.5px solid ' + color + ';transition:width .25s,height .25s,background .25s}' +
      '.fx-ring.fx-hover{width:' + ((o.size || 34) * 2) + 'px;height:' + ((o.size || 34) * 2) + 'px;background:' + color + '}' +
      (o.hideNative === false ? '' : 'html.fx-has-cursor,html.fx-has-cursor *{cursor:none!important}'));
    document.documentElement.classList.add('fx-has-cursor');
    var dot = document.createElement('div'); dot.className = 'fx-cursor';
    var ring = document.createElement('div'); ring.className = 'fx-ring';
    document.body.appendChild(dot); document.body.appendChild(ring);
    var mx = innerWidth / 2, my = innerHeight / 2, rx = mx, ry = my;
    addEventListener('mousemove', function (e) { mx = e.clientX; my = e.clientY; dot.style.transform = 'translate(' + (mx - 3) + 'px,' + (my - 3) + 'px)'; });
    document.addEventListener('mouseover', function (e) { ring.classList.toggle('fx-hover', !!(e.target.closest && e.target.closest('a,button,[data-cursor],input,textarea,select,label'))); });
    (function loop() { rx += (mx - rx) * 0.18; ry += (my - ry) * 0.18; ring.style.transform = 'translate(' + rx + 'px,' + ry + 'px) translate(-50%,-50%)'; requestAnimationFrame(loop); })();
    dot.style.transform = 'translate(' + mx + 'px,' + my + 'px)';
    dot.style.left = dot.style.top = '0';
    return { dot: dot, ring: ring };
  }

  /* Buttons that lean towards the pointer. */
  function magnetic(sel, strength) {
    if (touch || reduced) return;
    var s = strength == null ? 0.35 : strength;
    all(sel).forEach(function (el) {
      el.style.transition = 'transform .35s cubic-bezier(.2,.8,.2,1)';
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect();
        el.style.transform = 'translate(' + ((e.clientX - r.left - r.width / 2) * s) + 'px,' + ((e.clientY - r.top - r.height / 2) * s) + 'px)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    });
  }

  /* Headings that build themselves word by word (or letter by letter) as they come into view. */
  function splitReveal(sel, o) {
    o = o || {};
    var mode = o.mode || 'words';
    var stagger = o.stagger == null ? (mode === 'chars' ? 0.025 : mode === 'lines' ? 0.12 : 0.06) : o.stagger;
    addCss('.fx-split{display:inline-block;overflow:hidden;vertical-align:top}.fx-split>span{display:inline-block;transform:translateY(105%);opacity:0;transition:transform .9s cubic-bezier(.16,1,.3,1),opacity .9s}.fx-in .fx-split>span{transform:none;opacity:1}');
    all(sel).forEach(function (el) {
      if (el.getAttribute('data-fx-split')) return;
      el.setAttribute('data-fx-split', mode);
      if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', el.textContent.trim());
      var n = 0;
      var walk = function (node) {
        Array.prototype.slice.call(node.childNodes).forEach(function (ch) {
          if (ch.nodeType === 3) {
            var frag = document.createDocumentFragment();
            var parts = mode === 'chars' ? ch.textContent.split('') : ch.textContent.split(/(\s+)/);
            parts.forEach(function (p) {
              if (!p) return;
              if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(p)); return; }
              var outer = document.createElement('span'); outer.className = 'fx-split'; outer.setAttribute('aria-hidden', 'true');
              var inner = document.createElement('span'); inner.textContent = p;
              inner.style.transitionDelay = (reduced ? 0 : n++ * stagger) + 's';
              outer.appendChild(inner); frag.appendChild(outer);
            });
            ch.parentNode.replaceChild(frag, ch);
          } else if (ch.nodeType === 1 && ch.tagName !== 'BR') walk(ch);
        });
      };
      walk(el);
      if (reduced) el.classList.add('fx-in'); else onVisible(el, function (t) { t.classList.add('fx-in'); });
    });
  }

  /* A band of words or logos that scrolls forever. */
  function marquee(sel, o) {
    o = o || {};
    all(sel).forEach(function (el) {
      if (el.getAttribute('data-fx-marquee')) return;
      el.setAttribute('data-fx-marquee', '1');
      el.style.overflow = 'hidden'; el.style.whiteSpace = 'nowrap';
      var track = document.createElement('div');
      track.style.cssText = 'display:inline-flex;gap:' + (o.gap || '3rem') + ';will-change:transform';
      var item = document.createElement('div');
      item.style.cssText = 'display:inline-flex;gap:' + (o.gap || '3rem') + ';flex-shrink:0';
      while (el.firstChild) item.appendChild(el.firstChild);
      track.appendChild(item);
      for (var i = 0; i < 3; i++) { var c = item.cloneNode(true); c.setAttribute('aria-hidden', 'true'); track.appendChild(c); }
      el.appendChild(track);
      var x = 0, last = performance.now(), speed = (o.speed || 60) * (o.reverse ? -1 : 1);
      (function loop(now) {
        var w = item.getBoundingClientRect().width + parseFloat(getComputedStyle(track).gap || 0);
        if (!reduced && w > 0) { x -= speed * (now - last) / 1000; if (x <= -w) x += w; if (x > 0) x -= w; track.style.transform = 'translateX(' + x + 'px)'; }
        last = now;
        requestAnimationFrame(loop);
      })(last);
    });
  }

  /* Cards and pictures that tilt in 3D towards the pointer. */
  function tilt(sel, max) {
    if (touch || reduced) return;
    var m = max == null ? 10 : max;
    all(sel).forEach(function (el) {
      el.style.transformStyle = 'preserve-3d'; el.style.transition = 'transform .4s cubic-bezier(.2,.8,.2,1)';
      el.addEventListener('mousemove', function (e) {
        var r = el.getBoundingClientRect(), px = (e.clientX - r.left) / r.width - 0.5, py = (e.clientY - r.top) / r.height - 0.5;
        el.style.transform = 'perspective(900px) rotateY(' + (px * m) + 'deg) rotateX(' + (-py * m) + 'deg) scale(1.02)';
      });
      el.addEventListener('mouseleave', function () { el.style.transform = ''; });
    });
  }

  /* Layers that move at their own speed as the page scrolls: data-speed="0.2" (or the speed given). */
  function parallax(sel, speed) {
    if (reduced) return;
    var els = all(sel);
    var tick = function () {
      els.forEach(function (el) {
        var r = el.getBoundingClientRect(), s = parseFloat(el.getAttribute('data-speed') || speed || 0.2);
        el.style.transform = 'translate3d(0,' + ((r.top + r.height / 2 - innerHeight / 2) * -s) + 'px,0)';
      });
    };
    addEventListener('scroll', function () { requestAnimationFrame(tick); }, { passive: true });
    tick();
  }

  /* Numbers that count up when seen: <span data-to="2500" data-suffix="+">0</span>. */
  function counter(sel) {
    all(sel).forEach(function (el) {
      var to = parseFloat(el.getAttribute('data-to') || el.textContent.replace(/[^\d.]/g, '')) || 0;
      var dec = (String(el.getAttribute('data-to') || '').split('.')[1] || '').length;
      var pre = el.getAttribute('data-prefix') || '', suf = el.getAttribute('data-suffix') || '';
      var show = function (v) { el.textContent = pre + v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; };
      if (reduced) { show(to); return; }
      show(0);
      onVisible(el, function () {
        var t0 = performance.now(), dur = parseFloat(el.getAttribute('data-duration') || 1.6) * 1000;
        (function step(now) { var k = Math.min(1, (now - t0) / dur); show(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
      });
    });
  }

  /* A thin bar at the top that fills as the page is read. */
  function scrollProgress(o) {
    o = o || {};
    var bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;top:0;height:' + (o.height || 3) + 'px;width:100%;transform-origin:0 50%;transform:scaleX(0);z-index:2147482999;background:' + (o.color || 'currentColor');
    document.body.appendChild(bar);
    var tick = function () { var h = document.documentElement.scrollHeight - innerHeight; bar.style.transform = 'scaleX(' + (h > 0 ? scrollY / h : 0) + ')'; };
    addEventListener('scroll', tick, { passive: true }); tick();
    return bar;
  }

  /* Page changes with a wipe: the next page slides in under a panel of colour. */
  function pageTransitions(o) {
    o = o || {};
    if (reduced) return;
    addCss('.fx-wipe{position:fixed;inset:0;z-index:2147483002;pointer-events:none;background:' + (o.color || '#000') + ';transform:scaleY(1);transform-origin:50% 0;transition:transform .55s cubic-bezier(.76,0,.24,1)}.fx-wipe.fx-out{transform:scaleY(0)}.fx-wipe.fx-cover{transform-origin:50% 100%;transform:scaleY(1)}');
    var w = document.createElement('div'); w.className = 'fx-wipe'; w.setAttribute('aria-hidden', 'true');
    document.body.appendChild(w);
    requestAnimationFrame(function () { requestAnimationFrame(function () { w.classList.add('fx-out'); }); });
    addEventListener('pageshow', function (e) { if (e.persisted) { w.classList.remove('fx-cover'); w.classList.add('fx-out'); } });
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      if (a.target && a.target !== '_self') return;
      if (a.hasAttribute('download') || a.origin !== location.origin) return;
      if (a.pathname === location.pathname && a.hash) return;
      e.preventDefault();
      w.style.transformOrigin = '50% 100%';
      w.classList.remove('fx-out'); w.classList.add('fx-cover');
      setTimeout(function () { location.href = a.href; }, 560);
    });
  }

  /* WebGL backgrounds: "aurora", "liquid", "grid" (retro floor and sun) or "noise" (smoke). */
  var VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  var HEAD = [
    'precision highp float;uniform float t;uniform vec2 r;uniform vec2 m;uniform vec3 c1;uniform vec3 c2;uniform vec3 c3;',
    'float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}',
    'float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}',
    'float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p*=2.02;a*=.5;}return v;}',
  ].join('\n');
  var PRESETS = {
    aurora: 'void main(){vec2 u=gl_FragCoord.xy/r;float a=fbm(vec2(u.x*2.+t*.05,u.y*1.5-t*.03));float b=fbm(vec2(u.x*3.-t*.04,u.y*2.+a));vec3 col=mix(c1,c2,smoothstep(.2,.8,a));col=mix(col,c3,smoothstep(.45,.95,b)*.85);col*=.55+.6*smoothstep(0.,1.,u.y+a*.4);gl_FragColor=vec4(col,1.);}',
    liquid: 'void main(){vec2 u=(gl_FragCoord.xy-.5*r)/r.y;vec2 q=vec2(fbm(u*2.+t*.08),fbm(u*2.+vec2(5.2,1.3)-t*.06));vec2 w=vec2(fbm(u*2.+q*3.+vec2(1.7,9.2)+t*.05),fbm(u*2.+q*3.+vec2(8.3,2.8)));float f=fbm(u*2.+w*2.+(m-.5));vec3 col=mix(c1,c2,clamp(f*f*2.,0.,1.));col=mix(col,c3,clamp(length(q),0.,1.)*.7);gl_FragColor=vec4(col*(.8+.4*f),1.);}',
    grid: 'void main(){vec2 u=gl_FragCoord.xy/r;vec3 col=mix(c1,c1*.4,u.y);float hz=.42;vec2 s=vec2(u.x-.5,u.y-.62);float d=length(s*vec2(r.x/r.y,1.));float sun=smoothstep(.2,.19,d)*step(hz,u.y);float bands=step(.5,fract((u.y-hz)*40.-t*.4))+step(.62,u.y);col=mix(col,mix(c3,c2,smoothstep(.45,.8,u.y)),sun*clamp(bands,0.,1.));if(u.y<hz){float z=1./(hz-u.y+.001);vec2 g=vec2((u.x-.5)*z*.9,z*.6+t*1.6);vec2 l=abs(fract(g)-.5);float line=smoothstep(.06*z*.1+.02,0.,min(l.x,l.y));col=mix(c1*.25,c2,line*clamp((hz-u.y)*3.,0.,1.)+.0);col+=c2*.25*exp(-(hz-u.y)*18.);}gl_FragColor=vec4(col,1.);}',
    noise: 'void main(){vec2 u=gl_FragCoord.xy/r;float f=fbm(u*3.+vec2(t*.03,-t*.02)+fbm(u*4.-t*.02));vec3 col=mix(c1,c2,smoothstep(.3,.75,f));col=mix(col,c3,smoothstep(.65,.95,f)*.6);float v=1.-length(u-.5)*.9;gl_FragColor=vec4(col*v,1.);}',
  };
  function shader(target, o) {
    o = o || {};
    var host = typeof target === 'string' ? document.querySelector(target) : target;
    if (!host) return null;
    var colors = (o.colors || ['#0b0820', '#7b5cff', '#00e0ff']).map(hex);
    var c = host.tagName === 'CANVAS' ? host : document.createElement('canvas');
    if (c !== host) {
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      c.setAttribute('aria-hidden', 'true');
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:0;pointer-events:none;display:block';
      host.insertBefore(c, host.firstChild);
    }
    var gl = c.getContext('webgl', { antialias: false, premultipliedAlpha: false });
    var fallback = function () { (c === host ? c : host).style.background = 'radial-gradient(120% 90% at 20% 10%,' + (o.colors || [])[1] + ',transparent 60%),radial-gradient(100% 80% at 90% 80%,' + (o.colors || [])[2] + ',transparent 60%),' + (o.colors || ['#000'])[0]; };
    if (!gl) { fallback(); return null; }
    var mk = function (type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('fx.shader: ' + gl.getShaderInfoLog(s)); return s; };
    var prog = gl.createProgram();
    gl.attachShader(prog, mk(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, mk(gl.FRAGMENT_SHADER, HEAD + '\n' + (PRESETS[o.preset] || PRESETS.aurora)));
    gl.linkProgram(prog); gl.useProgram(prog);
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = function (name) { return gl.getUniformLocation(prog, name); };
    gl.uniform3fv(U('c1'), colors[0]); gl.uniform3fv(U('c2'), colors[1] || colors[0]); gl.uniform3fv(U('c3'), colors[2] || colors[1] || colors[0]);
    var mouse = [0.5, 0.5];
    addEventListener('mousemove', function (e) { mouse = [e.clientX / innerWidth, 1 - e.clientY / innerHeight]; });
    var scale = Math.min(window.devicePixelRatio || 1, 1.5) * (o.quality || 0.75);
    var size = function () { c.width = Math.max(1, Math.round(c.clientWidth * scale)); c.height = Math.max(1, Math.round(c.clientHeight * scale)); gl.viewport(0, 0, c.width, c.height); };
    size(); addEventListener('resize', size);
    var t0 = performance.now(), speed = o.speed || 1, visible = true;
    if ('IntersectionObserver' in window) new IntersectionObserver(function (e) { visible = e[0].isIntersecting; }).observe(c);
    var draw = function (now) {
      gl.uniform1f(U('t'), reduced ? 8 : (now - t0) / 1000 * speed);
      gl.uniform2f(U('r'), c.width, c.height); gl.uniform2f(U('m'), mouse[0], mouse[1]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    (function loop(now) { if (visible) draw(now); if (!reduced) requestAnimationFrame(loop); })(t0);
    if (reduced) draw(t0);
    return c;
  }

  /* Wire effects from attributes: data-fx="split|split-chars|split-lines|marquee|magnetic|tilt|parallax|counter". */
  function auto() {
    splitReveal('[data-fx="split"]'); splitReveal('[data-fx="split-chars"]', { mode: 'chars' }); splitReveal('[data-fx="split-lines"]', { mode: 'lines' });
    marquee('[data-fx="marquee"]'); magnetic('[data-fx="magnetic"]'); tilt('[data-fx="tilt"]'); parallax('[data-fx="parallax"]'); counter('[data-fx="counter"]');
  }

  window.fx = { grain: grain, cursor: cursor, magnetic: magnetic, splitReveal: splitReveal, marquee: marquee, tilt: tilt, parallax: parallax, counter: counter, scrollProgress: scrollProgress, pageTransitions: pageTransitions, shader: shader, auto: auto, reduced: reduced, version: 1 };
})();
`;

export const FX_USAGE =
  '<script src="/lib/fx/fx.js"></script> (a plain script: no module, no other library needed), then in your own script once the page is ready: ' +
  'fx.grain({opacity:0.06}) film grain; fx.shader("#hero", {preset:"aurora"|"liquid"|"grid"|"noise", colors:["#0b0820","#7b5cff","#00e0ff"]}) a moving WebGL background inside that element (put its content above with position:relative; z-index:1); ' +
  'fx.splitReveal("h1, h2", {mode:"words"|"chars"|"lines"}) headings build themselves as they come into view; fx.cursor({color:"#fff"}) a custom cursor that grows over links; fx.magnetic(".btn") buttons lean to the pointer; ' +
  'fx.marquee(".ticker", {speed:60}) an endless band; fx.tilt(".card", 10) 3D tilt to the pointer; fx.parallax("[data-speed]") layers move at data-speed; fx.counter("[data-to]") numbers count up (data-to, data-prefix, data-suffix); ' +
  'fx.scrollProgress({color:"#ff3b00"}) a reading bar; fx.pageTransitions({color:"#111"}) a colour wipe between pages; or fx.auto() for data-fx="split|split-chars|split-lines|marquee|magnetic|tilt|parallax|counter" attributes. All respect reduced motion.';
