import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Voices in Studio: read a text clip aloud (Keo's voice or OpenAI's), and record a voice-over with
 * the microphone straight onto the timeline.
 */

const VOICES = [
  { id: 'female', label: 'Keo — female' },
  { id: 'male', label: 'Keo — male' },
  { id: 'nova', label: 'OpenAI — Nova' },
  { id: 'onyx', label: 'OpenAI — Onyx' },
  { id: 'shimmer', label: 'OpenAI — Shimmer' },
  { id: 'echo', label: 'OpenAI — Echo' },
];

export function ReadAloud({ projectId, clipId }: { projectId: string; clipId: string }) {
  const ui = useUi();
  const [voice, setVoice] = useState('female');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await invoke('studio:readAloud', { id: projectId, clip: clipId, voice });
      ui.toast(`Added the voice-over (${r.seconds.toFixed(1)} s) on the Voice track.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="read-aloud">
      <select className="select" value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
        {VOICES.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
      <button className="btn sm" disabled={busy} onClick={() => void go()} title="Read this text in the chosen voice and put it under the text">
        {busy ? <span className="spinner tiny" /> : <Icon name="speaker" size={13} />} {busy ? 'Making the voice…' : 'Read aloud'}
      </button>
    </div>
  );
}

/** 16-bit mono WAV of a decoded recording. */
function wav(buf: AudioBuffer): Uint8Array {
  const rate = buf.sampleRate;
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i]! += d[i]! / buf.numberOfChannels;
  }
  const out = new Uint8Array(44 + mono.length * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => v.setUint8(at + i, ch.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + mono.length * 2, true);
  text(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, mono.length * 2, true);
  for (let i = 0; i < mono.length; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(mono[i]! * 32767))), true);
  return out;
}

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Record a voice-over: it goes on the Voice track at the playhead where recording started. */
export function VoiceRecorder({ projectId, time, onStart }: { projectId: string; time: number; onStart?: () => void }) {
  const ui = useUi();
  const [state, setState] = useState<'idle' | 'starting' | 'recording' | 'saving'>('idle');
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const rec = useRef<{ media: MediaRecorder; stream: MediaStream; chunks: Blob[]; at: number; ctx: AudioContext; timer: number } | null>(null);

  useEffect(
    () => () => {
      const r = rec.current;
      if (!r) return;
      clearInterval(r.timer);
      r.stream.getTracks().forEach((t) => t.stop());
      void r.ctx.close().catch(() => undefined);
    },
    [],
  );

  const start = async () => {
    setState('starting');
    onStart?.();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const media = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      media.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      // A level meter so the user sees the microphone hears them.
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const data = new Uint8Array(an.fftSize);
      const began = Date.now();
      const timer = window.setInterval(() => {
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        setSecs((Date.now() - began) / 1000);
      }, 100);
      rec.current = { media, stream, chunks, at: time, ctx, timer };
      media.start(250);
      setSecs(0);
      setState('recording');
    } catch (e) {
      setState('idle');
      ui.error(`The microphone could not be used: ${errText(e)}. Check Windows Settings → Privacy → Microphone.`);
    }
  };

  const stop = async () => {
    const r = rec.current;
    if (!r) return;
    setState('saving');
    clearInterval(r.timer);
    await new Promise<void>((res) => {
      r.media.onstop = () => res();
      r.media.stop();
    });
    r.stream.getTracks().forEach((t) => t.stop());
    try {
      const blob = new Blob(r.chunks, { type: r.media.mimeType || 'audio/webm' });
      const decoded = await r.ctx.decodeAudioData(await blob.arrayBuffer());
      const out = await invoke('studio:saveRecording', { id: projectId, wavBase64: base64(wav(decoded)), at: r.at });
      ui.toast(`Added your voice-over (${out.seconds.toFixed(1)} s) on the Voice track.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      void r.ctx.close().catch(() => undefined);
      rec.current = null;
      setState('idle');
      setLevel(0);
    }
  };

  return (
    <div className="recorder">
      {state === 'recording' ? (
        <>
          <span className="rec-dot" />
          <span className="rec-time">
            {Math.floor(secs / 60)}:{String(Math.floor(secs % 60)).padStart(2, '0')}
          </span>
          <span className="rec-meter">
            <span style={{ width: `${Math.min(100, level * 140)}%` }} />
          </span>
          <button className="btn sm danger" onClick={() => void stop()}>
            <Icon name="stop" size={12} /> Stop
          </button>
        </>
      ) : (
        <button className="btn sm" disabled={state !== 'idle'} onClick={() => void start()} title="Record your voice with the microphone; it goes on the Voice track at the playhead">
          {state === 'idle' ? <Icon name="mic" size={13} /> : <span className="spinner tiny" />} {state === 'saving' ? 'Saving…' : state === 'starting' ? 'Starting…' : 'Record voice-over'}
        </button>
      )}
    </div>
  );
}
