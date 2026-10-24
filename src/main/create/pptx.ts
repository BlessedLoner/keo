import { inlineRuns, type LoadedImage } from './docx';
import { fit } from './images';
import type { DeckSpec, SlideSpec } from './specs';
import { appProps, coreProps, esc, IMAGE_REL, OFFICE_DOC_REL, PACKAGE_RELS, writeZip, XML_HEAD } from './zip';

/**
 * PowerPoint decks drawn on a blank layout: every slide is laid out by Keo (title, accent shapes,
 * text sized to fit, pictures, simple charts made of shapes) from a colour theme, so a plain list
 * of slides still looks designed.
 */

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const IN = 914400; // EMU per inch
const SW = 12192000; // 13.333 in (16:9)
const SH = 6858000; // 7.5 in
const M = Math.round(0.65 * IN);

interface Palette {
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  font: string;
}

const PALETTES: Record<DeckSpec['theme'], Palette> = {
  midnight: { bg: '0F172A', surface: '1E293B', text: 'F8FAFC', muted: '94A3B8', accent: '38BDF8', accent2: 'A78BFA', font: 'Segoe UI' },
  ocean: { bg: '0B3C49', surface: '115E67', text: 'F0FDFA', muted: '99D5D3', accent: '2DD4BF', accent2: 'FBBF24', font: 'Segoe UI' },
  sunset: { bg: '1C1917', surface: '292524', text: 'FAFAF9', muted: 'A8A29E', accent: 'F97316', accent2: 'FACC15', font: 'Segoe UI' },
  forest: { bg: '052E16', surface: '14532D', text: 'F0FDF4', muted: '86EFAC', accent: '4ADE80', accent2: 'FDE68A', font: 'Segoe UI' },
  paper: { bg: 'FAFAF7', surface: 'EEF0F4', text: '1E293B', muted: '64748B', accent: '1D4ED8', accent2: '0EA5E9', font: 'Georgia' },
  coral: { bg: 'FFF7F2', surface: 'FFE4D6', text: '3B1F1A', muted: '8A6A60', accent: 'F2545B', accent2: '2A9D8F', font: 'Trebuchet MS' },
  mono: { bg: 'FFFFFF', surface: 'F2F2F2', text: '111111', muted: '6B6B6B', accent: '111111', accent2: '9CA3AF', font: 'Segoe UI' },
};

const lum = (hex: string) => {
  const c = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const mix = (a: string, b: string, t: number) =>
  [0, 2, 4]
    .map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

/** The deck's colours: the theme, with the user's background and accent. Text stays readable on any background. */
export function palette(spec: Pick<DeckSpec, 'theme' | 'accent' | 'background' | 'font'>): Palette {
  const p = { ...PALETTES[spec.theme] };
  if (spec.font) p.font = spec.font;
  if (spec.accent) p.accent = spec.accent;
  if (spec.background) return onBackground(p, spec.background);
  return p;
}

function onBackground(p: Palette, bg: string): Palette {
  const dark = lum(bg) < 0.5;
  const text = dark ? 'F8FAFC' : '1E293B';
  return { ...p, bg, text, muted: mix(text, bg, 0.4), surface: mix(bg, text, 0.08) };
}

// ---------- shapes ----------

class Slide {
  private id = 2;
  readonly shapes: string[] = [];
  readonly images: Array<{ rId: string; name: string; data: Buffer }> = [];
  constructor(readonly p: Palette) {}

  next() {
    return this.id++;
  }

  rect(x: number, y: number, w: number, h: number, fill: string, o: { shape?: 'rect' | 'roundRect' | 'ellipse'; alpha?: number } = {}) {
    const id = this.next();
    const alpha = o.alpha !== undefined ? `<a:alpha val="${Math.round(o.alpha * 100000)}"/>` : '';
    const adj = o.shape === 'roundRect' ? '<a:gd name="adj" fmla="val 6000"/>' : '';
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${r(x)}" y="${r(y)}"/><a:ext cx="${r(w)}" cy="${r(h)}"/></a:xfrm><a:prstGeom prst="${o.shape ?? 'rect'}"><a:avLst>${adj}</a:avLst></a:prstGeom><a:solidFill><a:srgbClr val="${fill}">${alpha}</a:srgbClr></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`,
    );
  }

  text(x: number, y: number, w: number, h: number, paras: Para[], o: { anchor?: 't' | 'ctr' | 'b' } = {}) {
    const id = this.next();
    this.shapes.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${r(x)}" y="${r(y)}"/><a:ext cx="${r(w)}" cy="${r(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${o.anchor ?? 't'}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paras.map((q) => para(q, this.p)).join('')}</p:txBody></p:sp>`,
    );
  }

  picture(rId: string, x: number, y: number, w: number, h: number) {
    const id = this.next();
    this.shapes.push(
      `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${r(x)}" y="${r(y)}"/><a:ext cx="${r(w)}" cy="${r(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`,
    );
  }
}

const r = Math.round;

interface Para {
  text: string;
  size: number;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  align?: 'l' | 'ctr' | 'r';
  bullet?: boolean;
  spaceBefore?: number;
}

function para(q: Para, p: Palette): string {
  const bullet = q.bullet
    ? `<a:buClr><a:srgbClr val="${p.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
    : '<a:buNone/>';
  const indent = q.bullet ? ` marL="${r(q.size * 0.9 * 12700)}" indent="-${r(q.size * 0.9 * 12700)}"` : '';
  const runs = inlineRuns(q.text)
    .map(
      (run) =>
        `<a:r><a:rPr lang="en-US" sz="${r(q.size * 100)}"${q.bold || run.bold ? ' b="1"' : ''}${q.italic || run.italic ? ' i="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${q.color ?? p.text}"/></a:solidFill><a:latin typeface="${esc(p.font)}"/><a:cs typeface="${esc(p.font)}"/></a:rPr><a:t>${esc(run.text)}</a:t></a:r>`,
    )
    .join('');
  return `<a:p><a:pPr algn="${q.align ?? 'l'}"${indent}><a:lnSpc><a:spcPct val="${q.bullet ? 110000 : 100000}"/></a:lnSpc><a:spcBef><a:spcPts val="${r((q.spaceBefore ?? 0) * 100)}"/></a:spcBef>${bullet}</a:pPr>${runs}<a:endParaRPr lang="en-US" sz="${r(q.size * 100)}" dirty="0"/></a:p>`;
}

/** The largest font size (pt) at which these lines fit in a w×h box (EMU), between min and max. */
export function fitSize(lines: string[], w: number, h: number, max: number, min: number, gap = 0.5): number {
  for (let s = max; s > min; s -= 1) {
    const perLine = Math.max(4, Math.floor((w / IN) * 72 / (s * 0.52)));
    const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
    const need = (rows * s * 1.2 + lines.length * s * gap) / 72;
    if (need <= h / IN) return s;
  }
  return min;
}

function bullets(sl: Slide, items: string[], x: number, y: number, w: number, h: number, max = 26) {
  const size = fitSize(items, w - 0.3 * IN, h, max, 12);
  sl.text(x, y, w, h, items.map((t) => ({ text: t, size, bullet: true, spaceBefore: size * 0.5 })));
}

function title(sl: Slide, text: string, p: Palette) {
  const size = fitSize([text], SW - 2 * M, 1.0 * IN, 36, 20, 0);
  sl.text(M, 0.45 * IN, SW - 2 * M, 1.0 * IN, [{ text, size, bold: true }], { anchor: 'b' });
  sl.rect(M, 1.58 * IN, 1.1 * IN, 0.07 * IN, p.accent);
}

function placeImage(sl: Slide, img: LoadedImage | undefined, rId: string, x: number, y: number, w: number, h: number) {
  if (!img) return;
  const f = fit(img.info.width, img.info.height, w, h);
  sl.picture(rId, x + (w - f.w) / 2, y + (h - f.h) / 2, f.w, f.h);
}

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}k`;
  return `${+n.toFixed(a < 10 ? 2 : 1)}`;
};
const withUnit = (n: number, unit?: string) => {
  const v = compact(n);
  if (!unit) return v;
  if (unit === '%') return `${v}%`;
  return unit.length <= 3 && !/[a-z]/i.test(unit) ? `${unit}${v}` : `${v} ${unit}`;
};

function chart(sl: Slide, c: NonNullable<SlideSpec['chart']>, x: number, y: number, w: number, h: number, p: Palette) {
  const colours = [p.accent, p.accent2, p.muted];
  const all = c.series.flatMap((s) => s.values);
  const hi = Math.max(0, ...all);
  const lo = Math.min(0, ...all);
  const span = hi - lo || 1;
  const n = c.labels.length;
  const k = c.series.length;
  const label = (q: Para, bx: number, by: number, bw: number, bh: number, anchor: 't' | 'ctr' | 'b' = 'ctr') => sl.text(bx, by, bw, bh, [q], { anchor });
  // Legend above the chart for more than one series.
  let top = y;
  if (k > 1) {
    let lx = x;
    for (const [i, s] of c.series.entries()) {
      sl.rect(lx, y + 0.08 * IN, 0.18 * IN, 0.18 * IN, colours[i]!, { shape: 'roundRect' });
      label({ text: s.name, size: 12, color: p.muted }, lx + 0.26 * IN, y, 2.2 * IN, 0.34 * IN);
      lx += 2.6 * IN;
    }
    top += 0.5 * IN;
  }
  const ch = y + h - top;
  if (c.kind === 'column') {
    const plotH = ch - 0.45 * IN;
    const zero = top + plotH * (hi / span);
    const group = w / n;
    const bw = (group * 0.7) / k;
    // Light gridlines at quarters of the highest value (all-positive charts).
    if (lo === 0) for (let g = 1; g <= 4; g++) sl.rect(x, top + plotH * (1 - g / 4), w, 0.01 * IN, p.muted, { alpha: 0.25 });
    sl.rect(x, zero, w, 0.015 * IN, p.muted, { alpha: 0.6 });
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < k; s++) {
        const v = c.series[s]!.values[i] ?? 0;
        const bh = (Math.abs(v) / span) * plotH;
        const bx = x + i * group + group * 0.15 + s * bw;
        const by = v >= 0 ? zero - bh : zero;
        sl.rect(bx, by, bw * 0.92, Math.max(bh, 0.01 * IN), colours[s]!);
        const size = Math.max(9, Math.min(14, (bw / IN) * 22));
        label({ text: withUnit(v, c.unit), size, color: p.text, align: 'ctr' }, bx - 0.2 * IN, v >= 0 ? by - 0.3 * IN : by + bh, bw * 0.92 + 0.4 * IN, 0.28 * IN, v >= 0 ? 'b' : 't');
      }
      label({ text: c.labels[i]!, size: Math.max(10, Math.min(14, (group / IN) * 9)), color: p.muted, align: 'ctr' }, x + i * group, top + plotH + 0.08 * IN, group, 0.36 * IN, 't');
    }
  } else {
    const labelW = Math.min(2.6 * IN, w * 0.28);
    const plotW = w - labelW - 0.9 * IN;
    const zero = x + labelW + plotW * (-lo / span);
    const group = ch / n;
    const bh = (group * 0.7) / k;
    sl.rect(zero, top, 0.015 * IN, ch, p.muted, { alpha: 0.6 });
    for (let i = 0; i < n; i++) {
      label({ text: c.labels[i]!, size: Math.max(10, Math.min(16, (group / IN) * 22)), color: p.muted, align: 'r' }, x, top + i * group, labelW - 0.15 * IN, group);
      for (let s = 0; s < k; s++) {
        const v = c.series[s]!.values[i] ?? 0;
        const bw = (Math.abs(v) / span) * plotW;
        const by = top + i * group + group * 0.15 + s * bh;
        const bx = v >= 0 ? zero : zero - bw;
        sl.rect(bx, by, Math.max(bw, 0.01 * IN), bh * 0.9, colours[s]!);
        label({ text: withUnit(v, c.unit), size: Math.max(9, Math.min(14, (bh / IN) * 30)), color: p.text, align: v >= 0 ? 'l' : 'r' }, v >= 0 ? bx + bw + 0.08 * IN : bx - 0.9 * IN, by, 0.82 * IN, bh * 0.9);
      }
    }
  }
}

function drawSlide(s: SlideSpec, index: number, total: number, deck: DeckSpec, base: Palette, images: Map<string, LoadedImage>): Slide {
  const p = s.background ? onBackground(base, s.background) : base;
  const sl = new Slide(p);
  const rIdImage = 'rId2';
  const img = s.image ? images.get(s.image) : undefined;
  if (img) sl.images.push({ rId: rIdImage, name: `image${index + 1}.${img.info.ext}`, data: img.data });
  const body = { x: M, y: 1.95 * IN, w: SW - 2 * M, h: SH - 1.95 * IN - 0.7 * IN };

  switch (s.layout) {
    case 'title':
    case 'closing': {
      // Soft accent circles in the corner, a bar beside the title.
      sl.rect(SW - 4.6 * IN, -1.6 * IN, 6.2 * IN, 6.2 * IN, p.accent, { shape: 'ellipse', alpha: 0.14 });
      sl.rect(SW - 2.6 * IN, 3.9 * IN, 3.6 * IN, 3.6 * IN, p.accent2, { shape: 'ellipse', alpha: 0.12 });
      const centre = s.layout === 'closing';
      const size = fitSize([s.title], 9.6 * IN, 2.0 * IN, centre ? 48 : 54, 28, 0);
      if (!centre) sl.rect(M, 2.25 * IN, 0.1 * IN, 2.55 * IN, p.accent);
      const tx = centre ? M : M + 0.4 * IN;
      const tw = centre ? SW - 2 * M : 9.6 * IN;
      sl.text(tx, 2.1 * IN, tw, 2.0 * IN, [{ text: s.title, size, bold: true, align: centre ? 'ctr' : 'l' }], { anchor: 'b' });
      if (s.subtitle) sl.text(tx, 4.25 * IN, tw, 1.2 * IN, [{ text: s.subtitle, size: fitSize([s.subtitle], tw, 1.2 * IN, 22, 14, 0), color: p.muted, align: centre ? 'ctr' : 'l' }]);
      break;
    }
    case 'section': {
      sl.rect(0, 0, 0.35 * IN, SH, p.accent);
      sl.text(M + 0.3 * IN, 1.6 * IN, 3 * IN, 1.2 * IN, [{ text: String(index + 1).padStart(2, '0'), size: 60, bold: true, color: p.accent }], { anchor: 'b' });
      sl.text(M + 0.3 * IN, 2.9 * IN, SW - 2 * M - 0.6 * IN, 1.6 * IN, [{ text: s.title, size: fitSize([s.title], SW - 2 * M, 1.6 * IN, 44, 24, 0), bold: true }]);
      if (s.subtitle) sl.text(M + 0.3 * IN, 4.6 * IN, SW - 2 * M - 0.6 * IN, 1 * IN, [{ text: s.subtitle, size: 20, color: p.muted }]);
      break;
    }
    case 'quote': {
      sl.text(M, 0.7 * IN, 2 * IN, 1.6 * IN, [{ text: '“', size: 140, bold: true, color: p.accent }]);
      const q = s.quote ?? s.title;
      sl.text(M + 0.9 * IN, 2.0 * IN, SW - 2 * M - 1.8 * IN, 3.2 * IN, [{ text: q, size: fitSize([q], SW - 2 * M - 1.8 * IN, 3.2 * IN, 34, 18, 0), italic: true }], { anchor: 'ctr' });
      const by = s.subtitle ?? (s.quote ? s.title : '');
      if (by) sl.text(M + 0.9 * IN, 5.4 * IN, SW - 2 * M - 1.8 * IN, 0.6 * IN, [{ text: `— ${by}`, size: 18, color: p.muted }]);
      break;
    }
    case 'two_column': {
      title(sl, s.title, p);
      const gap = 0.4 * IN;
      const cw = (body.w - gap) / 2;
      for (const [i, col] of [
        [s.leftHeading, s.bullets ?? []],
        [s.rightHeading, s.right ?? []],
      ].entries()) {
        const [head, items] = col as [string | undefined, string[]];
        const cx = body.x + i * (cw + gap);
        sl.rect(cx, body.y, cw, body.h, p.surface, { shape: 'roundRect' });
        sl.rect(cx, body.y, cw, 0.08 * IN, i ? p.accent2 : p.accent);
        let ty = body.y + 0.35 * IN;
        if (head) {
          sl.text(cx + 0.35 * IN, ty, cw - 0.7 * IN, 0.5 * IN, [{ text: head, size: 20, bold: true, color: i ? p.accent2 : p.accent }]);
          ty += 0.65 * IN;
        }
        if (items.length) bullets(sl, items, cx + 0.35 * IN, ty, cw - 0.7 * IN, body.y + body.h - ty - 0.25 * IN, 22);
      }
      break;
    }
    case 'image': {
      title(sl, s.title, p);
      if (s.bullets?.length) {
        const iw = body.w * 0.55;
        placeImage(sl, img, rIdImage, body.x, body.y, iw, body.h);
        bullets(sl, s.bullets, body.x + iw + 0.45 * IN, body.y, body.w - iw - 0.45 * IN, body.h, 22);
      } else placeImage(sl, img, rIdImage, body.x, body.y, body.w, body.h);
      break;
    }
    case 'chart': {
      title(sl, s.title, p);
      const side = s.bullets?.length ? 3.6 * IN : 0;
      if (s.chart) chart(sl, s.chart, body.x, body.y, body.w - side - (side ? 0.4 * IN : 0), body.h, p);
      if (side) bullets(sl, s.bullets!, body.x + body.w - side, body.y, side, body.h, 18);
      break;
    }
    default: {
      title(sl, s.title, p);
      if (img) {
        const iw = body.w * 0.42;
        bullets(sl, s.bullets ?? [], body.x, body.y, body.w - iw - 0.45 * IN, body.h);
        placeImage(sl, img, rIdImage, body.x + body.w - iw, body.y, iw, body.h);
      } else if (s.bullets?.length) bullets(sl, s.bullets, body.x, body.y, body.w, body.h);
      if (s.subtitle && !s.bullets?.length) sl.text(body.x, body.y, body.w, body.h, [{ text: s.subtitle, size: fitSize([s.subtitle], body.w, body.h, 24, 14), color: p.muted }]);
    }
  }
  if (deck.slideNumbers && s.layout !== 'title' && s.layout !== 'closing') {
    sl.text(SW - M - 1.5 * IN, SH - 0.55 * IN, 1.5 * IN, 0.3 * IN, [{ text: `${index + 1} / ${total}`, size: 11, color: p.muted, align: 'r' }]);
  }
  return sl;
}

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const REL = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const RELS = (inner: string) => `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${inner}</Relationships>`;

export function buildPptx(spec: DeckSpec, images: Map<string, LoadedImage>, now = new Date()): Buffer {
  const p = palette(spec);
  const slides = spec.slides.map((s, i) => drawSlide(s, i, spec.slides.length, spec, p, images));
  const files: Array<{ name: string; data: string | Buffer }> = [];
  const ct = (part: string, type: string) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}"/>`;
  files.push({
    name: '[Content_Types].xml',
    data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>${ct('/ppt/presentation.xml', 'presentationml.presentation.main+xml')}${ct('/ppt/slideMasters/slideMaster1.xml', 'presentationml.slideMaster+xml')}${ct('/ppt/slideLayouts/slideLayout1.xml', 'presentationml.slideLayout+xml')}${ct('/ppt/theme/theme1.xml', 'theme+xml')}${ct('/ppt/presProps.xml', 'presentationml.presProps+xml')}${ct('/ppt/viewProps.xml', 'presentationml.viewProps+xml')}${ct('/ppt/tableStyles.xml', 'presentationml.tableStyles+xml')}${slides.map((_, i) => ct(`/ppt/slides/slide${i + 1}.xml`, 'presentationml.slide+xml')).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>${ct('/docProps/app.xml', 'extended-properties+xml')}</Types>`,
  });
  files.push({ name: '_rels/.rels', data: PACKAGE_RELS('ppt/presentation.xml', OFFICE_DOC_REL) });
  files.push({ name: 'docProps/core.xml', data: coreProps(spec.title, now) });
  files.push({ name: 'docProps/app.xml', data: appProps('Keo') });
  files.push({
    name: 'ppt/presentation.xml',
    data: `${XML_HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${SW}" cy="${SH}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  });
  files.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: RELS(`${REL('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml')}${REL('rId2', 'theme', 'theme/theme1.xml')}${REL('rId3', 'presProps', 'presProps.xml')}${REL('rId4', 'viewProps', 'viewProps.xml')}${REL('rId5', 'tableStyles', 'tableStyles.xml')}${slides.map((_, i) => REL(`rId${10 + i}`, 'slide', `slides/slide${i + 1}.xml`)).join('')}`),
  });
  files.push({ name: 'ppt/presProps.xml', data: `${XML_HEAD}<p:presentationPr ${NS}/>` });
  files.push({ name: 'ppt/viewProps.xml', data: `${XML_HEAD}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` });
  files.push({ name: 'ppt/tableStyles.xml', data: `${XML_HEAD}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` });
  files.push({ name: 'ppt/theme/theme1.xml', data: theme(p) });
  files.push({
    name: 'ppt/slideMasters/slideMaster1.xml',
    data: `${XML_HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${p.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3600"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`,
  });
  files.push({ name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: RELS(`${REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')}${REL('rId2', 'theme', '../theme/theme1.xml')}`) });
  files.push({ name: 'ppt/slideLayouts/slideLayout1.xml', data: `${XML_HEAD}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` });
  files.push({ name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: RELS(REL('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')) });
  slides.forEach((sl, i) => {
    const bg = sl.p.bg;
    files.push({
      name: `ppt/slides/slide${i + 1}.xml`,
      data: `${XML_HEAD}<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${sl.shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`,
    });
    files.push({
      name: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data: RELS(`${REL('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')}${sl.images.map((m) => `<Relationship Id="${m.rId}" Type="${IMAGE_REL}" Target="../media/${m.name}"/>`).join('')}`),
    });
    for (const m of sl.images) files.push({ name: `ppt/media/${m.name}`, data: m.data });
  });
  return writeZip(files);
}

function theme(p: Palette): string {
  const f = esc(p.font);
  const dark = lum(p.bg) < 0.5;
  // The master maps background 1 to lt1 and text 1 to dk1, so boxes the user adds later get the deck's colours.
  const [dk1, lt1] = [p.text, p.bg];
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML_HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Keo"><a:themeElements><a:clrScheme name="Keo"><a:dk1><a:srgbClr val="${dk1}"/></a:dk1><a:lt1><a:srgbClr val="${lt1}"/></a:lt1><a:dk2><a:srgbClr val="${dark ? p.surface : p.text}"/></a:dk2><a:lt2><a:srgbClr val="${dark ? p.muted : p.surface}"/></a:lt2><a:accent1><a:srgbClr val="${p.accent}"/></a:accent1><a:accent2><a:srgbClr val="${p.accent2}"/></a:accent2><a:accent3><a:srgbClr val="${p.muted}"/></a:accent3><a:accent4><a:srgbClr val="${mix(p.accent, p.accent2, 0.5)}"/></a:accent4><a:accent5><a:srgbClr val="${mix(p.accent, p.bg, 0.4)}"/></a:accent5><a:accent6><a:srgbClr val="${mix(p.accent2, p.bg, 0.4)}"/></a:accent6><a:hlink><a:srgbClr val="${p.accent}"/></a:hlink><a:folHlink><a:srgbClr val="${p.accent2}"/></a:folHlink></a:clrScheme><a:fontScheme name="Keo"><a:majorFont><a:latin typeface="${f}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${f}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Keo"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}
