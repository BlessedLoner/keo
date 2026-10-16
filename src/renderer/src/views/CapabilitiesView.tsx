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

  const enableWithConfirm = async (key: 'observationEnabled' | 'desktopControlEnabled' | 'launchEnabled', on: boolean, what: string) => {
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

            <div className="section-title">Screen-content export</div>
            <div className="card stack">
              <p className="muted small" style={{ margin: 0 }}>
                Screenshots are analysed by the active model provider. Allow each destination explicitly; local models keep images on this computer.
              </p>
              {(['anthropic', 'openai', 'local'] as const).map((p) => (
                <Toggle key={p} checked={s.permissions.visionExport[p]} onChange={(v) => void patch({ permissions: { visionExport: { [p]: v } } })} label={`Allow sending window captures to ${p === 'local' ? 'the local model server' : p === 'anthropic' ? 'Anthropic' : 'OpenAI'}`} />
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

const PERMISSION_TEXT = {
  observationEnabled: 'Keo will be able to list windows of applications you allow-list and, with your approval, capture them. Captures are stored locally under the retention policy.',
  desktopControlEnabled: 'Keo will be able to propose keyboard, mouse and window actions in allow-listed applications. Each action shows a preview and runs only after you approve it.',
  launchEnabled: 'Keo will be able to propose starting applications from your launch list. Each launch requires approval.',
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
  return (
    <>
      <div className="section-title">Allowed applications</div>
      <div className="card">
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
              {a.id} · {a.path}
            </span>
            <button className="btn ghost sm" style={{ marginLeft: 'auto' }} onClick={() => void patch({ permissions: { launchableApps: s.permissions.launchableApps.filter((x) => x.id !== a.id) } })}>
              Remove
            </button>
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => void add()}>
          <Icon name="plus" size={14} /> Add application…
        </button>
      </div>
    </>
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
