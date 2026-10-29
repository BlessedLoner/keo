import { useRef, useState, type CSSProperties } from 'react';
import { CAPTION_STYLE, type Asset, type EditOp, type Project, type TextClip, type TextStyle } from '@shared/studio';
import { Icon } from '../components/Icon';
import { invoke } from '../lib/api';
import { mediaUrl } from './media';
import { useFilmstrip } from './thumbs';
import { VoiceRecorder } from './VoiceTools';

/**
 * The Studio's library on the left: the project's media (thumbnails, lengths, a moving preview
 * on hover), ready-made text styles, and music and sound effects. Drag anything onto the timeline,
 * or click to add it at the playhead.
 */

const fmt = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`);

/** Text styles: how they look in the gallery, and what they add. */
const TEXT_STYLES: Array<{ id: string; label: string; sample: string; css: CSSProperties; style: Partial<TextStyle>; animIn: TextClip['animIn']; animOut?: TextClip['animOut']; y?: number; duration?: number }> = [
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
const EMOJI = ['🔥', '😂', '😍', '🤯', '👀', '💯', '✨', '🎉', '👍', '❤️', '😱', '🤔', '🙌', '💡', '⚡', '🚀', '⭐', '✅', '❌', '👇', '👉', '💰', '📈', '🎯'];

const SFX = [
  { id: 'whoosh', label: 'Whoosh' },
  { id: 'swipe', label: 'Swipe' },
  { id: 'pop', label: 'Pop' },
  { id: 'click', label: 'Click' },
  { id: 'ding', label: 'Ding' },
  { id: 'riser', label: 'Riser' },
  { id: 'boom', label: 'Boom' },
] as const;

export function MediaBin({
  project,
  time,
  onImport,
  onAddAsset,
  onEdit,
  onMusic,
  onCaptions,
  captioning,
}: {
  project: Project;
  time: number;
  onImport: () => void;
  onAddAsset: (a: Asset) => void;
  onEdit: (ops: EditOp[]) => Promise<void> | void;
  onMusic: () => void;
  onCaptions: () => void;
  captioning: boolean;
}) {
  const [tab, setTab] = useState<'media' | 'text' | 'audio'>('media');
  const visual = project.assets.filter((a) => a.kind !== 'audio');
  const sounds = project.assets.filter((a) => a.kind === 'audio');
  const hasSpeech = project.assets.some((a) => a.hasAudio);
  return (
    <aside className="studio-bin">
      <div className="side-tabs bin-tabs" role="tablist" aria-label="Library">
        {(
          [
            ['media', 'Media'],
            ['text', 'Text'],
            ['audio', 'Audio'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'media' && (
        <>
          <div className="bin-actions">
            <button className="btn sm primary" onClick={onImport}>
              <Icon name="plus" size={13} /> Import
            </button>
            <span className="small muted">or drop files here</span>
          </div>
          {visual.length === 0 ? (
            <p className="small muted bin-hint">Add videos and pictures: click Import, or drag them here from File Explorer. Then drag them onto the timeline, or click + to add at the playhead.</p>
          ) : (
            <div className="bin-grid">
              {visual.map((a) => (
                <Tile key={a.id} projectId={project.id} asset={a} onAdd={() => onAddAsset(a)} />
              ))}
            </div>
          )}
          <div className="bin-tools">
            <button className="btn sm" onClick={() => void onEdit([{ op: 'add_track', kind: 'video' }])}>
              <Icon name="film" size={13} /> Video track
            </button>
          </div>
        </>
      )}
      {tab === 'text' && (
        <>
          <div className="bin-actions">
            <button className="btn sm" disabled={captioning || !hasSpeech} onClick={onCaptions} title={hasSpeech ? 'Turn the speech into word-by-word captions' : 'Add a video with speech first'}>
              {captioning ? <span className="spinner tiny" /> : <Icon name="text" size={13} />} {captioning ? 'Captioning…' : 'Auto captions'}
            </button>
          </div>
          <div className="studio-pane-head">
            <span>Stickers</span>
          </div>
          <div className="emoji-grid">
            {EMOJI.map((e) => (
              <button
                key={e}
                className="emoji"
                title="Add this sticker at the playhead"
                onClick={() =>
                  void onEdit([
                    {
                      op: 'add_text',
                      text: e,
                      start: time,
                      duration: 2.5,
                      animIn: 'pop',
                      animOut: 'pop',
                      animSeconds: 0.35,
                      style: { font: 'Segoe UI Emoji', sizePct: 14, weight: 'normal', shadow: 14 },
                      transform: { x: 0.72, y: 0.3, rotation: -8 },
                      loop: { kind: 'float', amount: 0.4, period: 2.4 },
                    },
                  ])
                }
              >
                {e}
              </button>
            ))}
          </div>
          <div className="studio-pane-head">
            <span>Text styles</span>
          </div>
          <div className="style-grid">
            {TEXT_STYLES.map((s) => (
              <button
                key={s.id}
                className="style-tile"
                title={`Add “${s.label}” at the playhead`}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('application/x-keo-text', s.id)}
                onClick={() => void onEdit([{ op: 'add_text', text: s.id === 'quote' ? '“Your words here”' : s.id === 'caption' ? 'SAY IT LOUD' : s.label === 'Title' ? 'YOUR TITLE' : 'Your text', start: time, duration: s.duration ?? 3, style: s.style, animIn: s.animIn, animOut: s.animOut ?? 'fade', transform: s.y ? { y: s.y } : {} }])}
              >
                <span className="style-sample" style={s.css}>
                  {s.sample}
                </span>
                <span className="style-label">{s.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {tab === 'audio' && (
        <>
          <div className="bin-actions">
            <button className="btn sm primary" onClick={onMusic} title="Your own music file: it goes on the Music track, quieter while someone speaks">
              <Icon name="music" size={13} /> Add music
            </button>
          </div>
          <div className="bin-actions">
            <VoiceRecorder projectId={project.id} time={time} />
          </div>
          {sounds.length > 0 && (
            <div className="bin-list">
              {sounds.map((a) => (
                <div
                  key={a.id}
                  className="bin-item"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-keo-asset', a.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDoubleClick={() => onAddAsset(a)}
                >
                  <span className="bin-thumb audio">
                    <Icon name="music" size={16} />
                  </span>
                  <div className="bin-info">
                    <span className="bin-name">{a.name}</span>
                    <span className="small muted">{fmt(a.duration)}</span>
                  </div>
                  <button className="btn icon sm ghost" onClick={() => onAddAsset(a)} title="Add at the playhead">
                    <Icon name="plus" size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="studio-pane-head">
            <span>Sound effects</span>
          </div>
          <div className="sfx-grid">
            {SFX.map((s) => (
              <button key={s.id} className="btn sm" title={`Add a ${s.label.toLowerCase()} at the playhead`} onClick={() => void invoke('studio:soundEffect', { id: project.id, kind: s.id, at: time }).catch(() => undefined)}>
                <Icon name="plus" size={12} /> {s.label}
              </button>
            ))}
          </div>
          <div className="bin-tools">
            <button className="btn sm" onClick={() => void onEdit([{ op: 'add_track', kind: 'audio' }])}>
              <Icon name="music" size={13} /> Audio track
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

/** A media tile: its first frame, its length, and the video playing while the mouse is over it. */
function Tile({ projectId, asset, onAdd }: { projectId: string; asset: Asset; onAdd: () => void }) {
  const strip = useFilmstrip(projectId, asset);
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
      title={`${asset.name} — drag to the timeline, or double-click to add at the playhead`}
    >
      {strip?.frames[0] ? <img src={strip.frames[0]} alt="" draggable={false} /> : <span className="tile-blank" />}
      {asset.kind === 'video' && hover && <video ref={video} src={mediaUrl(projectId, asset.id)} muted playsInline loop crossOrigin="anonymous" autoPlay />}
      {asset.kind === 'video' && <span className="tile-dur">{fmt(asset.duration)}</span>}
      <span className="tile-name">{asset.name}</span>
      <button
        className="tile-add"
        title="Add at the playhead"
        onClick={(e) => {
          e.stopPropagation();
          onAdd();
        }}
      >
        <Icon name="plus" size={13} />
      </button>
    </div>
  );
}
