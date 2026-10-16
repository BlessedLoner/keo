import { useEffect, useState } from 'react';
import type { ExportProviderId, Observation, WindowTarget } from '@shared/domain';
import { Icon } from '../components/Icon';
import { Empty, ErrorBanner, Toggle, ViewHeader, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { exact, timeAgo } from '../lib/format';
import { useInvoke } from '../lib/hooks';
import { useApp } from '../state/AppState';

export function VisionView() {
  const app = useApp();
  const ui = useUi();
  const s = app.settings.data;
  const [showAll, setShowAll] = useState(false);
  const windows = useInvoke('desktop:listWindows', { includeAll: showAll }, { refreshOn: ['settings:changed'] });
  const obs = useInvoke('vision:list', { limit: 50 }, { refreshOn: ['observations:changed'] });
  const [capturing, setCapturing] = useState<string | null>(null);

  const allow = async (w: WindowTarget) => {
    if (!s) return;
    const name = w.processName;
    if (!name) return ui.error('This window’s process name could not be read, so it cannot be allow-listed.');
    const ok = await ui.confirm({
      title: `Allow Keo to work with ${name}?`,
      body: 'Allow-listed applications can be observed and — only if Desktop control is enabled and you approve each action — controlled by Keo. You can remove it at any time in Access.',
      confirmLabel: 'Allow',
    });
    if (!ok) return;
    await invoke('settings:update', { patch: { permissions: { allowedApps: [...s.permissions.allowedApps, { processName: name, label: name }] } } }).catch((e) => ui.error(errText(e)));
    void windows.refresh();
  };

  const capture = async (w: WindowTarget) => {
    setCapturing(w.hwnd);
    try {
      await invoke('vision:capture', { hwnd: w.hwnd, pid: w.pid });
      ui.toast(`Captured ${w.processName}`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setCapturing(null);
    }
  };

  const enabled = !!s?.permissions.observationEnabled;
  return (
    <div className="view">
      <ViewHeader title="Vision" subtitle="Capture a single allow-listed window and ask the model about it. Keo never falls back to capturing your whole screen.">
        <button className="btn" onClick={() => void windows.refresh()}>
          <Icon name="retry" size={14} /> Refresh windows
        </button>
      </ViewHeader>
      <div className="view-body">
        {!enabled && (
          <div className="banner warn" style={{ marginBottom: 14 }}>
            <Icon name="shield" size={16} />
            <div className="grow">Window observation is off. Turn it on to list windows of allow-listed apps and capture them.</div>
            <button className="btn sm" onClick={() => void invoke('settings:update', { patch: { permissions: { observationEnabled: true } } }).catch((e) => ui.error(errText(e)))}>
              Enable observation
            </button>
          </div>
        )}
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>
            Windows
          </div>
          <Toggle checked={showAll} onChange={setShowAll} label={<span className="small">Show all windows (to choose apps to allow)</span>} />
        </div>
        <ErrorBanner error={windows.error} onRetry={() => void windows.refresh()} />
        {windows.data && !windows.data.supported && <div className="banner danger">{windows.data.reason}</div>}
        {windows.data?.reason && windows.data.supported && <p className="muted small">{windows.data.reason}</p>}
        {windows.loading && !windows.data && (
          <div className="row muted small">
            <span className="spinner" /> Reading windows…
          </div>
        )}
        {windows.data?.supported && windows.data.windows.length === 0 && !windows.data.reason && (
          <p className="muted small">{showAll ? 'No windows found.' : 'No windows from allow-listed apps are open. Turn on “Show all windows” to allow an app.'}</p>
        )}
        <div className="windows-grid">
          {(windows.data?.windows ?? []).map((w) => (
            <div className="win-card" key={w.hwnd}>
              <div className="row">
                <Icon name="window" size={16} />
                <strong className="t" title={w.title}>
                  {w.title}
                </strong>
              </div>
              <div className="small muted">
                {w.processName || 'unknown process'} · pid {w.pid} · {w.bounds.width}×{w.bounds.height}
                {w.minimized && ' · minimized'}
              </div>
              <div className="row">
                {w.allowed ? (
                  <>
                    <span className="chip ok">Allowed</span>
                    <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={!enabled || capturing === w.hwnd || w.minimized} title={w.minimized ? 'Restore the window first' : 'Capture this window now'} onClick={() => void capture(w)}>
                      {capturing === w.hwnd ? <span className="spinner" /> : <Icon name="camera" size={14} />} Capture
                    </button>
                  </>
                ) : (
                  <button className="btn sm" onClick={() => void allow(w)}>
                    Allow this app
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="section-title">Observations</div>
        <p className="muted small" style={{ marginTop: -4 }}>
          Images are kept for {s?.privacy.observationRetentionHours ?? 24} h (Settings → Privacy), then deleted; capture metadata remains for provenance.
        </p>
        <ErrorBanner error={obs.error} />
        {obs.data && obs.data.length === 0 && <Empty icon="camera" title="No observations yet">Captured windows appear here with their capture time and identity.</Empty>}
        {(obs.data ?? []).map((o) => (
          <ObservationCard key={o.id} o={o} />
        ))}
      </div>
    </div>
  );
}

function ObservationCard({ o }: { o: Observation }) {
  const ui = useUi();
  const app = useApp();
  const [img, setImg] = useState<string | null>(null);
  const [imgReason, setImgReason] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('Describe what is shown in this window.');
  const [busy, setBusy] = useState(false);
  const analyses = useInvoke('vision:analyses', { observationId: o.id }, { refreshOn: ['observations:changed'] });
  useEffect(() => {
    if (!o.hasImage) return;
    let live = true;
    invoke('vision:image', { id: o.id }).then(
      (r) => {
        if (!live) return;
        setImg(r.dataUrl);
        setImgReason(r.reason);
      },
      (e) => live && setImgReason(errText(e)),
    );
    return () => {
      live = false;
    };
  }, [o.id, o.hasImage]);
  const provider = app.activeProvider;
  const exportOk = provider ? provider.id === 'test' || (app.settings.data?.permissions.visionExport[provider.id as ExportProviderId] ?? false) : false;
  const visionModel = provider?.models.find((m) => m.id === provider.selectedModel)?.capabilities.vision ?? false;

  const analyze = async () => {
    if (!provider) return;
    const ok = await ui.confirm({
      title: 'Send this screenshot for analysis?',
      body: (
        <>
          The image of <strong>{o.target.processName}</strong> captured {exact(o.capturedAt)} will be sent to <strong>{provider.destination}</strong>.
        </>
      ),
      confirmLabel: 'Send',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await invoke('vision:analyze', { observationId: o.id, prompt });
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="obs">
      <div className="thumb">{img ? <img src={img} alt={`Capture of ${o.target.title}`} /> : <span>{o.hasImage ? (imgReason ?? 'Loading…') : 'Image removed by retention policy'}</span>}</div>
      <div className="stack" style={{ minWidth: 0 }}>
        <div className="row">
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.target.title}</strong>
          <span className="chip">{o.initiatedBy === 'user' ? 'Captured by you' : 'Captured by an approved task'}</span>
        </div>
        <div className="small muted">
          {o.target.processName} · window {o.target.hwnd} · {o.width}×{o.height} · {timeAgo(o.capturedAt)} ({exact(o.capturedAt)})
        </div>
        <div className="small muted mono" title="SHA-256 of the captured image">
          sha256 {o.sha256.slice(0, 24)}…
        </div>
        {(analyses.data ?? []).map((a) => (
          <div className="analysis" key={a.id}>
            <div className="small muted">
              {a.providerId}/{a.model} · {timeAgo(a.createdAt)} · “{a.prompt}”
            </div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{a.result}</div>
          </div>
        ))}
        {o.hasImage && (
          <div className="row">
            <input className="input" aria-label="Question about this capture" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <button className="btn" disabled={busy || !provider || !exportOk || !visionModel || !prompt.trim()} onClick={() => void analyze()}>
              {busy ? <span className="spinner" /> : <Icon name="vision" size={14} />} Analyze
            </button>
          </div>
        )}
        {o.hasImage && provider && (!exportOk || !visionModel) && (
          <div className="small" style={{ color: 'var(--warn)' }}>
            {!visionModel ? `${provider.selectedModel || 'The selected model'} is not declared as vision-capable.` : `Sending screen content to ${provider.label} is not enabled (Access → Screen-content export).`}
          </div>
        )}
        <div className="row">
          <button
            className="btn ghost sm"
            style={{ marginLeft: 'auto' }}
            onClick={async () => {
              if (await ui.confirm({ title: 'Delete observation?', body: 'The image, metadata and analyses are removed.', confirmLabel: 'Delete', danger: true })) {
                await invoke('vision:delete', { id: o.id }).catch((e) => ui.error(errText(e)));
              }
            }}
          >
            <Icon name="trash" size={13} /> Delete
          </button>
        </div>
      </div>
    </article>
  );
}
