import { useEffect, useRef } from 'react';
import { projectDuration, type Project } from '@shared/studio';
import { drawFrame } from './engine';
import { PreviewSources } from './media';

/**
 * The Studio's live preview: the project drawn by Keo's picture engine at the playhead, with the
 * clips' media playing in step while it plays.
 */
export function Preview({ project, time, playing, onTime, onEnd }: { project: Project; time: number; playing: boolean; onTime: (t: number) => void; onEnd: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const sources = useRef<PreviewSources | null>(null);
  const live = useRef({ project, time, playing });
  live.current = { project, time, playing };
  const redraw = useRef<() => void>(() => undefined);

  // Media for this project (made again when another project opens).
  useEffect(() => {
    const s = new PreviewSources(project.id, () => redraw.current());
    sources.current = s;
    return () => {
      s.dispose();
      if (sources.current === s) sources.current = null;
    };
  }, [project.id]);

  // The canvas keeps the project's shape and fits its box.
  useEffect(() => {
    const el = box.current;
    const c = canvas.current;
    if (!el || !c) return;
    const fit = () => {
      const { width, height } = el.getBoundingClientRect();
      const ar = project.width / project.height;
      let w = width;
      let h = width / ar;
      if (h > height) {
        h = height;
        w = height * ar;
      }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.style.width = `${Math.floor(w)}px`;
      c.style.height = `${Math.floor(h)}px`;
      // Never more pixels than the export itself.
      const scale = Math.min(dpr, project.width / Math.max(1, w));
      c.width = Math.max(16, Math.round(w * scale));
      c.height = Math.max(16, Math.round(h * scale));
      redraw.current();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.width, project.height]);

  redraw.current = () => {
    const c = canvas.current;
    const s = sources.current;
    if (!c || !s) return;
    const ctx = c.getContext('2d');
    if (ctx) drawFrame(ctx, live.current.project, live.current.time, s);
  };

  // Paused: show the playhead's frame (and put the media there).
  useEffect(() => {
    if (playing) return;
    sources.current?.prune(project);
    sources.current?.sync(project, time, false);
    redraw.current();
  }, [project, time, playing]);

  // Playing: a clock from where play started, the media in step, a frame per screen refresh.
  useEffect(() => {
    if (!playing) {
      sources.current?.pauseAll();
      return;
    }
    const startAt = performance.now();
    const from = live.current.time;
    const end = projectDuration(live.current.project);
    let raf = 0;
    let lastReport = 0;
    const tick = () => {
      const t = from + (performance.now() - startAt) / 1000;
      if (t >= end) {
        onTime(end);
        onEnd();
        return;
      }
      live.current.time = t;
      sources.current?.sync(live.current.project, t, true);
      redraw.current();
      if (performance.now() - lastReport > 66) {
        lastReport = performance.now();
        onTime(t);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Restart the clock only when play starts or stops.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  return (
    <div className="studio-preview" ref={box}>
      <canvas ref={canvas} aria-label="Video preview" />
    </div>
  );
}
