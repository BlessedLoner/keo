import type { AgentEvent, LiveChatSession, NavigationGrant, PhotoIndexState, Presence, UpdateDownload, VideoToolsSetup } from '../shared/domain';
import type { InvokeChannel, InvokeInput, InvokeOutputs, IpcResult, PushChannel } from '../shared/ipc';

export interface PushPayloads {
  'agent:event': AgentEvent;
  'tasks:changed': { taskId: string | null };
  'memory:changed': { memoryId: string | null };
  'projects:changed': { projectId: string | null };
  'builds:changed': { buildId: string | null };
  'conversations:changed': { conversationId: string | null };
  'observations:changed': { observationId: string | null };
  'settings:changed': Record<string, never>;
  'presence:changed': Presence;
  'presence:command': PresenceCommand;
  'grants:changed': { grants: NavigationGrant[] };
  'livechat:changed': { sessions: LiveChatSession[] };
  'update:changed': UpdateDownload;
  'results:changed': { id: string };
  'visual:show': { at: number };
  'video:changed': { id: string };
  'video:setupChanged': VideoToolsSetup;
  'files:photosChanged': PhotoIndexState;
  'jobs:changed': Record<string, never>;
  'schedule:changed': Record<string, never>;
  /** The real voice level (microphone or playback), relayed from the main window to Keo's bar and Keo mode. */
  'presence:level': { level: number; source: 'mic' | 'playback' | null };
  'account:changed': import('../shared/cloud').AccountStatus;
  'app:switching': { mode: 'account' | 'local' | 'signed-out' };
  'app:recovered': { message: string };
  'studio:job': { jobId: string; job: import('../shared/studio').RenderJob };
  'studio:changed': import('../shared/studio').Project;
  /** Watching Keo edit: the step Keo is about to make, or 'done' when its edit has been shown. */
  /** Keo is about to work on this project: Studio opens it. */
  'studio:show': { projectId: string };
  /** Keo asks the user something in Studio: a question with answers to click, and maybe its edit plan. */
  'studio:ask': import('../shared/studio').StudioAsk;
  /** An AI shot fal.ai finished (or failed) after Keo stopped waiting for it. */
  'studio:aiShot': { projectId: string; state: 'waiting' | 'ready' | 'failed'; message: string };
  'studio:dna': { job: import('../shared/editDna').DnaJob | null; library: boolean; download?: { name: string; bytes: number; total: number | null; done: boolean } | null };
  'studio:keoAction': { projectId: string; kind: 'cut' | 'split' | 'trim' | 'move' | 'delete' | 'add' | 'captions' | 'change' | 'project' | 'done'; label?: string; at?: number; end?: number; clips?: string[]; index: number; total: number };
  'studio:progress': { projectId: string; stage: 'sound' | 'video' | 'saving' | 'done' | 'failed' | 'checklist'; done?: number; total?: number; file?: string; error?: string; steps?: Array<{ label: string; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; note?: string }> };
}

/** Instructions from the main process to a window (never from page content). */
export type PresenceCommand =
  | { type: 'stop_speaking' }
  | { type: 'record_command' }
  | { type: 'focus_input' }
  | { type: 'results_open' }
  | { type: 'video_open' }
  | { type: 'pencil_heard'; text: string | null; reason: string; listening: boolean }
  | { type: 'navigate'; view: string }
  | { type: 'transcript'; text: string; conversationId: string | null }
  | { type: 'listen_result'; reason: string }
  | { type: 'announce'; text: string }
  | { type: 'voice_listen'; id: string }
  | { type: 'voice_say'; id: string; text: string; queue?: boolean }
  | { type: 'voice_cancel' };

export interface KeoBridge {
  invoke<C extends InvokeChannel>(channel: C, input?: InvokeInput<C>): Promise<IpcResult<InvokeOutputs[C]>>;
  on<P extends PushChannel>(channel: P, listener: (payload: PushPayloads[P]) => void): () => void;
  /** Where a file the user dropped is on their PC (null: not a file from the PC). */
  pathForFile(file: File): string | null;
}

declare global {
  interface Window {
    keo: KeoBridge;
  }
}
