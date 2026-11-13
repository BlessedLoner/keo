import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CAPTION_STYLE, type Asset, type TextClip, type TextStyle } from '@shared/studio';
import { Icon } from '../components/Icon';
import { invoke } from '../lib/api';
import { mediaUrl } from './media';
import { useFilmstrip } from './thumbs';

/**
 * The Studio's library on the left: the project's media (thumbnails, lengths, a moving preview
 * on hover), ready-made text styles, and music and sound effects. Drag anything onto the timeline,
 * or click to add it at the playhead.
 */

const fmt = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/** Text styles: how they look in the gallery, and what they add. */
export const TEXT_STYLES: Array<{ id: string; label: string; sample: string; css: CSSProperties; style: Partial<TextStyle>; animIn: TextClip['animIn']; animOut?: TextClip['animOut']; y?: number; duration?: number }> = [
  { id: 'title', label: 'Title', sample: 'TITLE', css: { fontWeight: 900, fontSize: 20, letterSpacing: 1 }, style: { sizePct: 8, weight: 'black', uppercase: true, shadow: 12 }, animIn: 'pop' },
  { id: 'caption', label: 'Bold caption', sample: 'SAY IT', css: { fontWeight: 900, fontSize: 17, WebkitTextStroke: '1.5px #000', color: '#fff' }, style: { ...CAPTION_STYLE }, animIn: 'pop', y: 0.74 },
  { id: 'neon', label: 'Neon glow', sample: 'Neon', css: { fontWeight: 800, fontSize: 19, color: '#fff', textShadow: '0 0 8px #ff3df0, 0 0 16px #ff3df0' }, style: { sizePct: 7, weight: 'bold', glow: 34, glowColor: '#FF3DF0', shadow: 0 }, animIn: 'blur-in' },
  { id: 'gradient', label: 'Gradient', sample: 'Gradient', css: { fontWeight: 900, fontSize: 18, background: 'linear-gradient(90deg,#ffd400,#ff3d7f)', WebkitBackgroundClip: 'text', color: 'transparent' }, style: { sizePct: 8, weight: 'black', color: '#FFD400', color2: '#FF3D7F', shadow: 10 }, animIn: 'letters' },
  { id: 'boxed', label: 'Boxed', sample: 'Boxed', css: { fontWeight: 700, fontSize: 15, background: 'rgba(0,0,0,.75)', padding: '2px 8px', borderRadius: 4, color: '#fff' }, style: { sizePct: 4.5, weight: 'bold', box: true, boxColor: '#000000C0', shadow: 0 }, animIn: 'fade', y: 0.8 },
  { id: 'highlight', label: 'Highlight', sample: 'Pop', css: { fontWeight: 900, fontSize: 18, background: '#ffd400', color: '#111', padding: '0 8px', borderRadius: 4 }, style: { sizePct: 6, weight: 'black', color: '#111111', box: true, boxColor: '#FFD400', shadow: 0, uppercase: true }, animIn: 'zoom' },
  { id: 'typewriter', label: 'Typewriter', sample: 'Type_', css: { fontFamily: 'Consolas, monospace', fontSize: 16, color: '#9eff9e' }, style: { font: 'Consolas', sizePct: 4.5, weight: 'normal', color: '#9EFF9E', shadow: 0 }, animIn: 'typewriter', duration: 4 },
  { id: 'quote', label: 'Quote', sample: '“Quote”', css: { fontFamily: 'Georgia, serif', fontStyle: 'italic', fontSize: 17, color: '#fff' }, style: { font: 'Georgia', sizePct: 5, weight: 'normal', shadow: 10 }, animIn: 'words', duration: 4 },
  { id: 'glitch', label: 'Glitch', sample: 'GLITCH', css: { fontWeight: 900, fontSize: 17, color: '#fff', textShadow: '2px 0 #ff2a55, -2px 0 #2ae5ff' }, style: { sizePct: 7, weight: 'black', uppercase: true, shadow: 0 }, animIn: 'glitch' },
  { id: 'wave', label: 'Wave', sample: 'wave~', css: { fontWeight: 800, fontSize: 18, color: '#8bf' }, style: { sizePct: 7, weight: 'black', color: '#88BBFF', shadow: 8 }, animIn: 'wave', duration: 4 },
  { id: 'subtitle', label: 'Subtitle', sample: 'Subtitle', css: { fontSize: 14, color: '#fff', textShadow: '0 1px 3px #000' }, style: { sizePct: 3.6, weight: 'normal', shadow: 14 }, animIn: 'fade', y: 0.86 },
  { id: 'outline', label: 'Outline', sample: 'Outline', css: { fontWeight: 900, fontSize: 19, color: 'transparent', WebkitTextStroke: '1.5px #fff' }, style: { sizePct: 8, weight: 'black', color: '#00000000', outline: 4, outlineColor: '#FFFFFF', shadow: 0 }, animIn: 'drop' },
  // Modern looks built on Keo's own fonts.
  { id: 'chrome', label: 'Chrome', sample: 'CHROME', css: {}, style: { font: 'Unbounded', sizePct: 7, weight: 'black', uppercase: true, color: '#F4F6FA', color2: '#7C8696', outline: 2, outlineColor: '#1B1F27', shadow: 18 }, animIn: 'zoom' },
  { id: 'luxury', label: 'Luxury serif', sample: 'Maison', css: {}, style: { font: 'Cormorant Garamond', sizePct: 7.5, weight: 'normal', italic: true, color: '#F3E7C9', letterSpacing: 2, shadow: 12 }, animIn: 'blur-in' },
  { id: 'editorial', label: 'Editorial', sample: 'The Edit', css: {}, style: { font: 'Fraunces', sizePct: 8, weight: 'bold', color: '#FFFFFF', shadow: 10 }, animIn: 'words-up' },
  { id: 'poster', label: 'Poster', sample: 'NOW', css: {}, style: { font: 'Anton', sizePct: 14, weight: 'normal', uppercase: true, color: '#FFFFFF', letterSpacing: -1, shadow: 20 }, animIn: 'drop' },
  { id: 'sport', label: 'Sport', sample: 'GAME DAY', css: {}, style: { font: 'Big Shoulders Display', sizePct: 10, weight: 'black', uppercase: true, italic: true, color: '#FFD400', outline: 3, outlineColor: '#111111', shadow: 12 }, animIn: 'slide-left' },
  { id: 'neon-sign', label: 'Neon sign', sample: 'Open', css: {}, style: { font: 'Monoton', sizePct: 9, weight: 'normal', color: '#FFFFFF', glow: 46, glowColor: '#36E2FF', shadow: 0 }, animIn: 'glitch' },
  { id: 'script', label: 'Signature', sample: 'with love', css: {}, style: { font: 'Great Vibes', sizePct: 9, weight: 'normal', color: '#FFFFFF', shadow: 14 }, animIn: 'wipe' },
  { id: 'handwritten', label: 'Handwritten', sample: 'note to self', css: {}, style: { font: 'Caveat', sizePct: 7, weight: 'bold', color: '#FFE45E', shadow: 8, curve: -12 }, animIn: 'typewriter' },
  { id: 'marker', label: 'Marker', sample: 'DON’T SKIP', css: {}, style: { font: 'Permanent Marker', sizePct: 7, weight: 'normal', color: '#FFFFFF', box: true, boxColor: '#E53935E6', shadow: 0 }, animIn: 'pop' },
  { id: 'comic', label: 'Comic', sample: 'BOOM!', css: {}, style: { font: 'Bangers', sizePct: 12, weight: 'normal', uppercase: true, color: '#FFD400', outline: 7, outlineColor: '#111111', shadow: 0, curve: 18, letterSpacing: 2 }, animIn: 'bounce' },
  { id: 'tech', label: 'Tech', sample: 'SYSTEM ONLINE', css: {}, style: { font: 'Orbitron', sizePct: 5, weight: 'bold', uppercase: true, color: '#9AF7FF', letterSpacing: 8, glow: 18, glowColor: '#36E2FF', shadow: 0 }, animIn: 'letters' },
  { id: 'retro', label: 'Retro game', sample: 'LEVEL UP', css: {}, style: { font: 'Press Start 2P', sizePct: 4.5, weight: 'normal', color: '#FFFFFF', outline: 4, outlineColor: '#7A2BFF', shadow: 0 }, animIn: 'typewriter' },
  { id: 'minimal', label: 'Minimal', sample: 'less is more', css: {}, style: { font: 'Manrope', sizePct: 4.5, weight: 'normal', color: '#FFFFFF', letterSpacing: 6, shadow: 6 }, animIn: 'fade' },
  { id: 'stacked', label: 'Bold stack', sample: 'MAKE IT COUNT', css: {}, style: { font: 'Archivo Black', sizePct: 9, weight: 'black', uppercase: true, color: '#FFFFFF', maxWidth: 0.6, lineHeight: 0.95, shadow: 16 }, animIn: 'words-pop' },
  { id: 'sunset', label: 'Sunset gradient', sample: 'Golden', css: {}, style: { font: 'Shrikhand', sizePct: 10, weight: 'normal', color: '#FFD36B', color2: '#FF4D8D', shadow: 14 }, animIn: 'wave' },
  { id: 'label', label: 'Label tag', sample: 'NEW DROP', css: {}, style: { font: 'Space Grotesk', sizePct: 3.6, weight: 'bold', uppercase: true, color: '#111111', box: true, boxColor: '#FFFFFFF0', letterSpacing: 4, shadow: 0 }, animIn: 'slide-up' },
  { id: 'cinema', label: 'Cinema credit', sample: 'A FILM BY', css: {}, style: { font: 'Instrument Serif', sizePct: 4, weight: 'normal', uppercase: true, color: '#E9E4D8', letterSpacing: 14, shadow: 8 }, animIn: 'blur-in', duration: 4 },
  { id: 'brush', label: 'Brush script', sample: 'Adventure', css: {}, style: { font: 'Kaushan Script', sizePct: 10, weight: 'normal', color: '#FFFFFF', shadow: 18, curve: -8 }, animIn: 'letters' },
];

/** Stickers: emoji drawn big, popping in and floating. */
export const EMOJI = ['🔥', '😂', '😍', '🤯', '👀', '💯', '✨', '🎉', '👍', '❤️', '😱', '🤔', '🙌', '💡', '⚡', '🚀', '⭐', '✅', '❌', '👇', '👉', '💰', '📈', '🎯'];

/** A media tile: its first frame, its length, and the video playing while the mouse is over it. */
/** Why this PC cannot play a video (its format), or null when it can. Checked once per file. */
const playability = new Map<string, Promise<string | null>>();
export function usePlayable(projectId: string, asset: Asset): string | null {
  const [issue, setIssue] = useState<string | null>(null);
  useEffect(() => {
    if (asset.kind !== 'video') return;
    const key = `${projectId}/${asset.id}`;
    if (!playability.has(key))
      playability.set(
        key,
        (async () => {
          const t = await invoke('studio:videoTrack', { projectId, assetId: asset.id }).catch(() => null);
          if (!t || typeof VideoDecoder === 'undefined') return null;
          const ok = await VideoDecoder.isConfigSupported({ codec: t.codec, codedWidth: t.width, codedHeight: t.height, ...(t.description ? { description: t.description } : {}) })
            .then((r) => !!r.supported)
            .catch(() => false);
          if (ok) return null;
          const hevc = /^(hvc1|hev1)/.test(t.codec);
          const issue = hevc ? 'HEVC (H.265)' : t.codec;
          void invoke('studio:assetIssue', { id: projectId, assetId: asset.id, issue: `This PC cannot play ${issue} video${hevc ? ' (install HEVC Video Extensions from the Microsoft Store)' : ''}.` }).catch(() => undefined);
          return issue;
        })(),
      );
    let live = true;
    void playability.get(key)!.then((r) => live && setIssue(r));
    return () => {
      live = false;
    };
  }, [projectId, asset.id, asset.kind]);
  return issue;
}

export function Tile({ projectId, asset, onAdd, onOverlay }: { projectId: string; asset: Asset; onAdd: () => void; onOverlay?: () => void }) {
  const strip = useFilmstrip(projectId, asset);
  const issue = usePlayable(projectId, asset);
  const video = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  return (
    <div
      className="bin-tile"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-keo-asset', asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={onAdd}
      onMouseEnter={() => {
        setHover(true);
        if (asset.kind === 'video') void video.current?.play().catch(() => undefined);
      }}
      onMouseLeave={() => {
        setHover(false);
        video.current?.pause();
      }}
      title={`${asset.name} — drag to the timeline, or double-click to add at the playhead${asset.about ? `\nKeo sees: ${asset.about}` : ''}`}
    >
      {strip?.frames[0] ? <img src={strip.frames[0]} alt="" draggable={false} /> : <span className="tile-blank" />}
      {asset.kind === 'video' && hover && <video ref={video} src={mediaUrl(projectId, asset.id)} muted playsInline loop crossOrigin="anonymous" autoPlay />}
      {asset.kind === 'video' && <span className="tile-dur">{fmt(asset.duration)}</span>}
      {issue && (
        <span
          className="tile-issue"
          title={
            /HEVC/.test(issue)
              ? 'This video is HEVC (H.265), which this PC cannot play yet. Install “HEVC Video Extensions” from the Microsoft Store and restart Keo — or on the phone choose Camera → Formats → Most Compatible (H.264) for new videos.'
              : `This PC cannot play this video’s format (${issue}). Convert it to MP4 (H.264) first.`
          }
        >
          ⚠ Can’t play: {issue}
        </span>
      )}
      <span className="tile-name">{asset.name}</span>
      <button
        className="tile-add"
        title="Add to the main track at the playhead"
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
      >
        <Icon name="plus" size={13} />
      </button>
      {onOverlay && (
        <button
          className="tile-add overlay"
          title="Add as an overlay: on its own track above, small in the corner (picture-in-picture)"
          onClick={(e) => {
            e.stopPropagation();
            onOverlay();
          }}
        >
          <Icon name="copy" size={12} />
        </button>
      )}
    </div>
  );
}
