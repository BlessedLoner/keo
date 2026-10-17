import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentEvent, AgentPhase, Presence, ProviderInfo, Task } from '@shared/domain';
import { emblemFor, usePresence, useVoiceReporting } from '../lib/presence';
import type { Settings } from '@shared/settings';
import type { EmblemState } from '../components/KeoEmblem';
import { invoke, subscribe } from '../lib/api';
import { useInvoke, type Query } from '../lib/hooks';
import { voice, type VoiceState } from '../lib/voice';

export type ViewId = 'chat' | 'tasks' | 'memory' | 'projects' | 'vision' | 'capabilities' | 'settings' | 'diagnostics';

export interface TurnInfo {
  messageId: string;
  phase: AgentPhase;
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
  presence: Presence | null;
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
  const [voiceState, setVoiceState] = useState<VoiceState>(voice.get());
  const presence = usePresence();
  useVoiceReporting();
  useEffect(
    () =>
      subscribe('presence:command', (c) => {
        if (c.type === 'navigate' && (c.view === 'chat' || c.view === 'tasks' || c.view === 'settings')) setView(c.view);
      }),
    [],
  );
  const voiceSettings = settings.data?.voice;
  // Voice mode: this (main) window records and speaks for the main process, even while hidden.
  useEffect(
    () =>
      subscribe('presence:command', (c) => {
        const vs = voiceSettings;
        if (c.type === 'voice_listen') {
          void voice
            .start({ autoStop: true })
            .then((text) => invoke('voice:done', { id: c.id, text: text ?? null, reason: text ? 'ok' : voice.get().error ? 'error' : 'silence' }))
            .catch(() => invoke('voice:done', { id: c.id, text: null, reason: 'error' }).catch(() => undefined));
        } else if (c.type === 'voice_say') {
          void voice
            .speakAndWait(c.text, vs?.ttsEngine ?? 'system', vs?.systemVoice ?? '')
            .finally(() => void invoke('voice:done', { id: c.id, text: null, reason: 'spoken' }).catch(() => undefined));
        } else if (c.type === 'voice_cancel') {
          voice.abort();
          voice.stopSpeaking();
        }
      }),
    [voiceSettings],
  );
  // Live chat alerts are spoken from the main window only (no duplicates from other windows).
  useEffect(
    () =>
      subscribe('presence:command', (c) => {
        if (c.type !== 'announce' || !voiceSettings?.speakResponses || voiceSettings.ttsEngine === 'none') return;
        void voice.speak(c.text, voiceSettings.ttsEngine, voiceSettings.systemVoice).catch(() => undefined);
      }),
    [voiceSettings],
  );
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

  // The emblem shows the main process's presence (derived from real events only);
  // uncertain outcomes also need the user, so they show as awaiting approval.
  let emblem: EmblemState = emblemFor(presence);
  if (emblem === 'idle' && uncertainTasks > 0) emblem = 'awaiting_approval';

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
      presence,
    }),
    [view, conversationId, settings, providers, tasks, proposals.data, turns, voiceState, emblem, pendingApprovals, uncertainTasks, runningTasks, activeProvider, presence],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
