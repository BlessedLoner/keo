/**
 * Keo Studio — a new copy of the project (after an edit, or Keo's change arriving) that keeps the
 * previous copy's objects wherever nothing changed. The timeline and preview are memoised on those
 * objects, so one moved clip redraws one clip, not the whole timeline (and the same project
 * arriving twice — the edit's answer, then the change notice — redraws nothing).
 */
import type { Clip, Project, Track } from './studio';

/** Each kept object's JSON, worked out once (kept objects are compared again on the next change). */
const seen = new WeakMap<object, string>();
const json = (o: object) => {
  let s = seen.get(o);
  if (s === undefined) {
    s = JSON.stringify(o);
    seen.set(o, s);
  }
  return s;
};
const same = (a: object | undefined, b: object) => a === b || (a !== undefined && json(a) === JSON.stringify(b));

function reuseTrack(old: Track | undefined, t: Track): Track {
  if (!old) return t;
  const byId = new Map<string, Clip>(old.clips.map((c) => [c.id, c]));
  const clips = t.clips.map((c) => {
    const o = byId.get(c.id);
    return o && same(o, c) ? o : c;
  });
  const { clips: _c1, ...headNew } = t;
  const { clips: _c2, ...headOld } = old;
  if (clips.length === old.clips.length && clips.every((c, i) => c === old.clips[i]) && JSON.stringify(headNew) === JSON.stringify(headOld)) return old;
  return { ...t, clips } as Track;
}

export function reuseProject(prev: Project | null, next: Project): Project {
  if (!prev || prev.id !== next.id) return next;
  const old = new Map(prev.tracks.map((t) => [t.id, t]));
  const tracks = next.tracks.map((t) => reuseTrack(old.get(t.id), t));
  const assets = same(prev.assets, next.assets) ? prev.assets : next.assets;
  const { tracks: _t1, assets: _a1, ...restNext } = next;
  const { tracks: _t2, assets: _a2, ...restPrev } = prev;
  const unchanged = tracks.length === prev.tracks.length && tracks.every((t, i) => t === prev.tracks[i]) && assets === prev.assets && JSON.stringify(restPrev) === JSON.stringify(restNext);
  return unchanged ? prev : { ...next, tracks, assets };
}
