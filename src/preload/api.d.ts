import type { AgentEvent } from '../shared/domain';
import type { InvokeChannel, InvokeInput, InvokeOutputs, IpcResult, PushChannel } from '../shared/ipc';

export interface PushPayloads {
  'agent:event': AgentEvent;
  'tasks:changed': { taskId: string | null };
  'memory:changed': { memoryId: string | null };
  'projects:changed': { projectId: string | null };
  'conversations:changed': { conversationId: string | null };
  'observations:changed': { observationId: string | null };
  'settings:changed': Record<string, never>;
}

export interface KeoBridge {
  invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<IpcResult<InvokeOutputs[C]>>;
  on<P extends PushChannel>(channel: P, listener: (payload: PushPayloads[P]) => void): () => void;
}

declare global {
  interface Window {
    keo: KeoBridge;
  }
}
