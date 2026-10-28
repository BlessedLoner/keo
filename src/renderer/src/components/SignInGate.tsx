import { useEffect, useRef, useState } from 'react';
import introVideo from '../assets/intro/keo-intro.mp4';
import { invoke } from '../lib/api';
import { useApp } from '../state/AppState';
import '../styles/signin.css';
import { useAccount, useAuthForm } from './AccountPanel';
import { Icon } from './Icon';

/** The intro plays once per run of Keo (signing out later goes straight to the form, even after the window reloads). */
const INTRO_KEY = 'keo-intro-seen';
let introSeen = (() => {
  try {
    return sessionStorage.getItem(INTRO_KEY) === '1';
  } catch {
    return false;
  }
})();
const markIntroSeen = () => {
  introSeen = true;
  try {
    sessionStorage.setItem(INTRO_KEY, '1');
  } catch {
    /* not needed to work */
  }
};

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Keo's sign-in screen: the whole window, until the user signs in to their Keo account. It opens
 * with Keo's intro (the robot turns and says hello), then the robot glides aside and the form
 * comes in. People who prefer their own API key can opt out at the bottom (Settings → Providers →
 * Advanced then has the keys).
 */
export function SignInGate() {
  const app = useApp();
  const account = useAccount();
  const f = useAuthForm();
  const video = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<'intro' | 'form'>(() => (introSeen || reduceMotion() ? 'form' : 'intro'));
  const email = useRef<HTMLInputElement>(null);

  // The intro: play once, then hold the last frame (Keo facing you) beside the form.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (phase === 'form') {
      const hold = () => {
        if (Number.isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 0.05);
      };
      if (v.readyState >= 1) hold();
      else v.addEventListener('loadedmetadata', hold, { once: true });
      return;
    }
    const done = () => {
      markIntroSeen();
      setPhase('form');
    };
    v.addEventListener('ended', done);
    void v.play().catch(done);
    // Never longer than the video itself (+ a little), even if it stalls.
    const t = window.setTimeout(done, 9000);
    return () => {
      v.removeEventListener('ended', done);
      window.clearTimeout(t);
    };
  }, [phase]);

  useEffect(() => {
    if (phase === 'form') window.setTimeout(() => email.current?.focus(), 700);
  }, [phase]);

  const skip = () => {
    markIntroSeen();
    setPhase('form');
  };
  // Keo without a Keo account has its own data (not this sign-in screen's): Keo starts again on it.
  const ownKey = async () => {
    await invoke('settings:update', { patch: { ui: { ownKeys: true } } }).catch(() => undefined);
    app.setView('settings');
    await invoke('account:useLocal', {}).catch(() => undefined);
  };
  const signup = f.mode === 'signup';

  return (
    <div className={`signin ${phase}`} role="dialog" aria-modal="true" aria-label="Sign in to Keo">
      <div className="signin-drag" />
      <div className="signin-glow" aria-hidden="true" />

      <div className="signin-stage" aria-hidden="true">
        <video ref={video} src={introVideo} muted playsInline preload="auto" />
      </div>

      {phase === 'intro' && (
        <button className="signin-skip" onClick={skip}>
          Skip intro
        </button>
      )}

      <section className="signin-pitch" aria-hidden={phase === 'intro'}>
        <h1>Your AI that works on your computer.</h1>
        <ul>
          <li>
            <Icon name="chat" size={16} /> Chats, researches and writes with you
          </li>
          <li>
            <Icon name="shield" size={16} /> Works in your apps — only with your permission
          </li>
          <li>
            <Icon name="memory" size={16} /> Remembers what matters, on your PC
          </li>
        </ul>
      </section>

      <section className="signin-card" aria-hidden={phase === 'intro'}>
        <h2>{signup ? 'Create your Keo account' : 'Welcome back'}</h2>
        <p className="signin-sub">{signup ? 'Free to start — no API keys, no setup.' : 'Sign in to continue with Keo.'}</p>

        <div className="signin-tabs" role="tablist" aria-label="Account">
          <button role="tab" aria-selected={signup} className={signup ? 'on' : ''} onClick={() => f.setMode('signup')}>
            Create account
          </button>
          <button role="tab" aria-selected={!signup} className={!signup ? 'on' : ''} onClick={() => f.setMode('signin')}>
            Sign in
          </button>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void f.submit();
          }}
        >
          <label className="signin-field">
            <span>Email</span>
            <input ref={email} type="email" autoComplete="email" placeholder="you@example.com" value={f.email} onChange={(e) => f.setEmail(e.target.value)} required />
          </label>
          <label className="signin-field">
            <span>Password</span>
            <input
              type="password"
              autoComplete={signup ? 'new-password' : 'current-password'}
              placeholder={signup ? 'At least 8 characters' : 'Your password'}
              value={f.password}
              minLength={signup ? 8 : 1}
              onChange={(e) => f.setPassword(e.target.value)}
              required
            />
          </label>
          {!signup && (
            <button type="button" className="signin-link right" onClick={() => void f.reset()}>
              Forgot password?
            </button>
          )}
          <button className="signin-primary" type="submit" disabled={f.busy || !f.ready}>
            {f.busy ? <span className="spinner" /> : signup ? 'Create account' : 'Sign in'}
          </button>
        </form>

        {account?.pendingEmail && account.waitingForConfirmation && (
          <p className="signin-note ok">
            <span className="spinner" /> Open the link we sent to {account.pendingEmail}. Keo signs you in by itself as soon as you confirm.
          </p>
        )}
        {account?.pendingEmail && !account.waitingForConfirmation && !f.note && <p className="signin-note ok">Check {account.pendingEmail} for the confirmation link, then sign in.</p>}
        {f.note && <p className={`signin-note ${f.note.ok ? 'ok' : 'bad'}`}>{f.note.text}</p>}

        <p className="signin-fine">
          By continuing you agree to Keo’s{' '}
          <button type="button" className="signin-link" onClick={() => void invoke('app:openLink', { id: 'terms' })}>
            Terms
          </button>{' '}
          and{' '}
          <button type="button" className="signin-link" onClick={() => void invoke('app:openLink', { id: 'privacy' })}>
            Privacy Policy
          </button>
          . Your conversations stay on this PC.
        </p>
        <div className="signin-divider" />
        <button type="button" className="signin-link muted" onClick={() => void ownKey()}>
          Advanced: use my own API key instead
        </button>
      </section>
    </div>
  );
}
