import { useState } from 'react';
import { Icon } from '../components/Icon';
import { ErrorBanner, ViewHeader } from '../components/ui';
import { useInvoke } from '../lib/hooks';

export function DiagnosticsView() {
  const [tab, setTab] = useState<'events' | 'audit'>('events');
  const info = useInvoke('app:info', {});
  const logs = useInvoke('diagnostics:logs', { limit: 300 }, { enabled: tab === 'events', pollMs: 4000 });
  const audit = useInvoke('diagnostics:audit', { limit: 300 }, { enabled: tab === 'audit', refreshOn: ['tasks:changed', 'settings:changed', 'memory:changed'] });
  const i = info.data;
  return (
    <div className="view">
      <ViewHeader title="Diagnostics" subtitle="Structured, privacy-filtered events. Conversation text, prompts, screenshots, audio and keys are never logged.">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>
            Events
          </button>
          <button role="tab" aria-selected={tab === 'audit'} onClick={() => setTab('audit')}>
            Audit trail
          </button>
        </div>
      </ViewHeader>
      <div className="view-body">
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
        {tab === 'events' ? (
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
