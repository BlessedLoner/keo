// A copy of src/shared/audioLength.ts (the gateway is its own package): keep the two the same.
/**
 * How long a WAV or MP3 recording is, read from its own bytes (headers and frames, nothing
 * decoded), so a talking character's price is known before anything is sent. Keo Cloud reads the
 * uploaded file the same way (cloud/src/studio.ts), so the price cannot be talked down.
 */

/** Seconds of a WAV file (its fmt and data chunks); null when it is not a readable WAV. */
export function wavSeconds(b: Uint8Array, totalBytes = b.length): number | null {
  if (b.length < 44 || text(b, 0, 4) !== 'RIFF' || text(b, 8, 4) !== 'WAVE') return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let byteRate = 0;
  for (let at = 12; at + 8 <= b.length; ) {
    const id = text(b, at, 4);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 16 <= b.length) byteRate = v.getUint32(at + 16, true);
    if (id === 'data') {
      if (!byteRate) return null;
      // A data size of 0 or "unknown" (streamed files): what is left of the file.
      const data = size > 0 && size < 0xfffffff0 ? Math.min(size, totalBytes - at - 8) : totalBytes - at - 8;
      return data > 0 ? data / byteRate : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/**
 * Seconds of an MP3 (Layer III): from its Xing/Info or VBRI frame count when there is one, else
 * from the bit rate and the file size (constant bit rate). Null when no MP3 frame is found.
 */
export function mp3Seconds(b: Uint8Array, totalBytes = b.length): number | null {
  let at = 0;
  // An ID3v2 tag first: its size is in 7-bit bytes.
  if (b.length >= 10 && text(b, 0, 3) === 'ID3') at = 10 + ((b[6]! & 0x7f) << 21) + ((b[7]! & 0x7f) << 14) + ((b[8]! & 0x7f) << 7) + (b[9]! & 0x7f);
  for (let tries = 0; at + 4 <= b.length && tries < 65536; at++, tries++) {
    if (b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) continue;
    const version = (b[at + 1]! >> 3) & 3; // 3 MPEG-1, 2 MPEG-2, 0 MPEG-2.5
    const layer = (b[at + 1]! >> 1) & 3; // 1 = Layer III
    const kbpsIndex = b[at + 2]! >> 4;
    const rateIndex = (b[at + 2]! >> 2) & 3;
    if (version === 1 || layer !== 1 || kbpsIndex === 0 || kbpsIndex === 15 || rateIndex === 3) continue;
    const rate = RATES[version]![rateIndex]!;
    const kbps = (version === 3 ? MPEG1_KBPS : MPEG2_KBPS)[kbpsIndex]!;
    const perFrame = version === 3 ? 1152 : 576;
    const mono = b[at + 3]! >> 6 === 3;
    // A Xing/Info header (in the first frame, after the side information) or a VBRI one counts the frames.
    const side = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
    const tag = text(b, at + 4 + side, 4);
    if ((tag === 'Xing' || tag === 'Info') && at + 4 + side + 12 <= b.length) {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (v.getUint32(at + 4 + side + 4) & 1) return (v.getUint32(at + 4 + side + 8) * perFrame) / rate;
    }
    if (text(b, at + 36, 4) === 'VBRI' && at + 36 + 18 <= b.length) {
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return (v.getUint32(at + 36 + 14) * perFrame) / rate;
    }
    return ((totalBytes - at) * 8) / (kbps * 1000);
  }
  return null;
}

/** Seconds of a WAV or MP3 recording; null when it is neither (or cannot be read). */
export function audioSeconds(b: Uint8Array, totalBytes = b.length): number | null {
  return wavSeconds(b, totalBytes) ?? mp3Seconds(b, totalBytes);
}

/** About how long a script takes to say (about 2.6 words a second, plus a breath). */
export function speakingSeconds(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return words ? Math.round((words / 2.6 + 0.6) * 10) / 10 : 0;
}

function text(b: Uint8Array, at: number, n: number): string {
  let s = '';
  for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}
