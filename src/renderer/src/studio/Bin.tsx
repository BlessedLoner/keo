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
