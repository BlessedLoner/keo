import { useEffect, useState } from 'react';
import type { Asset } from '@shared/studio';
import { mediaUrl } from './media';

/**
 * Timeline pictures: small frames along a video (a filmstrip) and the shape of a sound (a
 * waveform). Each is made once per media file in the background and kept for this session.
 */

export interface Filmstrip {
  /** Seconds between frames. */
  step: number;
  /** Small JPEG frames (data URLs), from 0 s. */
  frames: string[];
  /** Frame width ÷ height. */
  aspect: number;
}

const THUMB_H = 48;
const strips = new Map<string, Promise<Filmstrip | null>>();
const waves = new Map<string, Promise<Float32Array | null>>();
/** One video decoded at a time, so thumbnails never slow the preview down. */
let queue: Promise<unknown> = Promise.resolve();

function makeStrip(projectId: string, a: Asset): Promise<Filmstrip | null> {
  if (a.kind === 'image') {
    return new Promise((res) => {
      const i = new Image();
      i.crossOrigin = 'anonymous';
      i.onload = () => {
        const c = document.createElement('canvas');
        c.height = THUMB_H;
        c.width = Math.max(8, Math.round((THUMB_H * i.naturalWidth) / Math.max(1, i.naturalHeight)));
        c.getContext('2d')!.drawImage(i, 0, 0, c.width, c.height);
        res({ step: Infinity, frames: [c.toDataURL('image/jpeg', 0.7)], aspect: c.width / c.height });
      };
      i.onerror = () => res(null);
      i.src = mediaUrl(projectId, a.id);
    });
  }
  const run = async (): Promise<Filmstrip | null> => {
    const v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.muted = true;
    v.preload = 'auto';
    v.src = mediaUrl(projectId, a.id);
    try {
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res();
        v.onerror = () => rej(new Error('no video'));
      });
      const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : a.duration;
      // About 60 frames for the whole video, at least one a second for short ones.
      const step = Math.max(1, dur / 60);
      const c = document.createElement('canvas');
      c.height = THUMB_H;
      c.width = Math.max(8, Math.round((THUMB_H * v.videoWidth) / Math.max(1, v.videoHeight)));
      const ctx = c.getContext('2d')!;
      const frames: string[] = [];
      for (let t = 0; t < dur; t += step) {
        await new Promise<void>((res) => {
          const done = () => {
            v.removeEventListener('seeked', done);
            res();
          };
          v.addEventListener('seeked', done);
          v.currentTime = Math.min(dur - 0.05, t + Math.min(0.2, step / 2));
          setTimeout(done, 1500);
        });
        ctx.drawImage(v, 0, 0, c.width, c.height);
        frames.push(c.toDataURL('image/jpeg', 0.6));
      }
      return { step, frames, aspect: c.width / c.height };
    } catch {
      return null;
    } finally {
      v.removeAttribute('src');
      v.load();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

/** The peaks (0..1) of a sound, 50 per second of the media. */
function makeWave(projectId: string, a: Asset): Promise<Float32Array | null> {
  const run = async () => {
    try {
      const bytes = await (await fetch(mediaUrl(projectId, a.id))).arrayBuffer();
      const buf = await new OfflineAudioContext(1, 1, 8000).decodeAudioData(bytes);
      const per = Math.max(1, Math.round(buf.sampleRate / 50));
      const n = Math.ceil(buf.length / per);
      const out = new Float32Array(n);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let j = i * per; j < Math.min(d.length, (i + 1) * per); j++) m = Math.max(m, Math.abs(d[j]!));
          out[i] = Math.max(out[i]!, m);
        }
      }
      // Loud enough to read: scaled to the loudest moment (never more than 4×).
      let peak = 0;
      for (const v of out) peak = Math.max(peak, v);
      const g = peak > 0 ? Math.min(4, 1 / peak) : 1;
      for (let i = 0; i < n; i++) out[i] = Math.min(1, out[i]! * g);
      return out;
    } catch {
      return null;
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

export function useFilmstrip(projectId: string, a: Asset | undefined): Filmstrip | null {
  const [s, setS] = useState<Filmstrip | null>(null);
  useEffect(() => {
    if (!a || a.kind === 'audio') return setS(null);
    const key = `${projectId}/${a.id}`;
    if (!strips.has(key)) strips.set(key, makeStrip(projectId, a));
    let live = true;
    void strips.get(key)!.then((r) => live && setS(r));
    return () => {
      live = false;
    };
  }, [projectId, a]);
  return s;
}

export function useWaveform(projectId: string, a: Asset | undefined): Float32Array | null {
  const [w, setW] = useState<Float32Array | null>(null);
  useEffect(() => {
    if (!a || !a.hasAudio || a.kind === 'image') return setW(null);
    const key = `${projectId}/${a.id}`;
    if (!waves.has(key)) waves.set(key, makeWave(projectId, a));
    let live = true;
    void waves.get(key)!.then((r) => live && setW(r));
    return () => {
      live = false;
    };
  }, [projectId, a]);
  return w;
}
