import { invoke } from '../lib/api';
import { useApp } from '../state/AppState';
import { AccountPanel } from './AccountPanel';
import { KeoEmblem } from './KeoEmblem';

/**
 * The first thing Keo shows until the user signs in to their Keo account. People who prefer
 * their own API key can opt out here (it moves them to Settings → Providers → Advanced).
 */
export function SignInGate() {
  const app = useApp();
  const useOwnKey = async () => {
    await invoke('settings:update', { patch: { ui: { ownKeys: true } } }).catch(() => undefined);
    app.setView('settings');
  };
  return (
    <div className="onboarding-backdrop signin-gate" role="dialog" aria-modal="true" aria-label="Sign in to Keo">
      <div className="onboarding">
        <div className="row" style={{ gap: 12, marginBottom: 10 }}>
          <KeoEmblem state="idle" size={44} />
          <div className="grow">
            <h2 style={{ margin: 0 }}>Welcome to Keo</h2>
            <span className="muted small">Create a free account or sign in to start.</span>
          </div>
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          Your Keo account gives you Keo’s AI right away — no API keys or setup. Conversations, memory and settings stay on this PC.
        </p>
        <AccountPanel />
        <div className="row" style={{ marginTop: 14 }}>
          <span className="grow" />
          <button className="link-btn small muted" onClick={() => void useOwnKey()}>
            Advanced: use my own API key instead
          </button>
        </div>
      </div>
    </div>
  );
}
