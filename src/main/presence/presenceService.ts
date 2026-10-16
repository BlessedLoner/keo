import type { AgentEvent, AgentPhase, Presence, PresenceState } from '../../shared/domain';
import type { CapabilityRegistry } from '../capabilities/registry';
import type { StepActivity } from '../tasks/orchestrator';

export interface VoiceReport {
  speaking: boolean;
  recording: boolean;
  transcribing: boolean;
}

type WakeStatus = Presence['wake'];

/**
 * Single source of truth for what Keo is doing *right now*, derived only from
 * real events (turn phases, step execution/verification, approvals, audio
 * playback/recording, the wake-word listener). The main window, the floating
 * companion and the command bar all render from this — none of them invents
 * a state of its own.
 */
export class PresenceService {
  private readonly turns = new Map<string, AgentPhase>();
  private readonly steps = new Map<string, { capabilityId: string; phase: 'executing' | 'verifying'; app: string | null }>();
  private voice: VoiceReport = { speaking: false, recording: false, transcribing: false };
  private wake: WakeStatus = { enabled: false, listening: false, muted: false, status: 'off', message: null, phrase: null };
  private approvals: { count: number; first: { capabilityId: string; app: string | null } | null } = { count: 0, first: null };
  private grants = 0;
  private transient: { state: 'cancelled' | 'error'; until: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = '';
  private readonly listeners = new Set<(p: Presence) => void>();

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(fn: (p: Presence) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // -- inputs -------------------------------------------------------------------

  agentEvent(e: AgentEvent): void {
    if (e.type === 'turn_started') this.turns.set(e.conversationId, 'thinking');
    else if (e.type === 'phase') {
      if (this.turns.has(e.conversationId)) this.turns.set(e.conversationId, e.phase);
    } else if (e.type === 'turn_finished') {
      this.turns.delete(e.conversationId);
      if (e.message.status === 'error') this.flash('error', 5000);
      if (e.message.status === 'cancelled') this.flash('cancelled', 2500);
    }
    this.schedule();
  }

  stepActivity(a: StepActivity, app: string | null): void {
    if (a.phase === 'done') this.steps.delete(a.stepId);
    else this.steps.set(a.stepId, { capabilityId: a.capabilityId, phase: a.phase, app });
    this.schedule();
  }

  setApprovals(count: number, first: { capabilityId: string; app: string | null } | null): void {
    this.approvals = { count, first };
    this.schedule();
  }

  setGrants(n: number): void {
    this.grants = n;
    this.schedule();
  }

  reportVoice(v: VoiceReport): void {
    this.voice = { ...v };
    this.schedule();
  }

  get speaking(): boolean {
    return this.voice.speaking;
  }

  setWake(w: Partial<WakeStatus>): void {
    this.wake = { ...this.wake, ...w };
    this.schedule();
  }

  flash(state: 'cancelled' | 'error', ms: number): void {
    this.transient = { state, until: this.now() + ms };
    this.schedule();
    setTimeout(() => this.schedule(), ms + 30).unref?.();
  }

  // -- output -------------------------------------------------------------------

  private title(capabilityId: string): string {
    return this.registry.get(capabilityId)?.title ?? 'Working';
  }

  get(): Presence {
    const t = this.now();
    if (this.transient && this.transient.until <= t) this.transient = null;
    const phases = [...this.turns.values()];
    const stepList = [...this.steps.values()];
    const verifying = stepList.find((s) => s.phase === 'verifying');
    const executing = stepList.find((s) => s.phase === 'executing');
    const label = (cap: string, app: string | null) => `${this.title(cap)}${app ? ` · ${app}` : ''}`;
    let state: PresenceState = 'idle';
    let activity: string | null = null;
    if (this.transient?.state === 'error') {
      state = 'error';
      activity = 'Something went wrong — see Keo';
    } else if (this.approvals.count > 0) {
      state = 'awaiting_approval';
      activity = this.approvals.first ? `Needs your approval: ${label(this.approvals.first.capabilityId, this.approvals.first.app)}` : 'Needs your approval';
    } else if (this.voice.recording || this.wake.status === 'capturing') {
      state = 'listening';
      activity = 'Listening…';
    } else if (this.voice.speaking) {
      state = 'speaking';
      activity = 'Speaking';
    } else if (verifying) {
      state = 'verifying';
      activity = `Verifying: ${label(verifying.capabilityId, verifying.app)}`;
    } else if (executing) {
      state = 'acting';
      activity = label(executing.capabilityId, executing.app);
    } else if (phases.includes('tool')) {
      state = 'acting';
      activity = 'Working';
    } else if (phases.includes('planning')) {
      state = 'planning';
      activity = 'Planning';
    } else if (phases.includes('gathering_context')) {
      state = 'understanding';
      activity = 'Gathering context';
    } else if (phases.length > 0 || this.voice.transcribing) {
      state = 'understanding';
      activity = this.voice.transcribing ? 'Transcribing' : 'Understanding your request';
    } else if (this.transient?.state === 'cancelled') {
      state = 'cancelled';
      activity = 'Stopped';
    }
    return {
      state,
      activity,
      pendingApprovals: this.approvals.count,
      activeTurns: this.turns.size,
      runningSteps: this.steps.size,
      wake: { ...this.wake },
      grants: this.grants,
      updatedAt: new Date(t).toISOString(),
    };
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const p = this.get();
      const key = JSON.stringify({ ...p, updatedAt: '' });
      if (key === this.last) return;
      this.last = key;
      for (const l of this.listeners) l(p);
    }, 40);
    this.timer.unref?.();
  }

  /** Forget turn/step state (e.g. after cancelling everything). */
  resetActivity(): void {
    this.turns.clear();
    this.steps.clear();
    this.schedule();
  }
}
