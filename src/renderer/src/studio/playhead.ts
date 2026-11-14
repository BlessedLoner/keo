/**
 * The playhead's exact time, every frame while playing: the preview sets it, the timeline's
 * playhead and the time readout follow it directly (no re-render of the timeline or the Studio
 * screen 60 times a second). Studio's own `time` still changes, a few times a second, for
 * everything else.
 */
type Listener = (t: number) => void;

let now = 0;
let running = false;
const listeners = new Set<Listener>();

export const playhead = {
  get: (): number => now,
  playing: (): boolean => running,
  set(t: number, playing = running): void {
    now = t;
    running = playing;
    for (const f of listeners) f(t);
  },
  subscribe(f: Listener): () => void {
    listeners.add(f);
    return () => listeners.delete(f);
  },
};
