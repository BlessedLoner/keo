import { invoke } from './api';
import { levelBus } from './levelBus';

export interface VoiceState {
  recording: boolean;
  transcribing: boolean;
  speaking: boolean;
  /** How the speaking animation is driven, so the UI never overstates sync. */
  speakingSync: 'amplitude' | 'word-boundaries' | null;
  micPermission: 'unknown' | 'granted' | 'denied';
  error: string | null;
}

type Listener = (s: VoiceState) => void;

const MAX_RECORDING_MS = 120_000;

/**
 * Voice controller. Recording only happens between an explicit start and
 * stop (push-to-talk); the microphone stream is released immediately after.
 * Audio is kept in memory and sent only to the configured STT provider.
 */
class VoiceController {
  private state: VoiceState = { recording: false, transcribing: false, speaking: false, speakingSync: null, micPermission: 'unknown', error: null };
  private listeners = new Set<Listener>();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private ctx: AudioContext | null = null;
  private raf = 0;
  private stopTimer = 0;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private resolveRecording: ((text: string | null) => void) | null = null;

  get(): VoiceState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(p: Partial<VoiceState>): void {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l(this.state);
  }

  private audioCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
    return this.ctx;
  }

  private vad: { speechAt: number; quietSince: number; startedAt: number } | null = null;

  private meter(analyser: AnalyserNode, from: 'mic' | 'playback'): void {
    const buf = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      levelBus.set(level, from);
      // Voice-activity detection for hands-free commands: stop after ~1.3 s of
      // silence following speech, or give up after 7 s without speech.
      if (from === 'mic' && this.vad) {
        const now = performance.now();
        if (level > 0.12) {
          this.vad.speechAt = now;
          this.vad.quietSince = 0;
        } else if (this.vad.speechAt && !this.vad.quietSince) this.vad.quietSince = now;
        if (this.vad.speechAt && this.vad.quietSince && now - this.vad.quietSince > 1300) {
          this.vad = null;
          this.stop();
          return;
        }
        if (!this.vad.speechAt && now - this.vad.startedAt > 7000) {
          this.vad = null;
          this.abort();
          return;
        }
      }
      this.raf = this.next(loop, from);
    };
    this.cancelTick();
    this.raf = this.next(loop, from);
  }

  /**
   * The microphone meter (and its silence detection) runs on a timer, not on
   * animation frames: those stop while the window is minimized or hidden, and
   * hands-free listening must keep working then.
   */
  private tickIsTimer = false;
  private next(fn: () => void, from: 'mic' | 'playback'): number {
    this.tickIsTimer = from === 'mic' || document.hidden;
    return this.tickIsTimer ? window.setTimeout(fn, 40) : requestAnimationFrame(fn);
  }

  private cancelTick(): void {
    if (this.tickIsTimer) window.clearTimeout(this.raf);
    else cancelAnimationFrame(this.raf);
  }

  private stopMeter(): void {
    this.cancelTick();
    levelBus.reset();
  }

  /** Starts recording. Resolves with the transcript when stop() is called. */
  async start(opts: { autoStop?: boolean } = {}): Promise<string | null> {
    if (this.state.recording || this.state.transcribing) return null;
    this.set({ error: null });
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      this.set({ micPermission: 'granted' });
    } catch (e) {
      const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      this.set({ micPermission: denied ? 'denied' : this.state.micPermission, error: denied ? 'Microphone access was denied.' : 'No microphone is available.' });
      return null;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    this.recorder = new MediaRecorder(this.stream, { mimeType: mime });
    this.chunks = [];
    this.recorder.ondataavailable = (ev) => {
      if (ev.data.size) this.chunks.push(ev.data);
    };
    const ctx = this.audioCtx();
    const src = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    this.vad = opts.autoStop ? { speechAt: 0, quietSince: 0, startedAt: performance.now() } : null;
    this.meter(analyser, 'mic');
    this.recorder.start(250);
    this.set({ recording: true });
    this.stopTimer = window.setTimeout(() => this.stop(), MAX_RECORDING_MS);
    return new Promise((resolve) => {
      this.resolveRecording = resolve;
    });
  }

  /** Stops recording and transcribes. */
  stop(): void {
    const rec = this.recorder;
    if (!rec || rec.state === 'inactive') return;
    window.clearTimeout(this.stopTimer);
    rec.onstop = async () => {
      this.release();
      this.set({ recording: false, transcribing: true });
      const blob = new Blob(this.chunks, { type: 'audio/webm' });
      this.chunks = [];
      let text: string | null = null;
      try {
        if (blob.size < 2000) throw new Error('The recording was too short.');
        const bytes = new Uint8Array(await blob.arrayBuffer());
        text = (await invoke('voice:transcribe', { audio: bytes, mimeType: 'audio/webm' })).text;
        if (!text) this.set({ error: 'No speech was recognised.' });
      } catch (e) {
        this.set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        this.set({ transcribing: false });
        this.resolveRecording?.(text);
        this.resolveRecording = null;
      }
    };
    rec.stop();
  }

  /** Discards the current recording without transcribing. */
  abort(): void {
    window.clearTimeout(this.stopTimer);
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.chunks = [];
    this.release();
    this.set({ recording: false });
    this.resolveRecording?.(null);
    this.resolveRecording = null;
  }

  private release(): void {
    this.stopMeter();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
  }

  // -- speech output ----------------------------------------------------------

  async speak(text: string, engine: 'system' | 'openai' | 'none', systemVoice: string): Promise<void> {
    this.stopSpeaking();
    const clean = speakable(text);
    if (!clean || engine === 'none') return;
    this.set({ error: null });
    if (engine === 'system') {
      if (!('speechSynthesis' in window)) {
        this.set({ error: 'System speech is not available.' });
        return;
      }
      const u = new SpeechSynthesisUtterance(clean);
      // The chosen voice; otherwise an English one (Windows' default voice can be another language).
      const voices = speechSynthesis.getVoices();
      const v = voices.find((x) => x.name === systemVoice) ?? voices.find((x) => /^en[-_]/i.test(x.lang) && x.localService) ?? voices.find((x) => /^en[-_]/i.test(x.lang));
      if (v) u.voice = v;
      u.lang = v?.lang ?? 'en-US';
      let env = 0;
      const decay = () => {
        env *= 0.88;
        levelBus.set(env, 'playback');
        this.raf = this.next(decay, 'playback');
      };
      u.onstart = () => {
        this.set({ speaking: true, speakingSync: 'word-boundaries' });
        this.raf = this.next(decay, 'playback');
      };
      u.onboundary = () => {
        env = 0.85;
      };
      const end = () => {
        this.stopMeter();
        this.set({ speaking: false, speakingSync: null });
      };
      u.onend = end;
      u.onerror = end;
      speechSynthesis.speak(u);
      return;
    }
    try {
      this.set({ speaking: true, speakingSync: null });
      const r = await invoke('voice:speak', { text: clean.slice(0, 4000) });
      const blob = new Blob([r.audio as BlobPart], { type: r.mimeType });
      this.audioUrl = URL.createObjectURL(blob);
      const el = new Audio(this.audioUrl);
      this.audio = el;
      const ctx = this.audioCtx();
      const src = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      el.onplay = () => {
        this.set({ speaking: true, speakingSync: 'amplitude' });
        this.meter(analyser, 'playback');
      };
      el.onended = () => this.stopSpeaking();
      el.onerror = () => {
        this.set({ error: 'Audio playback failed.' });
        this.stopSpeaking();
      };
      await ctx.resume();
      await el.play();
    } catch (e) {
      this.set({ error: e instanceof Error ? e.message : String(e) });
      this.stopSpeaking();
    }
  }

  /**
   * Speaks and resolves once playback has finished: 'spoken', or 'no_start' when the voice never
   * began (it is then cancelled, so it cannot start late — while Keo listens, or after voice mode).
   * A Windows voice can take several seconds to start the first time.
   */
  async speakAndWait(text: string, engine: 'system' | 'openai' | 'none', systemVoice: string): Promise<'spoken' | 'no_start'> {
    await this.speak(text, engine === 'none' ? 'system' : engine, systemVoice);
    const started = performance.now();
    while (!this.state.speaking && performance.now() - started < 15_000) await new Promise((r) => setTimeout(r, 50));
    if (!this.state.speaking) {
      this.stopSpeaking();
      return 'no_start';
    }
    while (this.state.speaking && performance.now() - started < 120_000) await new Promise((r) => setTimeout(r, 100));
    return 'spoken';
  }

  /** Loads the system voice ahead of time (silently), so the first spoken reply starts promptly. */
  prime(): void {
    if (!('speechSynthesis' in window) || speechSynthesis.speaking) return;
    const u = new SpeechSynthesisUtterance('.');
    u.volume = 0;
    speechSynthesis.speak(u);
  }

  stopSpeaking(): void {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (this.audio) {
      this.audio.pause();
      this.audio = null;
    }
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    this.stopMeter();
    if (this.state.speaking) this.set({ speaking: false, speakingSync: null });
  }
}

/** Removes code blocks and Markdown syntax so speech stays natural. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export const voice = new VoiceController();
