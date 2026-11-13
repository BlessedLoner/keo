import { useEffect, useMemo, useRef, useState } from 'react';
import { applyEdits, FONT_KIND, KEO_FONTS, LOOK_LABEL, LOOKS, MOTION_PIECE_INFO, MOTION_PIECES, newProject, SYSTEM_FONTS, TRANSITIONS, type Clip, type EditOp, type Effects, type LookId, type Project, type Transition } from '@shared/studio';
import type { Brand } from '@shared/studioBrand';
import { PRESETS, presetOps, type PresetId } from '@shared/studioPresets';
import { STARTER_TEMPLATES } from '@shared/studioTemplates';
import { blueprintFollowUps, blueprintOps, type Blueprint } from '@shared/editDna';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { TEXT_STYLES } from './Bin';
import { drawFrame, type SourceProvider } from './engine';
import { MOTION_SAMPLE, NEEDS_MEDIA, PRESET_LABEL } from './MotionFields';
import { TRANSITION_LABEL } from './Timeline';

/**
 * Keo Studio's live library: every card is drawn by Studio's own picture engine, so what you see
 * is exactly what you get. Transitions and effects play over and over while they are on screen;
 * templates, text and shapes play when you point at them.
 */

// ---------------------------------------------------------------- one clock for every card

const tickers = new Set<(t: number) => void>();
let raf = 0;
let last = 0;
function loop(now: number) {
  // About 24 frames a second is smooth for small cards and light on the computer.
  if (now - last >= 40) {
    last = now;
    for (const f of tickers) f(now / 1000);
  }
  raf = tickers.size ? requestAnimationFrame(loop) : 0;
}
function onTick(f: (t: number) => void): () => void {
  tickers.add(f);
  if (!raf) raf = requestAnimationFrame(loop);
  return () => {
    tickers.delete(f);
  };
}

// ---------------------------------------------------------------- sample pictures

let samples: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
/** Two pictures to show transitions and effects on: a sunset over water, and a neon city at night. */
function samplePictures(): [HTMLCanvasElement, HTMLCanvasElement] {
  if (samples) return samples;
  const make = (paint: (c: CanvasRenderingContext2D, w: number, h: number) => void) => {
    const cv = document.createElement('canvas');
    cv.width = 640;
    cv.height = 640;
    paint(cv.getContext('2d')!, 640, 640);
    return cv;
  };
  const sunset = make((c, w, h) => {
    const sky = c.createLinearGradient(0, 0, 0, h * 0.62);
    sky.addColorStop(0, '#1d2b64');
    sky.addColorStop(0.55, '#c0587e');
    sky.addColorStop(1, '#f8b267');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h);
    const sun = c.createRadialGradient(w * 0.5, h * 0.6, 0, w * 0.5, h * 0.6, w * 0.22);
    sun.addColorStop(0, '#fff6d5');
    sun.addColorStop(0.35, '#ffd27a');
    sun.addColorStop(1, 'rgba(255,170,90,0)');
    c.fillStyle = sun;
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#2a1d3a';
    c.beginPath();
    c.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 20) c.lineTo(x, h * (0.5 + 0.06 * Math.sin(x / 70) + 0.04 * Math.sin(x / 23)));
    c.lineTo(w, h * 0.62);
    c.fill();
    const sea = c.createLinearGradient(0, h * 0.62, 0, h);
    sea.addColorStop(0, '#d97b6c');
    sea.addColorStop(1, '#141a3a');
    c.fillStyle = sea;
    c.fillRect(0, h * 0.62, w, h * 0.38);
    c.globalAlpha = 0.5;
    c.fillStyle = '#ffe4a8';
    for (let i = 0; i < 9; i++) c.fillRect(w * 0.5 - (60 - i * 6), h * (0.64 + i * 0.03), (60 - i * 6) * 2, 3);
    c.globalAlpha = 1;
  });
  const city = make((c, w, h) => {
    const sky = c.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#07091a');
    sky.addColorStop(1, '#2a0f3d');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, h);
    let seed = 7;
    const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 14; i++) {
      const bw = 30 + rnd() * 60;
      const bx = (i / 14) * w + rnd() * 10;
      const bh = h * (0.25 + rnd() * 0.5);
      c.fillStyle = i % 2 ? '#141933' : '#1b1240';
      c.fillRect(bx, h - bh, bw, bh);
      for (let y = h - bh + 10; y < h - 8; y += 14)
        for (let x = bx + 5; x < bx + bw - 6; x += 10) {
          if (rnd() < 0.45) continue;
          c.fillStyle = rnd() < 0.5 ? '#ff3df0' : rnd() < 0.5 ? '#36e2ff' : '#ffd36b';
          c.globalAlpha = 0.55 + rnd() * 0.45;
          c.fillRect(x, y, 4, 6);
        }
      c.globalAlpha = 1;
    }
    const glow = c.createRadialGradient(w * 0.7, h * 0.25, 0, w * 0.7, h * 0.25, w * 0.35);
    glow.addColorStop(0, 'rgba(255,61,240,0.45)');
    glow.addColorStop(1, 'rgba(255,61,240,0)');
    c.fillStyle = glow;
    c.fillRect(0, 0, w, h);
  });
  return (samples = [sunset, city]);
}

const A = 'as_sampleaa';
const B = 'as_samplebb';
const sampleSources: SourceProvider = { frame: (clip) => (clip.assetId === B ? samplePictures()[1] : samplePictures()[0]) };

/** A project of this shape with the two sample pictures as media. */
function stage(shape: { width: number; height: number }): Project {
  const p = newProject({ name: 'Preview', format: 'square' });
  const img = (id: string, name: string) => ({ id, kind: 'image', name, path: `C:/keo-sample/${name}.png`, duration: 10, width: 640, height: 640, hasAudio: false });
  return { ...p, width: shape.width, height: shape.height, background: '#15171E', assets: [img(A, 'sunset'), img(B, 'city')] as never };
}

// ---------------------------------------------------------------- one card

type Draw = (ctx: CanvasRenderingContext2D, t: number) => void;

/**
 * One live card. play: 'always' (while on screen), 'hover' (a still frame until pointed at).
 * The canvas is drawn at the card's own size, so it stays sharp and cheap.
 */
export function LiveCard({ draw, still, play, aspect, label, sub, on, onClick, onDoubleClick, title, draggable, onDragStart }: { draw: Draw; still: number; play: 'always' | 'hover'; aspect: number; label: string; sub?: string; on?: boolean; onClick: () => void; onDoubleClick?: () => void; title?: string; draggable?: boolean; onDragStart?: (e: React.DragEvent) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const io = new IntersectionObserver(([e]) => setSeen(!!e?.isIntersecting));
    io.observe(c);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !seen) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(40, Math.round(c.clientWidth * dpr));
    const h = Math.round(w / aspect);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d')!;
    const paint = (t: number) => {
      try {
        draw(ctx, t);
      } catch {
        /* a card that cannot be drawn stays as it was */
      }
    };
    if (play === 'hover' && !hover) {
      paint(still);
      return;
    }
    const t0 = performance.now() / 1000;
    return onTick((now) => paint(now - t0));
  }, [draw, still, play, hover, seen, aspect]);
  return (
    <button className={`live-card ${on ? 'on' : ''}`} onClick={onClick} onDoubleClick={onDoubleClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} title={title} draggable={draggable} onDragStart={onDragStart}>
      <canvas ref={canvas} style={{ aspectRatio: String(aspect) }} />
      <span className="live-label">{label}</span>
      {sub && <span className="live-sub">{sub}</span>}
    </button>
  );
}

/** A still or looping frame of a small project, drawn by the engine. */
function projectDraw(p: Project | null, from = 0, loopSeconds = 0): Draw {
  return (ctx, t) => {
    if (!p) return;
    drawFrame(ctx, p, loopSeconds ? from + (t % loopSeconds) : t, sampleSources);
  };
}

/**
 * An Edit DNA blueprint's preview: its structure (shot timing, transitions, camera moves, text,
 * graphics, effects) played on Keo's two sample pictures — never the reference's own footage.
 */
export function dnaPreviewDraw(b: Blueprint, shape: { width: number; height: number }): Draw {
  let p: Project | null = stage(previewShapeOf(shape));
  try {
    const built = blueprintOps(b, p, [
      { assetId: A, kind: 'image', duration: 3600 },
      { assetId: B, kind: 'image', duration: 3600 },
    ], { at: 0, trackName: 'Preview' });
    p = applyEdits(p, built.ops).project;
    const ids = p.tracks
      .filter((t) => t.name === 'Preview')
      .flatMap((t) => t.clips)
      .filter((c) => c.type === 'media')
      .sort((x, y) => x.start - y.start)
      .map((c) => c.id);
    p = applyEdits(p, blueprintFollowUps(b, ids)).project;
  } catch {
    p = null;
  }
  return projectDraw(p, 0, Math.max(1, Math.min(b.seconds, 120)));
}
function previewShapeOf(p: { width: number; height: number }): { width: number; height: number } {
  const r = p.width / p.height;
  return r < 0.8 ? { width: 1080, height: 1350 } : r > 1.3 ? { width: 1920, height: 1080 } : { width: 1080, height: 1080 };
}

// ---------------------------------------------------------------- transitions, effects, looks

export function TransitionGallery({ current, onPick, onPickAll, note }: { current: Transition['kind'] | null; onPick: (k: Transition['kind']) => void; onPickAll?: (k: Transition['kind']) => void; note: string }) {
  const draws = useMemo(
    () =>
      Object.fromEntries(
        TRANSITIONS.map((k) => {
          let p = stage({ width: 1080, height: 1080 });
          p = applyEdits(p, [{ op: 'add_media', assetId: A, start: 0, duration: 1.6 }, { op: 'add_media', assetId: B, start: 1.6, duration: 1.6 }]).project;
          const second = p.tracks.flatMap((t) => t.clips)[1]!;
          p = applyEdits(p, [{ op: 'set', clip: second.id, transition: { kind: k, seconds: 0.9 } }]).project;
          // Each loop: a moment of the first picture, the change, a moment of the second.
          return [k, projectDraw(p, 0.95, 1.35)];
        }),
      ) as Record<Transition['kind'], Draw>,
    [],
  );
  return (
    <>
      <p className="lib-note small muted">{note}</p>
      <div className="live-grid">
        {TRANSITIONS.map((k) => (
          <LiveCard key={k} draw={draws[k]} still={1.6} play="always" aspect={1} label={TRANSITION_LABEL[k]} on={current === k} onClick={() => onPick(k)} {...(onPickAll ? { onDoubleClick: () => onPickAll(k) } : {})} title={`${TRANSITION_LABEL[k]}${onPickAll ? ' — double-click to put it on every cut' : ''}`} />
        ))}
      </div>
    </>
  );
}

export const EFFECT_LIST: Array<[keyof Effects, string]> = [
  ['letterbox', 'Cinema bars'],
  ['filmBurn', 'Film burn'],
  ['dream', 'Dreamy'],
  ['grain', 'Film grain'],
  ['vhs', 'VHS'],
  ['glow', 'Glow'],
  ['rgbSplit', 'RGB split'],
  ['lightLeak', 'Light leak'],
  ['glitch', 'Glitch'],
  ['crt', 'Old TV'],
  ['sparkle', 'Sparkles'],
  ['bokeh', 'Bokeh'],
  ['prism', 'Prism flare'],
  ['strobe', 'Strobe'],
];

export function EffectGallery({ active, onPick, note }: { active: (k: keyof Effects) => boolean; onPick: (k: keyof Effects) => void; note: string }) {
  const draws = useMemo(
    () =>
      Object.fromEntries(
        EFFECT_LIST.map(([k], i) => {
          let p = stage({ width: 1080, height: 1080 });
          p = applyEdits(p, [{ op: 'add_media', assetId: i % 2 ? B : A, start: 0, duration: 600 }]).project;
          const c = p.tracks.flatMap((t) => t.clips)[0]!;
          p = applyEdits(p, [{ op: 'set', clip: c.id, effects: { [k]: 0.9 } }]).project;
          return [k, projectDraw(p, 0, 600)];
        }),
      ) as Record<keyof Effects, Draw>,
    [],
  );
  return (
    <>
      <p className="lib-note small muted">{note}</p>
      <div className="live-grid">
        {EFFECT_LIST.map(([k, label]) => (
          <LiveCard key={k} draw={draws[k]} still={1} play="always" aspect={1} label={label} on={active(k)} onClick={() => onPick(k)} />
        ))}
      </div>
    </>
  );
}

export function LookGallery({ onPick, note }: { onPick: (k: LookId) => void; note: string }) {
  const draws = useMemo(
    () =>
      Object.fromEntries(
        (Object.keys(LOOKS) as LookId[]).map((k, i) => {
          let p = stage({ width: 1080, height: 1080 });
          p = applyEdits(p, [{ op: 'add_media', assetId: i % 3 === 2 ? B : A, start: 0, duration: 5 }]).project;
          const c = p.tracks.flatMap((t) => t.clips)[0]!;
          p = applyEdits(p, [{ op: 'set', clip: c.id, color: { ...LOOKS[k] } }]).project;
          return [k, projectDraw(p, 1, 0)];
        }),
      ) as Record<LookId, Draw>,
    [],
  );
  return (
    <>
      <p className="lib-note small muted">{note}</p>
      <div className="live-grid">
        {(Object.keys(LOOKS) as LookId[]).map((k) => (
          <LiveCard key={k} draw={draws[k]} still={1} play="hover" aspect={1} label={LOOK_LABEL[k]} onClick={() => onPick(k)} />
        ))}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- templates, motion, text, shapes

interface Item {
  id: string;
  name: string;
  sub: string;
  group: string;
  seconds: number;
  hero: number;
  ops: (at: number, brand: Brand, project: Project) => EditOp[];
}

const PIECE_SECONDS = (piece: (typeof MOTION_PIECES)[number]) => (piece === 'light_sweep' ? 1.2 : piece === 'scene' ? 2.5 : piece === 'scene3d' ? 12 : 4);

/** Everything the Templates tab offers: Keo's templates, its motion graphics and its animated presets. */
export const GALLERY_ITEMS: Item[] = [
  ...MOTION_PIECES.map(
    (piece): Item => ({
      id: `motion-${piece}`,
      name: MOTION_PIECE_INFO[piece].label,
      sub: 'Motion graphic',
      group: 'Motion graphics',
      seconds: PIECE_SECONDS(piece),
      hero: Math.min(PIECE_SECONDS(piece) * 0.7, 2.6),
      ops: (at) => [{ op: 'add_motion', piece, place: 'auto', start: at, duration: PIECE_SECONDS(piece), ...MOTION_SAMPLE[piece] }],
    }),
  ),
  ...(Object.keys(PRESETS) as PresetId[]).map(
    (id): Item => ({
      id: `preset-${id}`,
      name: PRESET_LABEL[id],
      sub: NEEDS_MEDIA.includes(id) ? 'Animated · uses your media' : 'Animated',
      group: 'Animated',
      seconds: 3,
      hero: 1.6,
      ops: (at, _b, p) => {
        const media = p.assets.filter((a) => a.kind !== 'audio').at(-1)?.id;
        if (NEEDS_MEDIA.includes(id) && !media) throw new Error('Add a picture or video to Media first: this one shows your media.');
        return presetOps(p, id, { at, ...(NEEDS_MEDIA.includes(id) && media ? { assetId: media } : {}) });
      },
    }),
  ),
  ...STARTER_TEMPLATES.map((t): Item => ({ id: t.id, name: t.name, sub: t.category, group: t.category, seconds: t.seconds, hero: t.hero, ops: (at, b) => t.ops(at, b) })),
];

export const GALLERY_GROUPS = ['Motion graphics', 'Animated', ...new Set(STARTER_TEMPLATES.map((t) => t.category))];

function useBrand(): Brand {
  const [brand, setBrand] = useState<Brand>({});
  useEffect(() => {
    void invoke('studio:brand', {})
      .then(setBrand)
      .catch(() => undefined);
  }, []);
  return brand;
}

/** A card for anything made of edits: a preview project of the user's shape with the edits at 0. */
function useItemDraw(ops: (at: number) => EditOp[], shape: { width: number; height: number }, seconds: number, media = false): Draw {
  return useMemo(() => {
    let p: Project | null = stage(shape);
    try {
      if (media) p = applyEdits(p, [{ op: 'add_media', assetId: A, start: 0, duration: seconds }]).project;
      p = applyEdits(p, ops(0)).project;
    } catch {
      p = null;
    }
    return projectDraw(p, 0, seconds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape.width, shape.height, seconds, media, ops]);
}

function ItemCard({ item, project, brand, time, onEdit }: { item: Item; project: Project; brand: Brand; time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const ui = useUi();
  const shape = previewShape(project);
  // Previews use the sample picture as "your media".
  const previewOps = useMemo(() => (at: number) => item.ops(at, brand, { ...stage(shape), assets: [...stage(shape).assets] }), [item, brand, shape]);
  // Over a sample picture, as it would look over footage (full-screen pieces cover it anyway).
  const draw = useItemDraw(previewOps, shape, item.seconds, true);
  return (
    <LiveCard
      draw={draw}
      still={item.hero}
      play="hover"
      aspect={shape.width / shape.height}
      label={item.name}
      sub={item.sub}
      title={`${item.name} — click to put it at the playhead`}
      onClick={() => {
        try {
          void onEdit(item.ops(Math.max(0, time), brand, project)).catch((e: unknown) => ui.error(errText(e)));
        } catch (e) {
          ui.error(errText(e));
        }
      }}
    />
  );
}

/** Cards follow the project's shape, but never taller than 4:5 (a tall grid would need much scrolling). */
function previewShape(p: { width: number; height: number }): { width: number; height: number } {
  const r = p.width / p.height;
  return r < 0.8 ? { width: 1080, height: 1350 } : r > 1.3 ? { width: 1920, height: 1080 } : { width: 1080, height: 1080 };
}

export function TemplateGallery({ project, time, group, onEdit }: { project: Project; time: number; group: string; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const brand = useBrand();
  const items = GALLERY_ITEMS.filter((i) => group === 'all' || i.group === group);
  return (
    <>
      <p className="lib-note small muted">Point at a card to play it; click to put it at the playhead. Everything stays editable, in your brand colours.</p>
      <div className="live-grid">
        {items.map((i) => (
          <ItemCard key={i.id} item={i} project={project} brand={brand} time={time} onEdit={onEdit} />
        ))}
      </div>
    </>
  );
}

/** Text styles, drawn live: what you see is the text Keo adds. */
export function TextStyleGallery({ project, time, onEdit }: { project: Project; time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const brand = useBrand();
  const items: Item[] = TEXT_STYLES.map((s) => ({
    id: `text-${s.id}`,
    name: s.label,
    sub: 'Text style',
    group: 'Text',
    seconds: s.duration ?? 3,
    hero: 1.4,
    ops: (at) => [{ op: 'add_text', text: s.id === 'quote' ? '“Your words”' : s.id === 'caption' ? 'SAY IT LOUD' : s.label === 'Title' ? 'YOUR TITLE' : s.sample, start: at, duration: s.duration ?? 3, style: s.style, animIn: s.animIn, animOut: s.animOut ?? 'fade', transform: { y: 0.5 } }],
  }));
  return (
    <div className="live-grid">
      {items.map((i) => (
        <ItemCard key={i.id} item={i} project={project} brand={brand} time={time} onEdit={onEdit} />
      ))}
    </div>
  );
}

const SHAPES: Array<[Extract<EditOp, { op: 'add_shape' }>['shape'], string]> = [
  ['rect', 'Rectangle'],
  ['circle', 'Circle'],
  ['ring', 'Ring'],
  ['line', 'Line'],
  ['arrow', 'Arrow'],
  ['star', 'Star'],
  ['triangle', 'Triangle'],
];

export function ShapeGallery({ project, time, onEdit }: { project: Project; time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const brand = useBrand();
  const items: Item[] = SHAPES.map(([shape, name]) => ({
    id: `shape-${shape}`,
    name,
    sub: 'Shape',
    group: 'Shapes',
    seconds: 2.4,
    hero: 1,
    ops: (at, b, p) => {
      const side = 0.3 * Math.min(p.width, p.height);
      const round = shape === 'circle' || shape === 'ring' || shape === 'star';
      const style = round ? { width: side / p.width, height: side / p.height } : shape === 'line' || shape === 'arrow' ? { width: 0.4, height: 0.05, strokeWidth: 10 } : { width: 0.3, height: 0.12 };
      return [{ op: 'add_shape', shape, start: at, duration: 3, style: { ...style, fill: b.accent ?? '#8B6BFF', glow: 20, glowColor: b.accent ?? '#8B6BFF' }, enter: { kind: 'pop', seconds: 0.4 }, exit: { kind: 'fade', seconds: 0.3 } }];
    },
  }));
  return (
    <div className="live-grid">
      {items.map((i) => (
        <ItemCard key={i.id} item={{ ...i, ops: (at, b, p) => i.ops(at, b, p) }} project={project} brand={brand} time={time} onEdit={onEdit} />
      ))}
    </div>
  );
}

/** Fonts as cards in their own lettering: click to use it on the selected text, or add text in it. */
export function FontGallery({ selected, time, onEdit }: { selected: Clip | null; time: number; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const ui = useUi();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'All' | 'Sans' | 'Display' | 'Serif' | 'Script' | 'Mono' | 'Windows'>('All');
  const fonts = [...KEO_FONTS.map((f) => [f, FONT_KIND[f]] as const), ...SYSTEM_FONTS.map((f) => [f, 'Windows'] as const)].filter(([f, k]) => f.toLowerCase().includes(q.toLowerCase()) && (kind === 'All' || k === kind));
  const text = selected?.type === 'text' ? selected : null;
  return (
    <>
      <div className="lib-bar">
        <input className="input font-search" placeholder="Search fonts" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="lib-chiprow sub">
        {(['All', 'Sans', 'Display', 'Serif', 'Script', 'Mono', 'Windows'] as const).map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
            {k}
          </button>
        ))}
      </div>
      <p className="lib-note small muted">{text ? 'Click a font to use it on the selected text.' : 'Click a font to add text in it (select a text first to change its font).'}</p>
      <div className="font-grid">
        {fonts.map(([f, from]) => (
          <button
            key={f}
            className={`font-card ${text?.style.font === f ? 'on' : ''}`}
            onClick={() => void (text ? onEdit([{ op: 'set', clip: text.id, style: { font: f } }]) : onEdit([{ op: 'add_text', text: f, start: time, duration: 3, style: { font: f } }])).catch((e: unknown) => ui.error(errText(e)))}
            title={`${f} (${from})`}
          >
            <span className="font-aa" style={{ fontFamily: `"${f}"` }}>
              Aa
            </span>
            <span className="font-name" style={{ fontFamily: `"${f}"` }}>
              {f}
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
