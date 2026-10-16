import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { KeoEmblem, STATE_LABEL } from '../components/KeoEmblem';
import { invoke } from '../lib/api';
import { emblemFor, usePresence } from '../lib/presence';

/**
 * Floating companion: a small, non-focusable, click-through window showing
 * Keo's real presence. Only the visible pill takes the mouse; everything else
 * passes through to the desktop. Activity text is content-free (capability +
 * application), never message or page contents.
 */
export function CompanionApp() {
  const p = usePresence();
  const [hover, setHover] = useState(false);
  const dragging = useRef(false);
  const moved = useRef(false);
  const state = emblemFor(p);
  const busy = !!p && p.state !== 'idle' && p.state !== 'cancelled';

  const setInteractive = useCallback((b: boolean) => {
    void invoke('companion:setInteractive', { interactive: b }).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('companion-root');
    const up = () => {
      if (dragging.current) {
        dragging.current = false;
        void invoke('companion:drag', { phase: 'end' }).catch(() => undefined);
      }
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  }, []);

  const wake = p?.wake;
  const wakeLabel = !wake || !wake.enabled ? null : wake.muted ? 'Mic muted' : wake.status === 'listening' ? `Listening for “${wake.phrase ?? 'Hey Keo'}”` : wake.status === 'capturing' ? 'Hearing you…' : wake.message ?? wake.status;

  return (
    <div className="companion-stage">
      <div
        className={`companion ${hover ? 'expanded' : ''} state-${state}`}
        onMouseEnter={() => {
          setHover(true);
          setInteractive(true);
        }}
        onMouseLeave={() => {
          setHover(false);
          if (!dragging.current) setInteractive(false);
        }}
        role="status"
        aria-live="polite"
        aria-label={`Keo: ${STATE_LABEL[state]}${p?.activity ? `. ${p.activity}` : ''}`}
      >
        <div
          className="companion-emblem"
          title="Drag to move · click to open Keo"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = true;
            moved.current = false;
            const start = { x: e.screenX, y: e.screenY };
            const onMove = (ev: PointerEvent) => {
              if (Math.abs(ev.screenX - start.x) + Math.abs(ev.screenY - start.y) > 4) moved.current = true;
            };
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', () => window.removeEventListener('pointermove', onMove), { once: true });
            void invoke('companion:drag', { phase: 'start' }).catch(() => undefined);
          }}
          onClick={() => {
            if (!moved.current) void invoke('presence:openMain', {});
          }}
        >
          <KeoEmblem state={state} size={64} />
        </div>
        <div className="companion-body">
          <div className="companion-state">
            {STATE_LABEL[state]}
            {!!p?.pendingApprovals && <span className="badge">{p.pendingApprovals}</span>}
          </div>
          <div className="companion-activity">{p?.activity ?? wakeLabel ?? 'Ctrl+K to ask'}</div>
          {hover && (
            <div className="companion-actions">
              <button className="cbtn" aria-label="Open Keo" title="Open Keo" onClick={() => void invoke('presence:openMain', { view: p?.pendingApprovals ? 'tasks' : 'chat' })}>
                <Icon name="window" size={14} />
              </button>
              {p?.liveChats.firstReady && (
                <button
                  className="cbtn primary"
                  aria-label={`Send the reply to ${p.liveChats.firstReady.contact} now`}
                  title={`Send the reply to ${p.liveChats.firstReady.contact} now`}
                  onClick={() => void invoke('livechat:sendNow', { id: p.liveChats.firstReady!.id })}
                >
                  <Icon name="send" size={14} />
                </button>
              )}
              <button className="cbtn" aria-label="Command bar" title="Command bar" onClick={() => void invoke('commandBar:show')}>
                <Icon name="chat" size={14} />
              </button>
              {busy && (
                <button className="cbtn danger" aria-label="Stop everything" title="Stop replies and pending actions" onClick={() => void invoke('presence:stopAll')}>
                  <Icon name="stop" size={14} />
                </button>
              )}
              {wake?.enabled && (
                <button className={`cbtn ${wake.muted ? 'danger' : ''}`} aria-label={wake.muted ? 'Unmute microphone' : 'Mute microphone'} title={wake.muted ? 'Unmute wake word' : 'Mute wake word'} onClick={() => void invoke('wake:setMuted', { muted: !wake.muted })}>
                  <Icon name="mic" size={14} />
                </button>
              )}
              {!!p?.grants && (
                <button className="cbtn warn" aria-label="Revoke navigation permissions" title={`Revoke ${p.grants} navigation permission(s)`} onClick={() => void invoke('grants:revokeAll')}>
                  <Icon name="shield" size={14} />
                </button>
              )}
              <button className="cbtn" aria-label="Hide companion" title="Hide companion (re-enable in Settings)" onClick={() => void invoke('companion:hide')}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
