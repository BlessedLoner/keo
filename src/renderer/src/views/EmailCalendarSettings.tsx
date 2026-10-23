import { useEffect, useState } from 'react';
import type { CalendarStatus, EmailStatus } from '@shared/ipc';
import type { LinkId } from '@shared/release';
import type { Settings } from '@shared/settings';
import { EMAIL_PRESETS, providerFor, type EmailProvider } from '@shared/email';
import { Icon } from '../components/Icon';
import { Toggle, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

type Patch = (p: Record<string, unknown>) => Promise<void>;

const open = (id: LinkId) => void invoke('app:openLink', { id }).catch(() => undefined);

function LinkButton({ id, children }: { id: LinkId; children: string }) {
  return (
    <button className="btn ghost sm" onClick={() => open(id)}>
      <Icon name="link" size={12} /> {children}
    </button>
  );
}

/** Settings → Email & calendar: the user's own mailbox (IMAP/SMTP) and "Sign in with Google" for Calendar. */
export function EmailCalendarSettings({ s, patch }: { s: Settings; patch: Patch }) {
  return (
    <>
      <EmailAccount s={s} patch={patch} />
      <GoogleCalendarCard s={s} patch={patch} />
    </>
  );
}

function AppPasswordGuide({ provider }: { provider: EmailProvider }) {
  if (provider === 'gmail')
    return (
      <div className="banner info small">
        <Icon name="key" size={15} />
        <div className="grow">
          <strong>Gmail app password</strong>
          <ol style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
            <li>Turn on 2-Step Verification for your Google account (app passwords need it).</li>
            <li>Open App passwords, type a name such as “Keo” and choose Create.</li>
            <li>Copy the 16-letter password Google shows and paste it below (spaces don’t matter).</li>
          </ol>
          <div className="row">
            <LinkButton id="google2sv">2-Step Verification</LinkButton>
            <LinkButton id="googleAppPasswords">App passwords</LinkButton>
          </div>
          <div className="muted">IMAP is on for every Gmail account. A work or school account may not allow app passwords.</div>
        </div>
      </div>
    );
  if (provider === 'outlook')
    return (
      <div className="banner info small">
        <Icon name="key" size={15} />
        <div className="grow">
          <strong>Outlook / Hotmail app password</strong>
          <ol style={{ margin: '4px 0 6px', paddingLeft: 18 }}>
            <li>Turn on two-step verification for your Microsoft account.</li>
            <li>Under Security → Advanced security options, create an app password and paste it below.</li>
          </ol>
          <LinkButton id="microsoftAppPasswords">Microsoft app passwords</LinkButton>
          <div className="muted">Microsoft is phasing out app passwords for Outlook.com. If the login is refused even with an app password, your account needs Microsoft sign-in, which Keo does not support yet.</div>
        </div>
      </div>
    );
  if (provider === 'yahoo')
    return (
      <div className="banner info small">
        <Icon name="key" size={15} />
        <div className="grow">
          <strong>Yahoo app password</strong>: Account security → Generate app password, name it “Keo”, then paste it below. <LinkButton id="yahooAppPasswords">Yahoo app passwords</LinkButton>
        </div>
      </div>
    );
  if (provider === 'icloud')
    return (
      <div className="banner info small">
        <Icon name="key" size={15} />
        <div className="grow">
          <strong>iCloud app-specific password</strong>: sign in to your Apple Account → Sign-In and Security → App-Specific Passwords, create one for “Keo” and paste it below. Use your @icloud.com address. <LinkButton id="appleAppPasswords">Apple Account</LinkButton>
        </div>
      </div>
    );
  return (
    <div className="banner info small">
      <Icon name="key" size={15} />
      <div className="grow">Use the IMAP and SMTP servers your email provider lists, and an app password if it offers one. Keo only connects with TLS (port 993 for IMAP; 465, or 587 with STARTTLS, for SMTP).</div>
    </div>
  );
}

function EmailAccount({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const e = s.email;
  const [form, setForm] = useState({ provider: e.provider as EmailProvider, address: e.address, displayName: e.displayName, imapHost: e.imapHost, imapPort: e.imapPort, imapSecure: e.imapSecure, smtpHost: e.smtpHost, smtpPort: e.smtpPort, smtpSecure: e.smtpSecure });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    void invoke('email:status').then(setStatus, (err) => ui.error(errText(err)));
  }, [ui, s.email.address]);
  const set = (p: Partial<typeof form>) => setForm((f) => ({ ...f, ...p }));
  const choose = (provider: EmailProvider) => {
    if (provider === 'custom') return set({ provider });
    const p = EMAIL_PRESETS[provider];
    set({ provider, imapHost: p.imapHost, imapPort: p.imapPort, imapSecure: p.imapSecure, smtpHost: p.smtpHost, smtpPort: p.smtpPort, smtpSecure: p.smtpSecure });
  };
  const save = async () => {
    setBusy(true);
    setTest(null);
    try {
      setStatus(await invoke('email:save', { ...form, ...(password ? { password: password.replace(/\s+/g, '') } : {}) }));
      setPassword('');
      ui.toast('Email account saved (the app password is encrypted)', 'success');
      setTest(await invoke('email:test'));
      setStatus(await invoke('email:status'));
    } catch (err) {
      ui.error(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const connected = !!status?.connected;
  return (
    <section className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Email account</h2>
        {connected && status?.loginRefused ? (
          <span className="chip warn">Saved, but the login was refused</span>
        ) : connected ? (
          <span className="chip ok">Connected: {status?.address}</span>
        ) : (
          <span className="chip warn">Not connected</span>
        )}
      </div>
      <p className="muted small">
        Keo reads, searches, drafts and sends your mail directly with your mail server (IMAP and SMTP over TLS), not by clicking around a web page. Reading happens when you ask; the messages Keo reads go to your active AI provider to answer you. Sending, replying and invitations always ask
        you first and show the exact recipients, subject and text. The app password is encrypted with Windows (DPAPI) and never shown again.
      </p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="em-addr">Email address</label>
          <input
            id="em-addr"
            className="input"
            type="email"
            autoComplete="off"
            spellCheck={false}
            value={form.address}
            placeholder="you@gmail.com"
            onChange={(ev) => set({ address: ev.target.value })}
            onBlur={() => {
              if (!form.imapHost && form.address.includes('@')) choose(providerFor(form.address));
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="em-prov">Provider</label>
          <select id="em-prov" className="select" value={form.provider} onChange={(ev) => choose(ev.target.value as EmailProvider)}>
            {(Object.keys(EMAIL_PRESETS) as Array<keyof typeof EMAIL_PRESETS>).map((k) => (
              <option key={k} value={k}>
                {EMAIL_PRESETS[k].label}
              </option>
            ))}
            <option value="custom">Other (enter servers)</option>
          </select>
        </div>
      </div>
      <AppPasswordGuide provider={form.provider} />
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field">
          <label htmlFor="em-pass">App password</label>
          <input id="em-pass" className="input" type="password" autoComplete="new-password" spellCheck={false} value={password} placeholder={status?.hasPassword ? 'Stored — type to replace' : 'Paste the app password'} onChange={(ev) => setPassword(ev.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="em-name">Your name on sent mail (optional)</label>
          <input id="em-name" className="input" value={form.displayName} maxLength={120} onChange={(ev) => set({ displayName: ev.target.value })} />
        </div>
      </div>
      <details className="small" open={form.provider === 'custom'}>
        <summary>Servers</summary>
        <div className="grid-2" style={{ marginTop: 8 }}>
          <div className="field">
            <label htmlFor="em-imap">Incoming (IMAP) server and port</label>
            <div className="row">
              <input id="em-imap" className="input grow" value={form.imapHost} spellCheck={false} onChange={(ev) => set({ imapHost: ev.target.value.trim() })} />
              <input className="input" style={{ width: 80 }} type="number" aria-label="IMAP port" value={form.imapPort} onChange={(ev) => set({ imapPort: Number(ev.target.value) })} />
            </div>
            <Toggle checked={form.imapSecure} onChange={(v) => set({ imapSecure: v })} label="TLS from the start (port 993)" />
          </div>
          <div className="field">
            <label htmlFor="em-smtp">Outgoing (SMTP) server and port</label>
            <div className="row">
              <input id="em-smtp" className="input grow" value={form.smtpHost} spellCheck={false} onChange={(ev) => set({ smtpHost: ev.target.value.trim() })} />
              <input className="input" style={{ width: 80 }} type="number" aria-label="SMTP port" value={form.smtpPort} onChange={(ev) => set({ smtpPort: Number(ev.target.value) })} />
            </div>
            <Toggle checked={form.smtpSecure} onChange={(v) => set({ smtpSecure: v })} label="TLS from the start (465); off = STARTTLS (587), still encrypted" />
          </div>
        </div>
      </details>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="btn primary" disabled={busy || !form.address.includes('@') || !form.imapHost || !form.smtpHost || (!password && !status?.hasPassword)} onClick={() => void save()}>
          {busy ? <span className="spinner" /> : <Icon name="check" size={14} />} Save and test
        </button>
        {connected && (
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setTest(await invoke('email:test'));
                setStatus(await invoke('email:status'));
              } catch (err) {
                ui.error(errText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            Test connection
          </button>
        )}
        {(connected || status?.hasPassword) && (
          <button
            className="btn ghost"
            onClick={() =>
              void invoke('email:disconnect').then((st) => {
                setStatus(st);
                setTest(null);
                setForm((f) => ({ ...f, address: '' }));
              }, (err) => ui.error(errText(err)))
            }
          >
            Disconnect
          </button>
        )}
      </div>
      {test && (
        <div className={`banner ${test.ok ? 'info' : 'danger'} small`} style={{ marginTop: 10 }}>
          <Icon name={test.ok ? 'check' : 'warn'} size={15} />
          <div className="grow">{test.message}</div>
        </div>
      )}
      <h3 style={{ marginTop: 16 }}>New mail</h3>
      <Toggle checked={s.email.checkNew} disabled={!connected} onChange={(v) => void patch({ email: { checkNew: v } })} label="Check for new mail and show a notification (“2 new emails from …”)" />
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="em-every">Check every (minutes)</label>
        <input id="em-every" className="input" type="number" min={2} max={240} defaultValue={s.email.checkMinutes} onBlur={(ev) => void patch({ email: { checkMinutes: Number(ev.target.value) } })} />
        <span className="muted small">Only the sender and subject are shown on your PC; nothing goes to the AI provider until you ask.</span>
      </div>
    </section>
  );
}

function GoogleCalendarCard({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [clientId, setClientId] = useState(s.calendar.googleClientId);
  const [secret, setSecret] = useState('');
  const [signing, setSigning] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    void invoke('calendar:status').then(setStatus, (err) => ui.error(errText(err)));
  }, [ui, s.calendar.googleClientId]);
  // Keo's built-in client is used unless the user entered their own.
  const builtIn = !!status?.builtIn;
  const own = !!clientId.trim();
  const canSignIn = own ? /\.apps\.googleusercontent\.com$/.test(clientId.trim()) : builtIn;
  const days = status?.signedInAt ? Math.floor((Date.now() - new Date(status.signedInAt).getTime()) / 86400_000) : null;
  const signIn = async () => {
    setSigning(true);
    setNote(null);
    try {
      if (clientId.trim() !== s.calendar.googleClientId) await patch({ calendar: { googleClientId: clientId.trim() } });
      if (secret.trim()) {
        setStatus(await invoke('calendar:setClientSecret', { secret: secret.trim() }));
        setSecret('');
      }
      const r = await invoke('calendar:signIn');
      setNote(r);
    } catch (err) {
      ui.error(errText(err));
    } finally {
      setSigning(false);
      void invoke('calendar:status').then(setStatus, () => undefined);
    }
  };
  return (
    <section className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>Google Calendar</h2>
        {status?.signedIn ? <span className="chip ok">Signed in</span> : <span className="chip warn">Not signed in</span>}
      </div>
      <p className="muted small">
        “Sign in with Google” lets Keo see and change your calendar’s events (only that: not your mail, contacts or files). Adding, changing and deleting events always ask you first; inviting people always asks. Sign-in happens in your own browser; Keo keeps the sign-in encrypted and never
        sees your Google password. Without Google Calendar, Keo can still set meetings by emailing a calendar invitation (.ics).
      </p>
      {builtIn && !own && !status?.signedIn && <p className="small">Choose Sign in with Google, pick your account in the browser and allow calendar access. That’s all.</p>}
      <details className="small" open={!builtIn && !s.calendar.googleClientId}>
        <summary>{builtIn ? 'Advanced: use your own Google Cloud client instead' : 'One-time setup: your own Google Cloud client (about 5 minutes)'}</summary>
        <ol style={{ paddingLeft: 18 }}>
          <li>
            Create a Google Cloud project (any name, e.g. “Keo”). <LinkButton id="googleCloudProject">New project</LinkButton>
          </li>
          <li>
            Turn on the Google Calendar API for it. <LinkButton id="googleCalendarApi">Calendar API</LinkButton>
          </li>
          <li>
            Set up the consent screen (Google Auth Platform): app name “Keo”, your email, audience <em>External</em>. Under Audience → Test users, add your own Google address. Under Data access, add the scope <code>…/auth/calendar.events</code>. <LinkButton id="googleConsentScreen">Google Auth Platform</LinkButton>
          </li>
          <li>
            Create an OAuth client of type <strong>Desktop app</strong>. Copy its client ID (ends in .apps.googleusercontent.com) and, if Google shows one, its client secret, and paste them below. <LinkButton id="googleCredentials">Clients</LinkButton>
          </li>
          <li>Choose Sign in with Google. Google may warn that the app isn’t verified: it is your own app, so choose Continue.</li>
        </ol>
        <p className="muted">
          While the app’s publishing status is <em>Testing</em>, Google ends the sign-in after 7 days and Keo will ask you to sign in again. Publishing the app (Audience → Publish app) stops that; for your own use Google does not require verification. <LinkButton id="emailCalendarGuide">Full guide</LinkButton>
        </p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="g-client">{builtIn ? 'Your own OAuth client ID (leave empty to use Keo’s)' : 'OAuth client ID'}</label>
          <input id="g-client" className="input" spellCheck={false} autoComplete="off" value={clientId} placeholder="1234…apps.googleusercontent.com" onChange={(ev) => setClientId(ev.target.value)} onBlur={() => clientId.trim() !== s.calendar.googleClientId && void patch({ calendar: { googleClientId: clientId.trim() } })} />
        </div>
        <div className="field">
          <label htmlFor="g-secret">Client secret (if Google gave one)</label>
          <div className="row">
            <input id="g-secret" className="input grow" type="password" autoComplete="off" spellCheck={false} value={secret} placeholder={status?.hasClientSecret ? 'Stored — type to replace' : 'Optional'} onChange={(ev) => setSecret(ev.target.value)} />
            {status?.hasClientSecret && (
              <button className="btn ghost sm" onClick={() => void invoke('calendar:setClientSecret', { secret: '' }).then(setStatus, (err) => ui.error(errText(err)))}>
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
      </details>
      <div className="row">
        {signing ? (
          <>
            <span className="spinner" /> <span className="small">Finish signing in in your browser…</span>
            <button className="btn ghost sm" onClick={() => void invoke('calendar:cancelSignIn').then(setStatus, () => undefined)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="btn primary" disabled={!canSignIn} onClick={() => void signIn()}>
            <Icon name="key" size={14} /> {status?.signedIn ? 'Sign in again' : 'Sign in with Google'}
          </button>
        )}
        {status?.signedIn && !signing && (
          <button className="btn ghost" onClick={() => void invoke('calendar:signOut').then(setStatus, (err) => ui.error(errText(err)))}>
            Sign out
          </button>
        )}
      </div>
      {status?.signedIn && days !== null && (own || !builtIn) && <p className="muted small">Signed in {days === 0 ? 'today' : `${days} day(s) ago`}. If your Google app is still in Testing, the sign-in ends after 7 days.</p>}
      {note && (
        <div className={`banner ${note.ok ? 'info' : 'danger'} small`} style={{ marginTop: 10 }}>
          <Icon name={note.ok ? 'check' : 'warn'} size={15} />
          <div className="grow">{note.message}</div>
        </div>
      )}
    </section>
  );
}
