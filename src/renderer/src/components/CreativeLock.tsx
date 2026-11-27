import { useEffect, useState, type ReactNode } from 'react';
import type { InvokeOutputs } from '@shared/ipc';
import { invoke, subscribe } from '../lib/api';
import { Icon } from './Icon';

export type CreativeAccess = InvokeOutputs['account:creativeAccess'];

/**
 * Keo Studio and Builds without a Keo account: open for one day from first use, then locked until
 * the user signs in. `use` starts the free day (opening Studio or Builds counts as using them).
 */
export function useCreativeAccess(use = false): CreativeAccess | null {
  const [a, setA] = useState<CreativeAccess | null>(null);
  useEffect(() => {
    let live = true;
    const read = (start: boolean) =>
      void invoke('account:creativeAccess', start ? { use: true } : {})
        .then((r) => live && setA(r))
        .catch(() => undefined);
    read(use);
    const t = setInterval(() => read(false), 60_000);
    const off = subscribe('account:changed', () => read(false));
    return () => {
      live = false;
      clearInterval(t);
      off();
    };
  }, [use]);
  return a;
}

/** Opens the sign-in screen (Keo without an account shows it once "own keys" is off). */
export function openSignIn(): void {
  void invoke('settings:update', { patch: { ui: { ownKeys: false } } }).catch(() => undefined);
}

const left = (endsAt: string) => {
  const ms = Date.parse(endsAt) - Date.now();
  const h = Math.floor(ms / 3600_000);
  return h >= 1 ? `${h} hour${h === 1 ? '' : 's'}` : `${Math.max(1, Math.ceil(ms / 60_000))} minutes`;
};

/**
 * Wraps Studio or Builds: the page itself while it is open, a short note during the free day, and
 * a lock with "Sign in" once the day is over (the user's work is kept and comes back on sign-in).
 */
export function CreativeGate({ area, children }: { area: 'Studio' | 'Builds'; children: ReactNode }) {
  const a = useCreativeAccess(true);
  if (a?.locked)
    return (
      <div className="creative-lock" role="region" aria-label={`${area} is locked`}>
        <div className="creative-lock-box">
          <span className="creative-lock-icon">
            <Icon name="lock" size={26} />
          </span>
          <h2>Sign in to keep using Keo {area}</h2>
          <p>
            Your free day of {area} without a Keo account is over. A Keo account is free and opens Studio and Builds again — everything you made is kept and waiting for you.
          </p>
          <button className="btn primary" onClick={openSignIn}>
            Sign in or create a free account
          </button>
        </div>
      </div>
    );
  return (
    <>
      {a && !a.signedIn && a.endsAt && (
        <div className="creative-trial" role="status">
          <Icon name="clock" size={14} />
          <span className="grow">
            Free day without a Keo account: <strong>{left(a.endsAt)} left</strong> of Studio and Builds.
          </span>
          <button className="link-btn small" onClick={openSignIn}>
            Sign in to keep them
          </button>
        </div>
      )}
      {children}
    </>
  );
}
