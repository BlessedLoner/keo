/** Keo Studio — the video codecs an export can use, and asking whether this PC can encode one. */
import type { ExportVideoCodec } from '@shared/studio';

/** The codec strings to try for each export codec, most compatible first. */
export const CODECS: Record<ExportVideoCodec, string[]> = {
  // H.264: Constrained Baseline first (no B-frames).
  h264: ['avc1.42e033', 'avc1.42e02a', 'avc1.4d0033', 'avc1.640033'],
  // H.265 Main at level 4.1, 5.0, 5.1 (4K), 6.1.
  h265: ['hvc1.1.6.L123.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L183.B0'],
  // VP9 profile 0 (8-bit 4:2:0) at level 4.0, 4.1, 5.0, 5.1, 6.0.
  vp9: ['vp09.00.40.08', 'vp09.00.41.08', 'vp09.00.50.08', 'vp09.00.51.08', 'vp09.00.60.08'],
};
export const CODEC_NAMES: Record<ExportVideoCodec, string> = { h264: 'H.264', h265: 'H.265', vp9: 'VP9' };

export function encoderConfig(family: ExportVideoCodec, codec: string, w: number, h: number, fps: number, bitrate: number, hardwareAcceleration: HardwareAcceleration, latencyMode: LatencyMode): VideoEncoderConfig {
  const base: VideoEncoderConfig = { codec, width: w, height: h, bitrate, framerate: fps, hardwareAcceleration, latencyMode };
  // The stream description (avcC / hvcC) is given apart from the frames, as MP4 wants it.
  if (family === 'h264') return { ...base, avc: { format: 'avc' } };
  if (family === 'h265') return { ...base, hevc: { format: 'hevc' } } as VideoEncoderConfig;
  return base;
}

/** Whether this PC can encode the codec at this size (asked before an export starts). */
export async function canEncode(family: ExportVideoCodec, w: number, h: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  for (const hardwareAcceleration of ['no-preference', 'prefer-hardware', 'prefer-software'] as const) {
    for (const codec of CODECS[family]) {
      const ok = await VideoEncoder.isConfigSupported(encoderConfig(family, codec, w, h, fps, Math.round(w * h * fps * 0.1), hardwareAcceleration, 'quality')).catch(() => ({ supported: false }));
      if (ok.supported) return true;
    }
  }
  return false;
}
