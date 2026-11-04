import { useEffect, useState } from 'react';
import { motionCloneCost, studioPrice, swapCost, type SwapResolution } from '@shared/aiPrices';
import type { Character } from '@shared/studioCharacters';
import type { Asset } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { StudioCredits, useStudioAi } from './StudioCredits';

/**
 * Clone a video with a character: the user picks a content video and one of their characters;
 * Keo puts the video in a new project and swaps the person in it for the character (Keo Cloud's
 * Studio credits, or the user's own fal.ai key: the price is shown before anything is paid). The
 * original sound stays.
 *
 * The user chooses the part to clone (15 s to start with: the price grows with every second) and
 * how: Stable (the character performs the video's moves, the same person in every frame) or
 * Quick (painted over the person frame by frame: cheaper, can flicker).
 */
export function CloneVideo({ onDone, onCancel, onCharacters }: { onDone: (projectId: string) => void; onCancel: () => void; onCharacters: () => void }) {
  const ui = useUi();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [character, setCharacter] = useState('');
  const [resolution, setResolution] = useState<SwapResolution>('480p');
  const [picked, setPicked] = useState<{
    projectId: string;
    clip: string;
    asset: Asset;
  } | null>(null);
  const [busy, setBusy] = useState<'pick' | 'clone' | null>(null);
  const [from, setFrom] = useState(0);
  const [length, setLength] = useState(15);
  const [smooth, setSmooth] = useState(false);
  const [mode, setMode] = useState<'stable' | 'quick'>('stable');
  const max = mode === 'stable' ? 30 : 60;
  const ai = useStudioAi();
  const [steps, setSteps] = useState<Array<{
    label: string;
    status: string;
    note?: string;
  }> | null>(null);
  const pickedId = picked?.projectId ?? null;
  useEffect(
    () =>
      subscribe('studio:progress', (m) => {
        if (m.projectId === pickedId && m.stage === 'checklist' && m.steps) setSteps(m.steps);
      }),
    [pickedId],
  );
  const via = ai.status?.via ?? null;
  const ready = !ai.status || via !== null;
  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then((list) => {
        const usable = list.filter((c) => c.pictures.length > 0);
        setCharacters(usable);
        setCharacter((c) => c || usable[0]?.id || '');
      })
      .catch(() => undefined);
  }, []);

  const pick = async () => {
    setBusy('pick');
    try {
      const p = await invoke('studio:create', {
        name: 'Cloned video',
        format: 'vertical',
      });
      const r = await invoke('studio:import', { id: p.id });
      const video = r.added.find((a) => a.kind === 'video');
      if (!video) {
        await invoke('studio:delete', { id: p.id }).catch(() => undefined);
        if (r.added.length || r.skipped.length) ui.error('Choose a video file (MP4 or MOV).');
        return;
      }
      // The project takes the video's shape, then the video goes on the timeline.
      const wide = video.width > video.height * 1.15;
      const square = !wide && video.height <= video.width * 1.15;
      const shaped = await invoke('studio:edit', {
        id: p.id,
        ops: [
          {
            op: 'set_project',
            name: `Cloned ${video.name.replace(/\.[^.]+$/, '')}`.slice(0, 120),
            width: wide ? 1920 : 1080,
            height: wide ? 1080 : square ? 1080 : 1920,
          },
          // The first 15 s to start with (only the chosen part is sent and paid for).
          {
            op: 'add_media',
            assetId: video.id,
            start: 0,
            duration: Math.min(15, video.duration),
          },
        ],
      });
      const clip = shaped.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.assetId === video.id);
      if (clip) {
        setPicked({ projectId: p.id, clip: clip.id, asset: video });
        setFrom(0);
        setLength(Math.round(Math.min(15, video.duration) * 10) / 10);
      }
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const who = characters.find((c) => c.id === character);
  const total = picked?.asset.duration ?? 0;
  const start = Math.max(0, Math.min(from, Math.max(0, total - 1)));
  const seconds = picked ? Math.max(1, Math.min(length, max, total - start)) : 0;
  const fps = smooth ? 30 : 16;
  const priceOf = (s: number) => (mode === 'stable' ? motionCloneCost(s) : swapCost(s, fps, resolution));
  const price = picked ? priceOf(seconds) : 0;
  const clone = async () => {
    if (!picked || !who) return;
    const ok = await ui.confirm({
      title: `Put ${who.name} in this video?`,
      body:
        mode === 'stable'
          ? `Keo puts ${who.name} into the video’s first frame (same place, pose and light), then the AI films ${who.name} doing exactly the moves of ${seconds.toFixed(1)} s of the video (from ${fmt(start)}): ${who.name} in every frame, the original sound kept. About ${studioPrice(price, via)}. It takes several minutes: the new clip appears on the timeline by itself.`
          : `Keo sends ${seconds.toFixed(1)} s of the video (from ${fmt(start)}) and ${who.name}’s main picture to the AI, which paints ${who.name} over the person frame by frame (cheaper, but the original person can flicker through). About ${studioPrice(price, via)} at ${resolution}. The new clip appears on the timeline by itself.`,
      confirmLabel: `Clone it (about ${studioPrice(price, via)})`,
    });
    if (!ok) return;
    setBusy('clone');
    try {
      // The clip becomes the chosen part (it is what is sent), then the swap.
      let clip = picked.clip;
      const before = await invoke('studio:get', { id: picked.projectId });
      const old = before.tracks.flatMap((t) => t.clips).find((c) => c.id === clip);
      if (!old || old.type !== 'media' || Math.abs(old.in - start) > 0.01 || Math.abs(old.duration - seconds) > 0.01) {
        const shaped = await invoke('studio:edit', {
          id: picked.projectId,
          ops: [
            ...(old ? [{ op: 'delete' as const, clip }] : []),
            {
              op: 'add_media',
              assetId: picked.asset.id,
              start: 0,
              in: start,
              duration: seconds,
            },
          ],
        });
        const added = shaped.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.assetId === picked.asset.id);
        if (!added) throw new Error('Keo could not place that part of the video.');
        clip = added.id;
        setPicked({ ...picked, clip });
      }
      const r = await invoke('studio:swap', {
        id: picked.projectId,
        clip,
        character: who.id,
        resolution,
        smooth,
        mode,
      });
      ai.refresh();
      ui.toast(r.pending ? `Keo is making it: ${who.name} appears on the timeline by itself when it is ready.` : r.cached ? 'Made before: used again, nothing paid.' : `Done: ${who.name} is in the video.`, 'success');
      onDone(picked.projectId);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="studio-empty">
      <div className="studio-new faceless">
        <Icon name="film" size={30} />
        <h2>Clone a video with your character</h2>
        <p className="muted">Pick a content video and one of your characters: Keo replaces the person in the video with your character, keeping the movement, expressions, timing and sound. Use videos you have the right to use.</p>
        <StudioCredits status={ai.status} compact />
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="cl-char">Character</label>
            {characters.length ? (
              <select id="cl-char" className="select" value={character} onChange={(e) => setCharacter(e.target.value)} disabled={!!busy}>
                {characters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <button className="btn sm" onClick={onCharacters}>
                Add a character with a picture first
              </button>
            )}
          </div>
          <div className="field">
            <label htmlFor="cl-mode">How</label>
            <select id="cl-mode" className="select" value={mode} onChange={(e) => setMode(e.target.value as 'stable' | 'quick')} disabled={!!busy}>
              <option value="stable">Stable: exact character, no flicker</option>
              <option value="quick">Quick swap: cheaper, can flicker</option>
            </select>
          </div>
          {mode === 'quick' && (
            <div className="field">
              <label htmlFor="cl-motion">Motion</label>
              <select id="cl-motion" className="select" value={smooth ? 'smooth' : 'standard'} onChange={(e) => setSmooth(e.target.value === 'smooth')} disabled={!!busy}>
                <option value="standard">Standard (16 fps): about half the price</option>
                <option value="smooth">Smooth (30 fps): for fast movement</option>
              </select>
            </div>
          )}
          {mode === 'quick' && (
            <div className="field">
              <label htmlFor="cl-res">Quality</label>
              <select id="cl-res" className="select" value={resolution} onChange={(e) => setResolution(e.target.value as SwapResolution)} disabled={!!busy}>
                <option value="480p">480p: cheapest, good for a first try</option>
                <option value="580p">580p</option>
                <option value="720p">720p: best</option>
              </select>
            </div>
          )}
        </div>
        {who && (
          <div className="clone-who">
            <img src={`app://keo/character/${who.id}/0?v=${encodeURIComponent(who.pictures[0]!)}`} alt="" />
            <span className="small muted">{who.name}’s main picture is the face Keo uses.</span>
          </div>
        )}
        <div className="field">
          <label>Content video</label>
          {picked ? (
            <div className="clone-part">
              <p className="small">
                <strong>{picked.asset.name}</strong> · {fmt(total)} long
              </p>
              {total > 1.5 && (
                <div className="faceless-grid">
                  <div className="field">
                    <label htmlFor="cl-from">Start at: {fmt(start)}</label>
                    <input id="cl-from" type="range" min={0} max={Math.max(0, Math.floor(total - 1))} step={0.5} value={start} onChange={(e) => setFrom(Number(e.target.value))} disabled={!!busy} />
                  </div>
                  <div className="field">
                    <label htmlFor="cl-len">How long: {seconds.toFixed(1)} s</label>
                    <input id="cl-len" type="range" min={1} max={Math.max(1, Math.min(max, Math.floor(total - start)))} step={0.5} value={seconds} onChange={(e) => setLength(Number(e.target.value))} disabled={!!busy} />
                  </div>
                </div>
              )}
              <p className="small">
                Cloning {fmt(start)} to {fmt(start + seconds)} · about <strong>{studioPrice(price, via)}</strong> at {resolution}
                <span className="muted">
                  {' '}
                  (each second adds about {studioPrice((priceOf(11) - priceOf(1)) / 10, via)}; up to {max} s at a time)
                </span>
              </p>
            </div>
          ) : (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void pick()} disabled={!!busy}>
              {busy === 'pick' ? <span className="spinner tiny" /> : <Icon name="plus" size={13} />} Choose the video
            </button>
          )}
        </div>
        {busy === 'clone' && (
          <ol className="checklist clone-steps" aria-live="polite">
            {(steps ?? [{ label: 'Getting ready', status: 'running' }]).map((s, i) => (
              <li key={i} className={s.status}>
                <span className="check-mark">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'running' ? <span className="spinner tiny" /> : ''}</span>
                <span>
                  {s.label}
                  {s.note && <span className="small muted"> — {s.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" onClick={onCancel} disabled={busy === 'clone'}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked || !who || !ready || !!busy} onClick={() => void clone()}>
            {busy === 'clone' ? <span className="spinner tiny" /> : <Icon name="film" size={14} />} {picked ? `Clone it (about ${studioPrice(price, via)})` : 'Clone it'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 75.5 → "1:15". */
function fmt(sec: number): string {
  const t = Math.max(0, Math.round(sec));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
