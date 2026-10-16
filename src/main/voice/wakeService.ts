import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';
import { SPEECH_HELPER_SCRIPT } from './speechScript';

export type SpeechEvent =
  | { event: 'ready' }
  | { event: 'listening' }
  | { event: 'paused' }
  | { event: 'wake'; phrase: string; confidence: number }
  | { event: 'wake_rejected'; confidence: number }
  | { event: 'silent_input' }
  | { event: 'capturing' }
  | { event: 'level'; level: number }
  | { event: 'command'; text: string; confidence: number }
  | { event: 'command_none'; reason: string }
  | { event: 'capture_cancelled' }
  | { event: 'capture_error'; message: string }
  | { event: 'testing' }
  | { event: 'test_result'; recognized: boolean; confidence: number; heardSomething: boolean }
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
  private pendingTest: ((r: { recognized: boolean; confidence: number; heardSomething: boolean }) => void) | null = null;
  private resumeTimer: NodeJS.Timeout | null = null;
  private lastWakeAt = 0;
  private recognizerCache: Array<{ culture: string; name: string }> | null = null;
  private pendingRecognizers: Array<(l: Array<{ culture: string; name: string }>) => void> = [];

  constructor(
    private readonly engine: SpeechEngine,
    private readonly getSettings: () => Settings,
    private readonly log: Logger,
    private readonly handlers: { onWake(phrase: string): void; onState(s: WakeState & { muted: boolean }): void; onLevel?(level: number): void },
  ) {}

  private set(s: WakeState): void {
    this.state = s;
    this.handlers.onState({ ...s, muted: this.muted });
  }

  getState(): WakeState & { muted: boolean } {
    return { ...this.state, muted: this.muted };
  }

  private async ensure(): Promise<boolean> {
    if (this.started) return true;
    this.set({ status: 'starting', message: null });
    try {
      await this.engine.start(
        (e) => this.onEvent(e),
        (code) => {
          this.started = false;
          this.log.warn('wake.helper_exit', { code });
          if (this.state.status !== 'off') this.set({ status: 'error', message: 'The speech helper stopped. Toggle the wake word to restart it.' });
          this.pendingCapture?.({ text: null, reason: 'helper_exited' });
          this.pendingCapture = null;
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
    if (!w.enabled || this.muted) {
      if (this.started) this.engine.send({ cmd: 'pause' });
      this.set({ status: 'off', message: this.muted ? 'Microphone muted.' : null });
      return;
    }
    if (!(await this.ensure())) return;
    if (this.pausedForSpeech) return;
    this.engine.send({ cmd: 'wake', phrases: w.phrases, culture: w.culture, threshold: w.sensitivity });
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
      if (this.resumeTimer) clearTimeout(this.resumeTimer);
      if (!this.pausedForSpeech && this.state.status === 'listening') this.engine.send({ cmd: 'pause' });
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
    if (this.pendingCapture) return { text: null, reason: 'busy' };
    const w = this.getSettings().wake;
    return new Promise((resolve) => {
      this.pendingCapture = resolve;
      this.engine.send({ cmd: 'capture', culture: w.culture, initialMs: 6000, endMs: 1100, maxMs: 20000 });
    });
  }

  cancelCapture(): void {
    if (this.pendingCapture) this.engine.send({ cmd: 'cancel_capture' });
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

  async testPhrase(phrase: string, seconds = 8): Promise<{ recognized: boolean; confidence: number; heardSomething: boolean }> {
    if (!(await this.ensure())) throw new Error(this.state.message ?? 'Speech recognition unavailable');
    const w = this.getSettings().wake;
    return new Promise((resolve) => {
      this.pendingTest = resolve;
      this.engine.send({ cmd: 'test', phrases: [phrase], culture: w.culture, seconds });
    });
  }

  private onEvent(e: SpeechEvent): void {
    switch (e.event) {
      case 'listening':
        this.set({ status: 'listening', message: null });
        break;
      case 'paused':
        if (this.state.status === 'listening') this.set({ status: this.muted ? 'off' : 'listening', message: this.pausedForSpeech ? 'Paused while Keo speaks.' : null });
        break;
      case 'wake': {
        const now = Date.now();
        if (now - this.lastWakeAt < 2500) break; // debounce double detections
        this.lastWakeAt = now;
        this.log.info('wake.detected', { confidence: e.confidence });
        this.handlers.onWake(e.phrase);
        break;
      }
      case 'wake_rejected':
        this.log.debug('wake.rejected_low_confidence', { confidence: e.confidence });
        break;
      case 'silent_input':
        this.set({ status: 'listening', message: 'No audio is reaching Keo. Check the microphone and Windows Settings → Privacy → Microphone (allow desktop apps).' });
        break;
      case 'capturing':
        this.set({ status: 'capturing', message: null });
        break;
      case 'level':
        this.handlers.onLevel?.(Math.max(0, Math.min(1, e.level / 100)));
        break;
      case 'command':
      case 'command_none':
      case 'capture_cancelled':
      case 'capture_error': {
        const r =
          e.event === 'command'
            ? { text: e.text.trim(), reason: 'ok' }
            : { text: null, reason: e.event === 'command_none' ? e.reason : e.event === 'capture_error' ? 'error' : 'cancelled' };
        this.log.info('wake.capture_done', { reason: r.reason, chars: r.text?.length ?? 0 });
        this.pendingCapture?.(r);
        this.pendingCapture = null;
        void this.apply(); // back to wake listening (if enabled)
        if (this.state.status === 'capturing') this.set({ status: this.getSettings().wake.enabled && !this.muted ? 'listening' : 'off', message: null });
        break;
      }
      case 'recognizers':
        this.recognizerCache = e.list;
        for (const r of this.pendingRecognizers.splice(0)) r(e.list);
        break;
      case 'test_result':
        this.pendingTest?.(e);
        this.pendingTest = null;
        void this.apply();
        break;
      case 'error': {
        const msg =
          e.code === 'no_microphone'
            ? 'No microphone is available (or Windows blocks microphone access for desktop apps).'
            : e.code === 'no_recognizer'
              ? `No Windows speech recognizer is installed for ${this.getSettings().wake.culture}. Install the language's speech pack in Windows Settings → Time & language → Speech.`
              : (e.message ?? e.code);
        this.log.warn('wake.error', { code: e.code });
        this.set({ status: 'error', message: msg });
        this.pendingCapture?.({ text: null, reason: e.code });
        this.pendingCapture = null;
        this.pendingTest?.({ recognized: false, confidence: 0, heardSomething: false });
        this.pendingTest = null;
        break;
      }
      default:
        break;
    }
  }

  stop(): void {
    this.engine.stop();
    this.started = false;
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.set({ status: 'off', message: null });
  }
}
