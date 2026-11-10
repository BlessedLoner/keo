// Game sound made live with Web Audio (no sound files): engine by revs and gear, wind, tyre
// screech, siren, crashes and nitro. Starts on the first key press or tap (browsers require it).

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    const start = () => this.start();
    addEventListener('keydown', start, { once: true });
    addEventListener('pointerdown', start, { once: true });
  }
  start() {
    if (this.ctx) return;
    const C = (this.ctx = new AudioContext());
    this.master = C.createGain();
    this.master.gain.value = 0.7;
    const comp = C.createDynamicsCompressor();
    this.master.connect(comp).connect(C.destination);
    // Engine: two detuned saws and a sub through a low-pass filter that opens with throttle.
    this.engFilter = C.createBiquadFilter();
    this.engFilter.type = 'lowpass';
    this.engFilter.Q.value = 6;
    this.engGain = C.createGain();
    this.engGain.gain.value = 0;
    this.engOsc = [C.createOscillator(), C.createOscillator(), C.createOscillator()];
    this.engOsc[0].type = 'sawtooth';
    this.engOsc[1].type = 'sawtooth';
    this.engOsc[2].type = 'square';
    this.engOsc[1].detune.value = 9;
    for (const o of this.engOsc) {
      o.connect(this.engFilter);
      o.start();
    }
    this.engFilter.connect(this.engGain).connect(this.master);
    // Noise for wind, tyres and crashes.
    const len = C.sampleRate * 2;
    const buf = C.createBuffer(1, len, C.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const loop = (type, freq, q) => {
      const s = C.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      const f = C.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = C.createGain();
      g.gain.value = 0;
      s.connect(f).connect(g).connect(this.master);
      s.start();
      return { f, g };
    };
    this.wind = loop('bandpass', 600, 0.6);
    this.skid = loop('bandpass', 2200, 4);
    // Siren.
    this.siren = C.createOscillator();
    this.siren.type = 'triangle';
    this.sirenGain = C.createGain();
    this.sirenGain.gain.value = 0;
    this.siren.connect(this.sirenGain).connect(this.master);
    this.siren.start();
  }
  /** Each frame: speed (m/s), throttle 0..1, top speed, slip 0..1, nearest siren distance (m). */
  update({ speed = 0, throttle = 0, topSpeed = 80, slip = 0, siren = Infinity, boost = false }) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    // Six gears: revs rise through each, drop at the change.
    const r = Math.min(0.999, Math.abs(speed) / topSpeed);
    const gear = Math.min(5, Math.floor(r * 6));
    const inGear = r * 6 - gear;
    const rpm = 900 + (1200 + inGear * 5200) * (gear === 0 ? Math.max(0.15, inGear) : 1) * (0.85 + throttle * 0.15);
    const base = rpm / 60;
    this.engOsc[0].frequency.setTargetAtTime(base, t, 0.05);
    this.engOsc[1].frequency.setTargetAtTime(base * 1.005, t, 0.05);
    this.engOsc[2].frequency.setTargetAtTime(base / 2, t, 0.05);
    this.engFilter.frequency.setTargetAtTime(400 + throttle * 2600 + rpm * 0.2 + (boost ? 1500 : 0), t, 0.06);
    this.engGain.gain.setTargetAtTime(0.09 + throttle * 0.12, t, 0.08);
    this.wind.g.gain.setTargetAtTime(Math.min(0.35, (Math.abs(speed) / 90) ** 2), t, 0.2);
    this.skid.g.gain.setTargetAtTime(slip > 0.25 && Math.abs(speed) > 6 ? Math.min(0.3, slip * 0.4) : 0, t, 0.05);
    const near = siren < 250 ? (1 - siren / 250) ** 1.5 * 0.18 : 0;
    this.sirenGain.gain.setTargetAtTime(near, t, 0.1);
    this.siren.frequency.setValueAtTime(700 + Math.sin(t * Math.PI * 1.2) * 260, t);
  }
  /** A bang for a crash (strength 0..1). */
  crash(strength = 0.5) {
    if (!this.ctx || this.muted) return;
    const C = this.ctx;
    const s = C.createBufferSource();
    s.buffer = this.noiseBuf;
    const f = C.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900 + strength * 1600;
    const g = C.createGain();
    g.gain.setValueAtTime(0.5 * strength + 0.15, C.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, C.currentTime + 0.5);
    s.connect(f).connect(g).connect(this.master);
    s.start();
    s.stop(C.currentTime + 0.6);
  }
  /** A short tone (pickups, checkpoints, purchases). */
  blip(freq = 880, ms = 120) {
    if (!this.ctx || this.muted) return;
    const C = this.ctx;
    const o = C.createOscillator();
    const g = C.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.18, C.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, C.currentTime + ms / 1000);
    o.connect(g).connect(this.master);
    o.start();
    o.stop(C.currentTime + ms / 1000);
  }
  mute(on) {
    this.muted = on;
    if (this.master) this.master.gain.value = on ? 0 : 0.7;
  }
}
