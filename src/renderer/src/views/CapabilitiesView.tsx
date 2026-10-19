import { useState } from 'react';
import type { CapabilityInfo } from '@shared/domain';
import type { Settings } from '@shared/settings';
import { Icon } from '../components/Icon';
import { ErrorBanner, Toggle, ViewHeader, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useInvoke } from '../lib/hooks';
import { useApp } from '../state/AppState';

export function CapabilitiesView() {
  const app = useApp();
  const ui = useUi();
  const caps = useInvoke('capabilities:list', {}, { refreshOn: ['settings:changed'] });
  const s = app.settings.data;
  const patch = (p: Record<string, unknown>) => invoke('settings:update', { patch: p }).catch((e) => ui.error(errText(e)));

  const enableWithConfirm = async (key: keyof typeof PERMISSION_TEXT, on: boolean, what: string) => {
    if (on && !(await ui.confirm({ title: `Enable ${what}?`, body: PERMISSION_TEXT[key], confirmLabel: 'Enable' }))) return;
    await patch({ permissions: { [key]: on } });
  };

  return (
    <div className="view">
      <ViewHeader title="Access & capabilities" subtitle="Everything Keo can do is a registered capability with a risk level. Permissions here are off by default; the model cannot change them." />
      <div className="view-body narrow">
        {s && (
          <>
            <div className="section-title">Permissions</div>
            <div className="card stack">
              <Toggle checked={s.permissions.observationEnabled} onChange={(v) => void enableWithConfirm('observationEnabled', v, 'window observation')} label={<PermLabel title="Window observation" text="List windows of allow-listed apps and capture one window at a time (each capture by Keo needs approval)." />} />
              <Toggle checked={s.permissions.desktopControlEnabled} onChange={(v) => void enableWithConfirm('desktopControlEnabled', v, 'desktop control')} label={<PermLabel title="Desktop control" text="Focus, move, type, press keys and click in allow-listed windows. Every single action requires your approval." />} />
              <Toggle checked={s.permissions.launchEnabled} onChange={(v) => void enableWithConfirm('launchEnabled', v, 'application launch')} label={<PermLabel title="Application launch" text="Start applications you registered below. Each launch requires approval." />} />
            </div>

            <div className="section-title">Web research</div>
            <div className="card stack">
              <Toggle checked={s.permissions.webSearchEnabled} onChange={(v) => void enableWithConfirm('webSearchEnabled', v, 'web search')} label={<PermLabel title="Web search (Brave)" text="Keo may send search queries to Brave Search with your key, without asking each time. Needs a key in Settings → Web search." />} />
              <Toggle checked={s.permissions.webFetchEnabled} onChange={(v) => void enableWithConfirm('webFetchEnabled', v, 'web page reading')} label={<PermLabel title="Read web pages" text="Keo may download public web pages as text to research an answer. Pages on this computer or your local network are always refused." />} />
            </div>

            <div className="section-title">Screen-content export</div>
            <div className="card stack">
              <p className="muted small" style={{ margin: 0 }}>
                Screenshots are analysed by the active model provider. Allow each destination explicitly; local models keep images on this computer.
              </p>
              {(['anthropic', 'openai', 'openrouter', 'local'] as const).map((p) => (
                <Toggle key={p} checked={s.permissions.visionExport[p]} onChange={(v) => void patch({ permissions: { visionExport: { [p]: v } } })} label={`Allow sending window captures to ${EXPORT_LABEL[p]}`} />
              ))}
            </div>

            <AllowedApps s={s} patch={patch} />
            <LaunchableApps s={s} patch={patch} />
          </>
        )}

        <div className="section-title">Registered capabilities</div>
        <ErrorBanner error={caps.error} onRetry={() => void caps.refresh()} />
        <div className="card">
          {(caps.data ?? []).map((c) => (
            <CapRow key={c.id} c={c} />
          ))}
        </div>
      </div>
    </div>
  );
}

const EXPORT_LABEL = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter (and the model vendor it routes to)', local: 'the local model server' } as const;

const PERMISSION_TEXT = {
  observationEnabled: 'Keo will be able to list windows of applications you allow-list and, with your approval, capture them. Captures are stored locally under the retention policy.',
  desktopControlEnabled: 'Keo will be able to propose keyboard, mouse and window actions in allow-listed applications. Each action shows a preview and runs only after you approve it.',
  launchEnabled: 'Keo will be able to propose starting applications from your launch list. Each launch requires approval.',
  webSearchEnabled: 'Keo will be able to send search queries to Brave Search (using your API key and quota) whenever it decides a search helps, without asking each time. Results are treated as untrusted.',
  webFetchEnabled: 'Keo will be able to download public web pages to read them. Websites see requests from your computer. Local and private-network addresses are always refused.',
} as const;

function PermLabel({ title, text }: { title: string; text: string }) {
  return (
    <span>
      <strong style={{ fontWeight: 600 }}>{title}</strong>
      <br />
      <span className="muted small">{text}</span>
    </span>
  );
}

function AllowedApps({ s, patch }: { s: Settings; patch: (p: Record<string, unknown>) => Promise<unknown> }) {
  const app = useApp();
  const [picking, setPicking] = useState(false);
  return (
    <>
      <div className="section-title">Allowed applications</div>
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <span className="muted small">Keo may look at and (with your approval level) work in these apps.</span>
          <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
            <Icon name="plus" size={14} /> Add from installed apps…
          </button>
        </div>
        {picking && (
          <InstalledAppPicker
            action="Allow"
            isDone={(a) => !!a.processName && s.permissions.allowedApps.some((x) => x.processName.toLowerCase() === a.processName!.toLowerCase())}
            canPick={(a) => (a.processName ? null : 'Windows does not say which process this app runs as. Open it once, then allow it from Vision → Show all windows.')}
            onPick={(a) => void patch({ permissions: { observationEnabled: true, allowedApps: [...s.permissions.allowedApps, { processName: a.processName!, label: a.name.slice(0, 120) }] } })}
            onClose={() => setPicking(false)}
          />
        )}
        {s.permissions.allowedApps.length === 0 ? (
          <p className="muted small" style={{ margin: 0 }}>
            None. Add apps from the Vision view (“Show all windows” → “Allow this app”).{' '}
            <button className="btn ghost sm" onClick={() => app.setView('vision')}>
              Open Vision
            </button>
          </p>
        ) : (
          s.permissions.allowedApps.map((a) => (
            <div className="row" key={a.processName} style={{ padding: '4px 0' }}>
              <Icon name="window" size={15} />
              <span className="mono">{a.processName}</span>
              <button
                className="btn ghost sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => void patch({ permissions: { allowedApps: s.permissions.allowedApps.filter((x) => x.processName !== a.processName) } })}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function LaunchableApps({ s, patch }: { s: Settings; patch: (p: Record<string, unknown>) => Promise<unknown> }) {
  const ui = useUi();
  const [picking, setPicking] = useState(false);
  const pickInstalled = async (a: InstalledAppT) => {
    let id = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'app';
    while (s.permissions.launchableApps.some((x) => x.id === id)) id = `${id}-2`;
    const alreadyAllowed = !a.processName || s.permissions.allowedApps.some((x) => x.processName.toLowerCase() === a.processName!.toLowerCase());
    await patch({
      permissions: {
        launchEnabled: true,
        launchableApps: [...s.permissions.launchableApps, a.kind === 'desktop' && a.exePath ? { id, label: a.name.slice(0, 120), path: a.exePath } : { id, label: a.name.slice(0, 120), appId: a.appId }],
        ...(alreadyAllowed ? {} : { allowedApps: [...s.permissions.allowedApps, { processName: a.processName!, label: a.name.slice(0, 120) }] }),
      },
    });
  };
  const common = useInvoke('desktop:commonApps', {});
  const quickAdd = async (a: { id: string; label: string; path: string; processName: string }) => {
    const alreadyAllowed = s.permissions.allowedApps.some((x) => x.processName.toLowerCase() === a.processName.toLowerCase());
    const ok = await ui.confirm({
      title: `Let Keo launch ${a.label}?`,
      body: (
        <>
          Adds <span className="mono">{a.path}</span> to your launch list{alreadyAllowed ? '' : <> and allows Keo to work with <strong>{a.processName}</strong> windows</>}
          {s.permissions.launchEnabled ? '' : ', and turns on Application launch'}. Every launch, keystroke and click still needs your approval.
        </>
      ),
      confirmLabel: 'Add',
    });
    if (!ok) return;
    let id = a.id;
    while (s.permissions.launchableApps.some((x) => x.id === id)) id = `${id}-2`;
    await patch({
      permissions: {
        launchEnabled: true,
        launchableApps: [...s.permissions.launchableApps, { id, label: a.label, path: a.path }],
        ...(alreadyAllowed ? {} : { allowedApps: [...s.permissions.allowedApps, { processName: a.processName, label: a.label }] }),
      },
    });
  };
  const add = async () => {
    try {
      const r = await invoke('desktop:pickLaunchable');
      if (!r.path) return;
      const base = r.path.split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? 'app';
      const label = await ui.prompt({ title: 'Name this application', label: 'Label', initial: base });
      if (!label) return;
      let id = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'app';
      while (s.permissions.launchableApps.some((a) => a.id === id)) id = `${id}-2`;
      await patch({ permissions: { launchableApps: [...s.permissions.launchableApps, { id, label, path: r.path }] } });
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <>
      <div className="section-title">Launchable applications</div>
      <div className="card">
        {s.permissions.launchableApps.map((a) => (
          <div className="row" key={a.id} style={{ padding: '4px 0' }}>
            <Icon name="rocket" size={15} />
            <span>{a.label}</span>
            <span className="mono muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {a.id} · {a.path ?? a.appId}
            </span>
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => void patch({ permissions: { launchableApps: s.permissions.launchableApps.filter((x) => x.id !== a.id) } })}>
              Remove
            </button>
          </div>
        ))}
        {picking && (
          <InstalledAppPicker
            action="Add"
            isDone={(a) => s.permissions.launchableApps.some((x) => x.appId === a.appId || (!!a.exePath && (x.path ?? '').toLowerCase() === a.exePath.toLowerCase()))}
            canPick={() => null}
            onPick={(a) => void pickInstalled(a)}
            onClose={() => setPicking(false)}
          />
        )}
        <div className="row wrap" style={{ marginTop: 6 }}>
          {(common.data ?? [])
            .filter((a) => a.available && !s.permissions.launchableApps.some((x) => (x.path ?? '').toLowerCase() === a.path.toLowerCase()))
            .map((a) => (
              <button key={a.id} className="btn sm" onClick={() => void quickAdd(a)}>
                <Icon name="plus" size={14} /> {a.label}
              </button>
            ))}
          <button className="btn sm" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
            <Icon name="plus" size={14} /> Choose from installed apps…
          </button>
          <button className="btn ghost sm" onClick={() => void add()} title="Pick an .exe file">
            Browse for an .exe…
          </button>
        </div>
      </div>
    </>
  );
}

type InstalledAppT = { name: string; appId: string; kind: 'store' | 'desktop'; publisher: string | null; processName: string | null; exePath: string | null; icon: string | null };

/** Searchable list of the apps installed on this PC (Start menu and Microsoft Store), with icons. */
function InstalledAppPicker(p: { action: string; isDone(a: InstalledAppT): boolean; canPick(a: InstalledAppT): string | null; onPick(a: InstalledAppT): void; onClose(): void }) {
  const list = useInvoke('apps:installed', { refresh: false });
  const [q, setQ] = useState('');
  const apps = (list.data ?? []).filter((a) => !q || `${a.name} ${a.publisher ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="app-picker" role="dialog" aria-label="Installed apps">
      <div className="row">
        <input className="input" autoFocus placeholder="Search apps (WhatsApp, Calculator, File Explorer…)" aria-label="Search installed apps" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn ghost sm" onClick={p.onClose}>
          Close
        </button>
      </div>
      {list.loading && !list.data ? (
        <div className="row muted small" style={{ padding: 8 }}>
          <span className="spinner" /> Reading the apps installed on this PC…
        </div>
      ) : list.error ? (
        <div className="banner danger small">{list.error}</div>
      ) : (
        <ul className="app-list">
          {apps.map((a) => {
            const done = p.isDone(a);
            const why = p.canPick(a);
            return (
              <li key={a.appId} className="row">
                {a.icon ? <img src={a.icon} alt="" width={24} height={24} /> : <span className="app-icon-placeholder" aria-hidden="true"><Icon name="window" size={16} /></span>}
                <span className="grow">
                  {a.name}
                  <span className="muted small">
                    {' '}
                    · {a.kind === 'store' ? 'Microsoft Store' : 'Desktop'}
                    {a.publisher ? ` · ${a.publisher}` : ''}
                    {a.processName ? ` · ${a.processName}` : ''}
                  </span>
                </span>
                {done ? (
                  <span className="chip ok">Added</span>
                ) : (
                  <button className="btn sm" disabled={!!why} title={why ?? undefined} onClick={() => p.onPick(a)}>
                    {p.action}
                  </button>
                )}
              </li>
            );
          })}
          {apps.length === 0 && <li className="muted small">No app matches “{q}”.</li>}
        </ul>
      )}
    </div>
  );
}

function CapRow({ c }: { c: CapabilityInfo }) {
  return (
    <div className="cap-row">
      <div>
        <div className="row wrap">
          <strong style={{ fontWeight: 600 }}>{c.title}</strong>
          <span className="id">
            {c.id}@{c.version}
          </span>
        </div>
        <div className="muted small">{c.description}</div>
        <div className="row wrap small" style={{ marginTop: 4 }}>
          <span className={`risk-${c.risk}`}>Risk: {c.risk}</span>
          <span>{c.requiresApproval ? 'Approval every time' : 'No approval needed'}</span>
          {c.consequential && <span>Consequential (never auto-retried)</span>}
          <span className="muted">timeout {Math.round(c.timeoutMs / 1000)} s</span>
          {c.permissions.length > 0 && <span className="muted">needs: {c.permissions.join(', ')}</span>}
        </div>
      </div>
      <div>{c.available ? <span className="chip ok">Available</span> : <span className="chip" title={c.unavailableReason ?? ''}>Off</span>}</div>
    </div>
  );
}
