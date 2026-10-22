import { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoView } from '@shared/domain';
import { Icon } from '../components/Icon';
import { errText, invoke, subscribe } from '../lib/api';

/**
 * The video preview window: plays Keo's quick low-resolution preview and takes the user's
 * instructions ("shorter intro", "bigger captions"). Common instructions are applied at once;
 * anything else goes to Keo's conversation. Saving the finished video is the user's own click
 * and runs through Keo's normal task path (checked afterwards).
 */
export function VideoApp() {
  const [v, setV] = useState<VideoView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'say' | 'undo' | 'save'>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'info'; text: string; saved?: boolean } | null>(null);
  const [entering, setEntering] = useState(0);
  const shown = useRef<string>('');
  const url = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const view = await invoke('video:get', {});
      setV(view);
      const key = view?.preview ? `${view.id}:${view.preview.version}` : '';
      if (view?.preview && key !== shown.current) {
        const r = await invoke('video:preview', { id: view.id, version: view.preview.version });
        if (r.bytes) {
          shown.current = key;
          const next = URL.createObjectURL(new Blob([r.bytes as BlobPart], { type: 'video/mp4' }));
          if (url.current) URL.revokeObjectURL(url.current);
          url.current = next;
          setSrc(next);
        }
      }
    } catch {
      setV(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('results-root');
    void load();
    const offChanged = subscribe('video:changed', () => void load());
    const offCmd = subscribe('presence:command', (c) => {
      if (c.type === 'video_open') setEntering((n) => n + 1);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('video:close', {}).catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offChanged();
      offCmd();
      window.removeEventListener('keydown', onKey);
      if (url.current) URL.revokeObjectURL(url.current);
    };
  }, [load]);

  const say = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy('say');
    setStatus(null);
    try {
      const r = await invoke('video:say', { text: t });
      if (r.applied) setStatus({ kind: 'ok', text: `${r.changes.join(' · ')} — making the new preview…` });
      else if (r.forwarded) setStatus({ kind: 'info', text: 'Sent to Keo — the preview updates when Keo has made the change.' });
      else setStatus({ kind: 'error', text: r.error ?? 'Nothing was changed.' });
      if (r.applied || r.forwarded) setText('');
    } catch (e) {
      setStatus({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (busy) return;
    setBusy('undo');
    try {
      const r = await invoke('video:undo', {});
      setStatus(r.ok ? { kind: 'ok', text: 'Back to the previous version.' } : { kind: 'error', text: r.error ?? 'Nothing to undo.' });
    } catch (e) {
      setStatus({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (busy) return;
    setBusy('save');
    setStatus({ kind: 'info', text: 'Making the finished video…' });
    try {
      const r = await invoke('video:export', {});
      setStatus(r.ok ? { kind: 'ok', text: r.detail ?? `Saved ${r.file ?? ''}`, saved: true } : { kind: 'error', text: [r.error, r.detail].filter(Boolean).join(' ') || 'Could not save the video.' });
    } catch (e) {
      setStatus({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const close = () => void invoke('video:close', {}).catch(() => undefined);
  const working = v?.status === 'rendering' || v?.status === 'analyzing';
  const vertical = v?.aspect === '9:16' || v?.aspect === '4:5';

  return (
    <div className="results-stage">
      <section key={entering} className="results-panel video-panel" aria-label="Video preview">
        <header className="results-head">
          <div className="results-orb" aria-hidden="true" />
          <div className="results-heading">
            <small>Keo · video preview</small>
            <h1>{v?.title ?? (loaded ? 'No video yet' : 'Loading…')}</h1>
          </div>
          <button className="results-x" aria-label="Close" title="Close (Esc)" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="results-body">
          {!v && loaded && <p className="results-empty">Ask Keo to make a video, for example “make a video like template.mp4 from the clips in my Videos folder”. The preview appears here.</p>}
          {v && (
            <>
              <div className={`video-stage ${vertical ? 'tall' : 'wide'}`}>
                {src ? <video className="video-player" src={src} controls autoPlay loop playsInline /> : <div className="video-wait">{working ? 'Making the preview…' : 'No preview yet'}</div>}
                {working && (
                  <div className="video-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={v.progress ?? undefined}>
                    <span style={{ width: `${v.progress ?? 8}%` }} />
                  </div>
                )}
              </div>
              <p className="video-meta">
                {v.totalSec.toFixed(1)} s · {v.aspect} · {v.shots.length} shot{v.shots.length === 1 ? '' : 's'} · captions {v.captions.enabled ? 'on' : 'off'}
                {v.music ? ` · ♪ ${v.music}` : ''}
              </p>
              {v.message && <p className="results-summary">{v.message}</p>}
              {v.lastChanges.length > 0 && <p className="video-changes">Last change: {v.lastChanges.join(' · ')}</p>}
              {v.notes.length > 0 && (
                <ul className="video-notes">
                  {v.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              <ol className="video-shots" aria-label="Shots">
                {v.shots.map((s) => (
                  <li key={s.index} title={`${s.clip} · starts at ${s.startSec.toFixed(1)} s`}>
                    <b>{s.index + 1}</b> <span>{s.clip}</span> <em>{s.durationSec.toFixed(1)} s{s.speed !== 1 ? ` · ${s.speed}×` : ''}</em>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>

        {v && (
          <footer className="results-actions">
            {status && (
              <div className={`results-status ${status.kind === 'info' ? 'ok' : status.kind}`} role="status">
                <Icon name={status.kind === 'error' ? 'warn' : status.kind === 'ok' ? 'check' : 'info'} size={13} />
                <span>{status.text}</span>
                {status.saved && (
                  <button className="results-open" onClick={() => void invoke('video:openFolder', {}).catch(() => undefined)}>
                    Open folder
                  </button>
                )}
              </div>
            )}
            <form
              className="results-send"
              onSubmit={(e) => {
                e.preventDefault();
                void say();
              }}
            >
              <input className="input" placeholder="Tell Keo what to change (“shorter intro”, “bigger captions”)" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} disabled={busy === 'say'} aria-label="Instruction" />
              <div className="results-row">
                <button type="submit" className="btn" disabled={!text.trim() || !!busy}>
                  <Icon name="send" size={13} /> Change
                </button>
                <button type="button" className="btn ghost" onClick={() => void undo()} disabled={!v.canUndo || !!busy}>
                  <Icon name="retry" size={13} /> Undo
                </button>
                <span className="grow" />
                <button type="button" className="btn primary" onClick={() => void save()} disabled={!!busy || !v.preview}>
                  <Icon name="download" size={13} /> {busy === 'save' ? 'Saving…' : 'Save video'}
                </button>
              </div>
            </form>
            <p className="results-hint">Or say it: press your voice shortcut and talk to Keo while the preview plays.</p>
          </footer>
        )}
      </section>
    </div>
  );
}
