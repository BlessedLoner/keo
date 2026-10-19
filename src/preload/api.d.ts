import type { AgentEvent, LiveChatSession, NavigationGrant, Presence, UpdateDownload } from '../shared/domain';
import type { InvokeChannel, InvokeInput, InvokeOutputs, IpcResult, PushChannel } from '../shared/ipc';

export interface PushPayloads {
  'agent:event': AgentEvent;
  'tasks:changed': { taskId: string | null };
  'memory:changed': { memoryId: string | null };
  'projects:changed': { projectId: string | null };
  'conversations:changed': { conversationId: string | null };
  'observations:changed': { observationId: string | null };
  'settings:changed': Record<string, never>;
  'presence:changed': Presence;
  'presence:command': PresenceCommand;
  'grants:changed': { grants: NavigationGrant[] };
  'livechat:changed': { sessions: LiveChatSession[] };
  'update:changed': UpdateDownload;
  'results:changed': { id: string };
}

/** Instructions from the main process to a window (never from page content). */
export type PresenceCommand =
  | { type: 'stop_speaking' }
  | { type: 'record_command' }
  | { type: 'focus_input' }
  | { type: 'results_open' }
  | { type: 'pencil_heard'; text: string | null; reason: string; listening: boolean }
  | { type: 'navigate'; view: string }
  | { type: 'transcript'; text: string; conversationId: string | null }
  | { type: 'listen_result'; reason: string }
  | { type: 'announce'; text: string }
  | { type: 'voice_listen'; id: string }
  | { type: 'voice_say'; id: string; text: string }
  | { type: 'voice_cancel' };

export interface KeoBridge {
  invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<IpcResult<InvokeOutputs[C]>>;
  on<P extends PushChannel>(channel: P, listener: (payload: PushPayloads[P]) => void): () => void;
}

declare global {
  interface Window {
    keo: KeoBridge;
  }
}
