import { useEffect, useState } from 'react';
import { CODEC_BITS, EXPORT_PRESETS, exportSize, exportVideoCodec, projectDuration, QUALITY_BPP, type ExportOptions, type Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { canEncode } from './codecs';

/** The Export window: size, frame rate, quality and file name, with the file size to expect. */
export function ExportDialog({ project, onExport, onClose }: { project: Project; onExport: (o: Partial<ExportOptions>) => void; onClose: () => void }) {
  const [resolution, setResolution] = useState<ExportOptions['resolution']>('project');
  const [fps, setFps] = useState<ExportOptions['fps']>('project');
  const [quality, setQuality] = useState<ExportOptions['quality']>('high');
  const [name, setName] = useState(project.name);
  const [format, setFormat] = useState<ExportOptions['format']>('mp4');
  const [preset, setPreset] = useState<string | null>(null);
  const [codec, setCodec] = useState<ExportOptions['codec']>('h264');
  const video = format === 'mp4' || format === 'mov' || format === 'webm';
  const shape = project.width > project.height * 1.15 ? 'wide' : project.height > project.width * 1.15 ? (project.height / project.width > 1.5 ? 'tall' : 'portrait') : 'square';
  const applyPreset = (id: string) => {
    const p = EXPORT_PRESETS.find((x) => x.id === id)!;
    setPreset(id);
    setResolution(p.options.resolution);
    setFps(p.options.fps);
    setQuality(p.options.quality);
    setFormat(p.options.format);
    setCodec('h264');
  };
  const chosen = EXPORT_PRESETS.find((x) => x.id === preset);
  const mismatch = chosen && chosen.shape !== 'any' && !(chosen.shape === shape || (chosen.shape === 'portrait' && shape === 'square'));
  const size = exportSize(project, { resolution, fps });
  const family = exportVideoCodec({ format, codec });
  // Whether this PC has an encoder for the chosen codec at this size (null: still asking).
  const [encodable, setEncodable] = useState<boolean | null>(true);
  useEffect(() => {
    if (!video || family === 'h264') return setEncodable(true);
    let live = true;
    setEncodable(null);
    void canEncode(family, size.width, size.height, size.fps).then((ok) => live && setEncodable(ok));
    return () => {
      live = false;
    };
  }, [video, family, size.width, size.height, size.fps]);
  const seconds = projectDuration(project);
  // Video at the chosen quality plus sound (192 kb/s).
  const bytes = ((size.width * size.height * size.fps * QUALITY_BPP[quality] * CODEC_BITS[family] + (family === 'vp9' ? 160_000 : 192_000)) * seconds) / 8;
  const mb = bytes / 1_000_000;
  const short = Math.min(project.width, project.height);
  // AI-made clips on the timeline: the apps ask for an AI label on realistic AI video.
  const aiAssets = new Set(project.assets.filter((a) => a.aiMade).map((a) => a.id));
  const hasAi = project.tracks.some((t) => !t.hidden && t.clips.some((c) => (c.type === 'media' || c.type === 'audio') && aiAssets.has(c.assetId)));
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Export" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export-dialog">
        <h3>
          <Icon name="download" size={18} /> Export video
        </h3>
        {hasAi && (
          <div className="banner info small" role="note">
            <Icon name="info" size={15} />
            <div className="grow">
              This video has AI-made clips. When you post it, turn on the AI label: YouTube “Altered or synthetic content”, TikTok “AI-generated content”, Instagram “AI info”. Without it, platforms can hide or remove realistic AI videos.
            </div>
          </div>
        )}
        <div className="field">
          <label htmlFor="ex-name">File name</label>
          <input id="ex-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="export-presets" role="radiogroup" aria-label="Where it goes">
          {EXPORT_PRESETS.map((p) => (
            <button key={p.id} role="radio" aria-checked={preset === p.id} className={preset === p.id ? 'on' : ''} onClick={() => applyPreset(p.id)}>
              <strong>{p.label}</strong>
              <span>{p.for}</span>
            </button>
          ))}
        </div>
        {mismatch && <p className="small warn-text">This project is {shape === 'wide' ? 'wide' : shape === 'tall' ? 'tall' : shape}; {chosen!.label} looks best {chosen!.shape === 'tall' ? 'tall (9:16)' : chosen!.shape === 'wide' ? 'wide (16:9)' : '4:5 or square'}. Change the project’s shape in Details, or export as it is.</p>}
        <div className="field">
          <label htmlFor="ex-format">Format</label>
          <select id="ex-format" className="select" value={format} onChange={(e) => setFormat(e.target.value as ExportOptions['format'])}>
            <option value="mp4">Video (MP4)</option>
            <option value="mov">Video (MOV, for editors and Macs)</option>
            <option value="webm">Video (WebM, for websites)</option>
            <option value="gif">Animated GIF (for chats and sites)</option>
            <option value="wav">Sound only (WAV)</option>
          </select>
        </div>
        {(format === 'mp4' || format === 'mov') && (
          <div className="field">
            <label htmlFor="ex-codec">Video codec</label>
            <select id="ex-codec" className="select" value={codec} onChange={(e) => setCodec(e.target.value as ExportOptions['codec'])}>
              <option value="h264">H.264 (plays everywhere)</option>
              <option value="h265">H.265 / HEVC (smaller file, newer phones and players)</option>
            </select>
          </div>
        )}
        {video && (
        <div className="export-grid">
          <div className="field">
            <label htmlFor="ex-res">Resolution</label>
            <select id="ex-res" className="select" value={resolution} onChange={(e) => setResolution(e.target.value as ExportOptions['resolution'])}>
              <option value="project">Project ({short}p)</option>
              <option value="720">720p</option>
              <option value="1080">1080p (HD)</option>
              <option value="1440">1440p (2K)</option>
              <option value="2160">2160p (4K)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-fps">Frame rate</label>
            <select id="ex-fps" className="select" value={String(fps)} onChange={(e) => setFps(e.target.value === 'project' ? 'project' : (Number(e.target.value) as 24 | 25 | 30 | 50 | 60))}>
              <option value="project">Project ({project.fps} fps)</option>
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ex-q">Quality</label>
            <select id="ex-q" className="select" value={quality} onChange={(e) => setQuality(e.target.value as ExportOptions['quality'])}>
              <option value="standard">Standard (smaller file)</option>
              <option value="high">High (recommended)</option>
              <option value="best">Best (largest file)</option>
            </select>
          </div>
        </div>
        )}
        {format === 'gif' && <p className="small muted">{Math.min(480, project.width)} px wide · {Math.min(15, project.fps)} fps · no sound · saved in Videos\Keo{seconds > 60 ? ' — a GIF can be at most 60 seconds' : ''}</p>}
        {format === 'wav' && <p className="small muted">The whole mix as heard in the video · stereo, 48 kHz · about {Math.max(0.1, (seconds * 192_000) / 1_000_000).toFixed(1)} MB · saved in Videos\Keo</p>}
        {video && <p className="small muted">
          {size.width}×{size.height} · {size.fps} fps · {format === 'webm' ? 'WebM (VP9 + Opus)' : `${format === 'mov' ? 'MOV' : 'MP4'} (${family === 'h265' ? 'H.265' : 'H.264'} + AAC)`} · about {mb < 1 ? `${Math.max(0.1, mb).toFixed(1)}` : Math.round(mb)} MB · saved in Videos\Keo
        </p>}
        {video && encodable === null && <p className="small muted">Checking this PC can encode {family === 'vp9' ? 'VP9' : 'H.265'}…</p>}
        {video && encodable === false && <p className="small warn-text">This PC cannot encode {family === 'vp9' ? 'WebM (VP9)' : 'H.265'} at {size.width}×{size.height}. Pick H.264, or a smaller size.</p>}
        {video && Math.max(size.width, size.height) > 2600 && <p className="small warn-text">4K takes much longer to make, and some PCs cannot encode it; 1080p is what most apps show.</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || (format === 'gif' && seconds > 60) || (video && encodable !== true)} onClick={() => onExport({ resolution, fps, quality, format, ...(format === 'mp4' || format === 'mov' ? { codec } : {}), name: name.trim() })}>
            <Icon name="download" size={14} /> Export
          </button>
        </div>
      </div>
    </div>
  );
}
