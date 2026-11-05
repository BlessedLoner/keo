import { useState } from 'react';
import { MUSIC_SECONDS, musicCost, SFX_MAX_SECONDS, sfxCost, studioPrice } from '@shared/aiPrices';
import { projectDuration, type Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useStudioAi } from './StudioCredits';

const MUSIC_IDEAS = ['Uplifting lo-fi hip hop, 85 BPM, warm keys and soft drums', 'Cinematic, emotional piano and strings that build slowly', 'Upbeat pop for a product launch, bright synths, 120 BPM', 'Calm acoustic guitar, warm and hopeful', 'Dark tense trap beat for a reveal'];
const SOUND_IDEAS = ['Whoosh, fast and airy', 'Crowd gasps then cheers', 'Soft notification ding', 'Heavy cinematic boom with a long tail', 'Keyboard typing, quick'];

/**
 * AI music and sound effects for the open project: described in words, made by AI (Keo Cloud's
 * Studio credits or the user's own fal.ai key), placed on the Music or Effects track. The price
 * is shown before anything is paid.
 */
export function AiAudio({ project, time }: { project: Project; time: number }) {
  const ui = useUi();
  const ai = useStudioAi();
  const via = ai.status?.via ?? null;
  const ready = !ai.status || via !== null;
  const [music, setMusic] = useState('');
  const [vocals, setVocals] = useState(false);
  const [sound, setSound] = useState('');
  const [soundSeconds, setSoundSeconds] = useState(3);
  const [busy, setBusy] = useState<'music' | 'sound' | null>(null);
  const length = Math.round(Math.min(MUSIC_SECONDS.max, Math.max(MUSIC_SECONDS.min, projectDuration(project) || 30)));

  const makeMusic = async () => {
    const ok = await ui.confirm({
      title: 'Make original music?',
      body: `Keo sends your description to the AI music model and puts ${length} s of ${vocals ? 'music with vocals' : 'instrumental music'} on the Music track, quieter while someone speaks. About ${studioPrice(musicCost(length), via)}.`,
      confirmLabel: `Make it (about ${studioPrice(musicCost(length), via)})`,
    });
    if (!ok) return;
    setBusy('music');
    try {
      const r = await invoke('studio:aiMusic', { id: project.id, prompt: music.trim(), seconds: length, at: 0, ...(vocals ? { vocals: true } : {}) });
      ai.refresh();
      ui.toast(r.pending ? 'Your music is being made: it goes on the Music track by itself.' : r.cached ? 'Made before: used again, nothing paid.' : 'Your music is on the Music track.', 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const makeSound = async () => {
    setBusy('sound');
    try {
      const r = await invoke('studio:aiSound', { id: project.id, prompt: sound.trim(), seconds: soundSeconds, at: time });
      ai.refresh();
      ui.toast(r.cached ? 'Made before: used again, nothing paid.' : `The sound is on the Effects track at the playhead (about ${studioPrice(sfxCost(soundSeconds), via)}).`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="lib-pad ai-audio">
      {!ready && <p className="small muted">AI music and sounds need your Keo account: sign in under Settings → Providers → Keo account.</p>}
      <div className="field">
        <label htmlFor="ai-music">Original music for this video ({length} s)</label>
        <textarea id="ai-music" className="textarea" rows={3} maxLength={2000} value={music} placeholder="Genre, mood, tempo, instruments, how it builds…" onChange={(e) => setMusic(e.target.value)} disabled={!!busy} />
        <div className="ai-audio-ideas">
          {MUSIC_IDEAS.map((m) => (
            <button key={m} className="chip" onClick={() => setMusic(m)} disabled={!!busy}>
              {m}
            </button>
          ))}
        </div>
        <label className="insp-check">
          <input type="checkbox" checked={vocals} onChange={(e) => setVocals(e.target.checked)} disabled={!!busy} /> With vocals (singing)
        </label>
        <button className="btn sm primary" disabled={!ready || !!busy || music.trim().length < 3} onClick={() => void makeMusic()}>
          {busy === 'music' ? <span className="spinner tiny" /> : <Icon name="music" size={13} />} Make the music (about {studioPrice(musicCost(length), via)})
        </button>
      </div>
      <div className="field">
        <label htmlFor="ai-sound">A sound effect, at the playhead</label>
        <input id="ai-sound" className="input" maxLength={450} value={sound} placeholder="e.g. a heavy door creaks open in an empty hall" onChange={(e) => setSound(e.target.value)} disabled={!!busy} />
        <div className="ai-audio-ideas">
          {SOUND_IDEAS.map((m) => (
            <button key={m} className="chip" onClick={() => setSound(m)} disabled={!!busy}>
              {m}
            </button>
          ))}
        </div>
        <label className="insp-num">
          <span>Length: {soundSeconds} s</span>
          <input type="range" min={0.5} max={SFX_MAX_SECONDS} step={0.5} value={soundSeconds} onChange={(e) => setSoundSeconds(Number(e.target.value))} disabled={!!busy} />
        </label>
        <button className="btn sm" disabled={!ready || !!busy || sound.trim().length < 3} onClick={() => void makeSound()}>
          {busy === 'sound' ? <span className="spinner tiny" /> : <Icon name="speaker" size={13} />} Make the sound (about {studioPrice(sfxCost(soundSeconds), via)})
        </button>
      </div>
    </div>
  );
}
