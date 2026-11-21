import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useInvoke } from '../lib/hooks';

type App = 'whatsapp' | 'telegram';

const INFO: Record<App, { label: string; steps: string; channel: 'whatsapp_bg' | 'telegram_bg' }> = {
  whatsapp: { label: 'WhatsApp', steps: 'On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan the code in the window Keo opens.', channel: 'whatsapp_bg' },
  telegram: { label: 'Telegram', steps: 'On your phone: Telegram → Settings → Devices → Link Desktop Device, then scan the code in the window Keo opens.', channel: 'telegram_bg' },
};

const DEFAULT_GOAL = 'Reply for me: be friendly and short, and say I’ll get back to them for anything important.';
const LENGTHS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 180, label: '3 hours' },
  { minutes: 480, label: '8 hours' },
  { minutes: 1440, label: '24 hours' },
];

const until = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Settings → Connected apps: the user's own WhatsApp and Telegram, linked to Keo once (Keo's own
 * web version of each, running in the background), with the account shown and one switch to let
 * Keo answer everyone — no need to type a request in the chat.
 */
export function ChatAccounts() {
  const ui = useUi();
  const accounts = useInvoke('chats:accounts', {}, { refreshOn: ['chats:changed'], pollMs: 15000 });
  const auto = useInvoke('livechat:auto', {}, { refreshOn: ['livechat:changed'], pollMs: 15000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [goal, setGoal] = useState<Record<App, string>>({ whatsapp: DEFAULT_GOAL, telegram: DEFAULT_GOAL });
  const [minutes, setMinutes] = useState<Record<App, number>>({ whatsapp: 180, telegram: 180 });
  const [editing, setEditing] = useState<App | null>(null);
  const list = accounts.data ?? [];
  const linking = list.some((a) => a.status === 'linking');

  // While a QR code is waiting to be scanned, check often so the panel updates as soon as it is linked.
  useEffect(() => {
    if (!linking) return;
    const t = setInterval(() => accounts.refresh(), 2000);
    return () => clearInterval(t);
  }, [linking]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) ui.toast(done, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
      accounts.refresh();
      auto.refresh();
    }
  };

  const unlink = async (app: App) => {
    const ok = await ui.confirm({
      title: `Unlink ${INFO[app].label}?`,
      body: `Keo signs its copy out on this PC and stops answering there. To remove it from your phone too: ${app === 'whatsapp' ? 'WhatsApp → Settings → Linked devices' : 'Telegram → Settings → Devices'}, then tap the Keo device.`,
      confirmLabel: 'Unlink',
    });
    if (ok) await act(`unlink:${app}`, () => invoke('chats:unlink', { app }), `${INFO[app].label} unlinked.`);
  };

  const on = auto.data ?? null;

  return (
    <div className="chat-accounts">
      <h3 style={{ margin: '0 0 4px' }}>Your WhatsApp and Telegram</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Link your own account once and Keo can chat for you in the background — your screen, mouse and keyboard stay yours.
      </p>
      {(['whatsapp', 'telegram'] as const).map((app) => {
        const a = list.find((x) => x.app === app);
        const linked = !!a && (a.status === 'ready' || a.status === 'loading');
        const who = a ? [a.name, a.phone].filter(Boolean).join(' · ') : '';
        const answering = on && on.channel === INFO[app].channel ? on : null;
        return (
          <div key={app} className="connected-row">
            <div className="row" style={{ gap: 8 }}>
              <Icon name="chat" size={16} />
              <strong>{INFO[app].label}</strong>
              <span className="grow small muted">{linked ? who || 'Linked' : ''}</span>
              {a?.status === 'linking' ? (
                <span className="chip info">Waiting for you to scan the code…</span>
              ) : linked ? (
                <>
                  <span className="chip ok">Linked</span>
                  <button className="btn sm ghost" disabled={busy === `unlink:${app}`} onClick={() => void unlink(app)}>
                    Unlink
                  </button>
                </>
              ) : (
                <button className="btn sm" disabled={!!busy || linking} onClick={() => void act(`link:${app}`, () => invoke('chats:link', { app }))}>
                  {busy === `link:${app}` ? <span className="spinner tiny" /> : <Icon name="link" size={12} />} Link
                </button>
              )}
            </div>
            {a?.status === 'linking' && <p className="small muted">{INFO[app].steps}</p>}
            {!linked && a?.status !== 'linking' && <p className="small muted">{INFO[app].steps.replace('then scan the code in the window Keo opens.', 'after you click Link.')}</p>}
            {linked && (
              <div className="auto-answer">
                <label className="toggle">
                  <input
                    type="checkbox"
                    checked={!!answering}
                    disabled={!!busy}
                    onChange={(e) => {
                      if (e.target.checked) setEditing(app);
                      else void act(`auto:${app}`, () => invoke('livechat:autoStop', {}), 'Keo stopped answering everyone. Chats already running keep going.');
                    }}
                  />
                  <span className="small">
                    <strong>Answer everyone who messages me</strong>
                    {answering ? (
                      <span className="muted">
                        {' '}
                        · on until {until(answering.endsAt)} · {answering.started} chat{answering.started === 1 ? '' : 's'} so far
                      </span>
                    ) : null}
                  </span>
                </label>
                {answering && <p className="small muted">“{answering.goal}”</p>}
                {editing === app && !answering && (
                  <div className="auto-setup">
                    <textarea className="input" rows={2} value={goal[app]} maxLength={600} onChange={(e) => setGoal({ ...goal, [app]: e.target.value })} />
                    <div className="row" style={{ gap: 6 }}>
                      <span className="small muted">For</span>
                      <select className="input" value={minutes[app]} onChange={(e) => setMinutes({ ...minutes, [app]: Number(e.target.value) })}>
                        {LENGTHS.map((l) => (
                          <option key={l.minutes} value={l.minutes}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                      <span className="grow" />
                      <button className="btn sm ghost" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                      <button
                        className="btn sm primary"
                        disabled={!goal[app].trim() || !!busy}
                        onClick={() =>
                          void act(
                            `auto:${app}`,
                            async () => {
                              await invoke('livechat:autoStart', { where: app, goal: goal[app].trim(), minutes: minutes[app] });
                              setEditing(null);
                            },
                            `Keo is answering everyone on your ${INFO[app].label}.`,
                          )
                        }
                      >
                        Start
                      </button>
                    </div>
                    <p className="small muted">
                      Each person who writes gets their own chat (see Tasks). Keo still asks you about money, meetings, personal matters and “are you a bot?”. Messages already waiting are left for you.
                      {on && !answering ? ' This replaces the answer-everyone that is on now.' : ''}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
