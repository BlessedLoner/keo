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

export type Note = { ok: boolean; text: string } | null;

/** Create account / sign in / forgot password: the form's state and actions (sign-in screen and Settings). */
export function useAuthForm(onSignedIn?: () => void) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const submit = async () => {
    setBusy(true);
    setNote(null);
    try {
      if (mode === 'signup') {
        const r = await invoke('account:signUp', { email, password });
        if (r.needsConfirmation) {
          // Keo signs in by itself once the email is confirmed (the screen says so).
          setNote(null);
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
  /** "Continue with Google": the browser opens; Keo is signed in when the user comes back. */
  const google = async () => {
    setNote(null);
    try {
      await invoke('account:google', {});
      onSignedIn?.();
    } catch (e) {
      const text = errText(e);
      if (!/cancelled/i.test(text)) setNote({ ok: false, text });
    }
  };
  const cancelGoogle = () => void invoke('account:cancelGoogle', {}).catch(() => undefined);
  const ready = email.includes('@') && password.length >= (mode === 'signup' ? 8 : 1);
  return { mode, setMode, email, setEmail, password, setPassword, busy, note, setNote, submit, reset, ready, google, cancelGoogle };
}

/** Google's "G" (four colours), for the "Continue with Google" button. */
export function GoogleMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.6-.4-3.9z" />
    </svg>
  );
}

/** "Continue with Google", or (while the browser is open) a note with Cancel. */
export function GoogleButton({ waiting, onStart, onCancel, className = '' }: { waiting: boolean; onStart: () => void; onCancel: () => void; className?: string }) {
  if (waiting)
    return (
      <div className={`google-wait ${className}`} role="status">
        <span className="spinner" />
        <span>Finish signing in with Google in your browser…</span>
        <button type="button" className="link-btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    );
  return (
    <button type="button" className={`google-btn ${className}`} onClick={onStart}>
      <GoogleMark />
      <span>Continue with Google</span>
    </button>
  );
}

/** "Renews around 30 November 2026" / "Ends 30 November 2026" / a payment problem. */
function billingLine(b: NonNullable<AccountStatus['billing']>): string {
  const day = b.until ? new Date(b.until).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : null;
  if (b.status === 'attention') return 'The last renewal payment did not go through — update your card with Manage plan.';
  if (b.status === 'non-renewing' || b.status === 'cancelled') return day ? `Your plan ends ${day} (it will not renew).` : 'Your plan will not renew.';
  return day ? `Renews around ${day}.` : 'Renews monthly.';
}



/**
 * Sign up / sign in to Keo, or (signed in) the plan and today's allowance. Keo's own AI needs no
 * API key: requests go through Keo Cloud with this sign-in.
 */
const WINDOW_NAME = { day: 'Today', week: 'This week', month: 'This month' } as const;

/** One window of the AI allowance as a ring: how much is used, and when it resets. */
function AllowanceRing({ label, used, note }: { label: string; used: number; note: string }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, used));
  const tone = pct >= 100 ? 'full' : pct >= 80 ? 'high' : '';
  return (
    <div className={`acct-ring ${tone}`} role="progressbar" aria-label={`${label}: AI allowance used`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className="acct-ring-dial">
        <svg viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
          <circle cx="42" cy="42" r={r} className="track" />
          <circle cx="42" cy="42" r={r} className="fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
        </svg>
        <div className="acct-ring-num">
          {pct}
          <span>%</span>
        </div>
      </div>
      <div className="acct-ring-label">{label}</div>
      {note && <div className="acct-ring-note">{note}</div>}
    </div>
  );
}


/** When an allowance window resets, in the user's own time ("today at 01:00", "Monday at 01:00", "on 28 December"). */
function resetWords(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const time = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((new Date(t.toDateString()).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);
  if (days <= 0) return `today at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days < 7) return `${t.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`;
  return `on ${t.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`;
}

export function AccountPanel({ onSignedIn, activeProvider, onUseKeo }: { onSignedIn?: () => void; activeProvider?: string | null; onUseKeo?: () => void }) {
  const a = useAccount();
  const f = useAuthForm(onSignedIn);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);

  if (!a) return <div className="muted small">Loading…</div>;

  const buyTopup = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await invoke('account:upgrade', { go: 'topup' });
      if (!r.opened) setNote({ ok: false, text: 'Keo could not open your browser.' });
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const upgrade = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await invoke('account:upgrade', {});
      if (!r.opened) setNote({ ok: false, text: 'Keo could not open your browser.' });
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  if (a.signedIn) {
    const u = a.usage;
    const plan = a.plan;
    // The AI allowance's three windows (older servers send only the month's figure).
    const windows = u?.windows?.length ? u.windows : u ? [{ window: 'month' as const, used: u.monthUsed ?? u.allowanceUsed ?? 0, resetsAt: '' }] : [];
    const used = Math.max(0, ...windows.map((w) => w.used));
    const full = windows.find((w) => w.used >= 100);
    const strongLeft = u?.buildsLeft?.['keo-strong'] ?? u?.buildsLeft?.['keo-fast'];
    const n = (k: string) => (plan && typeof plan.features[k] === 'number' ? (plan.features[k] as number) : 0);
    const daily = u
      ? [
          { label: 'Web searches', icon: 'search', used: u.webSearches, max: n('web_search') },
          { label: 'Pictures', icon: 'image', used: u.images, max: n('images') },
          { label: 'Voice minutes', icon: 'mic', used: Math.ceil(u.voiceSeconds / 60), max: n('voice_minutes') },
        ]
      : [];
    return (
      <div className="account-panel signed-in">
        <div className="acct-head">
          <span className="acct-avatar" aria-hidden="true">
            {(a.email ?? '?').slice(0, 1).toUpperCase()}
          </span>
          <div className="acct-who">
            <div className="acct-email">{a.email}</div>
            <div className="acct-sub">{a.billing ? billingLine(a.billing) : plan ? `${plan.name} plan` : 'Keo account'}</div>
          </div>
          {plan && <span className={`acct-plan ${plan.id === 'free' ? 'free' : ''}`}>{plan.name}</span>}
        </div>

        {plan && u && (
          <>
            <div className="acct-section-title">
              AI allowance <span>chat, building and operating your computer</span>
            </div>
            <div className="acct-rings">
              {windows.map((w) => (
                <AllowanceRing key={w.window} label={WINDOW_NAME[w.window]} used={w.used} note={w.resetsAt ? `${w.window === 'month' ? 'Renews' : 'Resets'} ${resetWords(w.resetsAt)}` : ''} />
              ))}
              <div className="acct-left">
                {strongLeft && used < 100 ? (
                  <>
                    <div className="acct-big">{strongLeft.month.toLocaleString()}</div>
                    <div className="acct-left-label">
                      {strongLeft.month === 1 ? 'build' : 'builds'} left this month on {u.buildsLeft?.['keo-strong'] ? 'Keo Strong' : 'Keo Fast'}
                      {strongLeft.now < strongLeft.month ? ` · ${strongLeft.now.toLocaleString()} today` : ''}
                    </div>
                    <div className="acct-hint">Keo Best uses it about twice as fast.</div>
                  </>
                ) : (
                  <div className="acct-left-label">{full ? 'Paused until it resets — your tasks keep their work.' : 'Your allowance for this month.'}</div>
                )}
              </div>
            </div>
            {full && (
              <div className="acct-alert" role="status">
                <Icon name="warn" size={15} />
                <span>
                  {full.window === 'month' ? 'This month’s AI allowance is used up.' : full.window === 'week' ? 'This week’s share of your AI allowance is used up.' : 'Today’s share of your AI allowance is used up.'} Keo pauses tasks and keeps their work; they carry on when it {full.window === 'month' ? 'renews' : 'resets'}
                  {full.resetsAt ? ` (${resetWords(full.resetsAt)})` : ''}.{u.topup ? ' Your AI top-up is being used now.' : ' An AI top-up lets you carry on now.'}
                </span>
              </div>
            )}
            <div className="acct-tiles">
              {daily.map((d) => (
                <div key={d.label} className="acct-tile">
                  <div className="acct-tile-top">
                    <Icon name={d.icon} size={14} />
                    <span>{d.label}</span>
                  </div>
                  {d.max > 0 ? (
                    <>
                      <div className="acct-tile-num">
                        {d.used.toLocaleString()} <span>/ {d.max.toLocaleString()} today</span>
                      </div>
                      <div className="acct-mini" role="progressbar" aria-label={`${d.label} used today`} aria-valuenow={d.used} aria-valuemin={0} aria-valuemax={d.max}>
                        <i style={{ width: `${Math.min(100, (d.used / d.max) * 100)}%` }} />
                      </div>
                    </>
                  ) : (
                    <div className="acct-tile-num muted">Not in your plan</div>
                  )}
                </div>
              ))}
              <div className={`acct-tile topup${u.topup ? ' on' : ''}`}>
                <div className="acct-tile-top">
                  <Icon name="sparkle" size={14} />
                  <span>AI top-up</span>
                </div>
                {u.topup ? (
                  <>
                    <div className="acct-tile-num">
                      ~{(u.topup.buildsLeft['keo-strong'] ?? 0).toLocaleString()} <span>builds left</span>
                    </div>
                    <div className="acct-hint">or {u.topup.tasksLeft.toLocaleString()} tasks on Keo Fast · never expires</div>
                  </>
                ) : (
                  <div className="acct-hint">Extra AI for when the allowance runs out. Never expires.</div>
                )}
              </div>
            </div>
            <div className="acct-hint">The day and week are shares of the month, so the allowance lasts the whole month. Studio credits are separate and never pay for chat.</div>
          </>
        )}
        {a.error && <div className="small" style={{ color: 'var(--warn, #ffb547)' }}>{a.error}</div>}
        {note && <div className="small" style={{ color: 'var(--danger, #ff5d6c)' }}>{note.text}</div>}
        <div className="acct-actions">
          <button className={`btn sm ${plan?.id === 'free' || !plan ? 'primary' : ''}`} onClick={() => void upgrade()} disabled={busy} title="Opens Keo’s plans page in your browser">
            {plan?.id === 'free' || !plan ? 'Upgrade' : 'Manage plan'}
          </button>
          {plan && (
            <button className={`btn sm ${full && !u?.topup ? 'primary' : ''}`} onClick={() => void buyTopup()} disabled={busy} title="Opens Keo’s plans page at AI top-ups">
              Buy AI top-up
            </button>
          )}
          {activeProvider !== 'keo' && onUseKeo && (
            <button className="btn primary sm" onClick={onUseKeo}>
              Use Keo’s AI
            </button>
          )}
          <span className="grow" />
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

  const { mode, setMode, email, setEmail, password, setPassword, submit, reset } = f;

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
      <GoogleButton className="account-google" waiting={!!a.signingInWithGoogle} onStart={() => void f.google()} onCancel={f.cancelGoogle} />
      <div className="or-line small muted">or with your email</div>
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
          <button className="btn primary" type="submit" disabled={f.busy || !f.ready}>
            {f.busy ? 'Please wait…' : mode === 'signup' ? 'Create my Keo account' : 'Sign in'}
          </button>
          {mode === 'signin' && (
            <button type="button" className="link-btn small" onClick={() => void reset()}>
              Forgot password?
            </button>
          )}
        </div>
      </form>
      {a.pendingEmail && !f.note && <p className="small muted">Check {a.pendingEmail} for the confirmation link, then sign in.</p>}
      {f.note && <p className={`small ${f.note.ok ? 'muted' : ''}`} style={f.note.ok ? undefined : { color: 'var(--danger, #ff5d6c)' }}>{f.note.text}</p>}
      <p className="muted small">The Free plan is included. Your messages go through Keo Cloud to the AI model; Keo Cloud does not keep them.</p>
      <p className="muted small">
        By creating an account you agree to Keo’s{' '}
        <button type="button" className="link-btn small" onClick={() => void invoke('app:openLink', { id: 'terms' })}>
          Terms
        </button>{' '}
        and{' '}
        <button type="button" className="link-btn small" onClick={() => void invoke('app:openLink', { id: 'privacy' })}>
          Privacy Policy
        </button>
        .
      </p>
    </div>
  );
}
