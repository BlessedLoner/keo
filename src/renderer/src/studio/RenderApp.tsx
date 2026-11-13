import { useEffect } from 'react';
import type { Project } from '@shared/studio';
import { invoke, subscribe } from '../lib/api';
import { assetSheet, assetMotion, assetSignatures, compareTimeline, timelineMotion, videoBars, assetWav, denoiseAsset, exportFile, trackMotion, probe, renderFrames, reviewSamples, runExport, speechWav } from './exporter';

/**
 * Keo's hidden render window: it does the Studio's heavy work (exports, frames for Keo to look at,
 * measuring media) with the PC's video codecs, away from the Studio page so the page stays smooth.
 */
export function RenderApp() {
  useEffect(() => {
    let cancelled = false;
    // Exports the user stopped.
    const stopped = new Set<string>();
    const off = subscribe('studio:job', (msg) => {
      if (msg.job.kind === 'cancel') {
        stopped.add(msg.job.exportId);
        return;
      }
      void (async () => {
        console.info(`render job ${msg.job.kind}`);
        try {
          let result: unknown;
          if (msg.job.kind === 'probe') result = await probe(msg.job.url);
          else if (msg.job.kind !== 'cancel') {
            const p = (await invoke('studio:get', { id: msg.job.projectId })) as Project;
            if (msg.job.kind === 'frames') result = await renderFrames(p, msg.job.times, msg.job.width);
            else if (msg.job.kind === 'audio') result = await speechWav(p, msg.job.sampleRate);
            else if (msg.job.kind === 'asset_audio') result = await assetWav(p, msg.job.assetId, msg.job.sampleRate);
            else if (msg.job.kind === 'export_file') {
              const exportId = msg.job.exportId;
              result = await exportFile(
                p,
                msg.job.format,
                (pr) => void invoke('studio:exportProgress', { projectId: p.id, ...pr }).catch(() => undefined),
                () => cancelled || stopped.has(exportId),
              );
            } else if (msg.job.kind === 'track') result = await trackMotion(p, msg.job.assetId, msg.job.times, msg.job.box);
            else if (msg.job.kind === 'denoise') result = await denoiseAsset(p, msg.job.assetId, msg.job.strength);
            else if (msg.job.kind === 'signatures') result = await assetSignatures(p, msg.job.assetId, msg.job.times);
            else if (msg.job.kind === 'motion') result = await assetMotion(p, msg.job.assetId, msg.job.pairs);
            else if (msg.job.kind === 'compare') result = await compareTimeline(p, msg.job.assetId, msg.job.times, msg.job.source);
            else if (msg.job.kind === 'bars') result = await videoBars(p, msg.job.assetId, msg.job.times);
            else if (msg.job.kind === 'timeline_motion') result = await timelineMotion(p, msg.job.pairs);
            else if (msg.job.kind === 'review') result = await reviewSamples(p, msg.job.times);
            else if (msg.job.kind === 'asset_sheet') result = await assetSheet(p, msg.job.assetId);
            else if (msg.job.kind === 'export') {
              const exportId = msg.job.exportId;
              result = await runExport(
                p,
                exportId,
                (pr) => void invoke('studio:exportProgress', { projectId: p.id, ...pr }).catch(() => undefined),
                () => cancelled || stopped.has(exportId),
                msg.job.size,
              );
            }
          }
          await invoke('studio:jobDone', { jobId: msg.jobId, result: result ?? null, error: null });
        } catch (e) {
          console.error(`render job failed: ${e instanceof Error ? e.message : String(e)}`);
          await invoke('studio:jobDone', { jobId: msg.jobId, result: null, error: e instanceof Error ? e.message.slice(0, 400) : 'The render failed.' });
        }
      })();
    });
    void invoke('studio:renderReady', {}).catch(() => undefined);
    return () => {
      cancelled = true;
      off();
    };
  }, []);
  return null;
}
