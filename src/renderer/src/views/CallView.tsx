import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import type { EmblemState } from '../components/KeoEmblem';
import { invoke } from '../lib/api';
import { levelBus } from '../lib/levelBus';
import { startSphere } from '../presence/voiceSphere';
import { useUi } from '../components/ui';
import { useApp } from '../state/AppState';

/**
 * A call with Keo: the voice sphere fills the view, a hands-free voice conversation runs while the
 * call is on, and captions show what was heard and said. This window is the one that records and
 * speaks, so the sphere reads the real audio level directly.
 */
const TINT: Partial<Record<EmblemState, [number, number, number]>> = {
  idle: [0.86, 0.9, 1],
  listening: [0.42, 0.88, 1],
  speaking: [0.92, 0.95, 1],
  thinking: [0.66, 0.68, 1],
  understanding: [0.66, 0.68, 1],
  planning: [0.66, 0.68, 1],
  verifying: [0.66, 0.68, 1],
  acting: [0.5, 0.8, 1],
  working: [0.5, 0.8, 1],
  awaiting_approval: [1, 0.76, 0.36],
  attention: [1, 0.76, 0.36],
  error: [1, 0.42, 0.48],
  cancelled: [0.55, 0.57, 0.62],
};

export function CallView() {
  const app = useApp();
  const ui = useUi();
  const p = app.presence;
  const vm = p?.voiceMode;
  const inCall = !!vm?.active;
  const state = app.emblem;
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ state, voice: 'off', pointer: [0, 0] as [number, number] });
  live.current.state = state;
  live.current.voice = inCall ? vm!.state : 'off';
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // The call's clock.
  useEffect(() => {
    if (inCall) setSince((s) => s ?? Date.now());
    else setSince(null);
  }, [inCall]);
  useEffect(() => {
    if (!since) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onMove = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      live.current.pointer = [((e.clientX - r.left) / r.width - 0.5) * 2, ((e.clientY - r.top) / r.height - 0.5) * 2];
    };
    window.addEventListener('pointermove', onMove);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stop = startSphere(c, {
      energy: () => {
        const { state: st, voice } = live.current;
        if (voice === 'listening' || voice === 'speaking' || st === 'listening' || st === 'speaking') return Math.min(1, 0.12 + levelBus.get() * 1.6);
        if (voice === 'thinking' || st === 'thinking' || st === 'understanding' || st === 'planning' || st === 'verifying') return 0.16 + Math.sin(performance.now() / 420) * 0.07;
        if (st === 'acting' || st === 'working') return 0.14;
        return reduce ? 0 : 0.035;
      },
      tint: () => TINT[live.current.state] ?? TINT.idle!,
      pointer: () => live.current.pointer,
    });
    return () => {
      window.removeEventListener('pointermove', onMove);
      stop();
    };
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      await invoke(inCall ? 'voice:modeStop' : 'voice:modeStart', {});
    } catch (e) {
      ui.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const secs = since ? Math.max(0, Math.floor((now - since) / 1000)) : 0;
  const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  const mode = inCall ? vm!.state : 'off';
  const word = !inCall ? 'Call Keo' : mode === 'listening' ? 'Listening' : mode === 'speaking' ? 'Speaking' : mode === 'confirming' ? 'Yes or no?' : 'Thinking';
  // One line at most: what Keo just said (or what it heard), never a wall of text.
  const last = inCall ? (mode === 'speaking' && vm!.said ? vm!.said : vm!.heard ? `“${vm!.heard}”` : null) : null;

  return (
    <div className={`callview ${inCall ? 'on' : 'off'} state-${state} mode-${mode}`}>
      <div className="cv-bg" aria-hidden="true" />
      <div className="cv-halo" aria-hidden="true" />
      <canvas ref={canvas} className="cv-sphere" aria-hidden="true" />
      <header className="cv-top">
        {inCall ? (
          <div className="cv-pill">
            <span className="cv-dot live" aria-hidden="true" />
            <span className="cv-clock">{clock}</span>
          </div>
        ) : (
          <span />
        )}
        <button className="cv-ghost" title="Full screen" aria-label="Full screen" onClick={() => void invoke('call:fullscreen', {})}>
          <Icon name="expand" size={15} />
        </button>
      </header>
      <div className="cv-center" role="status" aria-live="polite">
        <div className="cv-big" key={word}>
          {word}
        </div>
        <Wave active={inCall && (mode === 'listening' || mode === 'speaking')} />
        <div className={`cv-last ${last ? 'on' : ''}`} key={last ?? 'none'} title={last ?? undefined}>
          {last ?? ' '}
        </div>
      </div>
      <footer className="cv-dock">
        <button className={`cv-call ${inCall ? 'end' : 'start'}`} disabled={busy} onClick={() => void toggle()} aria-label={inCall ? 'End the call' : 'Start a call'} title={inCall ? 'End the call (or say “hang up”)' : 'Start a call (or say “call Keo”)'}>
          <span className="cv-ring" aria-hidden="true" />
          <Icon name={inCall ? 'phone' : 'mic'} size={24} />
        </button>
      </footer>
    </div>
  );
}

/** The voice as bars: they follow the real audio level while Keo listens or speaks, and rest otherwise. */
function Wave({ active }: { active: boolean }) {
  const holder = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const bars = [...el.children] as HTMLElement[];
    let raf = 0;
    const tick = () => {
      const t = performance.now() / 1000;
      const lv = active ? Math.min(1, levelBus.get() * 1.8) : 0;
      bars.forEach((b, i) => {
        const shape = 0.55 + 0.45 * Math.sin(i * 0.9 + t * 6);
        const mid = 1 - Math.abs(i - (bars.length - 1) / 2) / (bars.length / 2);
        const h = 0.08 + (active ? 0.12 + lv * 0.9 * shape * (0.4 + mid * 0.6) : 0.04 * shape);
        b.style.transform = `scaleY(${Math.min(1, h)})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return (
    <div className={`cv-wave ${active ? 'on' : ''}`} ref={holder} aria-hidden="true">
      {Array.from({ length: 28 }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
