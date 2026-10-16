import { useEffect, useId, useRef } from 'react';
import { levelBus } from '../lib/levelBus';

export type EmblemState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'working' | 'attention' | 'error';

interface Props {
  state: EmblemState;
  size?: number;
  /** Subscribe to live audio level (0..1) for listening/speaking states. */
  live?: boolean;
  title?: string;
}

/**
 * Keo's animated identity: an original vector emblem of a sleek robotic head
 * inside a segmented halo. Visual state is driven by real application events
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

      {/* Inner disc with circuit traces */}
      <circle cx="100" cy="98" r="72" fill={`url(#${id('bg')})`} stroke="#1d2433" strokeWidth="1" />
      {!compact && (
        <g clipPath={`url(#${id('disc')})`} className="ke-circuit-bg" fill="none" stroke="var(--keo-a2)" strokeWidth="0.7" strokeOpacity="0.35">
          <path d="M34 70 H54 L62 78 V112 M40 124 H58 L66 132 M166 70 H146 L138 78 V112 M160 124 H142 L134 132 M46 92 H58 M154 92 H142" />
          <circle cx="34" cy="70" r="1.6" fill="var(--keo-a2)" />
          <circle cx="166" cy="70" r="1.6" fill="var(--keo-a1)" />
          <circle cx="40" cy="124" r="1.4" fill="var(--keo-a1)" />
          <circle cx="160" cy="124" r="1.4" fill="var(--keo-a2)" />
        </g>
      )}
      <g className="ke-scan" clipPath={`url(#${id('disc')})`}>
        <rect x="28" y="20" width="144" height="10" fill="var(--keo-a1)" opacity="0.18" />
      </g>

      {/* Shoulders / collar */}
      <path d="M58 172 C64 150 82 146 100 147 C118 146 136 150 142 172 Z" fill={`url(#${id('collar')})`} stroke="#4a5263" strokeWidth="0.8" />
      <path d="M86 150 L100 166 L114 150" fill="none" stroke="var(--keo-a1)" strokeWidth="1.2" strokeOpacity="0.8" filter={`url(#${id('glow')})`} />
      <g className="ke-core">
        <circle cx="100" cy="166" r="6.5" fill="#0b0e14" stroke="var(--keo-a1)" strokeWidth="1.6" filter={`url(#${id('glow')})`} />
        <circle cx="100" cy="166" r="2.6" fill="var(--keo-a1)" />
      </g>

      {/* Head */}
      <g className="ke-head">
        <path
          d="M100 34 C129 34 137 58 136 82 C135 103 129 121 117 136 C111 144 106 148 100 148 C94 148 89 144 83 136 C71 121 65 103 64 82 C63 58 71 34 100 34 Z"
          fill={`url(#${id('skin')})`}
          stroke="#56607a"
          strokeWidth="0.8"
        />
        {/* Specular highlight */}
        <path d="M80 44 C88 37 104 36 112 40 C100 41 88 46 80 58 Z" fill="#ffffff" opacity="0.14" />
        {/* Facial plates */}
        <path d="M70 96 C76 112 86 128 100 134 C114 128 124 112 130 96" fill="none" stroke="#000" strokeOpacity="0.35" strokeWidth="1" />
        {/* Forehead circuit */}
        <g className="ke-circuit" fill="none" stroke="var(--keo-a1)" strokeWidth="1.3" strokeLinecap="round" filter={`url(#${id('glow')})`}>
          <path d="M100 38 V58 L90 68 M100 58 L110 68" />
          {!compact && <path d="M78 52 L84 62 L84 72 M122 52 L116 62 L116 72" strokeOpacity="0.7" />}
        </g>
        {/* Eyes */}
        <g className="ke-eyes" filter={`url(#${id('glow')})`}>
          <path className="ke-eye" d="M77 91 Q86 84 95 90 Q86 96 77 91 Z" fill="var(--keo-eye)" />
          <path className="ke-eye" d="M105 90 Q114 84 123 91 Q114 96 105 90 Z" fill="var(--keo-eye)" />
        </g>
        {/* Mouth: a calm line, replaced by level-driven bars while speaking */}
        <path className="ke-mouth" d="M92 122 Q100 124.5 108 122" fill="none" stroke="var(--keo-a1)" strokeOpacity="0.55" strokeWidth="1.2" strokeLinecap="round" />
        <g className="ke-voice" fill="var(--keo-a1)">
          {[-8, -4, 0, 4, 8].map((dx, i) => (
            <rect key={dx} className={`ke-bar b${i}`} x={99 + dx} y="117" width="2" height="10" rx="1" />
          ))}
        </g>
      </g>

      {/* Base ring */}
      {!compact && <ellipse cx="100" cy="182" rx="56" ry="6" fill="none" stroke="var(--keo-a1)" strokeOpacity="0.35" strokeWidth="1" />}
    </svg>
  );
}

export const STATE_LABEL: Record<EmblemState, string> = {
  idle: 'Ready',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  working: 'Working',
  attention: 'Needs your approval',
  error: 'Something went wrong',
};
