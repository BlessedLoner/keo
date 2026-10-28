import type { EditOp, Project } from './studio';

/**
 * Motion-design presets: ready-made combinations of text, shapes and motion that editors use all
 * the time. Each one becomes ordinary edits (so every part can be changed or undone after).
 */

export const PRESETS = {
  title: 'Big kinetic title: letters rise in with a glow',
  'kinetic-words': 'The text one word at a time, big and centred, alternating colours (like a beat edit)',
  'lower-third': 'Name and role in a bar that slides in at the bottom left',
  subscribe: 'A red "Subscribe" button that pops in and pulses',
  'progress-bar': 'A thin bar along the bottom that fills up over the clip',
  counter: 'A number counting up (from 0 to the number in the text)',
  underline: 'A line that draws itself under a word',
  'neon-frame': 'A glowing outline that draws itself around the frame',
  'glow-orb': 'A soft glowing circle floating in the background',
  'logo-reveal': 'A logo or picture revealed through a growing circle with a ring and a flash (needs media)',
  phone: 'A video or picture shown in a phone that slides up and floats (needs media)',
  avatar: 'A photo in a circle with a ring (needs media)',
} as const;
export type PresetId = keyof typeof PRESETS;

export interface PresetOptions {
  at: number;
  duration?: number;
  text?: string;
  subtext?: string;
  color?: string;
  color2?: string;
  /** Media for logo-reveal, phone and avatar. */
  assetId?: string;
  /** Where: x, y fractions of the frame (the preset's own place by default). */
  x?: number;
  y?: number;
}

export class PresetError extends Error {}

/** The edits that make a preset. */
export function presetOps(p: Project, id: PresetId, o: PresetOptions): EditOp[] {
  const at = Math.max(0, o.at);
  const color = o.color ?? '#FFFFFF';
  const accent = o.color2 ?? '#8B6BFF';
  const vertical = p.height > p.width;
  /** A circle d (fraction of the shorter side) across, as shape width and height. */
  const round = (d: number) => {
    const px = d * Math.min(p.width, p.height);
    return { width: px / p.width, height: px / p.height };
  };
  const needText = (fallback?: string) => {
    const t = (o.text ?? fallback ?? '').trim();
    if (!t) throw new PresetError(`The ${id} preset needs text.`);
    return t.slice(0, 2000);
  };
  const needMedia = () => {
    const a = o.assetId ? p.assets.find((x) => x.id === o.assetId) : null;
    if (!a || a.kind === 'audio') throw new PresetError(`The ${id} preset needs a picture or video of this project (assetId).`);
    return a.id;
  };
  switch (id) {
    case 'title': {
      const d = o.duration ?? 3;
      return [
        {
          op: 'add_text',
          text: needText(),
          start: at,
          duration: d,
          animIn: 'letters',
          animOut: 'zoom',
          animSeconds: 0.5,
          style: { sizePct: vertical ? 8 : 11, weight: 'black', color, color2: accent, glow: 22, glowColor: accent, uppercase: true, shadow: 0, letterSpacing: 2 },
          transform: { x: o.x ?? 0.5, y: o.y ?? 0.45 },
        },
      ];
    }
    case 'kinetic-words': {
      const words = needText().split(/\s+/).filter(Boolean).slice(0, 60);
      const each = (o.duration ?? Math.max(1.2, words.length * 0.45)) / words.length;
      const styles = ['zoom', 'pop', 'blur-in', 'drop'] as const;
      return words.map((w, i) => ({
        op: 'add_text' as const,
        text: w,
        start: at + i * each,
        duration: Math.max(0.15, each),
        animIn: styles[i % styles.length]!,
        animOut: 'none' as const,
        animSeconds: Math.min(0.25, each * 0.6),
        style: { sizePct: w.length > 9 ? 9 : 13, weight: 'black' as const, color: i % 3 === 2 ? accent : color, glow: i % 3 === 2 ? 26 : 10, glowColor: i % 3 === 2 ? accent : '#FFFFFF', uppercase: true, shadow: 6 },
        transform: { x: o.x ?? 0.5, y: o.y ?? 0.5 },
      }));
    }
    case 'lower-third': {
      const d = o.duration ?? 4;
      const x = o.x ?? (vertical ? 0.5 : 0.28);
      const y = o.y ?? (vertical ? 0.78 : 0.82);
      return [
        { op: 'add_shape', shape: 'rect', start: at, duration: d, style: { width: vertical ? 0.84 : 0.44, height: 0.105, radius: 0.2, fill: '#0E0E14', fill2: '#1D1B2C', stroke: accent, strokeWidth: 3, shadow: 20 }, transform: { x, y, opacity: 0.94 }, enter: { kind: 'wipe-right', seconds: 0.45 }, exit: { kind: 'wipe-left', seconds: 0.35 } },
        { op: 'add_shape', shape: 'rect', start: at + 0.15, duration: d - 0.15, style: { width: 0.008, height: 0.07, radius: 0.5, fill: accent, glow: 16, glowColor: accent }, transform: { x: x - (vertical ? 0.38 : 0.2), y }, enter: { kind: 'zoom-in', seconds: 0.3 }, exit: { kind: 'fade', seconds: 0.25 } },
        {
          op: 'add_text',
          text: needText('Your Name'),
          start: at + 0.25,
          duration: d - 0.25,
          animIn: 'wipe',
          animOut: 'fade',
          animSeconds: 0.4,
          style: { sizePct: 3.6, weight: 'bold', color, align: 'left', shadow: 0, maxWidth: vertical ? 0.7 : 0.38 },
          transform: { x: x + 0.01, y: y - 0.018 },
        },
        ...(o.subtext
          ? [
              {
                op: 'add_text' as const,
                text: o.subtext.slice(0, 200),
                start: at + 0.4,
                duration: d - 0.4,
                animIn: 'fade' as const,
                animOut: 'fade' as const,
                animSeconds: 0.4,
                style: { sizePct: 2.4, weight: 'normal' as const, color: '#C9C4E8', align: 'left' as const, shadow: 0, maxWidth: vertical ? 0.7 : 0.38 },
                transform: { x: x + 0.01, y: y + 0.026 },
              },
            ]
          : []),
      ];
    }
    case 'subscribe': {
      const d = o.duration ?? 3;
      const x = o.x ?? 0.5;
      const y = o.y ?? 0.8;
      return [
        { op: 'add_shape', shape: 'rect', start: at, duration: d, style: { width: vertical ? 0.5 : 0.26, height: 0.075, radius: 0.5, fill: '#FF1E3C', fill2: '#D6002A', shadow: 24, glow: 10, glowColor: '#FF1E3C' }, transform: { x, y }, enter: { kind: 'pop', seconds: 0.4 }, exit: { kind: 'zoom-out', seconds: 0.3 }, loop: { kind: 'pulse', amount: 0.35, period: 1.2 } },
        { op: 'add_text', text: o.text ?? 'SUBSCRIBE', start: at + 0.1, duration: d - 0.1, animIn: 'pop', animOut: 'fade', animSeconds: 0.35, style: { sizePct: 3.4, weight: 'black', color: '#FFFFFF', shadow: 0, uppercase: true, letterSpacing: 3 }, transform: { x, y: y + 0.002 }, loop: { kind: 'pulse', amount: 0.35, period: 1.2 } },
      ];
    }
    case 'progress-bar': {
      const d = o.duration ?? Math.max(1, (p.tracks.reduce((m, t) => Math.max(m, ...t.clips.map((c) => c.start + c.duration)), 0) || 10) - at);
      const y = o.y ?? 0.985;
      return [
        { op: 'add_shape', shape: 'rect', start: at, duration: d, style: { width: 1, height: 0.012, radius: 0, fill: '#FFFFFF', shadow: 0 }, transform: { x: 0.5, y, opacity: 0.2 } },
        // Grows from the left edge: the centre moves right as the bar gets wider.
        {
          op: 'add_shape',
          shape: 'rect',
          start: at,
          duration: d,
          style: { width: 1, height: 0.012, radius: 0, fill: accent, fill2: color, glow: 10, glowColor: accent },
          transform: { x: 0, y },
          keys: { scaleX: [{ at: 0, value: 0, ease: 'linear' }, { at: d, value: 1, ease: 'linear' }], x: [{ at: 0, value: 0, ease: 'linear' }, { at: d, value: 0.5, ease: 'linear' }] },
        },
      ];
    }
    case 'counter': {
      const raw = needText('10000');
      const m = /^(\D*?)(-?[\d,.]+)(.*)$/.exec(raw);
      if (!m) throw new PresetError('The counter preset needs a number in the text, like "10,000 followers" or "$2.5M".');
      const num = Number(m[2]!.replace(/,/g, ''));
      const decimals = (m[2]!.split('.')[1] ?? '').length;
      const d = o.duration ?? 3;
      return [
        {
          op: 'add_text',
          text: raw,
          start: at,
          duration: d,
          animIn: 'pop',
          animOut: 'fade',
          animSeconds: 0.35,
          counter: { from: 0, to: num, decimals, prefix: m[1] ?? '', suffix: m[3] ?? '', separator: true, seconds: Math.min(d * 0.75, 2.2) },
          style: { sizePct: vertical ? 7 : 11, weight: 'black', color, color2: accent, glow: 18, glowColor: accent, shadow: 0 },
          transform: { x: o.x ?? 0.5, y: o.y ?? 0.45 },
        },
      ];
    }
    case 'underline': {
      const d = o.duration ?? 2.5;
      return [{ op: 'add_shape', shape: 'line', start: at, duration: d, style: { width: 0.35, height: 0.02, fill: accent, strokeWidth: 9, glow: 14, glowColor: accent, draw: true }, transform: { x: o.x ?? 0.5, y: o.y ?? 0.55 }, enter: { kind: 'fade', seconds: 0.5 }, exit: { kind: 'fade', seconds: 0.3 } }];
    }
    case 'neon-frame': {
      const d = o.duration ?? 4;
      return [{ op: 'add_shape', shape: 'rect', start: at, duration: d, style: { width: 0.9, height: 0.92, radius: 0.04, fill: null, stroke: accent, strokeWidth: 6, glow: 30, glowColor: accent, draw: true }, transform: { x: 0.5, y: 0.5 }, enter: { kind: 'fade', seconds: 1 }, exit: { kind: 'fade', seconds: 0.4 }, loop: { kind: 'flicker', amount: 0.15, period: 3 } }];
    }
    case 'glow-orb': {
      const d = o.duration ?? 6;
      return [
        {
          op: 'add_shape',
          shape: 'circle',
          start: at,
          duration: d,
          style: { ...round(0.7), fill: accent, fill2: '#00000000', angle: 90, glow: 80, glowColor: accent },
          transform: { x: o.x ?? 0.7, y: o.y ?? 0.3, opacity: 0.45 },
          keys: { blur: [{ at: 0, value: 6, ease: 'hold' }] },
          enter: { kind: 'fade', seconds: 1.2 },
          exit: { kind: 'fade', seconds: 1 },
          loop: { kind: 'float', amount: 0.8, period: 5 },
        },
      ];
    }
    case 'logo-reveal': {
      const assetId = needMedia();
      const d = o.duration ?? 3;
      const x = o.x ?? 0.5;
      const y = o.y ?? 0.45;
      return [
        { op: 'add_shape', shape: 'ring', start: at, duration: d, style: { ...round(0.62), fill: accent, strokeWidth: 7, glow: 30, glowColor: accent, draw: true }, transform: { x, y }, enter: { kind: 'zoom-in', seconds: 0.7 }, exit: { kind: 'fade', seconds: 0.4 } },
        { op: 'add_media', assetId, trackName: 'Logo', start: at + 0.25, duration: d - 0.25, fit: 'contain', transform: { x, y, scale: 0.4 }, enter: { kind: 'iris', seconds: 0.6 }, exit: { kind: 'zoom-out', seconds: 0.35 }, loop: { kind: 'pulse', amount: 0.15, period: 2 } },
      ];
    }
    case 'phone': {
      const assetId = needMedia();
      const d = o.duration ?? 5;
      return [{ op: 'add_media', assetId, trackName: 'Mock-up', start: at, duration: d, frame: 'phone', transform: { x: o.x ?? 0.5, y: o.y ?? 0.5, scale: vertical ? 0.85 : 1 }, enter: { kind: 'slide-up', seconds: 0.6 }, exit: { kind: 'slide-down', seconds: 0.5 }, loop: { kind: 'float', amount: 0.5, period: 4 } }];
    }
    case 'avatar': {
      const assetId = needMedia();
      const d = o.duration ?? 4;
      const x = o.x ?? 0.5;
      const y = o.y ?? 0.35;
      return [
        { op: 'add_media', assetId, trackName: 'Avatar', start: at, duration: d, transform: { x, y, scale: 0.42 }, mask: { shape: 'circle', radius: 0.5 }, shadow: 20, enter: { kind: 'pop', seconds: 0.45 }, exit: { kind: 'zoom-out', seconds: 0.3 } },
        { op: 'add_shape', shape: 'ring', start: at + 0.1, duration: d - 0.1, style: { ...round(0.46), fill: accent, strokeWidth: 8, glow: 18, glowColor: accent, draw: true }, transform: { x, y }, enter: { kind: 'fade', seconds: 0.6 }, exit: { kind: 'fade', seconds: 0.3 } },
      ];
    }
  }
}
