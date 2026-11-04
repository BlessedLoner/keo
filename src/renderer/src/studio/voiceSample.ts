import { VOICE_SAMPLE_SECONDS } from '@shared/studioCharacters';

/**
 * A character's voice sample from any recording the browser can play (an MP3, M4A or WAV the user
 * has, or what they just recorded): 24 kHz mono 16-bit WAV, the first 30 seconds, as base64.
 */
export async function voiceSample(blob: Blob): Promise<{ base64: string; seconds: number }> {
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('Keo could not play that file: choose a recording (MP3, M4A, WAV or OGG).');
  } finally {
    void ctx.close();
  }
  const seconds = Math.min(decoded.duration, VOICE_SAMPLE_SECONDS.max);
  if (seconds < VOICE_SAMPLE_SECONDS.min) throw new Error(`That recording is ${seconds.toFixed(1)} s: use at least ${VOICE_SAMPLE_SECONDS.min} seconds of the voice talking.`);
  const rate = 24000;
  const off = new OfflineAudioContext(1, Math.ceil(seconds * rate), rate);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  // Evened out: a quiet recording is brought up so the voice model hears it clearly.
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]!));
  if (peak < 0.01) throw new Error('That recording is silent: check the microphone or the file.');
  const gain = Math.min(4, 0.9 / peak);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const tag = (at: number, t: string) => [...t].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  tag(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  tag(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * gain * 32767))), true);
  const bytes = new Uint8Array(out.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { base64: btoa(bin), seconds };
}

/** Records the microphone until stop() (or 30 seconds), then gives the recording. */
export async function recordVoice(onTick: (seconds: number) => void): Promise<{ stop: () => void; done: Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const rec = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = Date.now();
  const timer = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    onTick(s);
    if (s >= VOICE_SAMPLE_SECONDS.max) stop();
  }, 250);
  const done = new Promise<Blob>((resolve) => {
    rec.onstop = () => {
      clearInterval(timer);
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    };
  });
  const stop = () => rec.state !== 'inactive' && rec.stop();
  rec.start(250);
  return { stop, done };
}
