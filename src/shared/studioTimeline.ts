/**
 * Keo Studio — the magnetic main track (like CapCut's): the clips of the main video track stay
 * packed end to end from 0:00. Moving one reorders the track and closes the gap it left; trimming
 * or deleting one pulls the clips after it along. Everything is plain edit operations (one undo).
 */
import { clipEnd, type Clip, type EditOp, type Project, type Track } from './studio';

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The main track: the bottom video track (the one the rest is layered on). */
export function mainTrack(p: Pick<Project, 'tracks'>): Track | null {
  return p.tracks.find((t) => t.kind === 'video') ?? null;
}

/** Moves that put `order` end to end from 0:00 (only clips whose place changes, onto `track` when given). */
function pack(order: Clip[], track?: string, from = 0): EditOp[] {
  const ops: EditOp[] = [];
  let t = from;
  for (const c of order) {
    if (Math.abs(c.start - t) > 1e-3 || track) ops.push({ op: 'move', clip: c.id, start: r3(t), ...(track ? { track } : {}) });
    t += c.duration;
  }
  return ops;
}

/**
 * A clip dropped at `start` on the main track (from the main track or another one): it goes in
 * where the pointer is among the others (else where its middle lands), and the track is packed again. A clip dragged off the
 * main track leaves no gap behind.
 */
export function magneticMove(p: Project, clipId: string, start: number, toTrack: string, pointer?: number): EditOp[] {
  const main = mainTrack(p);
  const from = p.tracks.find((t) => t.clips.some((c) => c.id === clipId));
  const clip = from?.clips.find((c) => c.id === clipId);
  if (!main || !from || !clip) return [];
  const others = main.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start);
  if (toTrack === main.id) {
    // Where the pointer is (as in other editors), else where the clip's middle lands.
    const mid = pointer ?? start + clip.duration / 2;
    const at = others.filter((c) => c.start + c.duration / 2 < mid).length;
    const order = [...others.slice(0, at), clip, ...others.slice(at)];
    // The moved clip always gets its move (it may also change track); the rest only when they shift.
    const ops = pack(order);
    if (!ops.some((o) => o.op === 'move' && o.clip === clipId)) ops.push({ op: 'move', clip: clipId, start: r3(order.slice(0, at).reduce((n, c) => n + c.duration, 0)) });
    return ops.map((o) => (o.op === 'move' && o.clip === clipId && from.id !== main.id ? { ...o, track: main.id } : o));
  }
  // Off the main track: placed where it was dropped, and the main track closes up.
  return [{ op: 'move', clip: clipId, start: r3(Math.max(0, start)), track: toTrack }, ...(from.id === main.id ? pack(others) : [])];
}

/** The end of a main-track clip trimmed to `duration`: the clips after it follow. */
export function magneticTrimEnd(p: Project, clipId: string, duration: number): EditOp[] {
  const main = mainTrack(p);
  const clip = main?.clips.find((c) => c.id === clipId);
  if (!main || !clip) return [];
  const delta = duration - clip.duration;
  const after = main.clips.filter((c) => c.id !== clipId && c.start >= clipEnd(clip) - 1e-3);
  return [{ op: 'trim', clip: clipId, duration: r3(duration) }, ...after.map((c) => ({ op: 'move' as const, clip: c.id, start: r3(Math.max(0, c.start + delta)) }))];
}

/** The start of a main-track clip trimmed by `delta` seconds: it stays where it is, the clips after it follow. */
export function magneticTrimStart(p: Project, clipId: string, delta: number): EditOp[] {
  const main = mainTrack(p);
  const clip = main?.clips.find((c) => c.id === clipId);
  if (!main || !clip) return [];
  const after = main.clips.filter((c) => c.id !== clipId && c.start >= clipEnd(clip) - 1e-3);
  return [{ op: 'trim', clip: clipId, trimStart: r3(delta) }, { op: 'move', clip: clipId, start: r3(clip.start) }, ...after.map((c) => ({ op: 'move' as const, clip: c.id, start: r3(Math.max(0, c.start - delta)) }))];
}

/** Whether every one of these clips is on the main track (deleting them then closes the gaps). */
export function allOnMain(p: Project, ids: string[]): boolean {
  const main = mainTrack(p);
  return !!main && ids.length > 0 && ids.every((id) => main.clips.some((c) => c.id === id));
}

/** The main track closed up without one of its clips (that clip is leaving it). */
export function closeUp(p: Project, clipId: string): EditOp[] {
  const main = mainTrack(p);
  if (!main || !main.clips.some((c) => c.id === clipId)) return [];
  return pack(main.clips.filter((c) => c.id !== clipId).sort((a, b) => a.start - b.start));
}
