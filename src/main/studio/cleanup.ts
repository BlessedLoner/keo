import { clipEnd, mergeRanges, projectDuration, timelineSpeech, timelineWords, type EditOp, type MediaClip, type Project, type Zoom } from '../../shared/studio';

/**
 * The talking-head clean-up: which parts of the timeline to cut so only the good takes remain —
 * long pauses (from Keo's own speech analysis), filler words and retakes (from the transcript).
 * Nothing here changes the project; Studio cuts the ranges in one edit (one undo).
 */

export interface Cut {
  from: number;
  to: number;
  reason: 'silence' | 'filler' | 'retake';
  /** What was said there (fillers and retakes). */
  text?: string;
}

type TWord = { text: string; start: number; end: number };

/** Filler sounds that are never words a sentence needs. "like", "so", "you know" are left alone. */
const FILLERS = new Set(['um', 'umm', 'ummm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'err', 'ah', 'ahh', 'hmm', 'hm', 'mm', 'mmm', 'eh']);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Pauses longer than minSilence between stretches of speech, cut down to `keep` seconds on each
 * side (so speech never starts or ends abruptly). With `ends`, also the silence before the first
 * and after the last words.
 */
export function silenceCuts(p: Project, o: { minSilence?: number; keep?: number; ends?: boolean } = {}): Cut[] {
  const minSilence = o.minSilence ?? 0.6;
  const keep = o.keep ?? 0.15;
  const speech = timelineSpeech(p);
  const end = projectDuration(p);
  if (!speech.length) return [];
  const cuts: Cut[] = [];
  const gap = (from: number, to: number, startKeep: number, endKeep: number) => {
    const a = from + startKeep;
    const b = to - endKeep;
    if (to - from >= minSilence && b - a >= 0.05) cuts.push({ from: round(a), to: round(b), reason: 'silence' });
  };
  if (o.ends !== false) gap(0, speech[0]!.start, 0, keep);
  for (let i = 1; i < speech.length; i++) gap(speech[i - 1]!.end, speech[i]!.start, keep, keep);
  if (o.ends !== false) gap(speech.at(-1)!.end, end, keep, 0);
  return cuts;
}

/** Filler words ("um", "uh"…), cut close around them without touching the words beside them. */
export function fillerCuts(words: TWord[]): Cut[] {
  const cuts: Cut[] = [];
  words.forEach((w, i) => {
    if (!FILLERS.has(norm(w.text))) return;
    const prev = words[i - 1];
    const next = words[i + 1];
    const from = Math.max(prev ? prev.end : 0, w.start - 0.04);
    const to = Math.min(next ? next.start : w.end + 0.08, w.end + 0.06);
    if (to - from >= 0.06) cuts.push({ from: round(from), to: round(to), reason: 'filler', text: w.text });
  });
  return cuts;
}

/** The transcript split into phrases at sentence ends and pauses. */
function phrases(words: TWord[]): TWord[][] {
  const out: TWord[][] = [];
  let cur: TWord[] = [];
  for (const w of words) {
    const prev = cur.at(-1);
    if (prev && (w.start - prev.end > 0.55 || /[.!?…]$/.test(prev.text))) {
      out.push(cur);
      cur = [];
    }
    if (!FILLERS.has(norm(w.text))) cur.push(w);
  }
  if (cur.length) out.push(cur);
  return out.filter((ph) => ph.length);
}

/**
 * Restarts without a pause: the same run of words said again straight after ("this is the… this is
 * the best part"), or a stutter ("the the"). The first go is cut, up to where the words start again.
 */
function repeats(words: TWord[]): Cut[] {
  const ws = words.filter((x) => !FILLERS.has(norm(x.text)));
  const cuts: Cut[] = [];
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j <= Math.min(ws.length - 1, i + 12); j++) {
      if (ws[j]!.start - ws[i]!.start > 12) break;
      let m = 0;
      while (i + m < j && j + m < ws.length && norm(ws[i + m]!.text) && norm(ws[i + m]!.text) === norm(ws[j + m]!.text)) m++;
      // The whole first go is repeated (two words or more), or one word said twice in a row.
      if (m === j - i && (m >= 2 || (m === 1 && j === i + 1))) {
        cuts.push({ from: round(Math.max(0, ws[i]!.start - 0.05)), to: round(ws[j]!.start - 0.05), reason: 'retake', text: ws.slice(i, j).map((x) => x.text).join(' ') });
        i = j - 1;
        break;
      }
    }
  }
  return cuts;
}

/**
 * Retakes: a phrase the speaker starts again soon after (the same first words), or abandons and
 * says again in full; also a run of words said again at once. The earlier take is cut, up to where
 * the new one starts; the last take stays.
 */
export function retakeCuts(words: TWord[]): Cut[] {
  const ph = phrases(words);
  const cuts: Cut[] = repeats(words);
  for (let i = 0; i < ph.length - 1; i++) {
    const a = ph[i]!;
    const head = a.slice(0, Math.min(3, a.length)).map((w) => norm(w.text));
    if (head.length < 2 && a.length < 2) continue;
    // A new take starts within the next few phrases and the next 20 seconds.
    for (let j = i + 1; j < Math.min(ph.length, i + 4); j++) {
      const b = ph[j]!;
      if (b[0]!.start - a[0]!.start > 20) break;
      const bHead = b.slice(0, head.length).map((w) => norm(w.text));
      if (bHead.length === head.length && bHead.every((w, k) => w === head[k])) {
        cuts.push({ from: round(Math.max(0, a[0]!.start - 0.05)), to: round(b[0]!.start - 0.05), reason: 'retake', text: ph.slice(i, j).map((x) => x.map((w) => w.text).join(' ')).join(' … ') });
        i = j - 1;
        break;
      }
    }
  }
  // One cut where both ways found the same retake.
  const out: Cut[] = [];
  for (const c of cuts.sort((x, y) => x.from - y.from)) {
    const last = out.at(-1);
    if (last && c.from <= last.to) {
      last.to = Math.max(last.to, c.to);
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

export interface CleanupPlan {
  cuts: Cut[];
  /** Seconds removed in all (overlaps counted once). */
  seconds: number;
  /** Why some kinds could not be found. */
  notes: string[];
}

/** What a clean-up would cut, from what Keo knows about the timeline's speech. */
export function planCleanup(p: Project, o: { silences?: boolean; fillers?: boolean; retakes?: boolean; minSilence?: number; keep?: number }): CleanupPlan {
  const notes: string[] = [];
  const cuts: Cut[] = [];
  if (o.silences) cuts.push(...silenceCuts(p, { ...(o.minSilence !== undefined ? { minSilence: o.minSilence } : {}), ...(o.keep !== undefined ? { keep: o.keep } : {}) }));
  if (o.fillers || o.retakes) {
    const words = timelineWords(p);
    if (!words.length) notes.push('Filler words and retakes need the transcript first.');
    else {
      if (words.some((w) => !w.exact)) notes.push('Some word times are close, not exact (no OpenAI key), so cuts around words may be a little off.');
      if (o.fillers) cuts.push(...fillerCuts(words));
      if (o.retakes) cuts.push(...retakeCuts(words));
    }
  }
  const merged = mergeRanges(cuts);
  return { cuts: cuts.sort((a, b) => a.from - b.from), seconds: round(merged.reduce((t, r) => t + r.to - r.from, 0)), notes };
}

/**
 * Punch-ins for a talking head: at each new phrase the shot jumps between normal and a closer
 * framing (like a second camera), centred on where a face usually is (a little above the middle).
 * Returns  edits for the video clips of the bottom video track.
 */
export function punchIns(p: Project, o: { scale?: number; x?: number; y?: number; minGap?: number } = {}): { ops: EditOp[]; points: number } {
  const scale = o.scale ?? 1.15;
  const minGap = o.minGap ?? 2.5;
  const words = timelineWords(p);
  // New phrases: after a pause or a sentence end (else: where speech starts again).
  const starts: number[] = [];
  if (words.length) {
    words.forEach((w, i) => {
      const prev = words[i - 1];
      if (!prev || w.start - prev.end > 0.35 || /[.!?…,]$/.test(prev.text)) starts.push(w.start);
    });
  } else for (const s of timelineSpeech(p)) starts.push(s.start);
  const chosen: number[] = [];
  for (const t of starts) if (!chosen.length || t - chosen.at(-1)! >= minGap) chosen.push(t);
  const base = p.tracks.find((t) => t.kind === 'video');
  const ops: EditOp[] = [];
  let points = 0;
  let close = false;
  for (const c of (base?.clips ?? []) as MediaClip[]) {
    if (c.type !== 'media' || p.assets.find((a) => a.id === c.assetId)?.kind !== 'video') continue;
    const zooms: Zoom[] = [];
    for (const t of chosen) {
      if (t < c.start || t >= clipEnd(c) - 0.3) continue;
      close = !close;
      zooms.push({ at: round(Math.max(0, t - c.start - 0.03)), scale: close ? scale : 1, x: o.x ?? 0.5, y: o.y ?? 0.42, ease: 'cut' });
    }
    if (zooms.length) {
      ops.push({ op: 'set', clip: c.id, zooms });
      points += zooms.length;
    }
  }
  return { ops, points };
}
