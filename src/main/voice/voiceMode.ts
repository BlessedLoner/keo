import type { Message, Task } from '../../shared/domain';
import type { Logger } from '../logging/logger';
import type { AuditRepo } from '../repos/audit';
import type { TaskOrchestrator } from '../tasks/orchestrator';
import { transcriptLooksWrong } from '../agent/language';

export type VoiceModeState = 'off' | 'listening' | 'thinking' | 'speaking' | 'confirming';

export interface VoiceModeView {
  active: boolean;
  state: VoiceModeState;
  /** Last thing the user said (shown as a caption). */
  heard: string | null;
  /** Last thing Keo said. */
  said: string | null;
}

export interface VoiceModeDeps {
  /** Records one utterance (local engine or the renderer's recorder); null text on silence. */
  listen(): Promise<{ text: string | null; reason: string }>;
  /** Speaks and resolves when finished. */
  speak(text: string): Promise<void>;
  /** Sends a user message to the conversation; resolves with Keo's reply. */
  send(text: string): { done: Promise<Message> } | null;
  conversationId(): string;
  tasks: TaskOrchestrator;
  audit: AuditRepo;
  log: Logger;
  /** Pause/resume the wake listener while the conversation runs. */
  pauseWake(paused: boolean): void;
  /** Bring Keo's window up (for approvals that must be clicked). */
  showApprovals(): void;
  changed(v: VoiceModeView): void;
}

const STOP = /^\s*(ok(ay)?[,.\s]+)?(stop|that'?s all|that is all|that'?ll be all|goodbye|bye|good ?night|thanks?,? keo|thank you,? keo|never ?mind|cancel|go to sleep|we'?re done|i'?m done)\b/i;
const YES = /\b(yes|yeah|yep|yup|sure|ok(ay)?|go ahead|do it|approve|approved|please do|confirm|correct|send it)\b/i;
const NO = /\b(no|nope|don'?t|do not|cancel|stop|deny|wait|not now)\b/i;

const TRANSIENT = new Set(['error', 'timeout', 'helper_exited', 'busy']);

/** What to say when listening failed (never a raw error code). */
function listenProblem(reason: string): string {
  if (reason === 'no_microphone') return 'I can’t reach a microphone. Check that one is connected and that Windows allows desktop apps to use it.';
  if (reason === 'no_recognizer') return 'Windows speech recognition isn’t installed for your language. You can add it in Windows speech settings, or use OpenAI transcription in Keo’s settings.';
  if (reason === 'muted') return 'The microphone is muted in Keo.';
  if (TRANSIENT.has(reason)) return 'I’m having trouble hearing you right now. Say the wake word to try again.';
  return reason.length > 20 ? reason : 'I couldn’t listen just now. Say the wake word to try again.';
}

/** Plain, speakable text: no Markdown, code or URLs; long answers end with a pointer to the screen. */
export function spokenVersion(md: string, max = 600): string {
  const t = md
    .replace(/```[\s\S]*?```/g, ' (code is on screen) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_>|~]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return `${end > 200 ? cut.slice(0, end + 1) : cut}… The rest is on screen.`;
}

/**
 * Hands-free conversation ("voice mode"): after the wake word Keo keeps
 * listening, answers out loud and listens again — until the user says stop,
 * stays silent twice, or presses Stop. Approvals can be given by voice
 * ("yes"/"no"), except actions that must always be approved on screen.
 */
export class VoiceMode {
  private view: VoiceModeView = { active: false, state: 'off', heard: null, said: null };
  private session = 0;

  constructor(private readonly d: VoiceModeDeps) {}

  get(): VoiceModeView {
    return { ...this.view };
  }

  isActive(): boolean {
    return this.view.active;
  }

  private set(p: Partial<VoiceModeView>): void {
    this.view = { ...this.view, ...p };
    this.d.changed(this.get());
  }

  /** Starts a conversation; `first` is a command already spoken with the wake phrase. */
  start(first?: string): void {
    if (this.view.active) {
      // Already talking: treat a new wake as "listen now".
      if (first) void this.handle(this.session, first);
      return;
    }
    const session = ++this.session;
    this.set({ active: true, state: 'listening', heard: null, said: null });
    this.d.pauseWake(true);
    this.d.audit.record({ kind: 'voice.mode', decision: 'started', detail: { withCommand: !!first } });
    void this.loop(session, first?.trim() || null).catch((e) => {
      this.d.log.warn('voice.mode_failed', { error: (e as Error).message });
      this.stop('error');
    });
  }

  stop(reason = 'stopped'): void {
    if (!this.view.active) return;
    this.session++;
    this.set({ active: false, state: 'off' });
    this.d.pauseWake(false);
    this.d.audit.record({ kind: 'voice.mode', decision: 'ended', detail: { reason } });
  }

  private alive(session: number): boolean {
    return this.view.active && session === this.session;
  }

  private async loop(session: number, first: string | null): Promise<void> {
    let pending = first;
    let quiet = 0;
    let hiccups = 0;
    while (this.alive(session)) {
      let text = pending;
      pending = null;
      if (!text) {
        this.set({ state: 'listening' });
        const r = await this.d.listen();
        if (!this.alive(session)) return;
        text = r.text?.trim() || null;
        if (!text) {
          const quietReason = r.reason === 'silence' || r.reason === 'no_speech' || r.reason === 'unclear';
          // A hiccup of the recognizer (microphone briefly busy, helper restarting) is retried twice.
          if (!quietReason && TRANSIENT.has(r.reason) && hiccups++ < 2) {
            await new Promise((res) => setTimeout(res, 600));
            continue;
          }
          if (++quiet >= 2 || !quietReason) {
            if (!quietReason && r.reason !== 'cancelled') await this.say(session, listenProblem(r.reason));
            return this.stop(r.reason);
          }
          continue;
        }
      }
      quiet = 0;
      hiccups = 0;
      if (STOP.test(text)) {
        this.set({ heard: text });
        await this.say(session, 'Okay.');
        return this.stop('user_stop');
      }
      if (transcriptLooksWrong(text)) {
        // Probably misheard (another language or gibberish): ask again instead of answering it.
        this.set({ heard: text });
        this.d.audit.record({ kind: 'voice.mode', decision: 'unclear_transcript', detail: { words: text.split(/\s+/).length } });
        await this.say(session, 'Sorry, I didn’t catch that. Could you say it again?');
        continue;
      }
      await this.handle(session, text);
    }
  }

  private async handle(session: number, text: string): Promise<void> {
    this.set({ heard: text, state: 'thinking' });
    const sent = this.d.send(text);
    if (!sent) {
      await this.say(session, 'I am still working on the last request.');
      return;
    }
    const asked = new Set<string>();
    const reply = await this.awaitTurn(session, sent.done, asked);
    if (!this.alive(session)) return;
    // Actions still waiting for approval after the reply: ask now (instead of reading out "waiting for approval").
    let decided = false;
    for (let pa = this.pendingApproval(asked); pa && this.alive(session); pa = this.pendingApproval(asked)) {
      asked.add(pa.step.id);
      const approved = await this.confirm(session, pa.task, pa.step);
      decided = true;
      if (approved) await this.reportOutcome(session, pa.task.id, pa.step.id);
    }
    if (decided || !this.alive(session)) return;
    const spoken = reply && reply.status !== 'error' ? spokenVersion(reply.content) : 'Sorry, something went wrong. The details are on screen.';
    if (spoken) await this.say(session, spoken);
  }

  /** After a voice approval: wait briefly for the action and say how it went. */
  private async reportOutcome(session: number, taskId: string, stepId: string): Promise<void> {
    const until = Date.now() + 60_000;
    while (Date.now() < until && this.alive(session)) {
      const st = this.d.tasks.get(taskId)?.steps.find((x) => x.id === stepId);
      if (!st) return;
      if (st.state === 'succeeded') return this.say(session, st.verification === 'verification_failed' ? 'It ran, but the result did not check out. Details are on screen.' : 'Done.');
      if (st.state === 'failed') return this.say(session, `That didn’t work: ${spokenVersion(st.error ?? 'unknown error', 200)}`);
      if (st.state === 'outcome_uncertain') return this.say(session, 'I’m not sure that went through. Please check it on screen.');
      if (st.state === 'cancelled' || st.state === 'denied') return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Waits for Keo's reply, handling approvals for this conversation by voice meanwhile. */
  private async awaitTurn(session: number, done: Promise<Message>, asked: Set<string>): Promise<Message | null> {
    let finished: Message | null = null;
    let settled = false;
    done.then(
      (m) => {
        finished = m;
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    while (!settled && this.alive(session)) {
      const step = this.pendingApproval(asked);
      if (step) {
        asked.add(step.step.id);
        await this.confirm(session, step.task, step.step);
      } else await new Promise((r) => setTimeout(r, 250));
    }
    return finished;
  }

  private pendingApproval(asked: Set<string>): { task: Task; step: Task['steps'][number] } | null {
    const conv = this.d.conversationId();
    for (const t of this.d.tasks.list(30)) {
      if (t.conversationId !== conv) continue;
      for (const s of t.steps) if (s.state === 'awaiting_authorization' && !asked.has(s.id)) return { task: t, step: s };
    }
    return null;
  }

  /** Asks for one approval by voice; true when approved. */
  private async confirm(session: number, task: Task, step: Task['steps'][number]): Promise<boolean> {
    const what = step.preview.summary;
    if (step.preview.autoTier === 'critical') {
      this.d.showApprovals();
      await this.say(session, `${what}. This one needs your approval on screen.`);
      return false;
    }
    this.set({ state: 'confirming' });
    for (let attempt = 0; attempt < 2 && this.alive(session); attempt++) {
      await this.say(session, attempt === 0 ? `I need your OK to ${lowerFirst(what)}. Shall I?` : 'Please say yes or no.');
      this.set({ state: 'confirming' });
      const r = await this.d.listen();
      const a = r.text?.trim() ?? '';
      const current = this.d.tasks.get(task.id)?.steps.find((s) => s.id === step.id);
      if (!current || current.state !== 'awaiting_authorization') return current?.state === 'ready' || current?.state === 'running' || current?.state === 'succeeded'; // decided elsewhere meanwhile
      if (a && NO.test(a) && !/\bno problem\b/i.test(a)) {
        this.d.tasks.denyStep(step.id);
        this.d.audit.record({ kind: 'voice.mode', decision: 'denied_by_voice', capabilityId: step.capabilityId, taskId: task.id });
        await this.say(session, 'Okay, I won’t.');
        return false;
      }
      if (a && YES.test(a)) {
        this.d.tasks.approveStep(step.id, step.inputHash);
        this.d.audit.record({ kind: 'permission.decision', decision: 'approved_by_voice', capabilityId: step.capabilityId, taskId: task.id });
        this.set({ state: 'thinking' });
        return true;
      }
    }
    this.d.showApprovals();
    await this.say(session, 'I’ll leave it for you to approve on screen.');
    return false;
  }

  private async say(session: number, text: string): Promise<void> {
    if (!this.alive(session) || !text) return;
    this.set({ state: 'speaking', said: text });
    try {
      await this.d.speak(text);
    } catch (e) {
      this.d.log.warn('voice.speak_failed', { error: (e as Error).message });
    }
  }
}

const lowerFirst = (s: string) => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
