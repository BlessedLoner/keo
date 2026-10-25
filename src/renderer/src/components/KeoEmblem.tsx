import { useEffect, useId, useRef } from 'react';
import { levelBus } from '../lib/levelBus';

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
  /** Where the live level comes from (default: this window's own microphone/playback analysers). */
  level?: () => number;
  title?: string;
}

/**
 * Keo's identity: a small glossy robot head with a dark visor and two glowing pixel eyes.
 * The eyes are Keo's state — they wander and blink when idle, turn cyan and grow with the real
 * microphone level while listening, bounce with the real playback level while speaking, narrow
 * and scan while thinking or acting, and turn amber when Keo needs the user. Drawn as vectors so
 * it stays sharp from a 16 px badge to the welcome screen.
 */
export function KeoEmblem({ state, size = 160, live = true, level = levelBus.get, title }: Props) {
  const uid = useId().replace(/:/g, '');
  const ref = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!live) return;
    const el = ref.current;
    if (!el) return;
    let smoothed = 0;
    let raf = 0;
    const tick = () => {
      const target = state === 'listening' || state === 'speaking' ? level() : 0;
      smoothed += (target - smoothed) * 0.35;
      el.style.setProperty('--lvl', smoothed.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state, live, level]);

  const compact = size < 56;
  const id = (n: string) => `${n}-${uid}`;
  const label = title ?? `Keo — ${STATE_LABEL[state]}`;

  return (
    <svg ref={ref} className={`keo-emblem state-${state}${compact ? ' compact' : ''}`} width={size} height={size} viewBox="0 0 200 200" role="img" aria-label={label}>
      <defs>
        <linearGradient id={id('shell')} x1="0.25" y1="0" x2="0.65" y2="1">
          <stop offset="0%" stopColor="#4a4d55" />
          <stop offset="22%" stopColor="#24262b" />
          <stop offset="60%" stopColor="#111215" />
          <stop offset="100%" stopColor="#060607" />
        </linearGradient>
        <radialGradient id={id('sheen')} cx="30%" cy="18%" r="55%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('screen')} cx="45%" cy="40%" r="75%">
          <stop offset="0%" stopColor="#15161b" />
          <stop offset="100%" stopColor="#040405" />
        </radialGradient>
        <linearGradient id={id('ear')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2e3036" />
          <stop offset="100%" stopColor="#09090a" />
        </linearGradient>
        <pattern id={id('grid')} width="11" height="11" patternUnits="userSpaceOnUse">
          <path d="M11 0H0V11" fill="none" stroke="#ffffff" strokeOpacity="0.045" strokeWidth="0.8" />
        </pattern>
        <clipPath id={id('visor')}>
          <rect x="47" y="55" width="110" height="92" rx="27" />
        </clipPath>
        <filter id={id('glow')} x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id={id('soft')} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
      </defs>

      {/* The light around Keo (state colour) and its shadow */}
      <ellipse className="ke-aura" cx="102" cy="100" rx="82" ry="74" filter={`url(#${id('soft')})`} />
      {!compact && <ellipse className="ke-shadow" cx="102" cy="184" rx="56" ry="6" filter={`url(#${id('soft')})`} />}

      <g className="ke-head">
        {/* Side "ear" */}
        <rect x="15" y="84" width="17" height="32" rx="5" fill={`url(#${id('ear')})`} />
        {/* Glossy shell */}
        <rect x="25" y="32" width="154" height="136" rx="46" fill={`url(#${id('shell')})`} />
        <rect x="25" y="32" width="154" height="136" rx="46" fill={`url(#${id('sheen')})`} />
        <rect className="ke-rim" x="25.8" y="32.8" width="152.4" height="134.4" rx="45.2" fill="none" />
        {/* Visor */}
        <rect x="40" y="48" width="124" height="106" rx="33" fill="#08080a" stroke="#2c2e33" strokeWidth="2.4" />
        <rect x="47" y="55" width="110" height="92" rx="27" fill={`url(#${id('screen')})`} />
        <g clipPath={`url(#${id('visor')})`}>
          <rect x="47" y="55" width="110" height="92" fill={`url(#${id('grid')})`} />
          <rect className="ke-scanline" x="47" y="55" width="110" height="10" />
          {/* Eyes: two glowing pixels */}
          <g className="ke-eyes" filter={`url(#${id('glow')})`}>
            <g className="ke-look">
              <rect className="ke-eye l" x="73" y="86" width="20" height="23" rx="3" />
              <rect className="ke-eye r" x="111" y="86" width="20" height="23" rx="3" />
            </g>
          </g>
          {/* Glass glare */}
          <path d="M60 55 L96 55 L64 147 L47 147 Z" fill="#ffffff" opacity="0.035" />
        </g>
      </g>
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
