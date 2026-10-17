import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';
import { SPEECH_HELPER_SCRIPT } from './speechScript';
import { learnableVariants, matchWake, normWords, soundKey, usableLearned } from './wakeMatch';

export type SpeechEvent =
  | { event: 'ready' }
  | { event: 'listening' }
  | { event: 'paused' }
  | { event: 'wake'; phrase: string; confidence: number }
  | { event: 'wake_rejected'; confidence: number }
  | { event: 'heard'; grammar: string | null; text: string | null; confidence: number; alts: string[] }
  | { event: 'silent_input' }
  | { event: 'capturing'; id?: string }
  | { event: 'level'; level: number }
  | { event: 'command'; text: string; confidence: number; id?: string }
  | { event: 'command_none'; reason: string; id?: string }
  | { event: 'capture_cancelled'; id?: string }
  | { event: 'capture_error'; message: string; code?: string; id?: string }
  | { event: 'quality'; problem: string }
  | { event: 'testing' }
  | { event: 'test_result'; recognized: boolean; confidence: number; heardSomething: boolean; text?: string | null; alts?: string[]; grammar?: string | null }
  | { event: 'recognizers'; list: Array<{ culture: string; name: string }> }
  | { event: 'error'; code: string; message?: string };

/** Engine boundary so tests can drive the service without a microphone. */
export interface SpeechEngine {
  start(onEvent: (e: SpeechEvent) => void, onExit: (code: number | null) => void): Promise<void>;
  send(cmd: Record<string, unknown>): void;
  stop(): void;
}

export class PowerShellSpeechEngine implements SpeechEngine {
  private proc: ChildProcessWithoutNullStreams | null = null;
  constructor(private readonly runtimeDir: string) {}

  start(onEvent: (e: SpeechEvent) => void, onExit: (code: number | null) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('Windows only'));
      fs.mkdirSync(this.runtimeDir, { recursive: true });
      const file = path.join(this.runtimeDir, 'keo-speech-helper.ps1');
      fs.writeFileSync(file, `\ufeff${SPEECH_HELPER_SCRIPT}`, 'utf8');
      const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const p = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: 'pipe' });
      this.proc = p;
      let ready = false;
      const t = setTimeout(() => !ready && reject(new Error('Speech helper did not start in time.')), 30000);
      readline.createInterface({ input: p.stdout }).on('line', (line) => {
        let e: SpeechEvent;
        try {
          e = JSON.parse(line.replace(/^\ufeff/, '')) as SpeechEvent;
        } catch {
          return;
        }
        if (e.event === 'ready' && !ready) {
          ready = true;
          clearTimeout(t);
          resolve();
        }
        onEvent(e);
      });
      p.on('exit', (code) => {
        clearTimeout(t);
        this.proc = null;
        if (!ready) reject(new Error('Speech helper exited during start.'));
        onExit(code);
      });
    });
  }

  send(cmd: Record<string, unknown>): void {
    this.proc?.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  stop(): void {
    try {
      this.proc?.stdin.end();
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

/** Validates a user-defined wake phrase. Returns an error message or null. */
export function validateWakePhrase(raw: string): string | null {
  const p = raw.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}' -]+$/u.test(p)) return 'Use letters only (no digits or symbols).';
  const words = p.split(' ');
  if (words.length < 2 || words.length > 4) return 'Use 2–4 words, e.g. “Hey Keo”.';
  if (p.length < 6 || p.length > 40) return 'Use 6–40 characters.';
  if (/^(ok|okay|yes|no|hello|hi|thanks|thank you|stop|go)( (ok|okay|yes|no))?$/i.test(p)) return 'That phrase is too common in normal speech.';
  return null;
}

export interface WakeState {
  status: 'off' | 'starting' | 'listening' | 'capturing' | 'error' | 'unavailable';
  message: string | null;
}

/**
 * Wake-word and local dictation service. Listening runs only when the user
 * enabled it and is not muted; it pauses while Keo speaks (so Keo cannot wake
 * itself) and while a command is being captured.
 */
export class WakeService {
  private started = false;
  private state: WakeState = { status: 'off', message: null };
  private muted = false;
  private pausedForSpeech = false;
  private pendingCapture: ((r: { text: string | null; reason: string }) => void) | null = null;
  /** Id of the running capture; events of older captures (late or duplicate) are ignored. */
  private captureId: string | null = null;
  private captureSeq = 0;
  private captureTimer: NodeJS.Timeout | null = null;
  /** Automatic restarts of a crashed speech helper (recent timestamps, bounded). */
  private restarts: number[] = [];
  /** Whether the helper really runs wake listening right now (the shown status stays "listening" while paused for speech). */
  private helperListening = false;
  private speakingSince = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private healing = false;
  private pendingTest: ((r: { recognized: boolean; confidence: number; heardSomething: boolean; text: string | null; alts: string[]; grammar?: string | null }) => void) | null = null;
  private lastHeardNote = 0;
  /** Engine preference the running helper was started with (switching restarts it). */
  private enginePref: string | null = null;
  /** Voice mode is running: the wake listener stays paused (captures still work). */
  private voicePaused = false;
  private resumeTimer: NodeJS.Timeout | null = null;
  private lastWakeAt = 0;
  private recognizerCache: Array<{ culture: string; name: string }> | null = null;
  private pendingRecognizers: Array<(l: Array<{ culture: string; name: string }>) => void> = [];

  constructor(
    private readonly engine: SpeechEngine,
    private readonly getSettings: () => Settings,
    private readonly log: Logger,
    private readonly handlers: { onWake(phrase: string, rest: string): void; onState(s: WakeState & { muted: boolean }): void; onLevel?(level: number): void },
  ) {}

  private set(s: WakeState): void {
    this.state = s;
    this.handlers.onState({ ...s, muted: this.muted });
  }

  getState(): WakeState & { muted: boolean } {
    return { ...this.state, muted: this.muted };
  }

  /** Which engine runs ("modern"/"classic") and why the modern one was not used, if it wasn't. */
  engineInfo(): { kind: string | null; fallbackReason: string | null } {
    const e = this.engine as { kind?: string | null; fallbackReason?: string | null };
    return { kind: e.kind ?? null, fallbackReason: e.fallbackReason ?? null };
  }

  private async ensure(): Promise<boolean> {
    const pref = this.getSettings().wake.engine;
    if (this.started && this.enginePref !== null && pref !== this.enginePref) {
      this.engine.stop();
      this.started = false;
      this.recognizerCache = null; // each engine has its own languages
    }
    if (this.started) return true;
    this.enginePref = pref;
    this.set({ status: 'starting', message: null });
    try {
      await this.engine.start(
        (e) => this.onEvent(e),
        (code) => {
          this.started = false;
          this.helperListening = false;
          this.log.warn('wake.helper_exit', { code });
          this.finishCapture({ text: null, reason: 'helper_exited' });
          // Restart on its own (a few times per 10 minutes) so the wake word stays ready.
          const now = Date.now();
          this.restarts = this.restarts.filter((t) => now - t < 10 * 60_000);
          if (this.state.status !== 'off' && this.restarts.length < 5) {
            this.restarts.push(now);
            this.set({ status: 'starting', message: 'Restarting speech recognition…' });
            setTimeout(() => void this.apply(), 1500 * this.restarts.length).unref?.();
          } else if (this.state.status !== 'off') this.set({ status: 'error', message: 'The speech helper keeps stopping. Toggle the wake word to try again.' });
        },
      );
      this.started = true;
      return true;
    } catch (e) {
      this.set({ status: 'unavailable', message: `Local speech recognition is unavailable: ${(e as Error).message}` });
      return false;
    }
  }

  /** Applies current settings: starts, restarts or stops wake listening. */
  async apply(): Promise<void> {
    const w = this.getSettings().wake;
    if (this.voicePaused) return;
    if (!w.enabled || this.muted) {
      if (this.started) this.sendPause();
      this.set({ status: 'off', message: this.muted ? 'Microphone muted.' : null });
      return;
    }
    this.startWatchdog();
    if (!(await this.ensure())) return;
    if (this.pausedForSpeech) return;
    this.engine.send({ cmd: 'wake', phrases: this.grammarPhrases(), culture: w.culture, threshold: w.sensitivity });
  }

  /** Voice mode on/off: pause wake listening during the conversation, resume afterwards. */
  setVoiceMode(active: boolean): void {
    this.voicePaused = active;
    if (active) {
      if (this.started && this.state.status === 'listening') this.sendPause();
    } else void this.apply();
  }

  setMuted(m: boolean): Promise<void> {
    this.muted = m;
    if (m) this.cancelCapture();
    this.log.info('wake.muted', { muted: m });
    return this.apply();
  }

  /** Keo is speaking: stop listening so playback can never trigger a wake. */
  setSpeaking(speaking: boolean): void {
    if (speaking) {
      if (!this.pausedForSpeech) this.speakingSince = Date.now();
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      if (!this.pausedForSpeech && this.state.status === 'listening') this.sendPause();
      this.pausedForSpeech = true;
    } else if (this.pausedForSpeech) {
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      this.resumeTimer = setTimeout(() => {
        this.pausedForSpeech = false;
        void this.apply();
      }, 1200);
    }
  }

  /** Records one spoken command locally (after the wake phrase, mic button or Ctrl+K). */
  async capture(): Promise<{ text: string | null; reason: string }> {
    if (this.muted) return { text: null, reason: 'muted' };
    if (!(await this.ensure())) return { text: null, reason: this.state.message ?? 'unavailable' };
    // A newer request wins over a capture still running (it is cancelled, never left blocking).
    if (this.pendingCapture) this.cancelCapture();
    const w = this.getSettings().wake;
    const maxMs = 20000;
    const id = `c${++this.captureSeq}`;
    return new Promise((resolve) => {
      this.pendingCapture = resolve;
      this.captureId = id;
      // Watchdog: a helper that never answers must not block listening.
      this.captureTimer = setTimeout(() => {
        if (this.captureId !== id) return;
        this.log.warn('wake.capture_timeout', {});
        this.engine.send({ cmd: 'cancel_capture' });
        this.finishCapture({ text: null, reason: 'timeout' });
        void this.apply();
      }, maxMs + 15000);
      this.captureTimer.unref?.();
      this.engine.send({ cmd: 'capture', id, culture: w.culture, initialMs: 6000, endMs: 1100, maxMs });
    });
  }

  /** Stops a running capture right away (its late events are ignored). */
  cancelCapture(): void {
    if (!this.pendingCapture) return;
    this.engine.send({ cmd: 'cancel_capture' });
    this.finishCapture({ text: null, reason: 'cancelled' });
    if (this.state.status === 'capturing') this.set({ status: this.getSettings().wake.enabled && !this.muted ? 'listening' : 'off', message: null });
  }

  private finishCapture(r: { text: string | null; reason: string }): void {
    if (this.captureTimer) clearTimeout(this.captureTimer);
    this.captureTimer = null;
    const p = this.pendingCapture;
    this.pendingCapture = null;
    this.captureId = null;
    p?.(r);
  }

  /** Speech recognizers installed in Windows (queried from the helper, then cached). */
  async recognizers(): Promise<Array<{ culture: string; name: string }>> {
    if (this.recognizerCache) return this.recognizerCache;
    if (!(await this.ensure())) return [];
    return new Promise((resolve) => {
      this.pendingRecognizers.push(resolve);
      this.engine.send({ cmd: 'recognizers' });
    });
  }

  /** The phrases plus the learned versions of the user's voice, as recognizer grammar. */
  private grammarPhrases(): string[] {
    const w = this.getSettings().wake;
    return [...new Set([...w.phrases, ...usableLearned(w.learned, w.phrases)].map((p) => normWords(p).join(' ')).filter((p) => p.length >= 4))];
  }

  /** Listens once and reports whether Keo would have woken up, and what it heard. */
  async testPhrase(phrase: string, seconds = 8): Promise<{ recognized: boolean; confidence: number; heardSomething: boolean; heard: string | null; how: string | null }> {
    if (!(await this.ensure())) throw new Error(this.state.message ?? 'Speech recognition unavailable');
    const w = this.getSettings().wake;
    const r = await new Promise<{ recognized: boolean; confidence: number; heardSomething: boolean; text: string | null; alts: string[] }>((resolve) => {
      this.pendingTest = resolve;
      this.engine.send({ cmd: 'test', phrases: [...new Set([phrase, ...w.learned])], culture: w.culture, seconds });
    });
    const m = r.text ? matchWake([r.text, ...r.alts], [phrase], w.learned) : null;
    const ok = (r.recognized && r.confidence >= w.sensitivity) || !!m;
    return { recognized: ok, confidence: r.confidence, heardSomething: r.heardSomething, heard: r.text, how: m?.how ?? (ok ? 'exact' : null) };
  }

  /**
   * "Teach Keo your voice": the user says their phrase; whatever the
   * recognizer makes of it (best reading and alternates) is remembered as a
   * version of the phrase. Returns what was heard and what was added.
   */
  async learnSample(phrase: string): Promise<{ heard: string | null; added: string[]; alreadyRecognized: boolean }> {
    if (!(await this.ensure())) throw new Error(this.state.message ?? 'Speech recognition unavailable');
    const w = this.getSettings().wake;
    const r = await new Promise<{ recognized: boolean; confidence: number; heardSomething: boolean; text: string | null; alts: string[]; grammar?: string | null }>((resolve) => {
      this.pendingTest = resolve;
      // Dictation competes with the phrase, so a mispronounced phrase comes back as what it sounded like.
      this.engine.send({ cmd: 'test', phrases: [phrase], culture: w.culture, seconds: 8 });
    });
    if (!r.text) return { heard: null, added: [], alreadyRecognized: false };
    const confident = r.grammar === 'wake' && r.confidence >= w.sensitivity;
    const readings = r.grammar === 'wake' ? r.alts.filter((a) => normWords(a).join(' ') !== normWords(phrase).join(' ')) : [r.text, ...r.alts];
    const added = confident ? [] : learnableVariants(readings.slice(0, 3), phrase, w.learned).slice(0, 3);
    return { heard: r.text, added, alreadyRecognized: confident };
  }

  private onEvent(e: SpeechEvent): void {
    switch (e.event) {
      case 'listening':
        this.helperListening = true;
        this.set({ status: 'listening', message: null });
        break;
      case 'paused':
        this.helperListening = false;
        if (this.state.status === 'listening') this.set({ status: this.muted ? 'off' : 'listening', message: this.pausedForSpeech ? 'Paused while Keo speaks.' : null });
        break;
      case 'wake':
        this.woke(e.phrase, '', 'exact', e.confidence);
        break;
      case 'heard': {
        // Not a confident exact hit: does it sound like the phrase (or a learned version of it)?
        const w = this.getSettings().wake;
        const readings = [e.text ?? '', ...(e.alts ?? [])].filter(Boolean);
        const m = matchWake(readings, w.phrases, w.learned);
        if (m) {
          this.woke(m.phrase, m.rest, m.how, e.confidence);
          break;
        }
        // Tell the user about near misses only (something starting like the phrase) — never other speech.
        const first = normWords(w.phrases[0] ?? '')[0] ?? '';
        const heardFirst = normWords(e.text ?? '')[0] ?? '';
        const near = e.grammar === 'wake' || (!!first && soundKey(first) === soundKey(heardFirst));
        if (near && Date.now() - this.lastHeardNote > 4000) {
          this.lastHeardNote = Date.now();
          this.set({ status: 'listening', message: `Heard “${(e.text ?? '').slice(0, 40)}” — not quite your wake phrase. Use “Teach Keo your voice” in Settings so Keo learns how you say it.` });
        }
        break;
      }
      case 'wake_rejected':
        this.log.debug('wake.rejected_low_confidence', { confidence: e.confidence });
        break;
      case 'quality': {
        const tip: Record<string, string> = {
          TooQuiet: 'Your voice is very quiet — speak up or move closer to the microphone.',
          TooLoud: 'The microphone is too loud — lower its level in Windows sound settings.',
          TooNoisy: 'It is noisy around you; Keo may miss the wake phrase.',
          TooFast: 'Speak a little slower so Keo can catch the wake phrase.',
          TooSlow: 'Speak a little faster.',
          NoSignal: 'No audio is reaching Keo. Check the microphone and Windows Settings → Privacy → Microphone (allow desktop apps).',
        };
        const m = tip[e.problem];
        if (m && Date.now() - this.lastHeardNote > 8000) {
          this.lastHeardNote = Date.now();
          this.set({ status: this.state.status, message: m });
        }
        break;
      }
      case 'silent_input':
        this.set({ status: 'listening', message: 'No audio is reaching Keo. Check the microphone and Windows Settings → Privacy → Microphone (allow desktop apps).' });
        break;
      case 'capturing':
        if (e.id && e.id !== this.captureId) break;
        this.helperListening = false;
        this.set({ status: 'capturing', message: null });
        break;
      case 'level':
        this.handlers.onLevel?.(Math.max(0, Math.min(1, e.level / 100)));
        break;
      case 'command':
      case 'command_none':
      case 'capture_cancelled':
      case 'capture_error': {
        if (e.id && e.id !== this.captureId) {
          this.log.info('wake.capture_stale_event', { event: e.event });
          break;
        }
        const r =
          e.event === 'command'
            ? { text: e.text.trim(), reason: 'ok' }
            : { text: null, reason: e.event === 'command_none' ? e.reason : e.event === 'capture_error' ? (e.code && ['online_speech_off', 'no_microphone', 'no_recognizer'].includes(e.code) ? e.code : 'error') : 'cancelled' };
        this.log.info('wake.capture_done', { reason: r.reason, chars: r.text?.length ?? 0 });
        this.finishCapture(r);
        void this.apply(); // back to wake listening (if enabled)
        if (this.state.status === 'capturing') this.set({ status: this.getSettings().wake.enabled && !this.muted ? 'listening' : 'off', message: null });
        break;
      }
      case 'recognizers':
        this.recognizerCache = e.list;
        for (const r of this.pendingRecognizers.splice(0)) r(e.list);
        break;
      case 'test_result':
        this.pendingTest?.({ recognized: e.recognized, confidence: e.confidence, heardSomething: e.heardSomething, text: e.text ?? null, alts: e.alts ?? [], grammar: e.grammar ?? null });
        this.pendingTest = null;
        void this.apply();
        break;
      case 'error': {
        const msg =
          e.code === 'no_microphone'
            ? 'No microphone is available (or Windows blocks microphone access for desktop apps).'
            : e.code === 'no_recognizer'
              ? `No Windows speech recognizer is installed for ${this.getSettings().wake.culture}. Install the language's speech pack in Windows Settings → Time & language → Speech.`
              : e.code === 'online_speech_off'
                ? 'Windows “Online speech recognition” is off, so free dictation is unavailable. Turn it on in Windows Settings → Privacy & security → Speech, or choose OpenAI transcription for commands.'
                : (e.message ?? e.code);
        this.log.warn('wake.error', { code: e.code });
        this.helperListening = false;
        this.set({ status: 'error', message: msg });
        this.finishCapture({ text: null, reason: e.code });
        this.pendingTest?.({ recognized: false, confidence: 0, heardSomething: false, text: null, alts: [] });
        this.pendingTest = null;
        break;
      }
      default:
        break;
    }
  }

  private woke(phrase: string, rest: string, how: string, confidence: number): void {
    const now = Date.now();
    if (now - this.lastWakeAt < 2500) return; // debounce double detections
    this.lastWakeAt = now;
    this.log.info('wake.detected', { how, confidence, withCommand: rest.length > 0 });
    if (this.state.message) this.set({ status: this.state.status, message: null });
    this.handlers.onWake(phrase, rest);
  }

  /**
   * Self-healing: every few seconds, if wake listening should be on but the
   * helper is not listening (a failed restart after a conversation, a lost
   * "finished speaking" signal, an error), it is started again — so the wake
   * word works without touching the mic button.
   */
  private sendPause(): void {
    this.helperListening = false;
    this.engine.send({ cmd: 'pause' });
  }

  private startWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => void this.heal(), 5000);
    this.watchdog.unref?.();
  }

  /** Exposed for tests. */
  async heal(): Promise<void> {
    const w = this.getSettings().wake;
    if (this.healing || !w.enabled || this.muted || this.voicePaused || this.pendingCapture || this.pendingTest) return;
    // Keo speaks for at most a couple of minutes; a pause older than that lost its "done" signal.
    if (this.pausedForSpeech && Date.now() - this.speakingSince > 120_000) {
      this.log.warn('wake.speaking_pause_expired', {});
      this.pausedForSpeech = false;
    }
    if (this.pausedForSpeech || this.helperListening || this.state.status === 'starting') return;
    this.healing = true;
    try {
      this.log.info('wake.heal', { status: this.state.status });
      await this.apply();
    } finally {
      this.healing = false;
    }
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.helperListening = false;
    this.engine.stop();
    this.started = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.set({ status: 'off', message: null });
  }
}
