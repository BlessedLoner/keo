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
