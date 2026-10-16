/**
 * Shared real-time audio level (0..1). Written only by real analysers
 * (microphone while recording, playback while speaking) and read by the
 * emblem's animation loop without causing React re-renders.
 */
let level = 0;
let source: 'mic' | 'playback' | null = null;

export const levelBus = {
  get: () => level,
  source: () => source,
  set(v: number, from: 'mic' | 'playback') {
    level = Math.max(0, Math.min(1, v));
    source = from;
  },
  reset() {
    level = 0;
    source = null;
  },
};
