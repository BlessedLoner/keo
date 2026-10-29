import { useState } from 'react';
import { exportSize, projectDuration, QUALITY_BPP, type ExportOptions, type Project } from '@shared/studio';
import { Icon } from '../components/Icon';

/** The Export window: size, frame rate, quality and file name, with the file size to expect. */
export function ExportDialog({ project, onExport, onClose }: { project: Project; onExport: (o: Partial<ExportOptions>) => void; onClose: () => void }) {
  const [resolution, setResolution] = useState<ExportOptions['resolution']>('project');
  const [fps, setFps] = useState<ExportOptions['fps']>('project');
  const [quality, setQuality] = useState<ExportOptions['quality']>('high');
  const [name, setName] = useState(project.name);
  const [format, setFormat] = useState<ExportOptions['format']>('mp4');
  const size = exportSize(project, { resolution, fps });
  const seconds = projectDuration(project);
  // Video at the chosen quality plus sound (192 kb/s).
  const bytes = ((size.width * size.height * size.fps * QUALITY_BPP[quality] + 192_000) * seconds) / 8;
  const mb = bytes / 1_000_000;
  const short = Math.min(project.width, project.height);
  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="Export" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal export-dialog">
        <h3>
          <Icon name="download" size={18} /> Export video
        </h3>
        <div className="field">
          <label htmlFor="ex-name">File name</label>
          <input id="ex-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ex-format">Format</label>
          <select id="ex-format" className="select" value={format} onChange={(e) => setFormat(e.target.value as ExportOptions['format'])}>
            <option value="mp4">Video (MP4)</option>
            <option value="gif">Animated GIF (for chats and sites)</option>
            <option value="wav">Sound only (WAV)</option>
          </select>
        </div>
        {format === 'mp4' && (
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
        {format === 'mp4' && <p className="small muted">
          {size.width}×{size.height} · {size.fps} fps · MP4 (H.264 + AAC) · about {mb < 1 ? `${Math.max(0.1, mb).toFixed(1)}` : Math.round(mb)} MB · saved in Videos\Keo
        </p>}
        {format === 'mp4' && Math.max(size.width, size.height) > 2600 && <p className="small warn-text">4K takes much longer to make, and some PCs cannot encode it; 1080p is what most apps show.</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim() || (format === 'gif' && seconds > 60)} onClick={() => onExport({ resolution, fps, quality, format, name: name.trim() })}>
            <Icon name="download" size={14} /> Export
          </button>
        </div>
      </div>
    </div>
  );
}
