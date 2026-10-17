import { useState } from 'react';
import type { ProviderDiagnostic, ProviderId } from '@shared/domain';
import type { LinkId } from '@shared/release';
import { errText, invoke } from '../lib/api';
import { useApp } from '../state/AppState';
import { KeoEmblem } from './KeoEmblem';

type Choice = Exclude<ProviderId, 'test'>;

const PROVIDERS: Array<{ id: Choice; title: string; text: string; keyLink: LinkId | null; model: string; modelHint: string }> = [
  {
    id: 'openrouter',
    title: 'OpenRouter',
    text: 'One key for many models (OpenAI, Anthropic, Google, open models). Easiest start.',
    keyLink: 'openrouterKeys',
    model: 'openai/gpt-4o-mini',
    modelHint: 'e.g. openai/gpt-4o-mini, anthropic/claude-sonnet-4.5',
  },
  { id: 'openai', title: 'OpenAI', text: 'Use your OpenAI API key directly.', keyLink: 'openaiKeys', model: 'gpt-4o-mini', modelHint: 'e.g. gpt-4o-mini' },
  { id: 'anthropic', title: 'Anthropic (Claude)', text: 'Use your Anthropic API key directly.', keyLink: 'anthropicKeys', model: 'claude-sonnet-5-5', modelHint: 'e.g. claude-sonnet-5-5' },
  { id: 'local', title: 'Local model', text: 'Free and private: a model running on this PC (Ollama, LM Studio). No key needed.', keyLink: 'ollama', model: '', modelHint: 'the model name in your local server' },
];

const open = (id: LinkId) => void invoke('app:openLink', { id }).catch(() => undefined);

/**
 * First-run welcome for a new installation: what Keo is, connecting an AI
 * provider with the user's own key, optional web search, and what Keo may do.
 * Keys go through the normal (OS-encrypted) key store; nothing is sent
 * anywhere until the user tests or chats.
 */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const [step, setStep] = useState(0);
  const [choice, setChoice] = useState<Choice>('openrouter');
  const p = PROVIDERS.find((x) => x.id === choice)!;
  const [key, setKey] = useState('');
  const [model, setModel] = useState(p.model);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [brave, setBrave] = useState('');
  const [braveNote, setBraveNote] = useState<string | null>(null);

  const finish = async () => {
    await invoke('settings:update', { patch: { ui: { onboarded: true } } }).catch(() => undefined);
    onDone();
  };

  const connect = async () => {
    setBusy(true);
    setResult(null);
    try {
      if (choice !== 'local') {
        if (key.trim().length < 8) throw new Error('Paste your API key first.');
        await invoke('providers:setKey', { providerId: choice, apiKey: key.trim() });
      }
      const providerPatch = choice === 'anthropic' ? { anthropic: { model: model.trim() || p.model } } : { [choice]: { model: model.trim() } };
      await invoke('settings:update', { patch: { activeProvider: choice, providers: providerPatch } });
      const d: ProviderDiagnostic = await invoke('providers:diagnose', { providerId: choice });
      setResult({ ok: d.ok, text: d.message });
      void app.providers.refresh();
      if (d.ok) setKey('');
    } catch (e) {
      setResult({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  const saveBrave = async () => {
    try {
      await invoke('web:setKey', { apiKey: brave.trim() });
      await invoke('settings:update', { patch: { permissions: { webSearchEnabled: true, webFetchEnabled: true } } });
      setBrave('');
      setBraveNote('Saved. Web search is on.');
    } catch (e) {
      setBraveNote(errText(e));
    }
  };

  return (
    <div className="onboarding-backdrop" role="dialog" aria-modal="true" aria-label="Welcome to Keo">
      <div className="onboarding">
        <div className="row" style={{ gap: 12, marginBottom: 6 }}>
          <KeoEmblem state="idle" size={44} />
          <div className="grow">
            <h2 style={{ margin: 0 }}>Welcome to Keo</h2>
            <span className="muted small">Step {step + 1} of 4</span>
          </div>
          <button className="btn sm ghost" onClick={() => void finish()}>
            Skip setup
          </button>
        </div>

        {step === 0 && (
          <>
            <p>Keo is a personal AI agent that runs on your Windows computer. It can chat, research, remember what matters to you, and — only when you allow it — work in your apps (Notepad, your browser, WhatsApp…).</p>
            <ul className="onboarding-points">
              <li>
                <strong>Your computer, your data.</strong> Conversations, memory and settings stay on this PC. There is no Keo account and no Keo server.
              </li>
              <li>
                <strong>Your own AI key.</strong> You connect the AI provider you choose; its messages go only to that provider.
              </li>
              <li>
                <strong>Nothing happens behind your back.</strong> Using your apps is off until you turn it on, and by default every action asks you first. <strong>Stop</strong> halts everything at once.
              </li>
            </ul>
            <button className="link-btn small" onClick={() => open('privacy')}>
              Read the privacy note
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <p>Choose where Keo’s thinking happens. You pay the provider directly for what you use.</p>
            <div className="choice-list" role="radiogroup" aria-label="AI provider">
              {PROVIDERS.map((x) => (
                <label key={x.id} className={`choice ${choice === x.id ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    checked={choice === x.id}
                    onChange={() => {
                      setChoice(x.id);
                      setModel(x.model);
                      setResult(null);
                    }}
                  />
                  <span>
                    <strong>{x.title}</strong>
                    <span className="muted small" style={{ display: 'block' }}>
                      {x.text}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {choice !== 'local' && (
              <div className="field" style={{ marginTop: 10 }}>
                <label htmlFor="ob-key">API key</label>
                <div className="row">
                  <input id="ob-key" className="input grow" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste your key" />
                  {p.keyLink && (
                    <button className="btn sm" onClick={() => open(p.keyLink!)}>
                      Get a key
                    </button>
                  )}
                </div>
                <span className="muted small">Stored encrypted by Windows on this PC; never shown again.</span>
              </div>
            )}
            {choice === 'local' && (
              <p className="muted small">
                Start your local server first (for Ollama: install it, then run a model). Keo connects to it on this PC only.{' '}
                <button className="link-btn" onClick={() => open('ollama')}>
                  Get Ollama
                </button>
              </p>
            )}
            <div className="field">
              <label htmlFor="ob-model">Model</label>
              <input id="ob-model" className="input" value={model} onChange={(e) => setModel(e.target.value)} placeholder={p.modelHint} />
              <span className="muted small">{p.modelHint}. You can change it later in Settings → Providers.</span>
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy || (choice !== 'local' && key.trim().length < 8) || (choice !== 'anthropic' && !model.trim())} onClick={() => void connect()}>
                {busy ? 'Connecting…' : 'Connect and test'}
              </button>
              {result && <span className={`chip ${result.ok ? 'ok' : 'danger'}`}>{result.ok ? 'Connected' : 'Not connected'}</span>}
            </div>
            {result && <p className={`small ${result.ok ? 'muted' : ''}`}>{result.text}</p>}
          </>
        )}

        {step === 2 && (
          <>
            <p>
              <strong>Optional:</strong> let Keo search the web for research and current information. It uses a Brave Search API key (there is a free tier).
            </p>
            <div className="row">
              <input className="input grow" type="password" autoComplete="off" value={brave} onChange={(e) => setBrave(e.target.value)} placeholder="Brave Search API key (optional)" />
              <button className="btn sm" onClick={() => open('braveKeys')}>
                Get a key
              </button>
              <button className="btn sm primary" disabled={brave.trim().length < 8} onClick={() => void saveBrave()}>
                Save
              </button>
            </div>
            {braveNote && <p className="small muted">{braveNote}</p>}
            <p className="muted small">You can skip this and add it later in Settings → Web search.</p>
          </>
        )}

        {step === 3 && (
          <>
            <p>You’re ready. A few things to know:</p>
            <ul className="onboarding-points">
              <li>
                <strong>Working in your apps</strong> is off until you allow it in <em>Access</em> — you choose exactly which apps Keo may use.
              </li>
              <li>
                <strong>Approvals:</strong> Keo asks before each action. When you trust it more (e.g. for voice use), choose a level in Settings → Approvals &amp; live chat.
              </li>
              <li>
                <strong>Quick commands:</strong> press <kbd>Ctrl</kbd>+<kbd>K</kbd> anywhere; a wake word (“Hey Keo”) can be turned on in Settings → Voice.
              </li>
            </ul>
            <p className="muted small">Try: “Research the best budget microphone and summarise it”, “Open Notepad and write a short cover letter”, or “Chat with Ma on WhatsApp until I say stop”.</p>
          </>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          {step > 0 && (
            <button className="btn ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className="grow" />
          {step < 3 ? (
            <button className="btn primary" onClick={() => setStep(step + 1)}>
              {step === 1 && !result?.ok ? 'Skip for now' : 'Next'}
            </button>
          ) : (
            <button
              className="btn primary"
              onClick={() => {
                void finish();
                if (app.view !== 'chat') app.setView('chat');
              }}
            >
              Start using Keo
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
