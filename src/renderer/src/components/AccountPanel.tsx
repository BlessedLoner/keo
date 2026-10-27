import { useEffect, useState } from 'react';
import type { AccountStatus } from '@shared/cloud';
import { errText, invoke, subscribe } from '../lib/api';
import { Icon } from './Icon';

/** The Keo account, live (from the main process). */
export function useAccount(): AccountStatus | null {
  const [a, setA] = useState<AccountStatus | null>(null);
  useEffect(() => {
    let live = true;
    void invoke('account:status', {}).then((v) => live && setA(v), () => undefined);
    const off = subscribe('account:changed', (v) => setA(v));
    return () => {
      live = false;
      off();
    };
  }, []);
  return a;
}

const pct = (used: number, limit: number) => (limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0);

/** Today's web searches, pictures and voice minutes against the plan ("not in plan" when it has none). */
function extras(features: Record<string, unknown>, u: NonNullable<AccountStatus['usage']>): string {
  const n = (k: string) => (typeof features[k] === 'number' ? (features[k] as number) : 0);
  const part = (label: string, used: number, max: number) => (max > 0 ? `${label} ${used} of ${max}` : `${label}: upgrade to use`);
  return [part('Web searches', u.webSearches, n('web_search')), part('Pictures', u.images, n('images')), part('Voice minutes', Math.ceil(u.voiceSeconds / 60), n('voice_minutes'))].join(' · ');
}

/**
 * Sign up / sign in to Keo, or (signed in) the plan and today's allowance. Keo's own AI needs no
 * API key: requests go through Keo Cloud with this sign-in.
 */
export function AccountPanel({ onSignedIn, activeProvider, onUseKeo }: { onSignedIn?: () => void; activeProvider?: string | null; onUseKeo?: () => void }) {
  const a = useAccount();
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  if (!a) return <div className="muted small">Loading…</div>;

  if (a.signedIn) {
    const u = a.usage;
    const plan = a.plan;
    return (
      <div className="account-panel">
        <div className="row">
          <Icon name="check" size={15} />
          <span className="grow">
            Signed in as <strong>{a.email}</strong>
          </span>
          {plan && <span className={`chip ${plan.id === 'free' ? '' : 'accent'}`}>{plan.name} plan</span>}
        </div>
        {plan && u && (
          <div className="account-usage">
            <div className="small muted">Today: {u.requests.toLocaleString()} of {plan.dailyRequests.toLocaleString()} AI steps · {(u.inputTokens + u.outputTokens).toLocaleString()} of {plan.dailyTokens.toLocaleString()} tokens</div>
            <div className="usage-bar" role="progressbar" aria-valuenow={pct(u.requests, plan.dailyRequests)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${Math.max(pct(u.requests, plan.dailyRequests), pct(u.inputTokens + u.outputTokens, plan.dailyTokens))}%` }} />
            </div>
            <div className="small muted">{extras(plan.features, u)}</div>
            <div className="small muted">Resets every day at midnight UTC.</div>
          </div>
        )}
        {a.error && <div className="small" style={{ color: 'var(--warn, #ffb547)' }}>{a.error}</div>}
        <div className="row" style={{ marginTop: 8 }}>
          {activeProvider !== 'keo' && onUseKeo && (
            <button className="btn primary sm" onClick={onUseKeo}>
              Use Keo’s AI
            </button>
          )}
          <button className="btn ghost sm" onClick={() => void invoke('account:refresh', {}).catch(() => undefined)}>
            <Icon name="retry" size={13} /> Refresh
          </button>
          <button className="btn ghost sm" onClick={() => void invoke('account:signOut', {}).catch(() => undefined)}>
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (mode === 'signup') {
        const r = await invoke('account:signUp', { email, password });
        if (r.needsConfirmation) {
          setNote({ ok: true, text: `Almost there: open the link we sent to ${email.trim()}, then come back and sign in.` });
          setMode('signin');
        } else onSignedIn?.();
      } else {
        await invoke('account:signIn', { email, password });
        setPassword('');
        onSignedIn?.();
      }
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const reset = async () => {
    if (!email.includes('@')) return setNote({ ok: false, text: 'Type your email first.' });
    try {
      await invoke('account:resetPassword', { email });
      setNote({ ok: true, text: `If there is a Keo account for ${email.trim()}, a link to choose a new password is on its way.` });
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    }
  };

  return (
    <div className="account-panel">
      <div className="seg" role="tablist" aria-label="Account">
        <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>
          Create account
        </button>
        <button role="tab" aria-selected={mode === 'signin'} className={mode === 'signin' ? 'on' : ''} onClick={() => setMode('signin')}>
          Sign in
        </button>
      </div>
      <form
        className="account-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input className="input" type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          className="input"
          type="password"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          placeholder={mode === 'signup' ? 'Choose a password (8+ characters)' : 'Password'}
          value={password}
          minLength={mode === 'signup' ? 8 : 1}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="row">
          <button className="btn primary" type="submit" disabled={busy || !email.includes('@') || password.length < (mode === 'signup' ? 8 : 1)}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create my Keo account' : 'Sign in'}
          </button>
          {mode === 'signin' && (
            <button type="button" className="link-btn small" onClick={() => void reset()}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
      {a.pendingEmail && !note && <p className="small muted">Check {a.pendingEmail} for the confirmation link, then sign in.</p>}
      {note && <p className={`small ${note.ok ? 'muted' : ''}`} style={note.ok ? undefined : { color: 'var(--danger, #ff5d6c)' }}>{note.text}</p>}
      <p className="muted small">The Free plan is included. Your messages go through Keo Cloud to the AI model; Keo Cloud does not keep them.</p>
    </div>
  );
}
