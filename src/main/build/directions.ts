/**
 * Art directions: distinct, current looks a build commits to, so Keo's sites stop coming out the same
 * (cream page, serif headline, three cards, emoji pictures). Each is a full brief an art director would
 * give: type, colour, layout, motion, the signature moves (with Keo's effects kit) and what to avoid.
 * Keo picks the boldest one that suits the request, and never the ones its recent builds used.
 */
export interface ArtDirection {
  id: string;
  name: string;
  /** The feeling, in a line. */
  mood: string;
  /** Words in a brief it suits (scored), and kinds of build. */
  fits: string[];
  type: string;
  colour: string;
  layout: string;
  motion: string;
  /** The moves that make it unforgettable (fx = Keo's effects kit, lib "fx"). */
  signature: string[];
  avoid: string[];
}

export const ART_DIRECTIONS: ArtDirection[] = [
  {
    id: 'kinetic-swiss',
    name: 'Kinetic Swiss',
    mood: 'Precise, confident, typography as the hero — a design studio’s own site.',
    fits: ['agency', 'studio', 'design', 'architecture', 'consult', 'portfolio', 'conference', 'event', 'startup', 'tech'],
    type: 'Headings "Unbounded" or "Bricolage Grotesque" at 12–20vw, tight tracking (-0.04em); body "Inter". Numbers and labels in "JetBrains Mono" caps.',
    colour: 'Off-white #f4f4f0 and true black, ONE loud accent (signal red #ff3b00 or electric blue #2337ff) used sparingly.',
    layout: 'A visible 12-column grid; giant type breaking the grid; numbered sections (01 —, 02 —); hairline rules; asymmetric blocks; generous white space.',
    motion: 'Headlines split into characters and slide up on scroll (fx.splitReveal); a marquee band of the brand’s words; page wipes between pages (fx.pageTransitions).',
    signature: ['fx.splitReveal on every heading', 'fx.marquee band', 'fx.cursor with mix-blend difference', 'fx.pageTransitions with the accent colour'],
    avoid: ['rounded cards with shadows', 'stock gradients', 'centred hero with two buttons'],
  },
  {
    id: 'neo-brutalist',
    name: 'Neo-Brutalist',
    mood: 'Raw, loud, funny, impossible to ignore.',
    fits: ['streetwear', 'fashion', 'music', 'festival', 'creator', 'youth', 'drink', 'snack', 'skate', 'merch', 'shop', 'launch'],
    type: '"Archivo Black" or "Rubik Mono One" headings in caps, huge; body "Space Grotesk" or "Space Mono".',
    colour: 'Saturated flat blocks — acid yellow #e8ff00, hot pink #ff4fd8, cobalt #2b44ff — with 3px black borders and hard offset shadows (6px 6px 0 #000).',
    layout: 'Stacked thick-bordered blocks, stickers rotated a few degrees, overlapping elements, a ticker bar, oversized buttons that press down on click.',
    motion: 'Snappy (no slow fades): elements pop in with overshoot, buttons squash, fx.magnetic on calls to action, a never-ending fx.marquee.',
    signature: ['hard offset shadows that move on hover', 'rotated sticker badges', 'fx.marquee ticker', 'fx.magnetic buttons'],
    avoid: ['pastel', 'thin fonts', 'subtle anything'],
  },
  {
    id: 'cinematic-dark',
    name: 'Cinematic Dark',
    mood: 'A film trailer: deep black, light cutting through, drama.',
    fits: ['film', 'game', 'car', 'automotive', 'luxury', 'watch', 'perfume', 'nightclub', 'bar', 'photography', 'launch', 'trailer'],
    type: '"Big Shoulders Display" or "Bebas Neue" tall caps for titles; "Instrument Serif" italic for one-line taglines; body "Manrope".',
    colour: 'Near-black #07070a, warm highlight (amber #ffb547) or cold (ice #9be7ff), film grain over everything (fx.grain).',
    layout: 'Full-screen chapters, each one a scene; pinned sections that scrub as you scroll (GSAP ScrollTrigger); letterbox bars; giant numerals.',
    motion: 'Slow, weighty easing; light sweeps across headings; images scale from 1.15 to 1 as they enter; fx.shader "aurora" or "noise" behind the hero.',
    signature: ['fx.grain at 0.06', 'fx.shader background in the hero', 'pinned scroll scenes', 'fx.splitReveal on chapter titles'],
    avoid: ['white backgrounds', 'busy layouts', 'emoji'],
  },
  {
    id: 'liquid-aurora',
    name: 'Liquid Aurora',
    mood: 'Futuristic, soft light, glass — a product from 2030.',
    fits: ['ai', 'app', 'saas', 'crypto', 'fintech', 'wellness', 'meditation', 'beauty', 'skincare', 'tech', 'software', 'web3'],
    type: '"Sora" or "Outfit" headings, light-to-bold weight contrast; body "Inter".',
    colour: 'Deep indigo #0b0820 with a moving aurora (violet #7b5cff, cyan #00e0ff, pink #ff5ca8) from fx.shader "aurora"; frosted glass panels (backdrop-filter: blur(20px), 1px white/15% borders).',
    layout: 'Floating glass panels over the moving light; a bento grid of features with different sizes; product UI shown big and tilted in 3D (fx.tilt).',
    motion: 'Everything floats and glows: panels drift on scroll (fx.parallax), cards tilt to the pointer, numbers count up (fx.counter).',
    signature: ['fx.shader aurora', 'glass bento grid', 'fx.tilt on product shots', 'fx.counter stats'],
    avoid: ['flat white', 'serif fonts', 'clip-art'],
  },
  {
    id: 'editorial-luxe',
    name: 'Editorial Luxe',
    mood: 'A fashion magazine spread: restraint, huge serif, beautiful pictures.',
    fits: ['hotel', 'restaurant', 'wedding', 'jewellery', 'fashion', 'interior', 'real estate', 'spa', 'wine', 'chef', 'boutique'],
    type: '"Instrument Serif" or "DM Serif Display" at enormous sizes with italic words; tiny caps labels in "Manrope" with wide tracking.',
    colour: 'Bone #efeae2, ink #151311, one deep tone (oxblood #5a1a1a or forest #1f3a2e). No bright colours.',
    layout: 'Magazine grid: tall portrait pictures, text in narrow columns, captions, drop caps, a pull quote across the page, lots of air.',
    motion: 'Quiet and slow: pictures reveal with a clip-path wipe, text fades up by line (fx.splitReveal mode "lines"), smooth scrolling.',
    signature: ['build__picture photographs, art-directed (not emoji, not icons)', 'clip-path picture reveals', 'fx.splitReveal lines', 'a full-width pull quote'],
    avoid: ['cream-and-terracotta template look', 'buttons everywhere', 'rounded cards'],
  },
  {
    id: 'retro-future',
    name: 'Retro Future',
    mood: '80s/90s computer dreams: chrome, grids, neon, CRT glow.',
    fits: ['game', 'arcade', 'music', 'synth', 'esports', 'gaming', 'retro', 'tech', 'event', 'party', 'radio'],
    type: '"Monoton" or "Orbitron" for the logo and titles; "Press Start 2P" for small labels; body "Space Mono".',
    colour: 'Night purple #12002b, neon magenta #ff2bd6, cyan #00f0ff, chrome gradients on titles, a sunset gradient sun.',
    layout: 'A perspective grid floor (fx.shader "grid"), scanlines, windows like an old OS, a sunset horizon in the hero.',
    motion: 'Text glitches in (scramble), a flicker on load, the grid scrolls forever, buttons glow on hover.',
    signature: ['fx.shader grid floor', 'scanline overlay', 'ScrambleText titles (GSAP)', 'chrome gradient logo'],
    avoid: ['modern minimal', 'serif fonts'],
  },
  {
    id: 'organic-soft',
    name: 'Organic Soft 3D',
    mood: 'Friendly, tactile, rounded — clay and jelly shapes you want to touch.',
    fits: ['kids', 'education', 'food', 'bakery', 'cafe', 'pet', 'health', 'app', 'family', 'toy', 'plant', 'garden'],
    type: '"Bricolage Grotesque" or "Outfit" in heavy weights, rounded; body "DM Sans".',
    colour: 'Candy pastels on a warm base: butter #ffe9a8, peach #ffb4a2, mint #b8f2d0, lilac #cdb4ff, with one deep tone for text #2a1a3a.',
    layout: 'Blobby shapes (CSS border-radius blobs or SVG) as section backgrounds, big rounded cards, 3D clay-style objects made in three.js or build__picture.',
    motion: 'Bouncy springs: things wobble on hover, blobs morph slowly, a three.js object that spins with the scroll.',
    signature: ['a three.js hero object (soft lighting, MeshPhysicalMaterial) or build__picture clay renders', 'morphing blobs', 'springy hover'],
    avoid: ['emoji used as product pictures', 'sharp corners', 'black backgrounds'],
  },
  {
    id: 'immersive-3d',
    name: 'Immersive 3D Story',
    mood: 'You fly through the product — the scroll is a camera move.',
    fits: ['product', 'launch', 'car', 'architecture', 'space', 'science', 'tech', 'hardware', 'drone', 'shoe', 'gadget', 'museum'],
    type: '"Syne" or "Unbounded" headings; body "Manrope".',
    colour: 'Decided by the product: a dark studio (#0d0d10) with one rim-light colour, or a bright void (#f2f2f2) with soft shadows.',
    layout: 'A full-screen three.js canvas fixed behind the page; text panels slide over it; each section moves the camera to a new angle (GSAP ScrollTrigger scrubbing the camera).',
    motion: 'Scroll-driven camera path, exploded views of the product, hotspots that reveal details.',
    signature: ['three.js scene with environment lighting and shadows', 'ScrollTrigger camera path', 'exploded view on scroll', 'build__model or a well-made procedural model'],
    avoid: ['a static hero picture', 'cards grid as the main content'],
  },
  {
    id: 'collage-maximal',
    name: 'Collage Maximalist',
    mood: 'Cut paper, tape, stamps and scribbles — handmade energy.',
    fits: ['art', 'zine', 'music', 'festival', 'cafe', 'bakery', 'craft', 'market', 'community', 'charity', 'school', 'kids'],
    type: 'Mix: "Shrikhand" or "Abril Fatface" display, "Permanent Marker" or "Caveat" handwriting notes, "Space Mono" body.',
    colour: 'Paper #f3ecdc with risograph inks — fluorescent pink #ff48b0, blue #0078bf, yellow #ffe800 — overprinted (mix-blend-mode: multiply).',
    layout: 'Torn-paper edges (SVG), cut-out pictures at angles, tape strips, hand-drawn arrows and circles (SVG drawn with DrawSVG), stamps.',
    motion: 'Arrows draw themselves, cut-outs drop in with a slight rotation, a wiggle on hover.',
    signature: ['DrawSVG hand-drawn arrows/circles', 'riso overprint colours with multiply', 'rotated cut-out pictures from build__picture', 'fx.grain paper texture'],
    avoid: ['corporate neatness', 'gradients', 'icons in circles'],
  },
  {
    id: 'terminal-hacker',
    name: 'Terminal',
    mood: 'A command line come to life — for developers and the curious.',
    fits: ['developer', 'api', 'open source', 'security', 'cli', 'devtools', 'hacker', 'crypto', 'data', 'ai'],
    type: '"JetBrains Mono" for everything, with "Space Grotesk" for one big title.',
    colour: 'Black #050505, phosphor green #39ff88 or amber #ffb000, dim grey comments #5a5a5a.',
    layout: 'Windows and panes like a tiling terminal, commands typing themselves, ASCII art, a live-looking log.',
    motion: 'Typewriter text, a blinking cursor, sections boot up line by line, fx.splitReveal mode "chars".',
    signature: ['typing commands', 'ASCII art logo', 'interactive fake prompt that answers a few commands', 'scanlines (subtle)'],
    avoid: ['photos', 'rounded friendly UI'],
  },
  {
    id: 'japanese-minimal',
    name: 'Japanese Minimal',
    mood: 'Calm, exact, vertical rhythm, one red seal.',
    fits: ['tea', 'sushi', 'ramen', 'ceramics', 'yoga', 'architecture', 'craft', 'skincare', 'stationery', 'zen', 'spa'],
    type: '"Cormorant Garamond" or "Fraunces" light for titles, some words set vertically (writing-mode: vertical-rl); body "Manrope" light.',
    colour: 'Washi white #f6f3ec, sumi ink #1b1b1b, one vermilion seal #d23a2a.',
    layout: 'Huge margins, vertical text columns, thin rules, objects on empty space, a seal mark in a corner.',
    motion: 'Barely there: slow ink-like fades, a brush stroke drawing in (DrawSVG), gentle parallax.',
    signature: ['vertical text', 'brush stroke SVG drawing in', 'vermilion seal', 'build__picture still-life photography'],
    avoid: ['clutter', 'bright colours', 'heavy shadows'],
  },
  {
    id: 'sport-energy',
    name: 'Sport Energy',
    mood: 'Speed and sweat — italic, slanted, high contrast.',
    fits: ['gym', 'fitness', 'sport', 'football', 'running', 'club', 'team', 'esports', 'energy drink', 'coach', 'boxing'],
    type: '"Teko" or "Oswald" in heavy italic caps (transform: skewX(-8deg)), huge numbers; body "Inter".',
    colour: 'Black and white with one volt colour (#d7ff00 or #ff2d2d), motion-blur streaks.',
    layout: 'Diagonal sections (clip-path polygons), athletes cut out over giant numbers, stat bars, a schedule like a scoreboard.',
    motion: 'Fast slide-ins along the diagonal, counters racing up (fx.counter), a marquee of results.',
    signature: ['diagonal clip-path sections', 'fx.counter stats', 'fx.marquee results', 'build__picture action photography'],
    avoid: ['soft pastels', 'serif fonts', 'slow fades'],
  },
];

const words = (s: string) => s.toLowerCase();

/**
 * Directions that suit a brief, best first, leaving out the ones recent builds used (so two sites in a
 * row never look alike). Always returns `n` with clearly different moods.
 */
export function pickDirections(brief: string, kind: string, recent: string[] = [], n = 3): ArtDirection[] {
  const text = words(`${brief} ${kind}`);
  const scored = ART_DIRECTIONS.filter((d) => !recent.includes(d.id))
    .map((d, i) => ({ d, score: d.fits.reduce((s, f) => s + (text.includes(f) ? 3 : 0), 0) + (kind === 'game' && d.fits.includes('game') ? 2 : 0) - i * 0.01 }))
    .sort((a, b) => b.score - a.score);
  const out: ArtDirection[] = [];
  for (const { d } of scored) {
    if (out.length >= n) break;
    out.push(d);
  }
  // Not enough left after leaving the recent ones out: allow them again.
  for (const d of ART_DIRECTIONS) if (out.length < n && !out.includes(d)) out.push(d);
  return out;
}

export function directionById(id: string): ArtDirection | undefined {
  return ART_DIRECTIONS.find((d) => d.id === id);
}

/** The full brief for the model, in a few lines. */
export function directionBrief(d: ArtDirection): string {
  return [
    `Art direction: ${d.name} — ${d.mood}`,
    `Type: ${d.type}`,
    `Colour: ${d.colour}`,
    `Layout: ${d.layout}`,
    `Motion: ${d.motion}`,
    `Signature moves (use them): ${d.signature.join('; ')}.`,
    `Avoid: ${d.avoid.join('; ')}.`,
  ].join('\n');
}
