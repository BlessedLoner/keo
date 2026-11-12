import { useState } from 'react';
import { Icon } from '../components/Icon';
import { ErrorBanner, ViewHeader } from '../components/ui';
import { useInvoke } from '../lib/hooks';
import { ReportProblem } from '../components/ReportProblem';

export function DiagnosticsView() {
  const [tab, setTab] = useState<'activity' | 'speed' | 'events' | 'audit'>('activity');
  const [reporting, setReporting] = useState(false);
  const info = useInvoke('app:info', {});
  const logs = useInvoke('diagnostics:logs', { limit: 300 }, { enabled: tab === 'events', pollMs: 4000 });
  const audit = useInvoke('diagnostics:audit', { limit: 300 }, { enabled: tab === 'audit', refreshOn: ['tasks:changed', 'settings:changed', 'memory:changed'] });
  const activity = useInvoke('diagnostics:activity', { limit: 200 }, { enabled: tab === 'activity', refreshOn: ['tasks:changed', 'settings:changed'] });
  const speed = useInvoke('diagnostics:speed', { days: 7 }, { enabled: tab === 'speed' });
  const i = info.data;
  return (
    <div className="view">
      <ViewHeader title="Diagnostics" subtitle="Structured, privacy-filtered events. Conversation text, prompts, screenshots, audio and keys are never logged.">
        <button className="btn sm" onClick={() => setReporting(true)} title="Tell the Keo team about a problem">
          <Icon name="warn" size={13} /> Report a problem
        </button>
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'activity'} onClick={() => setTab('activity')}>
            Activity
          </button>
          <button role="tab" aria-selected={tab === 'speed'} onClick={() => setTab('speed')}>
            Speed
          </button>
          <button role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>
            Events
          </button>
          <button role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
            Audit trail
          </button>
        </div>
      </ViewHeader>
      <div className="view-body">
        {reporting && <ReportProblem onClose={() => setReporting(false)} />}
        {i && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="row wrap small">
              <span className="chip">
                {i.name} {i.version}
              </span>
              <span className="chip">profile: {i.profile}</span>
              <span className="chip">schema v{i.schemaVersion}</span>
              <span className={`chip ${i.secretStorage === 'os-encrypted' ? 'ok' : 'danger'}`}>secrets: {i.secretStorage}</span>
              <span className="chip">Electron {i.electron}</span>
              <span className="chip">Node {i.node}</span>
              <span className="chip">{i.platform}</span>
              {i.testProviderEnabled && <span className="chip violet">test provider enabled</span>}
              {!i.packaged && <span className="chip warn">development build</span>}
            </div>
            <div className="mono muted" style={{ marginTop: 8 }}>
              <Icon name="folder" size={12} /> {i.userDataPath}
            </div>
          </div>
        )}
        {tab === 'activity' ? (
          <>
            <ErrorBanner error={activity.error} />
            <p className="small muted" style={{ marginTop: 0 }}>
              What Keo did, what you approved or declined, and what cost credits, newest first.
            </p>
            {(activity.data ?? []).length === 0 && !activity.loading && <p className="muted">Nothing yet.</p>}
            {(activity.data ?? []).map((a) => (
              <div key={a.id} className={`activity-line tone-${a.tone}`}>
                <span className="muted small">{new Date(a.ts).toLocaleString()}</span>
                <span>
                  {a.text}
                  {a.times > 1 && <span className="muted"> ×{a.times}</span>}
                </span>
              </div>
            ))}
          </>
        ) : tab === 'speed' ? (
          <>
            <ErrorBanner error={speed.error} />
            <p className="small muted" style={{ marginTop: 0 }}>
              How fast each AI model answered over the last 7 days. Typical: half of the answers were faster than this; slow: one in ten took longer.
            </p>
            {(speed.data ?? []).length === 0 && !speed.loading && <p className="muted">No AI answers in the last 7 days.</p>}
            {(speed.data ?? []).length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Answers</th>
                    <th>Typical</th>
                    <th>Slow</th>
                    <th>Words in / out</th>
                  </tr>
                </thead>
                <tbody>
                  {(speed.data ?? []).map((m) => (
                    <tr key={`${m.providerId}|${m.model}`}>
                      <td>
                        {m.model} <span className="muted small">· {m.providerId}</span>
                      </td>
                      <td>{m.calls}</td>
                      <td>{m.medianMs ? `${(m.medianMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td>{m.slowMs ? `${(m.slowMs / 1000).toFixed(1)} s` : '—'}</td>
                      <td className="muted small">
                        ~{Math.round((m.inputTokens * 0.75) / 1000)}k / ~{Math.round((m.outputTokens * 0.75) / 1000)}k
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : tab === 'events' ? (
          <>
            <ErrorBanner error={logs.error} />
            {(logs.data ?? []).map((l, n) => (
              <div className="log-line" key={`${l.ts}-${n}`}>
                <span className="muted">{new Date(l.ts).toLocaleTimeString()}</span>
                <span className={`lv-${l.level}`}>{l.level}</span>
                <span>{l.event}</span>
                <span className="data">
                  {l.data ? JSON.stringify(l.data) : ''}
                  {l.correlationId ? ` · ${l.correlationId}` : ''}
                </span>
              </div>
            ))}
          </>
        ) : (
          <>
            <ErrorBanner error={audit.error} />
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Kind</th>
                  <th>Decision</th>
                  <th>Capability</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {(audit.data ?? []).map((a) => (
                  <tr key={a.id}>
                    <td className="muted small">{new Date(a.ts).toLocaleString()}</td>
                    <td className="mono">{a.kind}</td>
                    <td>{a.decision}</td>
                    <td className="mono">{a.capabilityId ?? '—'}</td>
                    <td className="mono muted" style={{ wordBreak: 'break-all' }}>
                      {JSON.stringify(a.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}
