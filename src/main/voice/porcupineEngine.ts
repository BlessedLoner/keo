import fs from 'node:fs';
import type { SpeechEngine, SpeechEvent } from './wakeService';

/** What the wake listener needs from Porcupine and its recorder (a fake in tests). */
export interface WakeDetector {
  frameLength: number;
  process(frame: Int16Array): number;
  release(): void;
}
export interface FrameSource {
  start(): void;
  read(): Promise<Int16Array>;
  stop(): void;
  release(): void;
}
export interface PorcupineFactory {
  detector(accessKey: string, keywords: string[], sensitivities: number[]): WakeDetector;
  recorder(frameLength: number): FrameSource;
  builtinPath(keyword: string): string;
}

export interface PorcupineConfig {
  enabled: boolean;
  accessKey: string | null;
  /** A trained .ppn file (e.g. "Hey Keo" from Picovoice Console) or a built-in keyword ("jarvis"). */
  keywordPath: string | null;
  builtin: string | null;
  sensitivity: number;
}

/** Porcupine and PvRecorder, loaded only when this engine is used (native modules, unpacked from the asar). */
export function realPorcupine(): PorcupineFactory {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const pv = require('@picovoice/porcupine-node') as typeof import('@picovoice/porcupine-node');
  const rec = require('@picovoice/pvrecorder-node') as typeof import('@picovoice/pvrecorder-node');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    detector: (k, kw, s) => new pv.Porcupine(k, kw, s),
    recorder: (n) => new rec.PvRecorder(n),
    builtinPath: (name) => pv.getBuiltinKeywordPath(name as never),
  };
}

/**
 * A trained wake word: Picovoice Porcupine runs on this PC and listens only
 * for the keyword (no audio leaves the computer, no transcription). Wake
 * detection only — commands, tests and voice teaching stay with the Windows
 * engine underneath, which also takes over if Porcupine cannot start (no or
 * wrong access key, missing model file).
 */
export class PorcupineWakeEngine implements SpeechEngine {
  private onEvent: ((e: SpeechEvent) => void) | null = null;
  private listening = false;
  private gen = 0;
  private detector: WakeDetector | null = null;
  private recorder: FrameSource | null = null;
  private broken: string | null = null;
  private label = 'wake word';

  constructor(
    private readonly inner: SpeechEngine,
    private readonly config: () => PorcupineConfig,
    private readonly factory: () => PorcupineFactory = realPorcupine,
  ) {}

  get kind(): string | null {
    return this.config().enabled && !this.broken ? 'porcupine' : ((this.inner as { kind?: string | null }).kind ?? null);
  }

  get fallbackReason(): string | null {
    return this.broken ?? (this.inner as { fallbackReason?: string | null }).fallbackReason ?? null;
  }

  start(onEvent: (e: SpeechEvent) => void, onExit: (code: number | null) => void): Promise<void> {
    this.onEvent = onEvent;
    return this.inner.start(onEvent, onExit);
  }

  send(cmd: Record<string, unknown>): void {
    const c = this.config();
    if (cmd.cmd === 'wake') this.lastWake = cmd;
    if (cmd.cmd === 'wake' && c.enabled && !this.broken) {
      this.inner.send({ cmd: 'pause' }); // the Windows recognizer stays idle while Porcupine listens
      void this.listen(c);
      return;
    }
    if (cmd.cmd === 'pause' || cmd.cmd === 'capture' || cmd.cmd === 'test') this.stopListening();
    this.inner.send(cmd);
  }

  stop(): void {
    this.stopListening();
    this.releaseAll();
    this.inner.stop();
  }

  private open(c: PorcupineConfig): void {
    if (this.detector) return;
    if (!c.accessKey) throw new Error('No Picovoice access key yet (Settings → Voice & shortcuts → Trained wake word).');
    const f = this.factory();
    let keyword: string;
    if (c.keywordPath) {
      if (!/\.ppn$/i.test(c.keywordPath) || !fs.existsSync(c.keywordPath)) throw new Error('The wake word model file (.ppn) is missing. Choose it again in Settings.');
      keyword = c.keywordPath;
      this.label = (c.keywordPath.split(/[\\/]/).pop() ?? 'wake word').replace(/_(en|windows|wasm|mac|linux).*$/i, '').replace(/\.ppn$/i, '').replace(/[-_]+/g, ' ');
    } else if (c.builtin) {
      keyword = f.builtinPath(c.builtin);
      this.label = c.builtin;
    } else throw new Error('Choose a wake word: a trained .ppn file or a built-in one.');
    this.detector = f.detector(c.accessKey, [keyword], [Math.min(1, Math.max(0, c.sensitivity))]);
    this.recorder = f.recorder(this.detector.frameLength);
  }

  private async listen(c: PorcupineConfig): Promise<void> {
    if (this.listening) return;
    try {
      this.open(c);
      this.recorder!.start();
    } catch (e) {
      // Porcupine cannot run: say why (never the key) and let the Windows engine listen instead.
      this.broken = (e as Error).message.replace(/[A-Za-z0-9+/=]{30,}/g, '…').slice(0, 200);
      this.releaseAll();
      this.onEvent?.({ event: 'quality', problem: `Trained wake word unavailable: ${this.broken} Using Windows speech instead.` });
      this.inner.send({ ...this.lastWake, cmd: 'wake' });
      return;
    }
    this.listening = true;
    const gen = ++this.gen;
    this.onEvent?.({ event: 'listening' });
    while (this.listening && gen === this.gen) {
      let frame: Int16Array;
      try {
        frame = await this.recorder!.read();
      } catch (e) {
        if (gen !== this.gen) return;
        this.listening = false;
        this.onEvent?.({ event: 'error', code: 'microphone', message: `The microphone stopped: ${(e as Error).message.slice(0, 120)}` });
        return;
      }
      if (gen !== this.gen) return;
      if (this.detector!.process(frame) >= 0) this.onEvent?.({ event: 'wake', phrase: this.label, confidence: 1 });
    }
  }

  /** Parameters of the last wake request (for the Windows fallback). */
  private lastWake: Record<string, unknown> = {};

  private stopListening(): void {
    if (!this.listening) return;
    this.listening = false;
    this.gen++;
    try {
      this.recorder?.stop();
    } catch {
      /* already stopped */
    }
    this.onEvent?.({ event: 'paused' });
  }

  private releaseAll(): void {
    try {
      this.recorder?.release();
    } catch {
      /* ignore */
    }
    try {
      this.detector?.release();
    } catch {
      /* ignore */
    }
    this.recorder = null;
    this.detector = null;
  }

  /** Settings changed (key, file, sensitivity): rebuild on next listen. */
  reset(): void {
    this.stopListening();
    this.releaseAll();
    this.broken = null;
  }
}
