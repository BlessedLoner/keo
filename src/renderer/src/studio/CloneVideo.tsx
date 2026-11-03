import { useEffect, useState } from 'react';
import { swapCost, type SwapResolution } from '@shared/aiPrices';
import type { Character } from '@shared/studioCharacters';
import type { Asset } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Clone a video with a character: the user picks a content video and one of their characters;
 * Keo puts the video in a new project and swaps the person in it for the character (fal.ai,
 * the user's key: the price is shown before anything is paid). The original sound stays.
 */
export function CloneVideo({ onDone, onCancel, onCharacters }: { onDone: (projectId: string) => void; onCancel: () => void; onCharacters: () => void }) {
  const ui = useUi();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [character, setCharacter] = useState('');
  const [resolution, setResolution] = useState<SwapResolution>('480p');
  const [picked, setPicked] = useState<{ projectId: string; clip: string; asset: Asset } | null>(null);
  const [busy, setBusy] = useState<'pick' | 'clone' | null>(null);
  const [falReady, setFalReady] = useState(true);
  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then((list) => {
        const usable = list.filter((c) => c.pictures.length > 0);
        setCharacters(usable);
        setCharacter((c) => c || usable[0]?.id || '');
      })
      .catch(() => undefined);
    void invoke('aivideo:status')
      .then((s) => setFalReady(s.hasKey))
      .catch(() => undefined);
  }, []);

  const pick = async () => {
    setBusy('pick');
    try {
      const p = await invoke('studio:create', { name: 'Cloned video', format: 'vertical' });
      const r = await invoke('studio:import', { id: p.id });
      const video = r.added.find((a) => a.kind === 'video');
      if (!video) {
        await invoke('studio:delete', { id: p.id }).catch(() => undefined);
        if (r.added.length || r.skipped.length) ui.error('Choose a video file (MP4 or MOV).');
        return;
      }
      if (video.duration > 60.5) {
        await invoke('studio:delete', { id: p.id }).catch(() => undefined);
        ui.error(`That video is ${Math.round(video.duration)} s long: cloning takes videos up to 60 s. Trim it first.`);
        return;
      }
      // The project takes the video's shape, then the video goes on the timeline.
      const wide = video.width > video.height * 1.15;
      const square = !wide && video.height <= video.width * 1.15;
      const shaped = await invoke('studio:edit', {
        id: p.id,
        ops: [
          { op: 'set_project', name: `Cloned ${video.name.replace(/\.[^.]+$/, '')}`.slice(0, 120), width: wide ? 1920 : 1080, height: wide ? 1080 : square ? 1080 : 1920 },
          { op: 'add_media', assetId: video.id, start: 0 },
        ],
      });
      const clip = shaped.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.assetId === video.id);
      if (clip) setPicked({ projectId: p.id, clip: clip.id, asset: video });
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const who = characters.find((c) => c.id === character);
  const price = picked ? swapCost(picked.asset.duration, 30, resolution) : 0;
  const clone = async () => {
    if (!picked || !who) return;
    const ok = await ui.confirm({
      title: `Put ${who.name} in this video?`,
      body: `Keo sends the video and ${who.name}’s main picture to fal.ai, which replaces the person in it (their movement and expressions are kept; the original sound stays). About $${price.toFixed(2)} from your fal.ai account at ${resolution}. It can take several minutes: the new clip appears on the timeline by itself.`,
      confirmLabel: `Clone it (about $${price.toFixed(2)})`,
    });
    if (!ok) return;
    setBusy('clone');
    try {
      const r = await invoke('studio:swap', { id: picked.projectId, clip: picked.clip, character: who.id, resolution });
      ui.toast(r.pending ? `fal.ai is making it: ${who.name} appears on the timeline by itself when it is ready.` : r.cached ? 'Made before: used again, nothing paid.' : `Done: ${who.name} is in the video.`, 'success');
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
        {!falReady && <p className="small warn-text">This uses fal.ai: add your fal.ai key in Settings → Providers first.</p>}
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
            <label htmlFor="cl-res">Quality</label>
            <select id="cl-res" className="select" value={resolution} onChange={(e) => setResolution(e.target.value as SwapResolution)} disabled={!!busy}>
              <option value="480p">480p: cheapest, good for a first try</option>
              <option value="580p">580p</option>
              <option value="720p">720p: best</option>
            </select>
          </div>
        </div>
        {who && (
          <div className="clone-who">
            <img src={`app://keo/character/${who.id}/0?v=${encodeURIComponent(who.pictures[0]!)}`} alt="" />
            <span className="small muted">{who.name}’s main picture is the face Keo uses.</span>
          </div>
        )}
        <div className="field">
          <label>Content video (up to 60 seconds)</label>
          {picked ? (
            <p className="small">
              <strong>{picked.asset.name}</strong> · {picked.asset.duration.toFixed(1)} s · about <strong>${price.toFixed(2)}</strong> at {resolution}
            </p>
          ) : (
            <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void pick()} disabled={!!busy}>
              {busy === 'pick' ? <span className="spinner tiny" /> : <Icon name="plus" size={13} />} Choose the video
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" onClick={onCancel} disabled={busy === 'clone'}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked || !who || !falReady || !!busy} onClick={() => void clone()}>
            {busy === 'clone' ? <span className="spinner tiny" /> : <Icon name="film" size={14} />} {picked ? `Clone it (about $${price.toFixed(2)})` : 'Clone it'}
          </button>
        </div>
      </div>
    </div>
  );
}
