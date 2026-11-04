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
    </div>
  );
}
