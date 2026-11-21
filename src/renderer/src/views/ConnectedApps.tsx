import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { ChatAccounts } from './ChatAccounts';

type App = 'telegram' | 'notion' | 'slack';
type Status = { telegram: { connected: boolean }; notion: { connected: boolean }; slack: { connected: boolean }; drive: { connected: boolean }; googleReady: boolean };

/** How each app is connected, step by step. */
const APPS: Record<App, { label: string; what: string; steps: string[]; placeholder: string }> = {
  telegram: {
    label: 'Telegram bot',
    what: 'For a bot people message (like a help desk) — not your own account (that is above). Keo reads messages sent to your bot and sends messages and files (like exported videos) from it, after you approve each one.',
    steps: ['In Telegram, open a chat with @BotFather and send /newbot.', 'Give the bot a name and a username; BotFather replies with a token.', 'Paste that token here. Then message your bot once, so it can write back to you.'],
    placeholder: '123456789:AA…',
  },
  notion: {
    label: 'Notion',
    what: 'Keo finds and reads the pages you share with it, and adds notes or new pages after you approve.',
    steps: ['Open notion.so/my-integrations and click New integration (type: Internal).', 'Copy its Internal Integration Secret and paste it here.', 'In Notion, on each page Keo may use: ••• → Connections → add your integration.'],
    placeholder: 'ntn_… or secret_…',
  },
  slack: {
    label: 'Slack',
    what: 'Keo reads channels its app is in and posts messages after you approve each one.',
    steps: ['Open api.slack.com/apps → Create New App → From scratch, pick your workspace.', 'OAuth & Permissions → Bot Token Scopes: add chat:write, channels:read, channels:history, groups:read, groups:history. Install to Workspace.', 'Copy the Bot User OAuth Token (xoxb-…) and paste it here. In Slack, add the app to a channel with /invite.'],
    placeholder: 'xoxb-…',
  },
};

export function ConnectedApps() {
  const ui = useUi();
  const [st, setSt] = useState<Status | null>(null);
  const [open, setOpen] = useState<App | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => void invoke('connected:status', {}).then(setSt, () => undefined);
  useEffect(refresh, []);

  const connect = async (app: App) => {
    setBusy(app);
    try {
      const r = await invoke('connected:set', { app, token: token.trim() });
      ui.toast(`${APPS[app].label} connected${r.name ? `: ${r.name}` : ''}.`, 'success');
      setToken('');
      setOpen(null);
      refresh();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const disconnect = async (app: App) => {
    const ok = await ui.confirm({ title: `Disconnect ${APPS[app].label}?`, body: 'Keo forgets the token. You can connect it again any time.', confirmLabel: 'Disconnect' });
    if (!ok) return;
    await invoke('connected:clear', { app }).catch(() => undefined);
    refresh();
  };
  const drive = async () => {
    setBusy('drive');
    try {
      const r = await invoke('connected:connectDrive', {});
      if (!r.connected) ui.error('Drive was not connected: tick the box on Google’s page.');
      refresh();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Connected apps</h2>
      <ChatAccounts />
      <h3 style={{ margin: '16px 0 4px' }}>Other apps</h3>
      <p className="small muted">Ask Keo in chat, e.g. “send my latest video to Telegram”, “add these ideas to my Notion page”, “post the update in #general”, “save the export to Drive”. Anything that sends or writes asks you first. Tokens are stored encrypted on this PC.</p>
      {(Object.keys(APPS) as App[]).map((app) => (
        <div key={app} className="connected-row">
          <div className="row">
            <strong className="grow">{APPS[app].label}</strong>
            {st?.[app].connected ? (
              <>
                <span className="chip ok">Connected</span>
                <button className="btn sm ghost" onClick={() => void disconnect(app)}>Disconnect</button>
              </>
            ) : (
              <button className="btn sm" onClick={() => { setOpen(open === app ? null : app); setToken(''); }}>
                <Icon name="link" size={12} /> Connect
              </button>
            )}
          </div>
          <p className="small muted">{APPS[app].what}</p>
          {open === app && !st?.[app].connected && (
            <div className="connected-setup">
              <ol className="small">
                {APPS[app].steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div className="row" style={{ gap: 6 }}>
                <input className="input grow" type="password" autoComplete="off" value={token} placeholder={APPS[app].placeholder} onChange={(e) => setToken(e.target.value)} />
                <button className="btn sm primary" disabled={token.trim().length < 10 || busy === app} onClick={() => void connect(app)}>
                  {busy === app ? <span className="spinner tiny" /> : null} Check and save
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="connected-row">
        <div className="row">
          <strong className="grow">Google Drive</strong>
          {st?.drive.connected ? (
            <span className="chip ok">Connected</span>
          ) : (
            <button className="btn sm" disabled={!st?.googleReady || busy === 'drive'} onClick={() => void drive()}>
              {busy === 'drive' ? <span className="spinner tiny" /> : <Icon name="link" size={12} />} Connect Drive
            </button>
          )}
        </div>
        <p className="small muted">Keo saves files you ask for (exported videos, documents) to your Drive and gives you the link. It can only see the files it saved itself, never the rest of your Drive.</p>
      </div>
    </section>
  );
}
