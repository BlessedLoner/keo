const PATHS: Record<string, string> = {
  chat: 'M4 5h16v10H8l-4 4V5z',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  memory: 'M12 3a7 7 0 0 0-4 12.7V19h8v-3.3A7 7 0 0 0 12 3zM9 21h6',
  projects: 'M3 7h6l2 2h10v10H3V7z',
  vision: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  plus: 'M12 5v14M5 12h14',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  send: 'M4 12l16-8-6 16-3-7-7-1z',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  stop: 'M7 7h10v10H7z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  speaker: 'M4 9h4l5-4v14l-5-4H4V9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  copy: 'M9 9h11v11H9zM5 15V4h11',
  pin: 'M12 17v4M8 3h8l-1 6 3 4H6l3-4-1-6z',
  retry: 'M4 4v6h6M20 20v-6h-6M5.6 15a8 8 0 0 0 13.4 3M18.4 9A8 8 0 0 0 5 6',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16v4z',
  check: 'M5 12l5 5L20 7',
  x: 'M6 6l12 12M18 6L6 18',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  camera: 'M4 8h4l2-3h4l2 3h4v11H4V8zm8 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  folder: 'M3 6h6l2 2h10v11H3V6z',
  warn: 'M12 3l10 18H2L12 3zM12 10v4M12 17v.5',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.5',
  key: 'M14 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM10 11l-7 7v3h3l1-1v-2h2v-2h2l1.5-1.5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  window: 'M3 5h18v14H3zM3 9h18',
  phone: 'M6.6 3.5h3l1.6 4.4-2.1 1.4a11.5 11.5 0 0 0 5.6 5.6l1.4-2.1 4.4 1.6v3a2 2 0 0 1-2.2 2A17.5 17.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z',
  attach: 'M20.5 11.5l-8.3 8.3a5.2 5.2 0 0 1-7.4-7.4l8.6-8.6a3.5 3.5 0 0 1 4.9 4.9l-8.6 8.6a1.7 1.7 0 0 1-2.5-2.5l7.9-7.9',
  file: 'M6 3h8l4 4v14H6V3zM14 3v4h4M9 13h6M9 17h6',
  image: 'M4 5h16v14H4V5zM4 16l5-5 4 4 3-3 4 4M15.5 8.5h.01',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  sparkle: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z',
  rocket: 'M5 15c-1 1-2 5-2 5s4-1 5-2M9 15l-3-3c1-4 5-9 12-9 0 7-5 11-9 12zM14 9.5a1 1 0 1 0 0 .1',
  // Keo Studio
  film: 'M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  play: 'M7 5l12 7-12 7z',
  pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
  scissors: 'M6 3.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M6 15.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5M8 7.5L20 18M8 16.5L20 6',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  eyeoff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1',
  mute: 'M11 5L6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0M21 16a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  skipback: 'M19 20L9 12l10-8zM5 19V5',
  skipfwd: 'M5 4l10 8-10 8zM19 5v14',
};

export function Icon({ name, size = 18, stroke = 1.7, className }: { name: keyof typeof PATHS | string; size?: number; stroke?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
