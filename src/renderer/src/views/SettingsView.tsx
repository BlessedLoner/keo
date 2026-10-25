import { useCallback, useEffect, useState } from 'react';
import type { ProviderDiagnostic, ProviderInfo, SelfTestResult, VideoToolsSetup } from '@shared/domain';
import type { WakeStatusInfo, WebStatus } from '@shared/ipc';
import { subscribe } from '../lib/api';
import type { Settings } from '@shared/settings';
import { Icon } from '../components/Icon';
import { KeoEmblem, type EmblemState } from '../components/KeoEmblem';
import { Toggle, ViewHeader, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useApp } from '../state/AppState';
import { EmailCalendarSettings } from './EmailCalendarSettings';

type Section = 'providers' | 'web' | 'email' | 'files' | 'voice' | 'autonomy' | 'agent' | 'video' | 'appearance' | 'data' | 'help';

export function SettingsView() {
  const app = useApp();
  const ui = useUi();
  const [section, setSection] = useState<Section>('providers');
  const s = app.settings.data;
  const patch = async (p: Record<string, unknown>) => {
    try {
      await invoke('settings:update', { patch: p });
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <div className="view">
      <ViewHeader title="Settings">
        <div className="tabs" role="tablist" aria-label="Settings sections">
          {(
            [
              ['providers', 'Providers'],
              ['web', 'Web'],
              ['email', 'Email & calendar'],
              ['files', 'Files'],
              ['voice', 'Voice & shortcuts'],
              ['autonomy', 'Approvals & live chat'],
              ['agent', 'Agent'],
              ['video', 'Video'],
              ['appearance', 'Appearance'],
              ['data', 'Privacy & data'],
              ['help', 'Check & help'],
            ] as Array<[Section, string]>
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={section === k} onClick={() => setSection(k)}>
              {l}
            </button>
          ))}
        </div>
      </ViewHeader>
      <div className="view-body narrow">
        {!s ? (
          <div className="row muted">
            <span className="spinner" /> Loading…
          </div>
        ) : section === 'providers' ? (
          <Providers s={s} patch={patch} />
        ) : section === 'web' ? (
          <>
            <WebSearch s={s} patch={patch} />
            <WebApps s={s} patch={patch} />
          </>
        ) : section === 'email' ? (
          <EmailCalendarSettings s={s} patch={patch} />
        ) : section === 'files' ? (
          <Files s={s} patch={patch} />
        ) : section === 'voice' ? (
          <>
            <WakeAndShortcuts s={s} patch={patch} />
            <Voice s={s} patch={patch} />
          </>
        ) : section === 'autonomy' ? (
          <ApprovalsAndLiveChat s={s} patch={patch} />
        ) : section === 'agent' ? (
          <Agent s={s} patch={patch} />
        ) : section === 'video' ? (
          <Video s={s} patch={patch} />
        ) : section === 'appearance' ? (
          <Appearance s={s} patch={patch} />
        ) : section === 'help' ? (
          <CheckComputer />
        ) : (
          <Data s={s} patch={patch} />
        )}
      </div>
    </div>
  );
}

type Patch = (p: Record<string, unknown>) => Promise<void>;

/** Finding files: the switch, what Keo may read, and which folders it searches or skips. */
function Files({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const f = s.files;
  const pick = (list: 'roots' | 'excluded') => void invoke('files:pickFolder', { list }).catch((e) => ui.error(errText(e)));
  const remove = (list: 'roots' | 'excluded', dir: string) => void patch({ files: { [list]: f[list].filter((x) => x !== dir) } });
  return (
    <>
      <section className="card" aria-label="Finding files">
        <h2>Finding files</h2>
        <p className="muted small">
          Ask Keo for any file or folder — “open the photo of the orange table in Downloads”, “find my CV”, “videos from this week” — and it answers in well under a second from the Windows Search index (names, and the words inside indexed documents). When the index has nothing for a folder, Keo looks at names instead. The names and paths it finds go to your AI provider so it can answer you; files are never changed, moved or deleted, and programs or scripts are never opened.
        </p>
        <Toggle checked={f.searchEnabled} onChange={(v) => void patch({ files: { searchEnabled: v } })} label="Let Keo find my files and folders" />
        <Toggle checked={f.readContent} onChange={(v) => void patch({ files: { readContent: v } })} label="Let Keo read the text of files it finds when I ask (text files and Word documents; that text goes to my AI provider)" />
        <p className="muted small">Files that usually hold passwords or keys are never read.</p>
      </section>
      <section className="card" aria-label="Folders">
        <h2>Folders</h2>
        <p className="small">Keo searches {f.roots.length ? 'these folders:' : 'your whole user folder (Desktop, Documents, Downloads, Pictures, Videos, Music…).'}</p>
        {f.roots.map((r) => (
          <div className="row small" key={r}>
            <code className="grow">{r}</code>
            <button className="btn ghost sm" onClick={() => remove('roots', r)}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <button className="btn sm" onClick={() => pick('roots')}>
            {f.roots.length ? 'Add a folder' : 'Search only chosen folders…'}
          </button>
        </div>
        <p className="small" style={{ marginTop: 14 }}>
          Never searched: app data (AppData), Keo’s own data{f.excluded.length ? ', and:' : '.'}
        </p>
        {f.excluded.map((r) => (
          <div className="row small" key={r}>
            <code className="grow">{r}</code>
            <button className="btn ghost sm" onClick={() => remove('excluded', r)}>
              Remove
            </button>
          </div>
        ))}
        <div className="row">
          <button className="btn ghost sm" onClick={() => pick('excluded')}>
            Add a folder to skip
          </button>
        </div>
      </section>
    </>
  );
}

/** Video editing: which ffmpeg, where finished videos go, and whether clip sound may go to OpenAI. */
function Video({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [st, setSt] = useState<{ found: boolean; encoder: string | null; captions: boolean; message: string } | null>(null);
  const check = useCallback(() => {
    setSt(null);
    void invoke('video:status', {})
      .then(setSt)
      .catch((e) => setSt({ found: false, encoder: null, captions: false, message: errText(e) }));
  }, []);
  const [setup, setSetup] = useState<VideoToolsSetup | null>(null);
  useEffect(() => {
    void invoke('video:setupState', {})
      .then(setSetup)
      .catch(() => undefined);
    return subscribe('video:setupChanged', (st) => {
      setSetup(st);
      if (st.phase === 'done' || st.phase === 'idle') check();
    });
  }, [check]);
  useEffect(check, [check, s.video.ffmpegPath]);
  const busy = !!setup && (setup.phase === 'downloading' || setup.phase === 'checking' || setup.phase === 'unpacking');
  const mb = (b: number) => `${Math.round(b / 1_000_000)} MB`;
  const act = (ch: 'video:setupStart' | 'video:setupCancel' | 'video:setupRemove') => void invoke(ch, {}).then(setSetup).catch((e) => ui.error(errText(e)));
  return (
    <>
      <section className="card">
        <h2>ffmpeg</h2>
        <p className="muted small">Keo edits videos with ffmpeg on this PC: fast and exact, nothing is uploaded. Keo can set it up for you (one download into its own folder, only when you click), or use your own: add it to PATH, or choose ffmpeg.exe here (ffprobe.exe must be in the same folder).</p>
        <p className="small">
          {st ? (
            <>
              <Icon name={st.found ? 'check' : 'warn'} size={13} /> {st.message}
            </>
          ) : (
            <span className="muted">Checking…</span>
          )}
        </p>
        <p className="small muted">{s.video.ffmpegPath ? `Using ${s.video.ffmpegPath}` : setup?.installed ? `Using Keo’s own copy (ffmpeg ${setup.installed.version}).` : 'Looking for ffmpeg on PATH.'}</p>
        <div className="row">
          <button
            className="btn sm"
            onClick={() =>
              void invoke('video:pickFfmpeg', {})
                .then((r) => {
                  if (r.path) (r.ok ? ui.toast : ui.error)(r.message);
                  check();
                })
                .catch((e) => ui.error(errText(e)))
            }
          >
            <Icon name="folder" size={13} /> Choose ffmpeg.exe…
          </button>
          {s.video.ffmpegPath && (
            <button className="btn ghost sm" onClick={() => void patch({ video: { ffmpegPath: null } })}>
              {setup?.installed ? 'Use Keo’s copy instead' : 'Use PATH instead'}
            </button>
          )}
        </div>
      </section>
      {setup && (
        <section className="card" aria-label="Video tools">
          <h2>Set up video tools</h2>
          <p className="muted small">
            Downloads ffmpeg {setup.build.version} for Windows ({mb(setup.build.sizeBytes)}, built by {setup.build.publisher}) into Keo’s own folder. Keo checks the download against its published SHA-256 checksum and refuses it if it differs. No installer, no administrator rights, no change to PATH. Nothing is downloaded until you click.
          </p>
          {setup.message && (
            <p className="small">
              {setup.phase === 'failed' && <Icon name="warn" size={13} />} {setup.message}
            </p>
          )}
          {busy && <progress max={setup.totalBytes} value={setup.phase === 'downloading' ? setup.receivedBytes : undefined} style={{ width: '100%' }} aria-label="Download progress" />}
          <div className="row">
            {busy ? (
              <button className="btn ghost sm" onClick={() => act('video:setupCancel')}>
                Cancel
              </button>
            ) : setup.installed ? (
              <>
                <span className="chip accent">ffmpeg {setup.installed.version} installed</span>
                <button className="btn ghost sm" onClick={() => act('video:setupRemove')}>
                  Remove Keo’s copy
                </button>
              </>
            ) : (
              <button className="btn sm" onClick={() => act('video:setupStart')}>
                {setup.canResume ? `Try again (continue at ${mb(setup.receivedBytes)})` : `Set up video tools (${mb(setup.build.sizeBytes)} download)`}
              </button>
            )}
          </div>
          <p className="muted small">
            FFmpeg is free software under the {setup.build.licence}; Keo keeps its licence (LICENSE.txt and NOTICE.txt) next to the programs.{' '}
            <button className="btn ghost sm" onClick={() => void invoke('app:openLink', { id: 'ffmpegSource' })}>
              FFmpeg source code
            </button>
            <button className="btn ghost sm" onClick={() => void invoke('app:openLink', { id: 'ffmpegBuild' })}>
              About this build
            </button>
          </p>
        </section>
      )}
      <section className="card">
        <h2>Finished videos</h2>
        <p className="muted small">Saved as new MP4 files in {s.video.outputDir ?? 'your Videos\\Keo folder'}; existing files are never replaced. Previews stay in Keo’s own data folder.</p>
        <div className="row">
          <button className="btn sm" onClick={() => void invoke('video:pickOutput', {}).catch((e) => ui.error(errText(e)))}>
            <Icon name="folder" size={13} /> Choose folder…
          </button>
          {s.video.outputDir && (
            <button className="btn ghost sm" onClick={() => void patch({ video: { outputDir: null } })}>
              Use Videos\Keo
            </button>
          )}
        </div>
        <div style={{ height: 8 }} />
        <Toggle checked={s.video.showWindow} onChange={(v) => void patch({ video: { showWindow: v } })} label="Open the preview window when a new preview is ready" />
      </section>
      <section className="card">
        <h2>Captions</h2>
        <p className="muted small">Captions need the words spoken in your clips. Keo sends the clips’ sound (not the picture) to OpenAI’s speech-to-text and keeps the words only in memory. Without this, videos are made without captions. Music and stock footage are never downloaded: use your own files or ones you have a licence for.</p>
        <Toggle checked={s.video.transcribeAudio} onChange={(v) => void patch({ video: { transcribeAudio: v } })} label="I allow Keo to send my clips’ sound to OpenAI for captions" />
      </section>
    </>
  );
}

function Providers({ s, patch }: { s: Settings; patch: Patch }) {
  const app = useApp();
  const list = app.providers.data ?? [];
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Keo uses your own provider account. API keys are encrypted with Windows (DPAPI) via Electron safeStorage, stay in the main process, and are never shown again or logged.
      </p>
      {list.map((p) => (
        <ProviderCard key={p.id} p={p} active={s.activeProvider === p.id} s={s} patch={patch} />
      ))}
      <SmartRouting s={s} patch={patch} list={list} />
    </>
  );
}

function SmartRouting({ s, patch, list }: { s: Settings; patch: Patch; list: ProviderInfo[] }) {
  const r = s.routing;
  return (
    <section className="card" aria-label="Smart routing">
      <div className="row">
        <h2 style={{ margin: 0 }}>Smart routing</h2>
        {r.enabled && <span className="chip accent">On</span>}
      </div>
      <p className="muted small">
        Keo picks the model for each message itself, without an extra model call: the fast model for voice conversations, small talk and quick questions, the strong model for complex work (multi-step tasks, research, coding, planning, long requests). Each reply shows which model answered.
      </p>
      <div className="field">
        <Toggle checked={r.enabled} onChange={(v) => void patch({ routing: { enabled: v } })} label="Choose the model automatically for each message" />
      </div>
      {r.enabled && (
        <div className="grid-2">
          <RouteSide side="fast" title="Fast model" s={s} patch={patch} list={list} />
          <RouteSide side="strong" title="Strong model" s={s} patch={patch} list={list} />
        </div>
      )}
    </section>
  );
}

function RouteSide({ side, title, s, patch, list }: { side: 'fast' | 'strong'; title: string; s: Settings; patch: Patch; list: ProviderInfo[] }) {
  const t = s.routing[side];
  const set = (v: Record<string, unknown>) => void patch({ routing: { [side]: v } });
  const p = list.find((x) => x.id === (t.provider ?? s.activeProvider));
  return (
    <div className="field">
      <label htmlFor={`route-${side}-provider`}>{title}</label>
      <select id={`route-${side}-provider`} className="select" value={t.provider ?? ''} onChange={(e) => set({ provider: e.target.value || null, model: '' })}>
        <option value="">Active provider</option>
        {list.map((x) => (
          <option key={x.id} value={x.id}>
            {x.label}
            {x.status.kind !== 'ready' ? ' (needs setup)' : ''}
          </option>
        ))}
      </select>
      {p?.id === 'anthropic' ? (
        <select aria-label={`${title} id`} className="select" style={{ marginTop: 6 }} value={t.model} onChange={(e) => set({ model: e.target.value })}>
          <option value="">Provider’s model ({p.selectedModel})</option>
          {p.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </select>
      ) : (
        <input
          key={`${side}-${t.provider ?? 'active'}`}
          aria-label={`${title} id`}
          className="input"
          style={{ marginTop: 6 }}
          placeholder={p?.selectedModel ? `Provider’s model (${p.selectedModel})` : 'Model id'}
          defaultValue={t.model}
          onBlur={(e) => e.target.value.trim() !== t.model && set({ model: e.target.value.trim() })}
        />
      )}
      <span className="hint">{side === 'fast' ? 'Voice, small talk, quick questions.' : 'Multi-step tasks, research, coding, planning.'} If this provider is not set up, Keo uses the active provider.</span>
    </div>
  );
}

function ProviderCard({ p, active, s, patch }: { p: ProviderInfo; active: boolean; s: Settings; patch: Patch }) {
  const ui = useUi();
  const app = useApp();
  const [key, setKey] = useState('');
  const [diag, setDiag] = useState<ProviderDiagnostic | null>(null);
  const [testing, setTesting] = useState(false);
  const refresh = () => void app.providers.refresh();

  const saveKey = async () => {
    try {
      await invoke('providers:setKey', { providerId: p.id, apiKey: key });
      setKey('');
      ui.toast('Key saved (encrypted)', 'success');
      refresh();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      setDiag(await invoke('providers:diagnose', { providerId: p.id }));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setTesting(false);
    }
  };
  const statusChip = p.status.kind === 'ready' ? <span className="chip ok">Ready</span> : p.status.kind === 'unconfigured' ? <span className="chip warn">Needs setup</span> : <span className="chip danger">Error</span>;

  return (
    <section className="card" aria-label={p.label}>
      <div className="row">
        <h2 style={{ margin: 0 }}>{p.label}</h2>
        {statusChip}
        {p.id === 'test' && <span className="chip violet">Not an AI model</span>}
        <div style={{ flex: 1 }} />
        {active ? (
          <span className="chip accent">
            <Icon name="check" size={12} /> Active
          </span>
        ) : (
          <button className="btn sm" onClick={() => void patch({ activeProvider: p.id })}>
            Use for chat
          </button>
        )}
      </div>
      <p className="muted small">{p.description}</p>
      <p className="small">
        Requests go to: <strong>{p.destination}</strong>
      </p>
      {p.status.kind !== 'ready' && <div className="banner warn small" style={{ marginBottom: 10 }}>{p.status.reason}</div>}

      {p.requiresApiKey && (
        <div className="field">
          <label htmlFor={`key-${p.id}`}>API key {p.hasApiKey && <span className="chip ok" style={{ marginLeft: 6 }}>stored</span>}</label>
          <div className="row">
            <input id={`key-${p.id}`} className="input" type="password" autoComplete="off" spellCheck={false} placeholder={p.hasApiKey ? 'Replace stored key…' : 'Paste your API key'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" disabled={key.trim().length < 8} onClick={() => void saveKey()}>
              Save
            </button>
            {p.hasApiKey && (
              <button
                className="btn ghost"
                onClick={async () => {
                  await invoke('providers:clearKey', { providerId: p.id }).catch((e) => ui.error(errText(e)));
                  refresh();
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      )}

      {p.id === 'anthropic' && <AnthropicFields s={s} patch={patch} p={p} />}
      {(p.id === 'openai' || p.id === 'openrouter' || p.id === 'local') && <CompatFields id={p.id} s={s} patch={patch} />}

      <div className="row">
        <button className="btn" onClick={() => void test()} disabled={testing}>
          {testing ? <span className="spinner" /> : <Icon name="pulse" size={14} />} Test connection
        </button>
        <span className="muted small">Uses the provider’s model listing — no tokens are generated.</span>
      </div>
      {diag && (
        <div className={`banner ${diag.ok ? 'info' : 'danger'} small`} style={{ marginTop: 10 }}>
          <Icon name={diag.ok ? 'check' : 'warn'} size={15} />
          <div className="grow">
            {diag.message}
            {diag.latencyMs != null && <span className="muted"> ({diag.latencyMs} ms)</span>}
            {diag.remoteModels && diag.remoteModels.length > 0 && <div className="muted mono" style={{ marginTop: 4 }}>{diag.remoteModels.slice(0, 30).join(', ')}</div>}
          </div>
        </div>
      )}
    </section>
  );
}

function AnthropicFields({ s, patch, p }: { s: Settings; patch: Patch; p: ProviderInfo }) {
  const a = s.providers.anthropic;
  return (
    <div className="grid-2">
      <div className="field">
        <label htmlFor="an-model">Model</label>
        <select id="an-model" className="select" value={a.model} onChange={(e) => void patch({ providers: { anthropic: { model: e.target.value } } })}>
          {p.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} ({m.id})
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="an-effort">Effort</label>
        <select id="an-effort" className="select" value={a.effort} onChange={(e) => void patch({ providers: { anthropic: { effort: e.target.value } } })}>
          <option value="low">Low — fastest, cheapest</option>
          <option value="medium">Medium — balanced</option>
          <option value="high">High — most thorough</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="an-max">Max output tokens</label>
        <input id="an-max" className="input" type="number" min={256} max={128000} defaultValue={a.maxOutputTokens} onBlur={(e) => void patch({ providers: { anthropic: { maxOutputTokens: Number(e.target.value) } } })} />
      </div>
      <div className="field">
        <span className="field-label">Refusal fallback</span>
        <Toggle checked={a.refusalFallback} onChange={(v) => void patch({ providers: { anthropic: { refusalFallback: v } } })} label={<span className="small">If the model declines, let Anthropic retry the request on a fallback model (server-side).</span>} />
      </div>
    </div>
  );
}

function CompatFields({ id, s, patch }: { id: 'openai' | 'openrouter' | 'local'; s: Settings; patch: Patch }) {
  const c = s.providers[id];
  const set = (v: Record<string, unknown>) => void patch({ providers: { [id]: v } });
  return (
    <>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${id}-url`}>Base URL</label>
          <input id={`${id}-url`} className="input" defaultValue={c.baseUrl} onBlur={(e) => e.target.value !== c.baseUrl && set({ baseUrl: e.target.value })} />
          {id === 'local' && <span className="hint">Must be a loopback address (127.0.0.1 / localhost).</span>}
          {id === 'openrouter' && <span className="hint">OpenRouter forwards requests to the model’s vendor; their data policies apply too.</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model id</label>
          <input id={`${id}-model`} className="input" placeholder={id === 'local' ? 'e.g. llama3.1:8b' : id === 'openrouter' ? 'vendor/model id from openrouter.ai/models' : 'model id from your OpenAI account'} defaultValue={c.model} onBlur={(e) => e.target.value !== c.model && set({ model: e.target.value })} />
          <span className="hint">“Test connection” lists the ids your server or account offers.</span>
        </div>
      </div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Toggle checked={c.supportsTools} onChange={(v) => set({ supportsTools: v })} label="Model supports tool calls" />
        <Toggle checked={c.supportsVision} onChange={(v) => set({ supportsVision: v })} label="Model accepts images" />
      </div>
      <p className="hint small muted" style={{ marginTop: -6 }}>
        Capabilities are declared by you; Keo does not assume them. Without tool support, Keo can chat but cannot propose actions.
      </p>
    </>
  );
}

const LEVELS: Array<{ id: Settings['autonomy']['level']; title: string; text: string }> = [
  { id: 'always_ask', title: 'Always ask', text: 'Every action that changes something waits for your Approve. Safest when you are at the computer.' },
  {
    id: 'important_only',
    title: 'Ask only for important things',
    text: 'Looking around, opening chats, switching tabs and menus, scrolling and reading run on their own. Typing, sending, launching apps and other buttons still ask.',
  },
  {
    id: 'hands_free',
    title: 'Hands-free',
    text: 'Keo works without stopping to ask: opening and operating the apps you told it to use, clicking and typing in them, sending messages to people you named, and replying in live chats on its own. Still always asks: paying, buying, deleting, signing in, and running project code.'
  },
];

function ApprovalsAndLiveChat({ s, patch }: { s: Settings; patch: Patch }) {
  const lc = s.liveChat;
  const [topic, setTopic] = useState('');
  const num = (k: 'maxMinutes' | 'maxReplies' | 'quietMinutes' | 'idleSeconds', label: string, min: number, max: number, hint: string) => (
    <div className="field">
      <label htmlFor={`lc-${k}`}>{label}</label>
      <input id={`lc-${k}`} className="input" type="number" min={min} max={max} defaultValue={lc[k]} onBlur={(e) => void patch({ liveChat: { [k]: Math.min(max, Math.max(min, Number(e.target.value) || min)) } })} />
      <span className="muted small">{hint}</span>
    </div>
  );
  return (
    <>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Notifications</h2>
        <p className="muted small">Windows notifications for task events, shown only while Keo’s window is not in front, once per event. Clicking one opens Tasks.</p>
        <Toggle checked={s.notifications.approvals} onChange={(v) => void patch({ notifications: { approvals: v } })} label="When an action waits for my approval" />
        <div style={{ height: 6 }} />
        <Toggle checked={s.notifications.finished} onChange={(v) => void patch({ notifications: { finished: v } })} label="When a longer task finishes" />
        <div style={{ height: 6 }} />
        <Toggle checked={s.notifications.failed} onChange={(v) => void patch({ notifications: { failed: v } })} label="When a task fails or its result is uncertain" />
      </section>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>How much Keo may do without asking</h2>
        <div className="choice-list" role="radiogroup" aria-label="Approval level">
          {LEVELS.map((l) => (
            <label key={l.id} className={`choice ${s.autonomy.level === l.id ? 'selected' : ''}`}>
              <input type="radio" name="autonomy" checked={s.autonomy.level === l.id} onChange={() => void patch({ autonomy: { level: l.id } })} />
              <span>
                <strong>{l.title}</strong>
                <span className="muted small" style={{ display: 'block' }}>
                  {l.text}
                </span>
              </span>
            </label>
          ))}
        </div>
        <div className="banner info small" style={{ marginTop: 12 }}>
          <span>
            At every level Keo still asks before: payments and purchases, deleting, pressing buttons like Send / Delete / Buy / Confirm, keys like Enter or Delete, clicks on raw screen positions, and messaging anyone you did not name yourself. It never types passwords. Every automatic approval is recorded in Diagnose → Audit, and <strong>Stop</strong> (title bar or companion) halts everything.
          </span>
        </div>
      </section>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Live chats (WhatsApp)</h2>
        <p className="muted small">
          Say e.g. “chat with Ma Glo on WhatsApp until I say stop” or “reply to John and keep the conversation going”. You approve once; Keo then reads new messages and replies in your voice. It pauses and asks you about prices and money, payments, meetings and times, calls and files, personal or urgent matters, and when someone asks whether they are talking to a bot — Keo never denies being an assistant. Answer by typing or speaking (“tell her it’s $50”), or in Tasks → Live chats.
        </p>
        <div className="field">
          <span className="field-label">When a reply is ready while I’m using the computer</span>
          <div className="choice-list" role="radiogroup" aria-label="When a reply is ready">
            {(
              [
                ['ask', 'Ask me', 'Shows the reply with Send now (notification, companion, Tasks). If you don’t answer, it is sent as soon as you pause.'],
                ['when_idle', 'Wait until I pause', 'Sends as soon as you stop typing/clicking for a moment — no prompt.'],
                ['immediately', 'Send immediately', 'Fastest: Keo briefly takes the screen, keyboard focus and clipboard, then gives your window back.'],
              ] as Array<[Settings['liveChat']['sendMode'], string, string]>
            ).map(([id, title, text]) => (
              <label key={id} className={`choice ${lc.sendMode === id ? 'selected' : ''}`}>
                <input type="radio" name="sendMode" checked={lc.sendMode === id} onChange={() => void patch({ liveChat: { sendMode: id } })} />
                <span>
                  <strong>{title}</strong>
                  <span className="muted small" style={{ display: 'block' }}>
                    {text}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid-2">
          {num('maxMinutes', 'Longest session (minutes)', 5, 720, 'A session ends after this, even if you forget to stop it.')}
          {num('maxReplies', 'Most replies per session', 1, 300, 'Keo stops after this many messages.')}
          {num('quietMinutes', 'End after quiet minutes', 5, 240, 'Ends when nobody writes for this long.')}
          {num('idleSeconds', '“Paused” means idle for (seconds)', 0, 60, 'No keyboard/mouse input for this long. Keo then sends, and gives your window back.')}
        </div>
        <div className="field" style={{ marginTop: 8 }}>
          <span className="field-label">Also always ask me about</span>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {lc.attentionTopics.map((t) => (
              <span key={t} className="chip">
                {t}{' '}
                <button className="btn sm ghost" aria-label={`Remove ${t}`} onClick={() => void patch({ liveChat: { attentionTopics: lc.attentionTopics.filter((x) => x !== t) } })}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <input className="input" placeholder="e.g. delivery, stock, my boss" value={topic} maxLength={60} onChange={(e) => setTopic(e.target.value)} />
            <button
              className="btn sm"
              disabled={topic.trim().length < 2 || lc.attentionTopics.length >= 40}
              onClick={() => {
                void patch({ liveChat: { attentionTopics: [...new Set([...lc.attentionTopics, topic.trim()])] } });
                setTopic('');
              }}
            >
              Add
            </button>
          </div>
        </div>
        <div className="field">
          <Toggle checked={lc.notify} onChange={(v) => void patch({ liveChat: { notify: v } })} label="Show a Windows notification when someone needs me" />
          <Toggle checked={lc.speak} onChange={(v) => void patch({ liveChat: { speak: v } })} label="Say it out loud (when spoken replies are on)" />
        </div>
        <p className="muted small">
          Keo reads the chat through Windows accessibility while you keep working — no screen takeover. Keep WhatsApp visible (a second monitor is ideal): a browser stops updating a covered or minimised tab, so Keo can only refresh it while you pause. Works with WhatsApp Web (tab in front) and the WhatsApp app; a WhatsApp redesign can make Keo pause and say it cannot read the chat.
        </p>
      </section>
    </>
  );
}

/**
 * "Teach Keo your voice": the user says the phrase a few times; whatever
 * Windows makes of their pronunciation is remembered as that phrase.
 */
function TeachVoice({ phrase, learned, disabled }: { phrase: string; learned: string[]; disabled: boolean }) {
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const ROUNDS = 3;
  const sample = async () => {
    setBusy(true);
    setLog((l) => [...l, `Say “${phrase}” now…`]);
    try {
      const r = await invoke('wake:learnSample', { phrase });
      const line = !r.heard
        ? 'Heard nothing — check the microphone and try again.'
        : r.alreadyRecognized
          ? `Windows understood “${r.heard}” exactly — this sample already works.`
          : r.added.length
            ? `Windows heard “${r.heard}” — learned ${r.added.map((a) => `“${a}”`).join(', ')}.`
            : `Windows heard “${r.heard}” — nothing new to learn.`;
      setLog((l) => [...l.slice(0, -1), line]);
      setRound((n) => n + 1);
    } catch (e) {
      setLog((l) => [...l.slice(0, -1), errText(e)]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field">
      <span className="field-label">Teach Keo your voice</span>
      <span className="hint">
        Windows' recognizer is tuned for US/UK accents. Say your phrase {ROUNDS} times the way you normally would; Keo remembers how Windows hears <em>your</em> voice and accepts it from then on. Everything stays on this PC.
      </span>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn sm primary" disabled={busy || disabled} onClick={() => void sample()}>
          {busy ? 'Listening…' : round === 0 ? `Start (say “${phrase}”)` : round < ROUNDS ? `Again (${round + 1}/${ROUNDS})` : 'One more'}
        </button>
        {learned.length > 0 && (
          <button className="btn sm ghost" disabled={busy} onClick={() => void invoke('wake:forgetLearned').then(() => setLog([]))}>
            Forget learned ({learned.length})
          </button>
        )}
      </div>
      {log.length > 0 && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {log.map((l, k) => (
            <li key={k}>{l}</li>
          ))}
        </ul>
      )}
      {learned.length > 0 && <span className="hint">Keo also accepts: {learned.map((l) => `“${l}”`).join(', ')}</span>}
    </div>
  );
}

/** One global shortcut: state (active / not registered / off), conflicts, presets. */
function ShortcutCard(p: {
  title: string;
  help: string;
  status: { registered: boolean; enabled: boolean; error: string | null } | undefined;
  enabled: boolean;
  value: string;
  presets: string[];
  onEnabled(v: boolean): void;
  onSave(a: string): void;
}) {
  const [accel, setAccel] = useState(p.value);
  useEffect(() => setAccel(p.value), [p.value]);
  return (
    <section className="card">
      <div className="row">
        <h2 style={{ margin: 0 }}>{p.title}</h2>
        {p.status?.registered ? <span className="chip ok">Active</span> : p.status?.enabled ? <span className="chip danger">Not registered</span> : <span className="chip">Off</span>}
      </div>
      <p className="muted small">
        {p.help} A global shortcut is taken away from every other app while Keo runs (Ctrl+K is also used by browsers, VS Code and Slack).
      </p>
      {p.status?.error && <div className="banner danger small" style={{ marginBottom: 10 }}>{p.status.error}</div>}
      <Toggle checked={p.enabled} onChange={p.onEnabled} label="Enable this shortcut" />
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono" style={{ maxWidth: 220 }} aria-label={`${p.title} keys`} value={accel} onChange={(e) => setAccel(e.target.value)} />
        <button className="btn sm" disabled={accel === p.value} onClick={() => p.onSave(accel)}>
          Save
        </button>
        {p.presets.map((a) => (
          <button key={a} className="btn ghost sm" onClick={() => { setAccel(a); p.onSave(a); }}>
            {a.replace('Control', 'Ctrl')}
          </button>
        ))}
      </div>
    </section>
  );
}

/** Trained wake word (Picovoice Porcupine): access key, model file or built-in keyword, sensitivity. */
function TrainedWakeWord({ s, patch, hasKey }: { s: Settings; patch: Patch; hasKey: boolean }) {
  const ui = useUi();
  const p = s.wake.porcupine;
  const [key, setKey] = useState('');
  const [keySaved, setKeySaved] = useState(hasKey);
  return (
    <section className="card">
      <h2>Trained wake word</h2>
      <p className="muted small">
        Picovoice Porcupine listens on this PC for one trained phrase only — much more reliable than general speech recognition, and no audio leaves your computer. Create a free account at console.picovoice.ai, copy your
        AccessKey, and either train “Hey Keo” there (download the Windows .ppn file) or use a built-in word such as “Jarvis”. Then choose “Trained wake word” as the speech engine above.
      </p>
      <div className="field">
        <label htmlFor="pv-key">Picovoice AccessKey {keySaved && <span className="chip ok">Saved</span>}</label>
        <div className="row">
          <input id="pv-key" className="input mono" type="password" autoComplete="off" placeholder={keySaved ? '•••••••• (saved, encrypted)' : 'Paste your AccessKey'} value={key} onChange={(e) => setKey(e.target.value)} />
          <button className="btn sm" disabled={!key.trim()} onClick={() => void invoke('wake:setPicovoiceKey', { key: key.trim() }).then((r) => { setKeySaved(r.hasKey); setKey(''); ui.toast('AccessKey saved (encrypted)', 'success'); }).catch((e) => ui.error(errText(e)))}>
            Save
          </button>
          {keySaved && (
            <button className="btn ghost sm" onClick={() => void invoke('wake:setPicovoiceKey', { key: '' }).then((r) => setKeySaved(r.hasKey)).catch((e) => ui.error(errText(e)))}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Wake word</label>
          <div className="row">
            <button className="btn sm" onClick={() => void invoke('wake:pickKeywordFile', {}).catch((e) => ui.error(errText(e)))}>
              Choose trained .ppn file…
            </button>
          </div>
          <span className="hint">{p.keywordPath ? `Using ${p.keywordPath.split(/[\\/]/).pop()}` : p.builtin ? `Using the built-in word “${p.builtin}”` : 'Not chosen yet.'}</span>
        </div>
        <div className="field">
          <label htmlFor="pv-builtin">…or a built-in word</label>
          <select id="pv-builtin" className="select" value={p.builtin ?? ''} onChange={(e) => void patch({ wake: { porcupine: { builtin: e.target.value || null, keywordPath: e.target.value ? null : p.keywordPath } } })}>
            <option value="">(none)</option>
            {['jarvis', 'computer', 'hey siri', 'alexa', 'hey google', 'ok google', 'picovoice', 'porcupine', 'bumblebee', 'terminator'].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pv-sens">Sensitivity: {p.sensitivity.toFixed(2)}</label>
          <input id="pv-sens" type="range" min={0.1} max={0.95} step={0.05} defaultValue={p.sensitivity} onMouseUp={(e) => void patch({ wake: { porcupine: { sensitivity: Number((e.target as HTMLInputElement).value) } } })} onKeyUp={(e) => void patch({ wake: { porcupine: { sensitivity: Number((e.target as HTMLInputElement).value) } } })} />
          <span className="hint">Higher catches more of your calls but may wake on similar sounds.</span>
        </div>
      </div>
    </section>
  );
}

function WakeAndShortcuts({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [status, setStatus] = useState<WakeStatusInfo | null>(null);
  const [phrase, setPhrase] = useState('');
  const [testing, setTesting] = useState<string | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  const refresh = useCallback(() => void invoke('wake:status').then(setStatus, (e) => ui.error(errText(e))), [ui]);
  useEffect(() => {
    refresh();
    const off = subscribe('presence:changed', () => refresh());
    return off;
  }, [refresh, s]);
  const w = s.wake;
  const addPhrase = async () => {
    const p = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!p) return;
    if (w.phrases.includes(p)) return setPhrase('');
    await patch({ wake: { phrases: [...w.phrases, p].slice(0, 5) } });
    setPhrase('');
  };
  const test = async (p: string) => {
    setTesting(p);
    setTestMsg('Say the phrase now (8 seconds)…');
    try {
      const r = await invoke('wake:testPhrase', { phrase: p });
      setTestMsg(r.message);
    } catch (e) {
      setTestMsg(errText(e));
    } finally {
      setTesting(null);
    }
  };
  const statusChip = !status ? null : status.status === 'listening' ? <span className="chip ok">Listening locally</span> : status.status === 'error' || status.status === 'unavailable' ? <span className="chip danger">{status.status}</span> : <span className="chip">{status.muted ? 'muted' : status.status}</span>;
  return (
    <>
      <section className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Wake word</h2>
          {statusChip}
        </div>
        <p className="muted small">
          Uses Windows’ built-in speech recognizer on this computer. While enabled, the microphone is open and audio is processed locally; speech that is not your wake phrase is discarded and never stored or sent. Listening pauses while Keo speaks, and you can mute it any time (title bar or companion).
        </p>
        {status?.message && <div className={`banner ${status.status === 'error' || status.status === 'unavailable' ? 'danger' : 'info'} small`} style={{ marginBottom: 10 }}>{status.message}</div>}
        <Toggle checked={w.enabled} onChange={(v) => void patch({ wake: { enabled: v } })} label={<span><strong style={{ fontWeight: 600 }}>Listen for the wake phrase</strong></span>} />
        <div className="field" style={{ marginTop: 12 }}>
          <span className="field-label">Wake phrases</span>
          {w.phrases.map((p) => (
            <div className="row" key={p} style={{ padding: '3px 0' }}>
              <span className="mono">“{p}”</span>
              <button className="btn ghost sm" disabled={!!testing} onClick={() => void test(p)}>
                {testing === p ? <span className="spinner" /> : <Icon name="mic" size={13} />} Test
              </button>
              {w.phrases.length > 1 && (
                <button className="btn ghost sm" onClick={() => void patch({ wake: { phrases: w.phrases.filter((x) => x !== p) } })}>
                  Remove
                </button>
              )}
            </div>
          ))}
          <div className="row">
            <input className="input" style={{ maxWidth: 260 }} placeholder="Add a phrase, e.g. hey kio" value={phrase} maxLength={40} onChange={(e) => setPhrase(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void addPhrase()} />
            <button className="btn sm" disabled={!phrase.trim()} onClick={() => void addPhrase()}>
              Add
            </button>
          </div>
          <span className="hint">2–4 words, letters only. Distinctive phrases trigger less by accident. If “Keo” isn’t recognised reliably, add a spelling that sounds the same to Windows (e.g. “hey kio”) and test it.</span>
          {testMsg && <div className="small" style={{ marginTop: 6 }}>{testMsg}</div>}
        </div>
        <TeachVoice phrase={w.phrases[0] ?? 'hey keo'} learned={w.learned} disabled={!!testing} />
        <div className="grid-2">
          <div className="field">
            <label htmlFor="wake-sens">Required confidence: {w.sensitivity.toFixed(2)}</label>
            <input id="wake-sens" type="range" min={0.5} max={0.98} step={0.01} defaultValue={w.sensitivity} onMouseUp={(e) => void patch({ wake: { sensitivity: Number((e.target as HTMLInputElement).value) } })} onKeyUp={(e) => void patch({ wake: { sensitivity: Number((e.target as HTMLInputElement).value) } })} />
            <span className="hint">For the exact phrase. Higher means fewer accidental wakes from TV or conversation. Sound-alikes and learned versions of your voice are accepted regardless.</span>
          </div>
          <div className="field">
            <label htmlFor="wake-engine">Speech engine</label>
            <select id="wake-engine" className="select" value={w.engine} onChange={(e) => void patch({ wake: { engine: e.target.value } })}>
              <option value="auto">Automatic (modern Windows engine when available)</option>
              <option value="modern">Modern Windows 10/11 engine</option>
              <option value="classic">Classic Windows engine</option>
              <option value="porcupine">Trained wake word (Picovoice Porcupine)</option>
            </select>
            <span className="hint">
              {status?.engine.kind === 'porcupine'
                ? 'Using the trained wake word (Porcupine, on this PC). Commands are still understood by Windows speech or OpenAI.'
                : status?.engine.kind === 'modern'
                ? 'Using the modern engine (the one behind Windows voice typing) — best with accents.'
                : status?.engine.kind === 'classic'
                  ? `Using the classic engine${status.engine.fallbackReason ? ` (modern unavailable: ${status.engine.fallbackReason.slice(0, 120)})` : ''}.`
                  : 'Starts when the wake word is turned on.'}
            </span>
          </div>
          <div className="field">
            <label htmlFor="wake-lang">Language</label>
            <select id="wake-lang" className="select" value={w.culture} onChange={(e) => void patch({ wake: { culture: e.target.value } })}>
              {(status?.recognizers ?? [{ culture: w.culture, name: '' }]).map((r) => (
                <option key={r.culture} value={r.culture}>
                  {r.culture}
                </option>
              ))}
            </select>
            <span className="hint">Only languages with an installed Windows speech recognizer are listed{status ? ` (${status.recognizers.length} installed)` : ''}.</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="wake-cmd">After the wake phrase, understand the command with</label>
          <select id="wake-cmd" className="select" style={{ maxWidth: 420 }} value={w.commandRecognizer} onChange={(e) => void patch({ wake: { commandRecognizer: e.target.value } })}>
            <option value="local">Windows speech (offline, on this computer)</option>
            <option value="openai">OpenAI transcription (more accurate; sends that recording to OpenAI)</option>
          </select>
          {w.commandRecognizer === 'openai' && !(s.voice.sttProvider === 'openai' && s.voice.audioExportConsent) && <span className="hint" style={{ color: 'var(--warn)' }}>OpenAI transcription isn’t set up (Voice section below), so Keo will use Windows speech.</span>}
        </div>
      </section>

      {status && <TrainedWakeWord s={s} patch={patch} hasKey={status.picovoiceKey} />}
      <ShortcutCard
        title="Voice shortcut"
        help="Starts a voice conversation with Keo from anywhere (press again to end it)."
        status={status?.voiceShortcut}
        enabled={s.shortcuts.voiceEnabled}
        value={s.shortcuts.voice}
        presets={['Control+K', 'Control+Alt+K', 'Control+Shift+Space']}
        onEnabled={(v) => void patch({ shortcuts: { voiceEnabled: v } })}
        onSave={(a) => void patch({ shortcuts: { voice: a } })}
      />
      <ShortcutCard
        title="Pencil shortcut"
        help="Opens Keo’s pencil: circle or mark anything on screen and say or type what you want."
        status={status?.pencilShortcut}
        enabled={s.shortcuts.pencilEnabled}
        value={s.shortcuts.pencil}
        presets={['Control+Alt+P', 'Control+Shift+P', 'Alt+Shift+P']}
        onEnabled={(v) => void patch({ shortcuts: { pencilEnabled: v } })}
        onSave={(a) => void patch({ shortcuts: { pencil: a } })}
      />
      <ShortcutCard
        title="Mini-chat shortcut"
        help="Opens Keo’s mini-chat (command bar) over any app."
        status={status?.shortcut}
        enabled={s.shortcuts.commandBarEnabled}
        value={s.shortcuts.commandBar}
        presets={['Control+Shift+K', 'Control+Alt+K', 'Control+Shift+Space']}
        onEnabled={(v) => void patch({ shortcuts: { commandBarEnabled: v } })}
        onSave={(a) => void patch({ shortcuts: { commandBar: a } })}
      />

      <section className="card">
        <h2>Floating companion</h2>
        <p className="muted small">A small Keo emblem that stays on screen and shows what Keo is really doing. It never takes keyboard focus. Drag it to move; hover for controls.</p>
        <Toggle checked={s.companion.enabled} onChange={(v) => void patch({ companion: { enabled: v } })} label="Show the companion" />
        <div style={{ height: 8 }} />
        <Toggle checked={s.companion.alwaysOnTop} onChange={(v) => void patch({ companion: { alwaysOnTop: v } })} label="Keep it above other windows" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn ghost sm" onClick={() => void patch({ companion: { x: null, y: null, enabled: false } }).then(() => patch({ companion: { enabled: true } }))}>
            Reset position
          </button>
        </div>
      </section>
    </>
  );
}

function Voice({ s, patch }: { s: Settings; patch: Patch }) {
  const app = useApp();
  const v = s.voice;
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(speechSynthesis.getVoices());
    load();
    speechSynthesis.addEventListener('voiceschanged', load);
    return () => speechSynthesis.removeEventListener('voiceschanged', load);
  }, []);
  const openai = app.providers.data?.find((p) => p.id === 'openai');
  return (
    <>
      <section className="card">
        <h2>Speech input</h2>
        <p className="muted small">Push-to-talk only: recording starts when you press the microphone button and stops when you release or click it again. Audio stays in memory and is never saved.</p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="stt">Speech-to-text provider</label>
            <select id="stt" className="select" value={v.sttProvider} onChange={(e) => void patch({ voice: { sttProvider: e.target.value } })}>
              <option value="none">Off</option>
              <option value="openai">OpenAI transcription {openai?.hasApiKey ? '' : '(needs OpenAI key)'}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="stt-model">Transcription model</label>
            <input id="stt-model" className="input" defaultValue={v.sttModel} onBlur={(e) => void patch({ voice: { sttModel: e.target.value } })} />
          </div>
        </div>
        <Toggle checked={v.audioExportConsent} onChange={(c) => void patch({ voice: { audioExportConsent: c } })} label="I allow Keo to send my voice recordings to OpenAI for transcription" />
        <p className="small muted">Microphone permission: {app.voice.micPermission === 'granted' ? 'granted' : app.voice.micPermission === 'denied' ? 'denied by Windows or you' : 'requested the first time you record'}.</p>
      </section>
      <section className="card">
        <h2>Spoken replies</h2>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="tts">Text-to-speech engine</label>
            <select id="tts" className="select" value={v.ttsEngine} onChange={(e) => void patch({ voice: { ttsEngine: e.target.value } })}>
              <option value="none">Off</option>
              <option value="system">Windows voices (local, offline)</option>
              <option value="openai">OpenAI voices (cloud) {openai?.hasApiKey ? '' : '(needs OpenAI key)'}</option>
            </select>
            <span className="hint">{v.ttsEngine === 'system' ? 'The emblem animates on spoken word boundaries.' : v.ttsEngine === 'openai' ? 'Reply text is sent to OpenAI; the emblem follows the real audio level.' : ''}</span>
          </div>
          {v.ttsEngine === 'system' ? (
            <div className="field">
              <label htmlFor="sysvoice">Windows voice</label>
              <select id="sysvoice" className="select" value={v.systemVoice} onChange={(e) => void patch({ voice: { systemVoice: e.target.value } })}>
                <option value="">System default</option>
                {voices.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name} ({x.lang})
                  </option>
                ))}
              </select>
            </div>
          ) : v.ttsEngine === 'openai' ? (
            <div className="field">
              <label htmlFor="oaivoice">OpenAI voice / model</label>
              <div className="row">
                <input id="oaivoice" className="input" defaultValue={v.openaiTtsVoice} onBlur={(e) => void patch({ voice: { openaiTtsVoice: e.target.value } })} />
                <select className="select" aria-label="OpenAI TTS model" value={['tts-1', 'gpt-4o-mini-tts', 'tts-1-hd'].includes(v.openaiTtsModel) ? v.openaiTtsModel : 'custom'} onChange={(e) => e.target.value !== 'custom' && void patch({ voice: { openaiTtsModel: e.target.value } })}>
                  <option value="tts-1">tts-1 — fastest to start</option>
                  <option value="gpt-4o-mini-tts">gpt-4o-mini-tts — most natural</option>
                  <option value="tts-1-hd">tts-1-hd — higher quality, slower</option>
                  {!['tts-1', 'gpt-4o-mini-tts', 'tts-1-hd'].includes(v.openaiTtsModel) && <option value="custom">{v.openaiTtsModel}</option>}
                </select>
              </div>
              <span className="hint">For quick spoken answers choose tts-1. The Windows voices start fastest of all (no network).</span>
            </div>
          ) : (
            <div />
          )}
        </div>
        <Toggle checked={v.speakResponses} onChange={(c) => void patch({ voice: { speakResponses: c } })} label="Read replies aloud automatically" />
      </section>
    </>
  );
}

/** Keo's own browser window for working inside websites (Google Docs, eBay, web forms). */
function WebApps({ s, patch }: { s: Settings; patch: Patch }) {
  const w = s.webApps;
  return (
    <section className="card" aria-label="Web apps">
      <h2>Web apps</h2>
      <p className="muted small">
        Keo can work inside websites — Google Docs and Slides, eBay listings, web forms — in its own browser window: Chrome or Edge with a separate Keo profile, so your normal browser, its cookies and saved passwords are never touched. Keo reads each page’s structure (fields, buttons, values) instead of guessing from the screen. You sign in to sites in that window yourself; Keo never types passwords, codes or card details. Reading and scrolling are routine; typing follows your approval level; submitting, sending, buying, paying, deleting, accepting and uploading always ask. Page text goes to your AI provider and is treated as untrusted.
      </p>
      <Toggle checked={w.enabled} onChange={(v) => void patch({ webApps: { enabled: v } })} label="Let Keo work in websites in its own browser window" />
      <div className="field">
        <label htmlFor="webapps-browser">Browser for Keo’s window</label>
        <select id="webapps-browser" className="select" value={w.browser} onChange={(e) => void patch({ webApps: { browser: e.target.value as Settings['webApps']['browser'] } })}>
          <option value="auto">Automatic (Chrome, else Edge)</option>
          <option value="chrome">Google Chrome</option>
          <option value="edge">Microsoft Edge</option>
        </select>
      </div>
      <p className="muted small">Sign-ins you make there stay in Keo’s data folder (removed with “Delete all data”).</p>
    </section>
  );
}

function WebSearch({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const app = useApp();
  const [status, setStatus] = useState<WebStatus | null>(null);
  const [key, setKey] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string; sample: Array<{ title: string; url: string }> } | null>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    void invoke('web:status').then(setStatus, (e) => ui.error(errText(e)));
  }, [ui, s]);
  const save = async () => {
    try {
      setStatus(await invoke('web:setKey', { apiKey: key }));
      setKey('');
      ui.toast('Brave Search key saved (encrypted)', 'success');
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <>
      <section className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Brave Search</h2>
          {status?.hasKey ? <span className="chip ok">Key stored</span> : <span className="chip warn">No key</span>}
          {status && (status.searchEnabled ? <span className="chip ok">Search on</span> : <span className="chip">Search off</span>)}
        </div>
        <p className="muted small">
          Lets Keo research with live web results. Queries go to api.search.brave.com using your key and plan quota. The key is encrypted with Windows (DPAPI) and never shown again.
        </p>
        <div className="field">
          <label htmlFor="brave-key">API key</label>
          <div className="row">
            <input id="brave-key" className="input" type="password" autoComplete="off" spellCheck={false} placeholder={status?.hasKey ? 'Replace stored key…' : 'Paste your Brave Search API key'} value={key} onChange={(e) => setKey(e.target.value)} />
            <button className="btn primary" disabled={key.trim().length < 8} onClick={() => void save()}>
              Save
            </button>
            {status?.hasKey && (
              <button className="btn ghost" onClick={() => void invoke('web:clearKey').then(setStatus, (e) => ui.error(errText(e)))}>
                Remove
              </button>
            )}
          </div>
        </div>
        {status && !status.searchEnabled && (
          <div className="banner info small" style={{ marginBottom: 10 }}>
            <Icon name="shield" size={15} />
            <div className="grow">Web search and page reading are switched on separately in Access.</div>
            <button className="btn sm" onClick={() => app.setView('capabilities')}>
              Open Access
            </button>
          </div>
        )}
        <div className="field">
          <label htmlFor="engine">Search engine</label>
          <select id="engine" className="select" value={s.web.engine} onChange={(e) => void patch({ web: { engine: e.target.value } })}>
            <option value="auto">Automatic — Brave Search with a key, otherwise DuckDuckGo</option>
            <option value="brave">Brave Search only (needs the key)</option>
            <option value="duckduckgo">DuckDuckGo (no key)</option>
          </select>
          <span className="muted small">DuckDuckGo needs no key: Keo reads its plain results page. It may slow down if you search a lot.</span>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="safe">Safe search</label>
            <select id="safe" className="select" value={s.web.safesearch} onChange={(e) => void patch({ web: { safesearch: e.target.value } })}>
              <option value="strict">Strict</option>
              <option value="moderate">Moderate</option>
              <option value="off">Off</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rps">Results per search</label>
            <input id="rps" className="input" type="number" min={1} max={20} defaultValue={s.web.resultsPerSearch} onBlur={(e) => void patch({ web: { resultsPerSearch: Number(e.target.value) } })} />
          </div>
        </div>
        <div className="row">
          <button
            className="btn"
            disabled={(s.web.engine === 'brave' && !status?.hasKey) || testing}
            onClick={async () => {
              setTesting(true);
              try {
                setTest(await invoke('web:test'));
              } catch (e) {
                ui.error(errText(e));
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? <span className="spinner" /> : <Icon name="search" size={14} />} Test search
          </button>
          <span className="muted small">Runs one real query{status?.hasKey && s.web.engine !== 'duckduckgo' ? ' (counts toward your Brave quota)' : ' on DuckDuckGo'}.</span>
        </div>
        {test && (
          <div className={`banner ${test.ok ? 'info' : 'danger'} small`} style={{ marginTop: 10 }}>
            <Icon name={test.ok ? 'check' : 'warn'} size={15} />
            <div className="grow">
              {test.message}
              {test.sample.map((r) => (
                <div key={r.url} className="muted">
                  {r.title} — {r.url}
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function Agent({ s, patch }: { s: Settings; patch: Patch }) {
  const a = s.agent;
  const num = (k: keyof typeof a, label: string, hint: string, min: number, max: number) => (
    <div className="field">
      <label htmlFor={`ag-${k}`}>{label}</label>
      <input id={`ag-${k}`} className="input" type="number" min={min} max={max} defaultValue={a[k] as number} onBlur={(e) => void patch({ agent: { [k]: Number(e.target.value) } })} />
      <span className="hint">{hint}</span>
    </div>
  );
  return (
    <section className="card">
      <h2>Agent behaviour</h2>
      <Toggle checked={a.toolsEnabled} onChange={(v) => void patch({ agent: { toolsEnabled: v } })} label="Let the model propose capabilities (tools)" />
      <div className="field" style={{ marginTop: 14, maxWidth: 520 }}>
        <label htmlFor="mem-learning">Memory learning</label>
        <select id="mem-learning" className="select" value={s.memory.learning} onChange={(e) => void patch({ memory: { learning: e.target.value } })}>
          <option value="from_user_words">Remember what I tell Keo about myself automatically</option>
          <option value="ask">Ask me before remembering anything</option>
        </select>
        <span className="hint">
          Automatic saving only happens when Keo can quote your own words from the chat; anything else waits for your confirmation. Everything stays editable and deletable in Memory, and passwords or keys are never stored.
        </span>
      </div>
      <div className="grid-2" style={{ marginTop: 12 }}>
        {num('contextMessageLimit', 'Recent messages in context', 'Upper bound on history sent per request.', 2, 200)}
        {num('contextCharBudget', 'History character budget', 'Older messages beyond this are left out.', 2000, 400000)}
        {num('memoryTopK', 'Memories per request', 'Most relevant confirmed memories included.', 0, 30)}
        {num('maxToolIterations', 'Max tool rounds per reply', 'Stops runaway tool loops.', 1, 20)}
        {num('approvalWaitSeconds', 'Wait for approval (seconds)', 'After this the reply continues and the task stays pending.', 10, 1800)}
        {num('maxBackgroundJobs', 'Background jobs at once', 'Long requests (research, video) run in the background; more wait in a queue. Only one at a time uses the mouse and keyboard.', 1, 6)}
      </div>
    </section>
  );
}

function Appearance({ s, patch }: { s: Settings; patch: Patch }) {
  const states: EmblemState[] = ['idle', 'listening', 'thinking', 'speaking', 'working', 'attention', 'error'];
  return (
    <>
      <section className="card">
        <h2>Motion</h2>
        <div className="field">
          <label htmlFor="theme">Look</label>
          <select id="theme" className="select" style={{ maxWidth: 320 }} value={s.ui.theme} onChange={(e) => void patch({ ui: { theme: e.target.value } })}>
            <option value="noir">Noir — black and white (Keo)</option>
            <option value="classic">Classic — dark blue</option>
          </select>
        </div>
        <Toggle checked={s.ui.keoModeOnWake} onChange={(v) => void patch({ ui: { keoModeOnWake: v } })} label="Open Keo mode when I say the wake word" />
        <div style={{ height: 10 }} />
        <div className="field">
          <label htmlFor="motion">Animations</label>
          <select id="motion" className="select" style={{ maxWidth: 320 }} value={s.ui.reducedMotion} onChange={(e) => void patch({ ui: { reducedMotion: e.target.value } })}>
            <option value="system">Follow Windows setting</option>
            <option value="reduce">Reduce motion</option>
            <option value="full">Full motion</option>
          </select>
        </div>
      </section>
      <section className="card">
        <h2>Emblem states</h2>
        <p className="muted small">Preview of how Keo signals its state. In use, these follow real events (recording, playback, model activity, running tasks, approvals, errors).</p>
        <div className="row wrap" style={{ gap: 18 }}>
          {states.map((st) => (
            <div key={st} className="stack" style={{ alignItems: 'center', gap: 4 }}>
              <KeoEmblem state={st} size={88} live={false} />
              <span className="small muted">{st}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** "Check this computer": a self-test on a throw-away window, and a copyable report without personal content. */
function CheckComputer() {
  const ui = useUi();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SelfTestResult | null>(null);
  const [wa, setWa] = useState<{ ok: boolean; lines: string[] } | null>(null);
  const checkWa = async () => {
    try {
      setWa(await invoke('diag:checkWhatsApp', {}));
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const run = async () => {
    setRunning(true);
    try {
      setResult(await invoke('diag:checkComputer', {}));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setRunning(false);
    }
  };
  const copy = async () => {
    try {
      const { text } = await invoke('diag:report', {});
      const r = await invoke('app:copyText', { text });
      if (!r.copied) throw new Error('Copy failed');
      ui.toast('Report copied — paste it where you ask for help', 'success');
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <section className="card">
      <h2>Check this computer</h2>
      <p className="muted small">
        If Keo opens apps but can’t type, paste or click, run this. Keo opens its own small test window for about ten seconds, types and pastes into it, reads it back and presses a button — none of your apps are touched and your clipboard is put back. Please don’t use the mouse or keyboard while it runs.
      </p>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn sm" disabled={running} onClick={() => void run()}>
          {running ? (
            <>
              <span className="spinner" /> Checking…
            </>
          ) : (
            'Run the check'
          )}
        </button>
        <button className="btn sm" onClick={() => void checkWa()} title="Reads the WhatsApp window only — nothing is clicked or typed">
          Check WhatsApp
        </button>
        <button className="btn sm ghost" onClick={() => void copy()}>
          Copy diagnostic report
        </button>
      </div>
      {wa && (
        <div className="stack" style={{ marginTop: 12, gap: 4 }} aria-live="polite">
          <strong>{wa.ok ? 'Keo recognises WhatsApp.' : 'Keo can’t find WhatsApp’s search box.'}</strong>
          {wa.lines.map((l, i) => (
            <div key={i} className="small muted">
              {l}
            </div>
          ))}
        </div>
      )}
      {result && (
        <div className="stack" style={{ marginTop: 12, gap: 4 }} aria-live="polite">
          <strong>{result.ok ? 'Everything works on this computer.' : 'Something is blocking Keo.'}</strong>
          {result.steps.map((st) => (
            <div key={st.id} className="small">
              {st.ok ? '✓' : '✗'} {st.title} <span className="muted">— {st.detail}</span>
            </div>
          ))}
          {result.advice && <p className="small">{result.advice}</p>}
        </div>
      )}
      <p className="hint" style={{ marginTop: 8 }}>
        The report lists versions, displays, which switches are on and error codes — no API keys, chats, window titles or anything you typed.
      </p>
    </section>
  );
}

/** Saved workflows, and export/import of projects and workflows (never keys, settings or chats). */
function WorkflowsAndExport() {
  const ui = useUi();
  const [list, setList] = useState<Array<{ id: string; name: string; description: string; steps: number; imported: boolean }>>([]);
  const load = useCallback(() => void invoke('workflows:list', {}).then(setList).catch(() => undefined), []);
  useEffect(load, [load]);
  return (
    <section className="card">
      <h2>Workflows and export</h2>
      <p className="muted small">Save a finished task as a workflow from Tasks (“Save as workflow”), then ask Keo to run it again: Keo looks at the current screen, re-plans the steps and asks for approval as usual — it never replays old clicks.</p>
      {list.length === 0 ? (
        <p className="muted small">No saved workflows yet.</p>
      ) : (
        <ul className="plain-list">
          {list.map((w) => (
            <li key={w.id} className="row">
              <span className="grow">
                <strong>{w.name}</strong> <span className="muted small">· {w.steps} step(s){w.imported ? ' · imported' : ''}</span>
                {w.description && <div className="muted small">{w.description}</div>}
              </span>
              <button className="btn ghost sm" onClick={() => void invoke('workflows:delete', { id: w.id }).then(load).catch((e) => ui.error(errText(e)))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="btn sm"
          onClick={() =>
            void invoke('data:export', {})
              .then((r) => r.path && ui.toast(`Exported ${r.projects} project(s) and ${r.workflows} workflow(s)`, 'success'))
              .catch((e) => ui.error(errText(e)))
          }
        >
          Export projects and workflows…
        </button>
        <button
          className="btn ghost sm"
          onClick={() =>
            void invoke('data:import', {})
              .then((r) => {
                if (r) ui.toast(`Imported ${r.projects} project(s) and ${r.workflows} workflow(s)${r.skipped ? ` (${r.skipped} skipped: unknown actions)` : ''}`, 'success');
                load();
              })
              .catch((e) => ui.error(errText(e)))
          }
        >
          Import…
        </button>
      </div>
      <p className="hint">The export holds project notes and workflow steps only — no API keys, settings, conversations or memory.</p>
    </section>
  );
}

function Data({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [info, setInfo] = useState<{ path: string } | null>(null);
  return (
    <>
      <WorkflowsAndExport />
      <section className="card">
        <h2>Updates</h2>
        <Toggle checked={s.updates.check} onChange={(v) => void patch({ updates: { check: v } })} label="Keep Keo up to date: check once a day, download new versions in the background and install them when Keo closes (asks GitHub; nothing about you is sent)" />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm" onClick={() => void invoke('app:checkUpdate', { force: true }).then((u) => alert(!u ? 'Update checks run in the installed app.' : u.error ? u.error : u.download?.state === 'ready' ? `Keo ${u.download.version} is downloaded — use “Restart to update” at the top.` : u.download?.state === 'downloading' ? `Downloading Keo ${u.latest}… it installs when Keo closes.` : u.newer ? `Keo ${u.latest} is available.` : `You have the latest Keo (${u.current}).`))}>
            Check now
          </button>
          <button className="btn sm ghost" onClick={() => void invoke('app:openLink', { id: 'privacy' })}>
            Privacy note
          </button>
        </div>
      </section>
      <section className="card">
        <h2>Screen captures</h2>
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="ret">Keep capture images for (hours)</label>
          <input id="ret" className="input" type="number" min={0} max={720} defaultValue={s.privacy.observationRetentionHours} onBlur={(e) => void patch({ privacy: { observationRetentionHours: Number(e.target.value) } })} />
          <span className="hint">0 = delete images at the next cleanup (every 15 minutes). Metadata is kept for provenance.</span>
        </div>
      </section>
      <section className="card">
        <h2>Your data</h2>
        <p className="muted small">Keo stores everything in its own profile folder. Nothing is shared with other applications.</p>
        <div className="row wrap">
          <button className="btn" onClick={() => void invoke('app:openDataFolder').catch((e) => ui.error(errText(e)))}>
            <Icon name="folder" size={14} /> Open data folder
          </button>
          <button
            className="btn"
            onClick={() =>
              void invoke('data:backup').then(
                (r) => {
                  setInfo(r);
                  ui.toast('Backup created', 'success');
                },
                (e) => ui.error(errText(e)),
              )
            }
          >
            Create database backup
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              const typed = await ui.prompt({ title: 'Delete all Keo data?', label: 'This permanently deletes conversations, memory, projects, tasks, captures and stored API keys in this profile. Type DELETE to confirm.', confirmLabel: 'Delete everything' });
              if (typed !== 'DELETE') return;
              await invoke('data:deleteAll', { confirm: 'DELETE' }).then(() => ui.toast('All data deleted. Keo will restart.'), (e) => ui.error(errText(e)));
            }}
          >
            <Icon name="trash" size={14} /> Delete all data…
          </button>
        </div>
        {info && <p className="small mono muted">{info.path}</p>}
        <p className="small muted">Settings remain so your permissions stay off by default after deletion. Backups are not encrypted — store them safely.</p>
      </section>
    </>
  );
}
