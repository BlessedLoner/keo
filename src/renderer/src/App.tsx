import { useEffect } from 'react';
import { invoke } from './lib/api';
import { Icon } from './components/Icon';
import { KeoEmblem, STATE_LABEL } from './components/KeoEmblem';
import { useApp, type ViewId } from './state/AppState';
import { CapabilitiesView } from './views/CapabilitiesView';
import { ChatView } from './views/ChatView';
import { DiagnosticsView } from './views/DiagnosticsView';
import { MemoryView } from './views/MemoryView';
import { ProjectsView } from './views/ProjectsView';
import { SettingsView } from './views/SettingsView';
import { TasksView } from './views/TasksView';
import { VisionView } from './views/VisionView';

const NAV: Array<{ id: ViewId; label: string; icon: string; key: string }> = [
  { id: 'chat', label: 'Chat', icon: 'chat', key: '1' },
  { id: 'tasks', label: 'Tasks', icon: 'tasks', key: '2' },
  { id: 'memory', label: 'Memory', icon: 'memory', key: '3' },
  { id: 'projects', label: 'Projects', icon: 'projects', key: '4' },
  { id: 'vision', label: 'Vision', icon: 'vision', key: '5' },
  { id: 'capabilities', label: 'Access', icon: 'shield', key: '6' },
];

export function App() {
  const app = useApp();

  // Ctrl+1..8 navigation.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey) return;
      const all = [...NAV, { id: 'settings' as ViewId, key: '7' }, { id: 'diagnostics' as ViewId, key: '8' }];
      const hit = all.find((n) => n.key === e.key);
      if (hit) {
        e.preventDefault();
        app.setView(hit.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);

  const provider = app.activeProvider;
  const providerChip = !provider ? (
    <button className="chip warn" onClick={() => app.setView('settings')}>
      <span className="dot" /> No model provider configured
    </button>
  ) : provider.status.kind === 'ready' ? (
    <button className={`chip ${provider.id === 'test' ? 'violet' : 'ok'}`} onClick={() => app.setView('settings')} title={`Requests go to ${provider.destination}`}>
      <span className="dot" /> {provider.id === 'test' ? 'Test provider (not an AI model)' : `${provider.label} · ${provider.selectedModel}`}
    </button>
  ) : (
    <button className="chip warn" onClick={() => app.setView('settings')} title={provider.status.reason}>
      <span className="dot" /> {provider.label}: needs setup
    </button>
  );

  return (
    <div className="app">
      <div className="titlebar">
        <div className="brand">
          <KeoEmblem state={app.emblem} size={24} />
          KEO <small>{STATE_LABEL[app.emblem]}</small>
        </div>
        <div className="spacer" />
        <TitleControls />
        {providerChip}
      </div>
      <nav className="rail" aria-label="Main">
        {NAV.map((n) => (
          <RailButton key={n.id} id={n.id} label={n.label} icon={n.icon} shortcut={`Ctrl+${n.key}`} badge={badgeFor(n.id, app)} />
        ))}
        <div className="grow" />
        <RailButton id="diagnostics" label="Diagnose" icon="pulse" shortcut="Ctrl+8" />
        <RailButton id="settings" label="Settings" icon="settings" shortcut="Ctrl+7" />
      </nav>
      <main className="main">
        {app.view === 'chat' && <ChatView />}
        {app.view === 'tasks' && <TasksView />}
        {app.view === 'memory' && <MemoryView />}
        {app.view === 'projects' && <ProjectsView />}
        {app.view === 'vision' && <VisionView />}
        {app.view === 'capabilities' && <CapabilitiesView />}
        {app.view === 'settings' && <SettingsView />}
        {app.view === 'diagnostics' && <DiagnosticsView />}
      </main>
    </div>
  );
}

/** Command bar shortcut and a stop control that is visible whenever Keo is active. */
function TitleControls() {
  const app = useApp();
  const p = app.presence;
  const s = app.settings.data;
  const busy = !!p && p.state !== 'idle' && p.state !== 'cancelled';
  return (
    <div className="row" style={{ gap: 6, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {busy && (
        <button className="chip danger" onClick={() => void invoke('presence:stopAll')} title="Stop replies, pending actions and navigation permissions">
          <Icon name="stop" size={12} /> Stop
        </button>
      )}
      {p?.wake.enabled && (
        <button className={`chip ${p.wake.muted ? 'warn' : 'accent'}`} onClick={() => void invoke('wake:setMuted', { muted: !p.wake.muted })} title={p.wake.message ?? 'Wake word'}>
          <Icon name="mic" size={12} /> {p.wake.muted ? 'Mic muted' : p.wake.status === 'listening' ? `“${p.wake.phrase}”` : p.wake.status}
        </button>
      )}
      <button className="chip" onClick={() => void invoke('commandBar:show')} title="Open the command bar">
        <Icon name="chat" size={12} /> {s?.shortcuts.commandBarEnabled ? s.shortcuts.commandBar.replace('Control', 'Ctrl') : 'Command bar'}
      </button>
    </div>
  );
}

function badgeFor(id: ViewId, app: ReturnType<typeof useApp>): { n: number; tone: 'warn' | 'info' } | null {
  if (id === 'tasks' && app.pendingApprovals + app.uncertainTasks > 0) return { n: app.pendingApprovals + app.uncertainTasks, tone: 'warn' };
  if (id === 'memory' && app.proposedMemories > 0) return { n: app.proposedMemories, tone: 'info' };
  return null;
}

function RailButton({ id, label, icon, shortcut, badge }: { id: ViewId; label: string; icon: string; shortcut: string; badge?: { n: number; tone: 'warn' | 'info' } | null }) {
  const app = useApp();
  return (
    <button aria-current={app.view === id ? 'page' : undefined} onClick={() => app.setView(id)} title={`${label} (${shortcut})`}>
      <Icon name={icon} size={20} />
      {label}
      {badge && (
        <span className={`badge ${badge.tone === 'info' ? 'info' : ''}`} aria-label={`${badge.n} pending`}>
          {badge.n > 99 ? '99+' : badge.n}
        </span>
      )}
    </button>
  );
}
