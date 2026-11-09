import { useCallback, useEffect, useState } from 'react';
import type { AiVideoStatus } from '@shared/ipc';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/** Where Keo Studio's AI goes and the Studio credits left (refreshed when asked). */
export function useStudioAi(): { status: AiVideoStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<AiVideoStatus | null>(null);
  const refresh = useCallback(() => {
    void invoke('aivideo:status').then(setStatus, () => undefined);
  }, []);
  useEffect(refresh, [refresh]);
  return { status, refresh };
}

/**
 * The Studio credits line: how many are left, and a button to get more (Keo's plans page, where
 * the Creator plan and credit packs are). Nothing when the user's own fal.ai key is in use.
 */
export function StudioCredits({ status, compact }: { status: AiVideoStatus | null; compact?: boolean }) {
  const ui = useUi();
  const [busy, setBusy] = useState(false);
  if (!status || status.via === 'own') return null;
  const more = async () => {
    setBusy(true);
    try {
      const r = await invoke('account:upgrade', {});
      if (!r.opened) ui.error('Keo could not open your browser.');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (status.via === null)
    return <p className={`small ${compact ? 'muted' : 'warn-text'}`}>Keo Studio’s AI needs your Keo account: sign in under Settings → Providers → Keo account.</p>;
  const c = status.credits;
  return (
    <div className="studio-credits row small">
      {c ? (
        <span>
          <strong>{c.total.toLocaleString()}</strong> Studio credits left
          {!compact && (
            <span className="muted">
              {' '}
              ({c.monthlyLeft.toLocaleString()} of {c.monthlyAllowance.toLocaleString()} this month{c.bought ? `, ${c.bought.toLocaleString()} bought` : ''})
            </span>
          )}
          {!c.ready && <span className="muted"> · Studio AI is not switched on yet</span>}
        </span>
      ) : (
        <span className="muted">Studio credits: could not check right now.</span>
      )}
      <button className={`btn sm ${c && c.total < 150 ? 'primary' : ''}`} onClick={() => void more()} disabled={busy}>
        {c && c.plan !== 'creator' && c.plan !== 'max' ? 'Get credits or Creator plan' : 'Get more credits'}
      </button>
      {!compact && <CreditsMore />}
    </div>
  );
}

/** Where the credits went, and inviting friends (both get credits). */
function CreditsMore() {
  const ui = useUi();
  const [open, setOpen] = useState<'history' | 'invite' | null>(null);
  const [history, setHistory] = useState<Array<{ what: string; credits: number; refunded: boolean; at: string }> | null>(null);
  const [ref, setRef] = useState<{ code: string | null; credits: number; joined: number; earned: number; referred: boolean } | null>(null);
  const [code, setCode] = useState('');
  const show = async (what: 'history' | 'invite') => {
    if (open === what) return setOpen(null);
    setOpen(what);
    try {
      if (what === 'history') setHistory((await invoke('account:studioHistory', {})).items);
      else setRef(await invoke('account:referral', {}));
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const redeem = async () => {
    try {
      const r = await invoke('account:redeemReferral', { code: code.trim() });
      ui.toast(`${r.credits} Studio credits added. Your friend got them too.`, 'success');
      setCode('');
      setRef(await invoke('account:referral', {}));
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <>
      <button className="btn sm ghost" onClick={() => void show('history')}>History</button>
      <button className="btn sm ghost" onClick={() => void show('invite')}>Invite friends</button>
      {open === 'history' && (
        <div className="credits-pop">
          {!history ? <span className="spinner tiny" /> : !history.length ? <p className="small muted">No credits used yet.</p> : (
            <table className="credits-table small">
              <tbody>
                {history.slice(0, 50).map((h, i) => (
                  <tr key={i} className={h.refunded ? 'muted' : ''}>
                    <td>{new Date(h.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                    <td>{h.what}</td>
                    <td className="num">{h.refunded ? 'given back' : `−${h.credits}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {open === 'invite' && (
        <div className="credits-pop">
          {!ref ? <span className="spinner tiny" /> : (
            <>
              <p className="small">Share your code: when a friend new to Keo enters it, you both get <strong>{ref.credits}</strong> Studio credits.</p>
              {ref.code && (
                <div className="row" style={{ gap: 6 }}>
                  <code className="invite-code">{ref.code}</code>
                  <button className="btn sm" onClick={() => void invoke('app:copyText', { text: ref.code! }).then(() => ui.toast('Code copied.', 'success'), () => undefined)}>Copy</button>
                </div>
              )}
              <p className="small muted">{ref.joined} friend{ref.joined === 1 ? '' : 's'} joined · {ref.earned} credits earned</p>
              {!ref.referred && (
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" value={code} maxLength={12} placeholder="A friend’s code" onChange={(e) => setCode(e.target.value.toUpperCase())} />
                  <button className="btn sm primary" disabled={code.trim().length < 6} onClick={() => void redeem()}>Use code</button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}
