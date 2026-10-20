import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
import { STATE_LABEL } from '../components/KeoEmblem';
import keoArt from '../assets/keo.webp';
import { invoke } from '../lib/api';
import { emblemFor, usePresence } from '../lib/presence';

/**
 * Keo mode: Keo in full screen. The character floats in depth (it follows the mouse a little),
 * holographic rings turn around it, glass cards drift past, snow falls. The chest light and rings
 * follow Keo's real state (listening, thinking, speaking); captions show the conversation.
 */
const CARDS = [
  { icon: 'chat', x: -36, y: -18, z: 140, d: 0 },
  { icon: 'memory', x: 34, y: -24, z: 90, d: 1.4 },
  { icon: 'folder', x: 38, y: 16, z: 160, d: 2.6 },
  { icon: 'search', x: -40, y: 20, z: 110, d: 3.7 },
  { icon: 'settings', x: 44, y: -2, z: 60, d: 4.9 },
];

/**
 * Keo's open eyes over the art's closed ones (eyes at 377,434 and 476,421 of the 880×1168 art, the
 * head tilted about 7°): the lids are covered with skin, and glossy eyes look toward the mouse
 * (the scene's --px/--py) and blink now and then.
 */
function KeoEyes() {
  const eye = (cx: number, cy: number, key: string) => (
    <g key={key} transform={`translate(${cx} ${cy}) rotate(-7.5)`}>
      <ellipse className="ke2-skin" rx="30" ry="15" cy="1" />
      <g className="ke2-eye">
        <clipPath id={`ke2-clip-${key}`}>
          <path d="M-22 1 C-14 -14 14 -15 22 -1 C14 10 -14 11 -22 1 Z" />
        </clipPath>
        <path className="ke2-white" d="M-22 1 C-14 -14 14 -15 22 -1 C14 10 -14 11 -22 1 Z" />
        <g clipPath={`url(#ke2-clip-${key})`}>
          <g className="ke2-look">
            <circle className="ke2-iris" r="10.5" />
            <circle className="ke2-iris-in" r="7" />
            <circle className="ke2-pupil" r="4.2" />
            <circle className="ke2-shine" cx="-3.5" cy="-4" r="2.6" />
            <circle className="ke2-shine small" cx="3.6" cy="3" r="1.2" />
          </g>
        </g>
        <path className="ke2-lash" d="M-24 2 C-15 -16 15 -17 24 -2" />
        <path className="ke2-lash-tip" d="M20 -6 L27 -9" />
      </g>
    </g>
  );
  return (
    <svg className="km-eyes" viewBox="0 0 880 1168" aria-hidden="true">
      <defs>
        <radialGradient id="ke2-skin-g" cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#f3e2e0" />
          <stop offset="70%" stopColor="#eed8d6" />
          <stop offset="100%" stopColor="#eed8d6" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="ke2-iris-g" cx="50%" cy="35%" r="70%">
          <stop offset="0%" stopColor="#7d8798" />
          <stop offset="55%" stopColor="#2b2f3a" />
          <stop offset="100%" stopColor="#0b0c10" />
        </radialGradient>
      </defs>
      {eye(377, 434, 'l')}
      {eye(476, 421, 'r')}
    </svg>
  );
}

export function KeoModeApp() {
  const p = usePresence();
  const state = emblemFor(p);
  const vm = p?.voiceMode;
  const scene = useRef<HTMLDivElement>(null);
  const snow = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    document.documentElement.classList.add('keomode-root');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('keomode:close', {});
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Depth: the scene tilts toward the mouse (smoothed); a slow sway when the mouse is still.
  useEffect(() => {
    const el = scene.current;
    if (!el) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let tx = 0;
    let ty = 0;
    let x = 0;
    let y = 0;
    let raf = 0;
    const move = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth - 0.5) * 2;
      ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    const tick = (t: number) => {
      const sway = reduce ? 0 : Math.sin(t / 3200) * 0.18;
      x += (tx + sway - x) * 0.05;
      y += (ty - y) * 0.05;
      el.style.setProperty('--rx', `${(-y * 7).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(x * 10).toFixed(2)}deg`);
      el.style.setProperty('--px', x.toFixed(3));
      el.style.setProperty('--py', y.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener('pointermove', move);
    raf = requestAnimationFrame(tick);
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(raf);
    };
  }, []);

  // Snow in three depths.
  useEffect(() => {
    const c = snow.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = () => {
      c.width = window.innerWidth * dpr;
      c.height = window.innerHeight * dpr;
    };
    size();
    window.addEventListener('resize', size);
    const flakes = Array.from({ length: reduce ? 40 : 140 }, () => ({ x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7, w: Math.random() * Math.PI * 2 }));
    let raf = 0;
    let last = performance.now();
    const tick = (t: number) => {
      const dt = Math.min(50, t - last) / 1000;
      last = t;
      g.clearRect(0, 0, c.width, c.height);
      for (const f of flakes) {
        if (!reduce) {
          f.y += dt * 0.03 * f.z;
          f.w += dt * 0.6;
          f.x += Math.sin(f.w) * 0.0004 * f.z;
          if (f.y > 1.02) {
            f.y = -0.02;
            f.x = Math.random();
          }
        }
        g.globalAlpha = 0.25 + f.z * 0.55;
        g.fillStyle = '#eaf3ff';
        g.beginPath();
        g.arc(f.x * c.width, f.y * c.height, (0.6 + f.z * 2.2) * dpr, 0, Math.PI * 2);
        g.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', size);
    };
  }, []);

  const caption = vm?.active ? (vm.state === 'speaking' && vm.said ? vm.said : vm.heard ? `“${vm.heard}”` : null) : null;
  const line =
    !vm?.active ? 'Tap the microphone or say the wake word to talk' : vm.state === 'listening' ? 'Listening…' : vm.state === 'speaking' ? 'Speaking' : vm.state === 'confirming' ? 'Say yes or no' : 'Thinking…';

  return (
    <div className={`keomode state-${state} ${vm?.active ? `voice-${vm.state}` : 'voice-off'}`}>
      <canvas ref={snow} className="km-snow" aria-hidden="true" />
      <div className="km-vignette" aria-hidden="true" />
      <div className="km-scene" ref={scene} aria-hidden="true">
        <div className="km-glow" />
        <div className="km-rings">
          <div className="km-ring r1" />
          <div className="km-ring r2" />
          <div className="km-ring r3" />
        </div>
        <div className="km-figure">
          <img className="km-img" src={keoArt} alt="" draggable={false} />
          <KeoEyes />
          <div className="km-core" />
        </div>
        <div className="km-cards">
          {CARDS.map((c, i) => (
            <div key={i} className="km-card" style={{ '--cx': `${c.x}vmin`, '--cy': `${c.y}vmin`, '--cz': `${c.z}px`, animationDelay: `${-c.d}s` } as React.CSSProperties}>
              <Icon name={c.icon} size={18} />
            </div>
          ))}
        </div>
        <div className="km-floor" />
      </div>

      <header className="km-top">
        <div className="km-brand">
          <span className="km-dot" />
          KEO <span>mode</span>
        </div>
        <button className="km-x" aria-label="Close Keo mode" title="Close (Esc)" onClick={() => void invoke('keomode:close', {})}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <footer className="km-bottom" role="status" aria-live="polite">
        <div className="km-state">{STATE_LABEL[state]}</div>
        {caption && <div className="km-caption">{caption}</div>}
        <div className="km-line">{line}</div>
        <button
          className={`km-mic ${vm?.active ? 'live' : ''}`}
          aria-label={vm?.active ? 'End the voice conversation' : 'Talk to Keo'}
          title={vm?.active ? 'End the voice conversation' : 'Talk to Keo'}
          onClick={() => void invoke(vm?.active ? 'voice:modeStop' : 'voice:modeStart', {})}
        >
          <Icon name={vm?.active ? 'stop' : 'mic'} size={20} />
        </button>
      </footer>
    </div>
  );
}
