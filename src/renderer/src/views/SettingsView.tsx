import { useEffect, useState } from 'react';
import type { ProviderDiagnostic, ProviderInfo } from '@shared/domain';
import type { Settings } from '@shared/settings';
import { Icon } from '../components/Icon';
import { KeoEmblem, type EmblemState } from '../components/KeoEmblem';
import { Toggle, ViewHeader, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useApp } from '../state/AppState';

type Section = 'providers' | 'voice' | 'agent' | 'appearance' | 'data';

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
              ['voice', 'Voice'],
              ['agent', 'Agent'],
              ['appearance', 'Appearance'],
              ['data', 'Privacy & data'],
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
        ) : section === 'voice' ? (
          <Voice s={s} patch={patch} />
        ) : section === 'agent' ? (
          <Agent s={s} patch={patch} />
        ) : section === 'appearance' ? (
          <Appearance s={s} patch={patch} />
        ) : (
          <Data s={s} patch={patch} />
        )}
      </div>
    </div>
  );
}

type Patch = (p: Record<string, unknown>) => Promise<void>;

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
    </>
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
      {(p.id === 'openai' || p.id === 'local') && <CompatFields id={p.id} s={s} patch={patch} />}

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

function CompatFields({ id, s, patch }: { id: 'openai' | 'local'; s: Settings; patch: Patch }) {
  const c = s.providers[id];
  const set = (v: Record<string, unknown>) => void patch({ providers: { [id]: v } });
  return (
    <>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={`${id}-url`}>Base URL</label>
          <input id={`${id}-url`} className="input" defaultValue={c.baseUrl} onBlur={(e) => e.target.value !== c.baseUrl && set({ baseUrl: e.target.value })} />
          {id === 'local' && <span className="hint">Must be a loopback address (127.0.0.1 / localhost).</span>}
        </div>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model id</label>
          <input id={`${id}-model`} className="input" placeholder={id === 'local' ? 'e.g. llama3.1:8b' : 'model id from your OpenAI account'} defaultValue={c.model} onBlur={(e) => e.target.value !== c.model && set({ model: e.target.value })} />
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
                <input className="input" aria-label="OpenAI TTS model" defaultValue={v.openaiTtsModel} onBlur={(e) => void patch({ voice: { openaiTtsModel: e.target.value } })} />
              </div>
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
      <div className="grid-2" style={{ marginTop: 12 }}>
        {num('contextMessageLimit', 'Recent messages in context', 'Upper bound on history sent per request.', 2, 200)}
        {num('contextCharBudget', 'History character budget', 'Older messages beyond this are left out.', 2000, 400000)}
        {num('memoryTopK', 'Memories per request', 'Most relevant confirmed memories included.', 0, 30)}
        {num('maxToolIterations', 'Max tool rounds per reply', 'Stops runaway tool loops.', 1, 20)}
        {num('approvalWaitSeconds', 'Wait for approval (seconds)', 'After this the reply continues and the task stays pending.', 10, 1800)}
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

function Data({ s, patch }: { s: Settings; patch: Patch }) {
  const ui = useUi();
  const [info, setInfo] = useState<{ path: string } | null>(null);
  return (
    <>
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
