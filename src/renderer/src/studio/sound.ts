import type { Eq, VoiceFx } from '@shared/studio';

/**
 * Keo Studio's sound processing, shared by the preview and the export so both sound the same:
 * voice clean-up (low rumble cut, less boom, clearer speech, gentle compression) and the
 * export's loudness for social apps.
 */

/** input → voice clean-up → the returned node (connect it on). */
export function voiceChain(ctx: BaseAudioContext, input: AudioNode): AudioNode {
  const rumble = ctx.createBiquadFilter();
  rumble.type = 'highpass';
  rumble.frequency.value = 85;
  rumble.Q.value = 0.7;
  const mud = ctx.createBiquadFilter();
  mud.type = 'peaking';
  mud.frequency.value = 260;
  mud.Q.value = 1;
  mud.gain.value = -2.5;
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 3200;
  presence.Q.value = 0.9;
  presence.gain.value = 3;
  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 9000;
  air.gain.value = 1.5;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -26;
  comp.knee.value = 8;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.18;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.6;
  input.connect(rumble).connect(mud).connect(presence).connect(air).connect(comp).connect(makeup);
  return makeup;
}

/**
 * Integrated loudness of a mix, about LUFS: 400 ms blocks, gated like EBU R128 (absolute -70,
 * relative -10), without the K-weighting filter (within a dB or two for speech and music).
 */
export function loudness(buf: AudioBuffer): number {
  const block = Math.round(buf.sampleRate * 0.4);
  const hop = Math.round(block / 4);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i));
  const powers: number[] = [];
  for (let at = 0; at + block <= buf.length; at += hop) {
    let sum = 0;
    for (const ch of chans) for (let i = at; i < at + block; i++) sum += ch[i]! * ch[i]!;
    powers.push(sum / block);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p + 1e-12);
  const abs = powers.filter((p) => lufs(p) > -70);
  if (!abs.length) return -Infinity;
  const mean = (xs: number[]) => xs.reduce((t, x) => t + x, 0) / xs.length;
  const rel = lufs(mean(abs)) - 10;
  const gated = abs.filter((p) => lufs(p) > rel);
  return lufs(mean(gated.length ? gated : abs));
}

/** The mix brought to about `target` LUFS, with a soft limiter so peaks never clip. */
export function normalize(buf: AudioBuffer, target = -14): { gainDb: number } {
  const now = loudness(buf);
  if (!Number.isFinite(now)) return { gainDb: 0 };
  const gainDb = Math.max(-20, Math.min(20, target - now));
  const g = Math.pow(10, gainDb / 20);
  const knee = 0.89;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const x = d[i]! * g;
      const ax = Math.abs(x);
      d[i] = ax <= knee ? x : Math.sign(x) * (knee + (1 - knee) * Math.tanh((ax - knee) / (1 - knee)));
    }
  }
  return { gainDb };
}

/** The equalizer: input → bass, mids and treble filters → the returned node. */
export function eqChain(ctx: BaseAudioContext, input: AudioNode, eq: Eq): AudioNode {
  const low = ctx.createBiquadFilter();
  low.type = 'lowshelf';
  low.frequency.value = 120;
  low.gain.value = eq.low;
  const mid = ctx.createBiquadFilter();
  mid.type = 'peaking';
  mid.frequency.value = 1500;
  mid.Q.value = 0.8;
  mid.gain.value = eq.mid;
  const high = ctx.createBiquadFilter();
  high.type = 'highshelf';
  high.frequency.value = 6000;
  high.gain.value = eq.high;
  return input.connect(low).connect(mid).connect(high);
}

/**
 * The voice changer: input → the effect → the returned node. Built only from the browser's own
 * audio nodes, so the live preview and the offline export sound the same. `stop` ends its
 * oscillators (the preview calls it when the effect changes).
 */
export function voiceFxChain(ctx: BaseAudioContext, input: AudioNode, fx: VoiceFx): { out: AudioNode; stop: () => void } {
  const sources: AudioScheduledSourceNode[] = [];
  const begin = <T extends AudioScheduledSourceNode>(s: T): T => {
    sources.push(s);
    s.start(ctx.currentTime);
    return s;
  };
  const out = ctx.createGain();
  const filter = (type: BiquadFilterType, frequency: number, Q = 0.7, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    f.gain.value = gain;
    return f;
  };
  const shaper = (k: number) => {
    const w = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
    }
    w.curve = curve;
    return w;
  };
  const gainOf = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  switch (fx) {
    case 'chipmunk':
    case 'deep':
      pitchShift(ctx, input, fx === 'chipmunk' ? 1.6 : 0.7, begin).connect(out);
      break;
    case 'robot': {
      // Ring modulation (the voice times a 55 Hz tone) and a short metallic comb.
      const ring = gainOf(0);
      const osc = begin(ctx.createOscillator());
      osc.frequency.value = 55;
      osc.connect(ring.gain);
      input.connect(ring);
      const mix = ctx.createGain();
      ring.connect(mix);
      input.connect(gainOf(0.2)).connect(mix);
      const comb = ctx.createDelay(0.05);
      comb.delayTime.value = 0.008;
      const fb = gainOf(0.45);
      mix.connect(comb).connect(fb).connect(comb);
      mix.connect(out);
      comb.connect(gainOf(0.6)).connect(out);
      break;
    }
    case 'radio':
      input.connect(filter('highpass', 400)).connect(filter('lowpass', 3200)).connect(filter('peaking', 1500, 1, 6)).connect(shaper(4)).connect(gainOf(0.9)).connect(out);
      break;
    case 'megaphone':
      input.connect(filter('highpass', 700)).connect(filter('lowpass', 4000)).connect(shaper(20)).connect(gainOf(0.55)).connect(out);
      break;
    case 'echo': {
      input.connect(out);
      const d = ctx.createDelay(1);
      d.delayTime.value = 0.3;
      input.connect(d);
      d.connect(gainOf(0.4)).connect(d);
      d.connect(gainOf(0.45)).connect(out);
      break;
    }
    case 'hall': {
      // A big room: a 2.4 s decaying noise tail as the room's echo (the same every time).
      const conv = ctx.createConvolver();
      const len = Math.round(ctx.sampleRate * 2.4);
      const ir = ctx.createBuffer(2, len, ctx.sampleRate);
      let seed = 7;
      for (let c = 0; c < 2; c++) {
        const d = ir.getChannelData(c);
        for (let i = 0; i < len; i++) {
          seed = (seed * 1664525 + 1013904223) >>> 0;
          d[i] = (seed / 2 ** 32 - 0.5) * 2 * Math.pow(1 - i / len, 3);
        }
      }
      conv.buffer = ir;
      input.connect(gainOf(0.8)).connect(out);
      input.connect(conv).connect(gainOf(0.35)).connect(out);
      break;
    }
    case 'underwater': {
      const lp = filter('lowpass', 450, 6);
      const lfo = begin(ctx.createOscillator());
      lfo.frequency.value = 0.6;
      lfo.connect(gainOf(150)).connect(lp.frequency);
      input.connect(lp).connect(gainOf(0.9)).connect(out);
      break;
    }
  }
  return {
    out,
    stop: () => {
      for (const s of sources) s.stop();
    },
  };
}

/**
 * Higher or lower voice at the same speed: two delay lines whose delay ramps steadily (which
 * changes the pitch), each faded out while it jumps back, taking turns half a period apart.
 */
function pitchShift(ctx: BaseAudioContext, input: AudioNode, ratio: number, begin: <T extends AudioScheduledSourceNode>(s: T) => T): AudioNode {
  const period = 0.1;
  const depth = Math.abs(ratio - 1) * period;
  const up = ratio > 1;
  const n = Math.round(period * ctx.sampleRate);
  const out = ctx.createGain();
  for (const phase of [0, 0.5]) {
    const ramp = ctx.createBuffer(1, n, ctx.sampleRate);
    const fade = ctx.createBuffer(1, n, ctx.sampleRate);
    const r = ramp.getChannelData(0);
    const f = fade.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const p = (i / n + phase) % 1;
      r[i] = up ? 1 - p : p;
      f[i] = Math.sin(Math.PI * p) ** 2;
    }
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0;
    const mod = ctx.createBufferSource();
    mod.buffer = ramp;
    mod.loop = true;
    const amount = ctx.createGain();
    amount.gain.value = depth;
    mod.connect(amount).connect(delay.delayTime);
    const tap = ctx.createGain();
    tap.gain.value = 0;
    const fader = ctx.createBufferSource();
    fader.buffer = fade;
    fader.loop = true;
    fader.connect(tap.gain);
    input.connect(delay).connect(tap).connect(out);
    begin(mod);
    begin(fader);
  }
  return out;
}
