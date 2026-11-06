import { useEffect, useState } from 'react';
import { errText, invoke } from '../lib/api';
import { Icon } from './Icon';
import { useUi } from './ui';

/**
 * Report a problem: the user says what happened; Keo shows the exact report (their words, Keo's
 * version, and, if they tick it, the recent activity log with personal details removed) before
 * it is sent to Keo or saved as a file.
 */
export function ReportProblem({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const [message, setMessage] = useState('');
  const [includeLog, setIncludeLog] = useState(true);
  const [preview, setPreview] = useState<{ text: string; canSend: boolean } | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState<'keo' | 'file' | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      void invoke('report:preview', { message, includeLog })
        .then(setPreview)
        .catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [message, includeLog]);

  const send = async (to: 'keo' | 'file') => {
    setBusy(to);
    try {
      const r = await invoke('report:send', { message: message.trim(), includeLog, to });
      ui.toast(r.sent ? `Thank you: your report was sent${r.reference ? ` (reference ${r.reference})` : ''}.` : 'Saved: the report is in Documents\\Keo\\Reports (the folder is open).', 'success');
      onClose();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card report-problem" style={{ marginBottom: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Report a problem</h3>
        <button className="btn icon sm ghost" onClick={onClose} title="Close" aria-label="Close">
          <Icon name="x" size={13} />
        </button>
      </div>
      <p className="small muted">Tell us what happened and what you expected. You see exactly what is sent below, before anything leaves your PC.</p>
      <textarea className="textarea" rows={4} maxLength={4000} value={message} placeholder="e.g. I clicked Add captions on my podcast and it stopped half way with an error." onChange={(e) => setMessage(e.target.value)} disabled={!!busy} />
      <label className="insp-check">
        <input type="checkbox" checked={includeLog} onChange={(e) => setIncludeLog(e.target.checked)} disabled={!!busy} /> Include Keo’s recent activity (what Keo did and which errors it hit; no chat text, prompts, pictures, sound or keys; your name, emails and phone numbers removed)
      </label>
      <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setShowing((v) => !v)}>
        <Icon name={showing ? 'chevronDown' : 'chevronRight'} size={12} /> {showing ? 'Hide' : 'See'} exactly what is sent{preview ? ` (${Math.round(preview.text.length / 1024)} KB)` : ''}
      </button>
      {showing && preview && <pre className="report-preview mono small">{preview.text}</pre>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn sm primary" disabled={!!busy || message.trim().length < 3 || !preview?.canSend} onClick={() => void send('keo')} title={preview?.canSend ? 'Send it to the Keo team' : 'Sign in to your Keo account to send it'}>
          {busy === 'keo' ? <span className="spinner tiny" /> : <Icon name="send" size={13} />} Send to Keo
        </button>
        <button className="btn sm" disabled={!!busy || message.trim().length < 3} onClick={() => void send('file')} title="Save it as a text file you can email or attach">
          {busy === 'file' ? <span className="spinner tiny" /> : <Icon name="download" size={13} />} Save to a file
        </button>
        {preview && !preview.canSend && <span className="small muted">Sign in to your Keo account to send it, or save it and email it.</span>}
      </div>
    </div>
  );
}
