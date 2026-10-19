import { useEffect, useId, useRef } from 'react';
import { levelBus } from '../lib/levelBus';
import keoArt from '../assets/keo.webp';

export type EmblemState =
  | 'idle'
  | 'listening'
  | 'understanding'
  | 'planning'
  | 'acting'
  | 'verifying'
  | 'awaiting_approval'
  | 'speaking'
  | 'cancelled'
  | 'error'
  // legacy aliases kept for existing call sites
  | 'thinking'
  | 'working'
  | 'attention';

interface Props {
  state: EmblemState;
  size?: number;
  /** Subscribe to live audio level (0..1) for listening/speaking states. */
  live?: boolean;
  title?: string;
}

/**
 * Keo's animated identity: Keo's character portrait inside a segmented halo. Visual state is driven by real application events
 * (passed in as `state`); audio-reactive motion reads the shared level bus,
 * which is only fed by a real microphone analyser or real playback analyser.
 */
export function KeoEmblem({ state, size = 160, live = true, title }: Props) {
  const uid = useId().replace(/:/g, '');
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (!el) return;
    let smoothed = 0;
    let raf = 0;
    const tick = () => {
      const target = state === 'listening' || state === 'speaking' ? levelBus.get() : 0;
      smoothed += (target - smoothed) * 0.35;
      el.style.setProperty('--lvl', smoothed.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, live]);

  const compact = size < 56;
  const id = (n: string) => `${n}-${uid}`;
  const label = title ?? `Keo — ${STATE_LABEL[state]}`;

  return (
    <svg
      ref={ref}
      className={`keo-emblem state-${state}${compact ? ' compact' : ''}`}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      role="img"
      aria-label={label}
    >
      <defs>
        <radialGradient id={id('bg')} cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#141a26" />
          <stop offset="70%" stopColor="#0b0e15" />
          <stop offset="100%" stopColor="#07090d" />
        </radialGradient>
        <linearGradient id={id('skin')} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#5b6577" />
          <stop offset="28%" stopColor="#2a303c" />
          <stop offset="70%" stopColor="#141820" />
          <stop offset="100%" stopColor="#0b0d12" />
        </linearGradient>
        <linearGradient id={id('rim')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--keo-a2)" stopOpacity="0.9" />
          <stop offset="50%" stopColor="var(--keo-a1)" stopOpacity="0.15" />
          <stop offset="100%" stopColor="var(--keo-a1)" stopOpacity="0.9" />
        </linearGradient>
        <linearGradient id={id('collar')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3a4150" />
          <stop offset="100%" stopColor="#0d1016" />
        </linearGradient>
        <filter id={id('glow')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={id('soft')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <radialGradient id={id('vignette')} cx="50%" cy="45%" r="55%">
          <stop offset="70%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </radialGradient>
        <clipPath id={id('disc')}>
          <circle cx="100" cy="98" r="72" />
        </clipPath>
      </defs>

      {/* Ambient glow behind everything */}
      <circle className="ke-aura" cx="100" cy="98" r="80" fill="var(--keo-a1)" filter={`url(#${id('soft')})`} />

      {/* Halo: ticks + rotating segmented arcs */}
      <g className="ke-halo">
        {!compact && <circle className="ke-ticks" cx="100" cy="98" r="91" fill="none" stroke="var(--keo-a1)" strokeWidth="2.5" strokeDasharray="1 5.1" />}
        <g className="ke-spin-a">
          <circle cx="100" cy="98" r="84" fill="none" stroke={`url(#${id('rim')})`} strokeWidth="3" strokeDasharray="120 40 60 308" strokeLinecap="round" />
        </g>
        <g className="ke-spin-b">
          <circle cx="100" cy="98" r="78" fill="none" stroke="var(--keo-a2)" strokeOpacity="0.85" strokeWidth="1.6" strokeDasharray="70 420" strokeLinecap="round" filter={`url(#${id('glow')})`} />
          <circle cx="100" cy="98" r="78" fill="none" stroke="var(--keo-a1)" strokeOpacity="0.85" strokeWidth="1.6" strokeDasharray="40 450" strokeDashoffset="-245" strokeLinecap="round" filter={`url(#${id('glow')})`} />
        </g>
        <circle className="ke-pulse" cx="100" cy="98" r="86" fill="none" stroke="var(--keo-a1)" strokeWidth="1.5" />
      </g>

      {/* Keo's portrait in the inner disc (the character art), with a soft rim for depth */}
      <circle cx="100" cy="98" r="72" fill="#0a0a0c" />
      <image className="ke-portrait" href={keoArt} x="-58" y="-25" width="322" height="423" preserveAspectRatio="none" clipPath={`url(#${id('disc')})`} />
      <circle cx="100" cy="98" r="72" fill={`url(#${id('vignette')})`} />
      <circle className="ke-rim" cx="100" cy="98" r="72" fill="none" stroke="var(--keo-a1)" strokeOpacity="0.55" strokeWidth="1.4" />
      <g className="ke-scan" clipPath={`url(#${id('disc')})`}>
        <rect x="28" y="20" width="144" height="10" fill="var(--keo-a1)" opacity="0.18" />
      </g>

      {/* Chest core: glows with the real voice level while listening/speaking */}
      <g className="ke-core">
        <circle cx="100" cy="176" r="5.5" fill="#0b0b0e" stroke="var(--keo-a1)" strokeWidth="1.5" filter={`url(#${id('glow')})`} />
        <circle cx="100" cy="176" r="2.3" fill="var(--keo-a1)" />
      </g>
      <g className="ke-voice" fill="var(--keo-a1)">
        {[-22, -16, 16, 22].map((dx, i) => (
          <rect key={dx} className={`ke-bar b${i}`} x={99 + dx} y="171" width="2" height="10" rx="1" />
        ))}
      </g>

      {/* Base ring */}
      {!compact && <ellipse cx="100" cy="182" rx="56" ry="6" fill="none" stroke="var(--keo-a1)" strokeOpacity="0.35" strokeWidth="1" />}
    </svg>
  );
}

export const STATE_LABEL: Record<EmblemState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  understanding: 'Understanding',
  planning: 'Planning',
  acting: 'Acting',
  verifying: 'Verifying',
  awaiting_approval: 'Needs your approval',
  speaking: 'Speaking',
  cancelled: 'Stopped',
  error: 'Something went wrong',
  thinking: 'Thinking',
  working: 'Working',
  attention: 'Needs your approval',
};
