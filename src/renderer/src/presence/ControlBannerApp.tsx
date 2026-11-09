import { useEffect } from 'react';
import { invoke } from '../lib/api';

/**
 * Full control's banner: shown while Keo is using the computer. Stop (or Esc, or touching the
 * mouse or keyboard) hands the computer back at once. The window never takes focus and is left
 * out of screen pictures.
 */
export function ControlBannerApp() {
  useEffect(() => {
    document.documentElement.classList.add('control-root');
  }, []);
  return (
    <div className="control-banner" role="status" aria-live="polite">
      <span className="control-dot" aria-hidden="true" />
      <span className="control-text">
        <strong>Keo is using your computer</strong>
        <span className="control-hint">Esc or move the mouse to take over</span>
      </span>
      <button className="control-stop" onClick={() => void invoke('presence:stopAll')}>
        Stop
      </button>
    </div>
  );
}
