import { useEffect, useRef } from 'react';
import { Icon } from '../components/Icon';
import { KeoEmblem, STATE_LABEL, type EmblemState } from '../components/KeoEmblem';
import { invoke } from '../lib/api';
import { emblemFor, listenRelayedLevel, relayedLevel, usePresence } from '../lib/presence';
import { startSphere } from './voiceSphere';

/**
 * Keo mode: Keo as a living sphere of light in full screen. The sphere breathes when Keo is idle,
 * ripples with the real voice level while the user speaks or Keo answers, and pulses slowly while
 * Keo thinks; its rim takes Keo's state colour. Captions show the conversation.
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

export function KeoModeApp() {
  const p = usePresence();
  const state = emblemFor(p);
  const vm = p?.voiceMode;
  const canvas = useRef<HTMLCanvasElement>(null);
  // Read every frame by the sphere without re-rendering React.
  const live = useRef({ state, voice: vm?.state ?? 'off', pointer: [0, 0] as [number, number] });
  live.current.state = state;
  live.current.voice = vm?.active ? vm.state : 'off';

  useEffect(() => {
    document.documentElement.classList.add('keomode-root');
    listenRelayedLevel();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('keomode:close', {});
    };
    const onMove = (e: PointerEvent) => {
      live.current.pointer = [(e.clientX / window.innerWidth - 0.5) * 2, (e.clientY / window.innerHeight - 0.5) * 2];
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('pointermove', onMove);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointermove', onMove);
    };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return startSphere(c, {
      energy: () => {
        const { state: st, voice } = live.current;
        const lvl = relayedLevel();
        if (voice === 'listening' || voice === 'speaking' || st === 'listening' || st === 'speaking') return Math.min(1, 0.12 + lvl * 1.6);
        if (st === 'thinking' || st === 'understanding' || st === 'planning' || st === 'verifying' || voice === 'thinking') return 0.16 + Math.sin(performance.now() / 420) * 0.07;
        if (st === 'acting' || st === 'working') return 0.14;
        return reduce ? 0 : 0.035;
      },
      tint: () => TINT[live.current.state] ?? TINT.idle!,
      pointer: () => live.current.pointer,
    });
  }, []);

  const caption = vm?.active ? (vm.state === 'speaking' && vm.said ? vm.said : vm.heard ? `“${vm.heard}”` : null) : null;
  const line = !vm?.active ? 'Tap the microphone or say the wake word' : vm.state === 'listening' ? 'Listening…' : vm.state === 'speaking' ? 'Speaking' : vm.state === 'confirming' ? 'Say yes or no' : 'Thinking…';

  return (
    <div className={`keomode state-${state} ${vm?.active ? `voice-${vm.state}` : 'voice-off'}`}>
      <div className="km-bg" aria-hidden="true" />
      <canvas ref={canvas} className="km-sphere" aria-hidden="true" />

      <header className="km-top">
        <div className="km-brand">
          <KeoEmblem state={state} size={26} level={relayedLevel} />
          <span>Keo</span>
        </div>
        <button className="km-x" aria-label="Close Keo mode" title="Close (Esc)" onClick={() => void invoke('keomode:close', {})}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <footer className="km-bottom" role="status" aria-live="polite">
        <div className="km-state">{STATE_LABEL[state]}</div>
        <div className={`km-caption ${caption ? 'on' : ''}`}>{caption ?? ' '}</div>
        <div className="km-line">{line}</div>
        <button
          className={`km-mic ${vm?.active ? 'live' : ''}`}
          aria-label={vm?.active ? 'End the voice conversation' : 'Talk to Keo'}
          title={vm?.active ? 'End the voice conversation' : 'Talk to Keo'}
          onClick={() => void invoke(vm?.active ? 'voice:modeStop' : 'voice:modeStart', {})}
        >
          <span className="km-mic-ring" aria-hidden="true" />
          <Icon name={vm?.active ? 'stop' : 'mic'} size={20} />
        </button>
      </footer>
    </div>
  );
}
