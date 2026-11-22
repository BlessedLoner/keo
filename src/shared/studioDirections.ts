import type { LookId } from './studio';

/**
 * Art directions for videos: a whole look a video commits to — fonts, palette, colour grade,
 * transitions, caption treatment, motion energy, music mood and signature graphics — so Keo's videos
 * stop coming out in the same violet-and-cyan Poppins style. Keo picks one that suits the video and
 * that recent projects did not use; every motion piece and text then takes its fonts and colours
 * unless Keo sets others on purpose. Keo's own designs (the "design" motion piece) are where each
 * direction's signature graphics are made.
 */
export interface VideoDirection {
  id: string;
  name: string;
  mood: string;
  fits: string[];
  /** Headline font, body/caption font, and an accent face for stressed words. */
  fonts: { display: string; body: string; accent: string };
  palette: { accent: string; accent2: string; text: string; background: string };
  look: LookId;
  transitions: string[];
  captions: string;
  energy: 'calm' | 'steady' | 'punchy' | 'frantic';
  music: string;
  /** Graphics to design for it (with the design piece). */
  signature: string[];
  avoid: string[];
}

export const VIDEO_DIRECTIONS: VideoDirection[] = [
  {
    id: 'kinetic-type',
    name: 'Kinetic Typography',
    mood: 'Words are the visuals: huge type that builds, slams and slides on the beat.',
    fits: ['talking', 'podcast', 'motivation', 'quote', 'explainer', 'tips', 'educat', 'reel', 'tiktok', 'shorts', 'speech', 'interview'],
    fonts: { display: 'Unbounded', body: 'Inter', accent: 'Instrument Serif' },
    palette: { accent: '#FF3B00', accent2: '#FFD23F', text: '#FFFFFF', background: '#0B0B0D' },
    look: 'punchy',
    transitions: ['whip', 'push', 'flash'],
    captions: 'big stacked words, one stressed word per line in the accent serif italic and the accent colour',
    energy: 'punchy',
    music: 'driving electronic or hip-hop beat, 100–128 BPM',
    signature: ['full-frame keyword cards: one word per beat, chars split from below with expo ease', 'a counter for every number said', 'a hard light-flash between ideas'],
    avoid: ['soft glows', 'pastel', 'slow crossfades'],
  },
  {
    id: 'documentary',
    name: 'Documentary',
    mood: 'Serious, honest, cinematic — a Netflix doc.',
    fits: ['story', 'history', 'documentary', 'interview', 'true', 'journal', 'news', 'nonprofit', 'charity', 'biography'],
    fonts: { display: 'Big Shoulders Display', body: 'Manrope', accent: 'Instrument Serif' },
    palette: { accent: '#E8D3A2', accent2: '#B23A2E', text: '#F2EEE6', background: '#0E0D0B' },
    look: 'film',
    transitions: ['dip', 'crossfade', 'blur'],
    captions: 'small, quiet white captions low in the frame; key names and dates as elegant lower thirds',
    energy: 'calm',
    music: 'sparse piano or ambient strings',
    signature: ['location and date slugs typed in mono caps', 'archival-style frames with grain and a slow push-in', 'chapter cards: a big condensed number and a serif italic title'],
    avoid: ['emoji', 'bouncy motion', 'bright saturated colour'],
  },
  {
    id: 'luxury-editorial',
    name: 'Luxury Editorial',
    mood: 'A fashion film: slow, airy, expensive.',
    fits: ['fashion', 'beauty', 'luxury', 'perfume', 'jewel', 'hotel', 'real estate', 'wedding', 'interior', 'brand', 'skincare'],
    fonts: { display: 'Instrument Serif', body: 'Manrope', accent: 'Cormorant Garamond' },
    palette: { accent: '#C9A86A', accent2: '#F2EDE4', text: '#F7F3EC', background: '#111010' },
    look: 'cinematic',
    transitions: ['crossfade', 'dip', 'zoom-out'],
    captions: 'none or a few words as titles; widely tracked small caps and a large serif italic',
    energy: 'calm',
    music: 'minimal deep house or solo cello',
    signature: ['thin gold lines drawing on around a title', 'words revealing by line through a mask', 'black bars and a slow 1.05× push-in on every shot'],
    avoid: ['stickers', 'fast cuts', 'heavy sans fonts'],
  },
  {
    id: 'hype-street',
    name: 'Hype Street',
    mood: 'Loud, raw, youth culture — a sneaker drop.',
    fits: ['sneaker', 'streetwear', 'drop', 'music', 'sport', 'gaming', 'merch', 'launch', 'party', 'festival', 'promo'],
    fonts: { display: 'Archivo Black', body: 'Space Grotesk', accent: 'Permanent Marker' },
    palette: { accent: '#E8FF00', accent2: '#FF4FD8', text: '#FFFFFF', background: '#000000' },
    look: 'punchy',
    transitions: ['glitch', 'whip', 'stretch', 'flash'],
    captions: 'all caps, heavy, words slammed one by one with a shake; the hype word in marker handwriting',
    energy: 'frantic',
    music: 'trap or drill, heavy bass drops on the cuts',
    signature: ['stickers and marker scribbles drawing on', 'hollow outline type repeating behind', 'a ticker band of the brand name'],
    avoid: ['serif fonts', 'slow fades', 'corporate blues'],
  },
  {
    id: 'tech-clean',
    name: 'Tech Clean',
    mood: 'Precise, bright, product-launch keynote.',
    fits: ['app', 'software', 'saas', 'ai', 'startup', 'product', 'tutorial', 'demo', 'tech', 'gadget', 'review'],
    fonts: { display: 'Sora', body: 'Inter', accent: 'JetBrains Mono' },
    palette: { accent: '#3D7BFF', accent2: '#00E0B8', text: '#0D1117', background: '#F5F7FA' },
    look: 'clean-bright',
    transitions: ['push', 'slide-up', 'zoom'],
    captions: 'clean sentence-case captions on a soft white pill; features as numbered cards',
    energy: 'steady',
    music: 'bright minimal electronic, 110 BPM',
    signature: ['UI frames floating in 3D with soft shadows', 'thin connector lines drawing between labels', 'stats counting up in mono'],
    avoid: ['grain', 'grunge', 'neon'],
  },
  {
    id: 'retro-vhs',
    name: 'Retro VHS',
    mood: '80s/90s tape nostalgia: neon, scanlines, chrome.',
    fits: ['retro', 'gaming', 'synth', 'music', 'throwback', 'arcade', 'nostalgia', 'party', 'vlog'],
    fonts: { display: 'Monoton', body: 'Space Mono', accent: 'Righteous' },
    palette: { accent: '#FF2BD6', accent2: '#00F0FF', text: '#FFFFFF', background: '#12002B' },
    look: 'neon',
    transitions: ['glitch', 'wipe', 'spin'],
    captions: 'mono captions with a cyan glow, a REC timecode in the corner',
    energy: 'punchy',
    music: 'synthwave',
    signature: ['neon ring and star stings', 'hollow glowing titles that flicker', 'drifting light streak particles'],
    avoid: ['flat corporate colours', 'serif fonts'],
  },
  {
    id: 'warm-vlog',
    name: 'Warm Vlog',
    mood: 'Personal, cosy, golden — a friend’s travel diary.',
    fits: ['vlog', 'travel', 'food', 'cooking', 'family', 'lifestyle', 'day in', 'cafe', 'bakery', 'diary', 'wedding'],
    fonts: { display: 'Bricolage Grotesque', body: 'DM Sans', accent: 'Caveat' },
    palette: { accent: '#FF8A3D', accent2: '#FFD7A8', text: '#FFFDF8', background: '#2A1A10' },
    look: 'golden-hour',
    transitions: ['crossfade', 'slide', 'zoom-out'],
    captions: 'friendly lowercase captions; asides in handwriting with a hand-drawn arrow',
    energy: 'steady',
    music: 'acoustic guitar or lo-fi',
    signature: ['location pins with handwritten place names', 'hand-drawn circles and arrows drawing on', 'polaroid-style frames for photos'],
    avoid: ['harsh neon', 'glitch'],
  },
  {
    id: 'bold-explainer',
    name: 'Bold Explainer',
    mood: 'Clear, graphic, confident — big shapes that make ideas obvious.',
    fits: ['explainer', 'educat', 'course', 'how to', 'finance', 'money', 'science', 'business', 'lesson', 'data', 'facts'],
    fonts: { display: 'Outfit', body: 'Inter', accent: 'DM Serif Display' },
    palette: { accent: '#FF5A36', accent2: '#2B44FF', text: '#111111', background: '#F4F1EA' },
    look: 'natural',
    transitions: ['push', 'wipe-left', 'iris'],
    captions: 'big black captions on cream, the key term highlighted with a marker swipe',
    energy: 'steady',
    music: 'light upbeat pizzicato or corporate pop',
    signature: ['diagrams made of shapes that draw on', 'big numbers and bar charts growing', 'icons as flat geometric shapes, never emoji'],
    avoid: ['dark moody grades', 'thin fonts'],
  },
  {
    id: 'noir-mono',
    name: 'Noir Mono',
    mood: 'Black and white, high contrast, mysterious.',
    fits: ['poetry', 'art', 'fashion', 'music video', 'mystery', 'thriller', 'manifesto', 'photography', 'gallery'],
    fonts: { display: 'Syne', body: 'Manrope', accent: 'Instrument Serif' },
    palette: { accent: '#FFFFFF', accent2: '#FF2D2D', text: '#FFFFFF', background: '#000000' },
    look: 'crisp-bw',
    transitions: ['dip', 'flash', 'iris'],
    captions: 'sparse white words centred, one red word per scene',
    energy: 'calm',
    music: 'dark ambient or jazz',
    signature: ['one red element per scene', 'type set huge and cropped by the frame edge', 'slow letter-by-letter reveals'],
    avoid: ['colour', 'cheerful motion'],
  },
  {
    id: 'sport-pulse',
    name: 'Sport Pulse',
    mood: 'Speed, sweat, scoreboards.',
    fits: ['sport', 'gym', 'fitness', 'football', 'basketball', 'running', 'workout', 'highlight', 'match', 'team', 'coach'],
    fonts: { display: 'Teko', body: 'Oswald', accent: 'Bebas Neue' },
    palette: { accent: '#D7FF00', accent2: '#FF2D2D', text: '#FFFFFF', background: '#0A0A0A' },
    look: 'teal-orange',
    transitions: ['whip', 'zoom', 'stretch'],
    captions: 'italic heavy caps, skewed; numbers huge',
    energy: 'frantic',
    music: 'stadium rock or high-BPM electronic',
    signature: ['slanted scoreboard lower thirds', 'speed lines particles', 'stat counters slamming in'],
    avoid: ['serif fonts', 'soft pastels'],
  },
];

/** Directions that suit what the video is about, best first, leaving out recent ones. */
export function pickVideoDirections(about: string, recent: string[] = [], n = 3): VideoDirection[] {
  const text = about.toLowerCase();
  const scored = VIDEO_DIRECTIONS.filter((d) => !recent.includes(d.id))
    .map((d, i) => ({ d, score: d.fits.reduce((s, f) => s + (text.includes(f) ? 3 : 0), 0) - i * 0.01 }))
    .sort((a, b) => b.score - a.score)
    .map((x) => x.d);
  const out = scored.slice(0, n);
  for (const d of VIDEO_DIRECTIONS) if (out.length < n && !out.includes(d)) out.push(d);
  return out;
}

export function videoDirectionById(id: string | undefined): VideoDirection | undefined {
  return id ? VIDEO_DIRECTIONS.find((d) => d.id === id) : undefined;
}

export function videoDirectionBrief(d: VideoDirection): string {
  return [
    `Video art direction: ${d.name} — ${d.mood}`,
    `Fonts: ${d.fonts.display} (titles), ${d.fonts.body} (captions, body), ${d.fonts.accent} (stressed words).`,
    `Colours: accent ${d.palette.accent}, second ${d.palette.accent2}, text ${d.palette.text}, background ${d.palette.background}.`,
    `Colour grade: the "${d.look}" look. Transitions: ${d.transitions.join(', ')}. Energy: ${d.energy}. Music: ${d.music}.`,
    `Captions: ${d.captions}.`,
    `Signature graphics (design them with the design piece): ${d.signature.join('; ')}.`,
    `Avoid: ${d.avoid.join('; ')}.`,
  ].join('\n');
}

/**
 * Keo's edits take the direction's fonts and colours wherever they did not choose their own:
 * motion pieces (accent, accent2, color, font) and text clips (font, colour).
 */
export function withDirectionDefaults(ops: unknown[], d: VideoDirection | undefined): unknown[] {
  if (!d) return ops;
  return ops.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const op = { ...(raw as Record<string, unknown>) };
    if (op.op === 'add_motion') {
      op.accent ??= d.palette.accent;
      op.accent2 ??= d.palette.accent2;
      op.color ??= d.palette.text;
      op.font ??= d.fonts.display;
    } else if (op.op === 'add_text') {
      const style = { ...((op.style as Record<string, unknown> | undefined) ?? {}) };
      style.font ??= d.fonts.display;
      op.style = style;
    }
    return op;
  });
}
