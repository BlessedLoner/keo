/**
 * "Learn from a site you love": Keo opens a real website in a hidden, sandboxed window (its own
 * throwaway session: no Keo data, no pop-ups, no downloads, no permissions), lets it play, measures
 * the design it really uses (colours by the area they cover, typefaces and sizes, spacing, shapes,
 * motion libraries) and takes screenshots on a desktop and a phone. Keo then describes its design
 * DNA so a build can reach the same level of craft in its own original way — never a copy.
 */

/** What the page reports about itself (read in the page by STUDY_SCRIPT). */
export interface RawStudy {
  title: string;
  /** Background colours with the area they cover (px²). */
  backgrounds: Array<{ color: string; area: number }>;
  /** Text colours with how much text uses them (characters). */
  texts: Array<{ color: string; chars: number }>;
  /** Buttons and links: their background and text colours. */
  accents: Array<{ color: string; count: number }>;
  /** Typefaces: the first family name, its role, the size used (px) and weight. */
  fonts: Array<{ family: string; role: 'heading' | 'body'; size: number; weight: number; chars: number; letterSpacing: number; transform: string }>;
  headings: { h1: number | null; h2: number | null; h3: number | null; body: number | null; lineHeight: number | null };
  layout: { contentWidth: number; sections: number; sectionPadding: number | null; grids: number; flexRows: number; sticky: number; fullBleedImages: number };
  shapes: { radii: number[]; shadows: number; borders: number };
  media: { images: number; svgs: number; videos: number; canvases: number; backgroundImages: number };
  motion: { libraries: string[]; cssAnimations: number; transitions: number; scrollSnap: boolean; customCursor: boolean };
  /** Section headings and navigation labels (structure only; never reused as copy). */
  outline: string[];
}

/** Read in the page: what it really draws (sampled visible elements, weighted by size). */
export const STUDY_SCRIPT = `(() => {
  const W = innerWidth, H = document.documentElement.scrollHeight;
  const els = Array.from(document.querySelectorAll('body *')).slice(0, 6000);
  const bg = new Map(), tx = new Map(), ac = new Map(), fonts = new Map(), radii = new Map();
  let shadows = 0, borders = 0, grids = 0, flexRows = 0, sticky = 0, anim = 0, trans = 0, bgImages = 0, fullBleed = 0, cursor = false;
  const add = (m, k, n) => m.set(k, (m.get(k) || 0) + n);
  const visible = (r, cs) => r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  for (const el of els) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (!visible(r, cs)) continue;
    const area = Math.min(r.width, W) * Math.min(r.height, 4000);
    if (cs.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor)) add(bg, cs.backgroundColor, area);
    if (cs.backgroundImage && cs.backgroundImage !== 'none') { bgImages++; if (/gradient/.test(cs.backgroundImage)) add(bg, 'gradient', area * 0.5); }
    let own = 0; for (const n of el.childNodes) if (n.nodeType === 3) own += n.textContent.trim().length;
    if (own) {
      add(tx, cs.color, own);
      const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
      const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
      const role = /^H[1-3]$/.test(el.tagName) || size >= 28 ? 'heading' : 'body';
      const key = fam + '|' + role;
      const f = fonts.get(key) || { family: fam, role, size: 0, weight, chars: 0, letterSpacing: parseFloat(cs.letterSpacing) || 0, transform: cs.textTransform };
      f.chars += own; if (size > f.size && role === 'heading') f.size = size; if (role === 'body' && !f.size) f.size = size; fonts.set(key, f);
    }
    if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
      if (cs.backgroundColor && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(cs.backgroundColor)) add(ac, cs.backgroundColor, 1); else add(ac, cs.color, 1);
    }
    const rad = parseFloat(cs.borderTopLeftRadius); if (rad > 0 && r.width > 40) add(radii, Math.round(rad), 1);
    if (cs.boxShadow && cs.boxShadow !== 'none') shadows++;
    if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') borders++;
    if (cs.display === 'grid') grids++;
    if (cs.display === 'flex' && cs.flexDirection.startsWith('row') && el.children.length >= 3) flexRows++;
    if (cs.position === 'sticky' || cs.position === 'fixed') sticky++;
    if (cs.animationName && cs.animationName !== 'none') anim++;
    if (cs.transitionDuration && cs.transitionDuration !== '0s') trans++;
    if (cs.cursor && /url\\(|none/.test(cs.cursor)) cursor = true;
    if ((el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'PICTURE') && r.width >= W * 0.95) fullBleed++;
  }
  const size = (sel) => { const e = document.querySelector(sel); return e ? parseFloat(getComputedStyle(e).fontSize) : null; };
  const p = document.querySelector('p');
  const sections = Array.from(document.querySelectorAll('section, main > div, [class*="section"]')).filter((s) => s.getBoundingClientRect().height > 200);
  const pads = sections.slice(0, 12).map((s) => parseFloat(getComputedStyle(s).paddingTop) + parseFloat(getComputedStyle(s).paddingBottom)).filter((x) => x > 0);
  const widths = Array.from(document.querySelectorAll('h1, h2, p')).slice(0, 40).map((e) => e.getBoundingClientRect().width).filter((x) => x > 0);
  const libs = [];
  const w = window;
  if (w.gsap || w.TweenMax) libs.push('GSAP'); if (w.ScrollTrigger) libs.push('ScrollTrigger'); if (w.Lenis || w.lenis || document.documentElement.classList.contains('lenis')) libs.push('Lenis smooth scroll');
  if (w.THREE || document.querySelector('canvas[data-engine*="three"]')) libs.push('three.js'); if (w.lottie || document.querySelector('lottie-player, dotlottie-player')) libs.push('Lottie');
  if (document.querySelector('[data-framer-component-type], [data-framer-name]')) libs.push('Framer'); if (w.AOS || document.querySelector('[data-aos]')) libs.push('AOS');
  if (document.querySelector('[data-scroll], [data-scroll-container]')) libs.push('Locomotive scroll'); if (w.Swiper || document.querySelector('.swiper')) libs.push('Swiper');
  if (document.querySelector('[data-w-id]')) libs.push('Webflow interactions');
  const outline = Array.from(document.querySelectorAll('nav a, header a, h1, h2')).map((e) => (e.innerText || '').trim().replace(/\\s+/g, ' ')).filter((t) => t && t.length < 80).slice(0, 30);
  const top = (m, n) => Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    title: document.title.slice(0, 160),
    backgrounds: top(bg, 8).map(([color, area]) => ({ color, area: Math.round(area) })),
    texts: top(tx, 6).map(([color, chars]) => ({ color, chars })),
    accents: top(ac, 6).map(([color, count]) => ({ color, count })),
    fonts: Array.from(fonts.values()).sort((a, b) => b.chars - a.chars).slice(0, 6),
    headings: { h1: size('h1'), h2: size('h2'), h3: size('h3'), body: p ? parseFloat(getComputedStyle(p).fontSize) : null, lineHeight: p ? (parseFloat(getComputedStyle(p).lineHeight) / parseFloat(getComputedStyle(p).fontSize)) || null : null },
    layout: { contentWidth: widths.length ? Math.round(Math.max(...widths)) : W, sections: sections.length, sectionPadding: pads.length ? Math.round(pads.reduce((a, b) => a + b, 0) / pads.length) : null, grids, flexRows, sticky, fullBleedImages: fullBleed },
    shapes: { radii: top(radii, 4).map(([r]) => r), shadows, borders },
    media: { images: document.images.length, svgs: document.querySelectorAll('svg').length, videos: document.querySelectorAll('video').length, canvases: document.querySelectorAll('canvas').length, backgroundImages: bgImages },
    motion: { libraries: libs, cssAnimations: anim, transitions: trans, scrollSnap: /mandatory|proximity/.test(getComputedStyle(document.documentElement).scrollSnapType + getComputedStyle(document.body).scrollSnapType), customCursor: cursor },
    outline,
    _height: H,
  };
})()`;

/** rgb(…) / rgba(…) as #rrggbb (alpha dropped); anything else unchanged. */
export function hex(color: string): string {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
  if (!m) return color;
  return `#${[m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('')}`;
}

/** The measured design in a few readable lines (for the build and its critic). */
export function summarizeStudy(raw: RawStudy): string {
  const bgTotal = raw.backgrounds.reduce((t, b) => t + b.area, 0) || 1;
  const palette = raw.backgrounds
    .filter((b) => b.color !== 'gradient')
    .slice(0, 5)
    .map((b) => `${hex(b.color)} ${Math.round((b.area / bgTotal) * 100)}%`)
    .join(', ');
  const gradient = raw.backgrounds.some((b) => b.color === 'gradient');
  const ink = raw.texts.slice(0, 3).map((t) => hex(t.color)).join(', ');
  const accents = [...new Set(raw.accents.map((a) => hex(a.color)))].slice(0, 4).join(', ');
  const heads = raw.fonts.filter((f) => f.role === 'heading');
  const body = raw.fonts.filter((f) => f.role === 'body');
  const face = (f: RawStudy['fonts'][number]) => `${f.family} ${f.weight}${f.transform && f.transform !== 'none' ? ` ${f.transform}` : ''}${Math.abs(f.letterSpacing) > 0.3 ? ` tracking ${f.letterSpacing.toFixed(1)}px` : ''}`;
  const h = raw.headings;
  const ratio = h.h1 && h.body ? (h.h1 / h.body).toFixed(1) : null;
  const m = raw.motion;
  return [
    `Colours (by area): ${palette || 'not measured'}${gradient ? '; uses gradients' : ''}. Text: ${ink || '—'}. Buttons and links: ${accents || '—'}.`,
    `Type: headings ${heads.map(face).join(' / ') || '—'}; body ${body.map(face).join(' / ') || '—'}. Sizes: h1 ${h.h1 ?? '—'}px, h2 ${h.h2 ?? '—'}px, body ${h.body ?? '—'}px${ratio ? ` (h1 is ${ratio}× the body)` : ''}${h.lineHeight ? `, body line height ${h.lineHeight.toFixed(2)}` : ''}.`,
    `Layout: content up to ${raw.layout.contentWidth}px wide, ${raw.layout.sections} sections${raw.layout.sectionPadding ? ` with about ${raw.layout.sectionPadding}px of vertical space each` : ''}, ${raw.layout.grids} grids, ${raw.layout.flexRows} rows of cards, ${raw.layout.fullBleedImages} full-width pictures, ${raw.layout.sticky} sticky or fixed parts.`,
    `Shapes: corner radii ${raw.shapes.radii.length ? raw.shapes.radii.map((r) => `${r}px`).join(', ') : 'square'}; ${raw.shapes.shadows} shadows; ${raw.shapes.borders} borders.`,
    `Media: ${raw.media.images} pictures, ${raw.media.svgs} SVGs, ${raw.media.videos} videos, ${raw.media.canvases} canvases (WebGL or drawing).`,
    `Motion: ${m.libraries.length ? m.libraries.join(', ') : 'no motion library found'}; ${m.cssAnimations} CSS animations, ${m.transitions} transitions${m.scrollSnap ? ', scroll snapping' : ''}${m.customCursor ? ', a custom cursor' : ''}.`,
  ].join('\n');
}

/** Only public web addresses (never this PC or the local network). */
export function studyableUrl(input: string): URL | null {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return null;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[') || /^\d+$/.test(h)) return null;
  return u;
}

export interface SiteStudy {
  url: string;
  title: string;
  measured: string;
  outline: string[];
  /** Desktop: the first screen and two further down; phone: the first screen (PNG, 960 px wide or less). */
  shots: Buffer[];
}
