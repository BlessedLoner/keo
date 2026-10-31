/**
 * Auto-captions for Keo Studio: where speech is in the timeline's sound (a simple loudness-based
 * voice detector), speech-to-text per stretch of speech, and caption lines of a few words each
 * with every word's time (for the karaoke highlight).
 *
 * With word times from the speech service (OpenAI) the words are exact. With text only (Keo
 * Cloud), each piece of speech is transcribed on its own and its words are spread over the voiced
 * parts of that piece by their length — close, but not exact.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}
export interface CaptionLine {
  text: string;
  start: number;
  end: number;
  words: Word[];
}
export interface Span {
  start: number;
  end: number;
}

/** 16-bit mono PCM samples from a WAV file (the render window makes 16 kHz mono). */
export function readWav(buf: Buffer): { rate: number; samples: Int16Array } {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file.');
  let at = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      rate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16 || channels !== 1 || !rate) throw new Error('Expected 16-bit mono sound.');
      const end = Math.min(buf.length, body + size);
      const copy = Buffer.from(buf.subarray(body, end - ((end - body) % 2)));
      return { rate, samples: new Int16Array(copy.buffer, copy.byteOffset, copy.length / 2) };
    }
    at = body + size + (size % 2);
  }
  throw new Error('The WAV file has no sound data.');
}

/** A 16-bit mono WAV file of samples[from..to) seconds. */
export function wavOf(samples: Int16Array, rate: number, from = 0, to = samples.length / rate): Buffer {
  const a = Math.max(0, Math.floor(from * rate));
  const b = Math.min(samples.length, Math.ceil(to * rate));
  const n = Math.max(0, b - a);
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(n * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset + a * 2, n * 2).copy(out, 44);
  return out;
}

/**
 * Stretches of speech (or any sound above the room's noise): 20 ms loudness frames against a
 * threshold well above the quietest tenth of the recording; short gaps are joined, blips dropped.
 */
export function voicedSpans(samples: Int16Array, rate: number, o: { minGap?: number; minSpan?: number } = {}): Span[] {
  const frame = Math.max(1, Math.round(rate * 0.02));
  const frames = Math.floor(samples.length / frame);
  if (!frames) return [];
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += samples[i]! * samples[i]!;
    db[f] = 10 * Math.log10(sum / frame / (32768 * 32768) + 1e-12);
  }
  const sorted = Array.from(db).sort((x, y) => x - y);
  const floor = sorted[Math.floor(frames * 0.1)]!;
  const peak = sorted[Math.floor(frames * 0.98)]!;
  // Quiet recordings: halfway between the noise and the loud parts; never below -50 dB.
  const threshold = Math.max(-50, Math.min(floor + 12, (floor + peak) / 2));
  const minGap = o.minGap ?? 0.3;
  const minSpan = o.minSpan ?? 0.12;
  const spans: Span[] = [];
  let open = -1;
  for (let f = 0; f <= frames; f++) {
    const on = f < frames && db[f]! > threshold;
    if (on && open < 0) open = f;
    if (!on && open >= 0) {
      spans.push({ start: (open * frame) / rate, end: (f * frame) / rate });
      open = -1;
    }
  }
  const joined: Span[] = [];
  for (const s of spans) {
    const last = joined.at(-1);
    if (last && s.start - last.end < minGap) last.end = s.end;
    else joined.push({ ...s });
  }
  return joined.filter((s) => s.end - s.start >= minSpan).map((s) => ({ start: round(Math.max(0, s.start - 0.05)), end: round(Math.min(samples.length / rate, s.end + 0.08)) }));
}

/** Speech grouped into pieces of at most maxSec (split at the pauses), for transcribing one by one. */
export function pieces(spans: Span[], maxSec = 14): Span[][] {
  const out: Span[][] = [];
  let cur: Span[] = [];
  for (const s of spans) {
    // A very long stretch without a pause is cut into maxSec parts.
    for (let a = s.start; a < s.end; a += maxSec) {
      const part = { start: a, end: Math.min(s.end, a + maxSec) };
      if (cur.length && part.end - cur[0]!.start > maxSec) {
        out.push(cur);
        cur = [];
      }
      cur.push(part);
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Nobody says more than this many words a second (fast talkers manage about 4). */
const MAX_WORDS_PER_SECOND = 5;

/**
 * Speech-to-text sometimes gets stuck and repeats itself ("the um, the um, the um…" for a minute)
 * over pauses or music. Keeps the first of any run of the same phrase said 3 or more times in a
 * row (a single word 4 or more times: "no, no, no" is real speech), and no more words than
 * `seconds` of speech can hold.
 */
export function dropLoops<T>(items: T[], textOf: (x: T) => string, seconds = Infinity): T[] {
  const key = (x: T) => textOf(x).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '');
  const keys = items.map(key);
  const same = (a: number, b: number, n: number) => {
    for (let k = 0; k < n; k++) if (keys[a + k] !== keys[b + k]) return false;
    return true;
  };
  const out: T[] = [];
  let i = 0;
  while (i < items.length) {
    let skip = 0;
    for (let n = 1; n <= 8 && !skip; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= items.length && same(i, i + reps * n, n)) reps++;
      if (reps >= (n === 1 ? 4 : 3) && keys.slice(i, i + n).some(Boolean)) skip = n * reps;
      if (skip) for (let k = 0; k < n; k++) out.push(items[i + k]!);
    }
    if (skip) i += skip;
    else out.push(items[i++]!);
  }
  return out.slice(0, Math.max(1, Math.ceil(seconds * MAX_WORDS_PER_SECOND) + 3));
}

/** Words of a transcript spread over voiced spans by their length (longer words take longer). */
export function spreadWords(text: string, spans: Span[]): Word[] {
  const words = text.split(/\s+/).map((w) => w.trim()).filter(Boolean);
  const total = spans.reduce((t, s) => t + (s.end - s.start), 0);
  if (!words.length || total <= 0) return [];
  const weight = (w: string) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1.5;
  const sum = words.reduce((t, w) => t + weight(w), 0);
  // Positions along the voiced time only (pauses between spans are skipped).
  const at = (pos: number) => {
    let left = pos;
    for (const s of spans) {
      const len = s.end - s.start;
      if (left <= len) return s.start + left;
      left -= len;
    }
    return spans.at(-1)!.end;
  };
  const out: Word[] = [];
  let pos = 0;
  for (const w of words) {
    const len = (weight(w) / sum) * total;
    out.push({ text: w, start: round(at(pos + 0.001)), end: round(at(pos + len)) });
    pos += len;
  }
  return out;
}

/**
 * Caption lines: up to maxWords words (and maxChars letters), a new line after a sentence ends
 * or at a pause; each line stays on screen until the next one (or a moment after its last word).
 */
export function captionLines(words: Word[], o: { maxWords?: number; maxChars?: number } = {}): CaptionLine[] {
  const maxWords = o.maxWords ?? 3;
  const maxChars = o.maxChars ?? 22;
  const lines: CaptionLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    lines.push({ text: cur.map((w) => w.text).join(' '), start: cur[0]!.start, end: cur.at(-1)!.end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const prev = cur.at(-1);
    const chars = cur.reduce((t, x) => t + x.text.length + 1, 0) + w.text.length;
    if (prev && (cur.length >= maxWords || chars > maxChars || w.start - prev.end > 0.45 || /[.!?…]$/.test(prev.text))) flush();
    cur.push(w);
  }
  flush();
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const l = lines[i]!;
    l.end = round(next ? Math.min(next.start, l.end + 0.25) : l.end + 0.4);
    if (l.end - l.start < 0.3) l.end = round(next ? Math.max(l.end, Math.min(next.start, l.start + 0.3)) : l.start + 0.3);
  }
  return lines.filter((l) => l.end > l.start);
}

const round = (v: number) => Math.round(v * 1000) / 1000;
