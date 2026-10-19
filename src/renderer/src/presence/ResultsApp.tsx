import { useCallback, useEffect, useState } from 'react';
import type { ResearchResultView } from '@shared/domain';
import { Icon } from '../components/Icon';
import { errText, invoke, subscribe } from '../lib/api';

/**
 * The research results window: the latest research result (pictures, prices, sellers, specs) in a
 * small floating panel. Save and Send are the user's own clicks; both run through Keo's normal
 * task path (recipient checked, message verified) and report what really happened.
 */
type Busy = null | 'pdf' | 'png' | 'page' | 'send';

const FORMAT_LABEL: Record<'pdf' | 'png' | 'page', string> = { pdf: 'PDF', png: 'Picture', page: 'Web page' };

export function ResultsApp() {
  const [r, setR] = useState<ResearchResultView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [entering, setEntering] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string; folder?: string } | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [contact, setContact] = useState('');
  const [which, setWhich] = useState<'app' | 'web'>('app');
  const [note, setNote] = useState('');

  const load = useCallback(async (id?: string) => {
    try {
      const v = await invoke('results:get', id ? { id } : {});
      setR((prev) => {
        if (v && v.id !== prev?.id) {
          setStatus(null);
          setSendOpen(false);
        }
        return v;
      });
    } catch {
      setR(null);
    } finally {
      setLoaded(true);
      setEntering((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('results-root');
    void load();
    const offChanged = subscribe('results:changed', ({ id }) => void load(id));
    const offCmd = subscribe('presence:command', (c) => {
      if (c.type === 'results_open') setEntering((n) => n + 1);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void invoke('results:close', {}).catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offChanged();
      offCmd();
      window.removeEventListener('keydown', onKey);
    };
  }, [load]);

  const save = async (format: 'pdf' | 'png' | 'page') => {
    if (!r || busy) return;
    setBusy(format);
    setStatus(null);
    try {
      const res = await invoke('results:save', { id: r.id, format });
      setStatus(res.ok ? { kind: 'ok', text: `Saved as ${FORMAT_LABEL[format]}, with the product pictures.`, folder: res.folder ?? undefined } : { kind: 'error', text: res.error ?? 'Could not save.' });
    } catch (e) {
      setStatus({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    if (!r || busy || !contact.trim()) return;
    setBusy('send');
    setStatus(null);
    try {
      const res = await invoke('results:send', { id: r.id, contact: contact.trim(), which, ...(note.trim() ? { note: note.trim() } : {}) });
      setStatus(res.ok ? { kind: 'ok', text: res.detail ?? `Sent to ${contact.trim()}.` } : { kind: 'error', text: [...new Set([res.error, res.detail].filter(Boolean))].join(' ') || 'Could not send.' });
      if (res.ok) setSendOpen(false);
    } catch (e) {
      setStatus({ kind: 'error', text: errText(e) });
    } finally {
      setBusy(null);
    }
  };

  const close = () => void invoke('results:close', {}).catch(() => undefined);

  return (
    <div className="results-stage">
      <section key={entering} className="results-panel" aria-label="Research result">
        <header className="results-head">
          <div className="results-orb" aria-hidden="true" />
          <div className="results-heading">
            <small>Keo · research result</small>
            <h1>{r?.title ?? (loaded ? 'No research yet' : 'Loading…')}</h1>
          </div>
          <button className="results-x" aria-label="Close" title="Close (Esc)" onClick={close}>
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="results-body">
          {!r && loaded && <p className="results-empty">Ask Keo to research something, for example “compare the best prices for …”, and the result will appear here.</p>}
          {r && (
            <>
              {r.summary && <p className="results-summary">{r.summary}</p>}
              {r.criteria.length > 0 && (
                <ul className="results-criteria" aria-label="What was compared">
                  {r.criteria.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              )}
              <ul className="results-cards">
                {r.cards.map((c, i) => (
                  <li key={`${c.url}-${i}`} className="results-card" style={{ animationDelay: `${120 + i * 90}ms` }}>
                    <div className="results-pic">{c.image ? <img src={c.image} alt={c.name} /> : <span>No picture on the page</span>}</div>
                    <div className="results-info">
                      <h2>{c.name}</h2>
                      <div className="results-price">
                        <strong className={c.price ? undefined : 'none'}>{c.price ? `${c.currency && /^[\d.,\s]+$/.test(c.price) ? `${c.currency} ` : ''}${c.price}` : 'Price not found'}</strong>
                        {c.merchant && <span> · {c.merchant}</span>}
                      </div>
                      {c.availability && <div className="results-avail">{c.availability}</div>}
                      {c.fit && <p className="results-fit">{c.fit}</p>}
                      {c.specs.length > 0 && (
                        <ul className="results-specs">
                          {c.specs.slice(0, 6).map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      )}
                      {(c.pros.length > 0 || c.cons.length > 0) && (
                        <div className="results-pc">
                          {c.pros.slice(0, 3).map((p) => (
                            <span key={`p-${p}`} className="pro">+ {p}</span>
                          ))}
                          {c.cons.slice(0, 3).map((p) => (
                            <span key={`c-${p}`} className="con">− {p}</span>
                          ))}
                        </div>
                      )}
                      <button className="results-link" title={c.url} onClick={() => void invoke('app:openUrl', { url: c.url }).catch(() => undefined)}>
                        <Icon name="link" size={12} /> {hostOf(c.url)}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="results-foot">Prices and pictures come from the pages Keo opened{r.createdAt ? ` on ${new Date(r.createdAt).toLocaleString()}` : ''}. Check the seller before buying.</p>
            </>
          )}
        </div>

        {r && (
          <footer className="results-actions">
            {status && (
              <div className={`results-status ${status.kind}`} role="status">
                <Icon name={status.kind === 'ok' ? 'check' : 'warn'} size={13} />
                <span>{status.text}</span>
                {status.folder && (
                  <button className="results-open" onClick={() => void invoke('results:openFolder', { folder: status.folder! }).catch(() => undefined)}>
                    Open folder
                  </button>
                )}
              </div>
            )}
            {sendOpen ? (
              <form
                className="results-send"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <input className="input" autoFocus placeholder="Send to (WhatsApp contact name)" value={contact} maxLength={120} onChange={(e) => setContact(e.target.value)} disabled={busy === 'send'} />
                <input className="input" placeholder="Note (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} disabled={busy === 'send'} />
                <div className="results-row">
                  <div className="results-seg" role="radiogroup" aria-label="WhatsApp">
                    {(['app', 'web'] as const).map((w) => (
                      <button key={w} type="button" role="radio" aria-checked={which === w} className={which === w ? 'on' : ''} onClick={() => setWhich(w)} disabled={busy === 'send'}>
                        {w === 'app' ? 'Desktop app' : 'WhatsApp Web'}
                      </button>
                    ))}
                  </div>
                  <span className="grow" />
                  <button type="button" className="btn ghost" onClick={() => setSendOpen(false)} disabled={busy === 'send'}>
                    Cancel
                  </button>
                  <button type="submit" className="btn primary" disabled={busy === 'send' || !contact.trim()}>
                    <Icon name="send" size={13} /> {busy === 'send' ? 'Sending…' : 'Send picture + text'}
                  </button>
                </div>
              </form>
            ) : (
              <div className="results-row">
                <span className="results-label">Save</span>
                {(['pdf', 'png', 'page'] as const).map((f) => (
                  <button key={f} className="btn" onClick={() => void save(f)} disabled={!!busy}>
                    <Icon name="download" size={13} /> {busy === f ? 'Saving…' : FORMAT_LABEL[f]}
                  </button>
                ))}
                <span className="grow" />
                <button className="btn primary" onClick={() => setSendOpen(true)} disabled={!!busy}>
                  <Icon name="send" size={13} /> Send on WhatsApp
                </button>
              </div>
            )}
            <p className="results-hint">Or just tell Keo: “save it as a PDF” or “send it to …”.</p>
          </footer>
        )}
      </section>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
