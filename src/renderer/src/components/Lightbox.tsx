import { useEffect, useState } from 'react';
import { Icon } from './Icon';

export interface LightboxPicture {
  name: string;
  /** Shown at once (a thumbnail or the picture itself). */
  src: string;
  /** Loads the full-size picture (a data or blob URL); the thumbnail stays while it loads or when it fails. */
  load?: () => Promise<string>;
  /** Extra actions under the picture (Open, Show in folder…). */
  actions?: Array<{ label: string; run: () => void }>;
}

/**
 * A picture full screen: blurred backdrop, the picture at its best size, the name, and Close (Esc,
 * a click outside or the X). Several pictures: arrows and ← → to move between them.
 */
export function Lightbox({ pictures, start = 0, onClose }: { pictures: LightboxPicture[]; start?: number; onClose: () => void }) {
  const [i, setI] = useState(start);
  const [full, setFull] = useState<Record<number, string>>({});
  const [failed, setFailed] = useState<Record<number, string>>({});
  const p = pictures[i]!;
  const many = pictures.length > 1;
  const go = (d: number) => setI((x) => (x + d + pictures.length) % pictures.length);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (many && e.key === 'ArrowRight') go(1);
      else if (many && e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!p.load || full[i] || failed[i]) return;
    let live = true;
    p.load().then(
      (url) => live && setFull((f) => ({ ...f, [i]: url })),
      (e: unknown) => live && setFailed((f) => ({ ...f, [i]: e instanceof Error ? e.message : String(e) })),
    );
    return () => {
      live = false;
    };
  }, [i, p, full, failed]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={p.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lightbox-top">
        <span className="lightbox-name" title={p.name}>
          {p.name}
          {many && (
            <span className="lightbox-count">
              {i + 1} / {pictures.length}
            </span>
          )}
        </span>
        <span className="grow" />
        {p.actions?.map((a) => (
          <button key={a.label} className="lightbox-btn" onClick={a.run}>
            {a.label}
          </button>
        ))}
        <button className="lightbox-btn round" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="lightbox-stage" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        {many && (
          <button className="lightbox-nav prev" aria-label="Previous picture" onClick={() => go(-1)}>
            <Icon name="chevronRight" size={20} />
          </button>
        )}
        <img key={i} src={full[i] ?? p.src} alt={p.name} className={full[i] || !p.load ? 'sharp' : 'soft'} draggable={false} />
        {many && (
          <button className="lightbox-nav next" aria-label="Next picture" onClick={() => go(1)}>
            <Icon name="chevronRight" size={20} />
          </button>
        )}
      </div>
      {failed[i] && <div className="lightbox-note">{failed[i]}</div>}
    </div>
  );
}

/** base64 → blob URL (revoked by the browser when the window closes; pictures are small and few). */
export function toObjectUrl(dataBase64: string, mimeType: string): string {
  const bin = atob(dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
}
