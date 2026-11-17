/** Keo Studio — keeping the preview's video and sound in step with its clock while playing. */
/**
 * The speed a playing element should run at to stay with the clock: a little faster when it is
 * behind, a little slower when ahead (no jump, so no hitch and no skip in the sound). Only when it
 * is far off (a cut, a click elsewhere on the timeline) is it sought.
 */
export function keepUp(el: { currentTime: number; paused: boolean }, target: number, rate: number): number {
  const drift = el.currentTime - target;
  if (Math.abs(drift) > (el.paused ? 0.15 : 0.75)) {
    el.currentTime = target;
    return rate;
  }
  if (Math.abs(drift) < 0.04) return rate;
  const nudge = Math.max(-0.08, Math.min(0.08, drift * 0.5));
  return Math.max(0.0625, Math.min(16, rate * (1 - nudge)));
}
