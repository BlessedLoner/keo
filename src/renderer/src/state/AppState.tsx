import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentEvent, ProviderInfo, Task } from '@shared/domain';
import type { Settings } from '@shared/settings';
import type { EmblemState } from '../components/KeoEmblem';
import { subscribe } from '../lib/api';
import { useInvoke, type Query } from '../lib/hooks';
import { voice, type VoiceState } from '../lib/voice';

export type ViewId = 'chat' | 'tasks' | 'memory' | 'projects' | 'vision' | 'capabilities' | 'settings' | 'diagnostics';

export interface TurnInfo {
  messageId: string;
  phase: 'thinking' | 'generating' | 'tool' | 'waiting_approval';
}

interface AppStateValue {
  view: ViewId;
  setView(v: ViewId): void;
  conversationId: string | null;
  setConversationId(id: string | null): void;
  settings: Query<Settings>;
  providers: Query<ProviderInfo[]>;
  tasks: Query<Task[]>;
  proposedMemories: number;
  turns: Record<string, TurnInfo>;
  voice: VoiceState;
  emblem: EmblemState;
  pendingApprovals: number;
  uncertainTasks: number;
  runningTasks: number;
  activeProvider: ProviderInfo | null;
}

const Ctx = createContext<AppStateValue | null>(null);

export function useApp(): AppStateValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppStateProvider missing');
  return v;
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<ViewId>('chat');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const settings = useInvoke('settings:get', {}, { refreshOn: ['settings:changed'] });
  const providers = useInvoke('providers:list', {}, { refreshOn: ['settings:changed'] });
  const tasks = useInvoke('tasks:list', { limit: 200 }, { refreshOn: ['tasks:changed'] });
  const proposals = useInvoke('memory:list', { status: 'proposed' }, { refreshOn: ['memory:changed'] });
  const [turns, setTurns] = useState<Record<string, TurnInfo>>({});
  const [errorUntil, setErrorUntil] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>(voice.get());
  const [, tick] = useState(0);

  useEffect(() => voice.subscribe(setVoiceState), []);

  useEffect(
    () =>
      subscribe('agent:event', (e: AgentEvent) => {
        setTurns((cur) => {
          switch (e.type) {
            case 'turn_started':
              return { ...cur, [e.conversationId]: { messageId: e.messageId, phase: 'thinking' } };
            case 'phase':
              return cur[e.conversationId] ? { ...cur, [e.conversationId]: { messageId: e.messageId, phase: e.phase } } : cur;
            case 'turn_finished': {
              const next = { ...cur };
              delete next[e.conversationId];
              return next;
            }
            default:
              return cur;
          }
        });
        if (e.type === 'turn_finished' && e.message.status === 'error') {
          setErrorUntil(Date.now() + 5000);
          window.setTimeout(() => tick((n) => n + 1), 5100);
        }
      }),
    [],
  );

  // Reduced-motion preference.
  const motion = settings.data?.ui.reducedMotion ?? 'system';
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('motion-reduce', motion === 'reduce');
    el.classList.toggle('motion-full', motion === 'full');
  }, [motion]);

  const taskList = tasks.data ?? [];
  const pendingApprovals = taskList.reduce((n, t) => n + t.steps.filter((s) => s.state === 'awaiting_authorization').length, 0) + taskList.filter((t) => t.state === 'proposed').length;
  const uncertainTasks = taskList.filter((t) => t.state === 'outcome_uncertain').length;
  const runningTasks = taskList.filter((t) => t.state === 'running').length;
  const anyTurn = Object.values(turns);

  // Priority: error > approval/uncertain > listening > speaking > working > thinking > idle.
  let emblem: EmblemState = 'idle';
  if (Date.now() < errorUntil) emblem = 'error';
  else if (pendingApprovals > 0 || uncertainTasks > 0) emblem = 'attention';
  else if (voiceState.recording) emblem = 'listening';
  else if (voiceState.speaking) emblem = 'speaking';
  else if (runningTasks > 0 || anyTurn.some((t) => t.phase === 'tool')) emblem = 'working';
  else if (anyTurn.length > 0 || voiceState.transcribing) emblem = 'thinking';

  const activeId = settings.data?.activeProvider ?? null;
  const activeProvider = (providers.data ?? []).find((p) => p.id === activeId) ?? null;

  const value = useMemo<AppStateValue>(
    () => ({
      view,
      setView,
      conversationId,
      setConversationId,
      settings,
      providers,
      tasks,
      proposedMemories: proposals.data?.length ?? 0,
      turns,
      voice: voiceState,
      emblem,
      pendingApprovals,
      uncertainTasks,
      runningTasks,
      activeProvider,
    }),
    [view, conversationId, settings, providers, tasks, proposals.data, turns, voiceState, emblem, pendingApprovals, uncertainTasks, runningTasks, activeProvider],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
