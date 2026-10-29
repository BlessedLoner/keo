import { useState } from 'react';
import { isAV, LOOKS, needsAnalysis, TRANSITIONS, type EditOp, type LookId, type Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * The Studio's one-click talking-head tools (the same ones Keo uses from the chat): clean-up,
 * voice, loudness, colour, punch-ins, music ducking, sound effects.
 */

const SFX_KINDS = ['whoosh', 'swipe', 'pop', 'click', 'ding', 'riser', 'boom'] as const;
const LOOK_LABEL: Record<LookId, string> = { natural: 'Natural', warm: 'Warm', cool: 'Cool', punchy: 'Punchy', cinematic: 'Cinematic', 'black-white': 'Black & white' };

/** Sound clips that are music: on an audio track named Music, or already set to duck. */
function musicClips(p: Project): string[] {
  return p.tracks.flatMap((t) => (t.kind === 'audio' ? t.clips.filter((c) => c.type === 'audio' && (/music/i.test(t.name) || c.duck !== null)).map((c) => c.id) : []));
}
/** Clips whose sound is a voice (not music, not effects). */
function voiceClips(p: Project): string[] {
  const music = new Set(musicClips(p));
  return p.tracks.flatMap((t) =>
    t.clips.filter((c) => isAV(c) && !music.has(c.id) && !/effect/i.test(t.name) && p.assets.find((a) => a.id === c.assetId)?.hasAudio).map((c) => c.id),
  );
}

export function Autopilot({ project, time, onEdit, onBusy }: { project: Project; time: number; onEdit: (ops: EditOp[]) => Promise<void>; onBusy: (b: boolean) => void }) {
  const ui = useUi();
  const [busy, setBusy] = useState<string | null>(null);
  const [sfx, setSfx] = useState<(typeof SFX_KINDS)[number]>('whoosh');
  const [allCuts, setAllCuts] = useState<(typeof TRANSITIONS)[number]>('crossfade');
  const [beatEvery, setBeatEvery] = useState<1 | 2 | 4>(2);
  const hasMusic = project.tracks.some((t) => t.kind === 'audio' && t.clips.length > 0);
  const beatSync = () =>
    run('beat', async () => {
      const r = await invoke('studio:beatSync', { id: project.id, every: beatEvery });
      ui.toast(`Put ${r.placed} clip${r.placed === 1 ? '' : 's'} on the beat${r.bpm ? ` (${Math.round(r.bpm)} BPM)` : ''}.`, 'success');
    });
  // Clips that start right where another clip ends on a video track (a cut).
  const cuts = project.tracks.flatMap((t) => (t.kind === 'video' ? t.clips.filter((c) => c.type === 'media' && t.clips.some((o) => o.id !== c.id && o.type === 'media' && Math.abs(o.start + o.duration - c.start) < 0.05)).map((c) => c.id) : []));
  const media = project.tracks.flatMap((t) => t.clips.filter((c) => c.type === 'media'));
  const voices = voiceClips(project);
  const music = musicClips(project);
  const voiceOn = voices.length > 0 && voices.every((id) => project.tracks.some((t) => t.clips.some((c) => c.id === id && isAV(c) && c.voice)));
  const duckOn = music.length > 0 && music.every((id) => project.tracks.some((t) => t.clips.some((c) => c.id === id && c.type === 'audio' && c.duck !== null)));
  const look = (() => {
    const first = media.find((c) => c.type === 'media')?.color;
    if (!first) return 'off';
    return (Object.keys(LOOKS) as LookId[]).find((k) => Object.entries(LOOKS[k]).every(([f, v]) => Math.abs((first as Record<string, number>)[f]! - v) < 1e-6)) ?? 'custom';
  })();

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    onBusy(true);
    try {
      await f();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
      onBusy(false);
    }
  };

  const removePauses = () =>
    run('pauses', async () => {
      const r = await invoke('studio:cleanup', { id: project.id, silences: true });
      ui.toast(r.cuts ? `Cut ${r.cuts} pause${r.cuts === 1 ? '' : 's'} (${r.seconds.toFixed(1)} s).` : 'No long pauses found.', 'success');
    });

  const removeFillers = () =>
    run('fillers', async () => {
      if (needsAnalysis(project, 'words').length) {
        const src = await invoke('studio:captionSource', {});
        if (!src.destination) throw new Error(src.reason ?? 'Speech-to-text is not available.');
        const ok = await ui.confirm({
          title: 'Find ums and retakes?',
          body: `Keo sends this video’s sound to ${src.destination} to turn the speech into text, then cuts filler words (um, uh) and retakes (a sentence started again — the last take stays). You can undo it.`,
          confirmLabel: 'Find and cut',
        });
        if (!ok) return;
        await invoke('studio:transcribe', { id: project.id });
      }
      const r = await invoke('studio:cleanup', { id: project.id, fillers: true, retakes: true });
      const parts = [r.byReason.filler ? `${r.byReason.filler} filler word${r.byReason.filler === 1 ? '' : 's'}` : null, r.byReason.retake ? `${r.byReason.retake} retake${r.byReason.retake === 1 ? '' : 's'}` : null].filter(Boolean);
      ui.toast(parts.length ? `Cut ${parts.join(' and ')} (${r.seconds.toFixed(1)} s).${r.notes.length ? ` ${r.notes.join(' ')}` : ''}` : 'No filler words or retakes found.', 'success');
    });

  const toggleVoice = () => run('voice', () => onEdit(voices.map((clip) => ({ op: 'set', clip, voice: !voiceOn }))));
  const gateOn = voices.length > 0 && voices.every((id) => project.tracks.some((t) => t.clips.some((c) => c.id === id && isAV(c) && c.gate)));
  const toggleGate = () =>
    run('gate', async () => {
      if (!gateOn) await invoke('studio:analyzeSpeech', { id: project.id });
      await onEdit(voices.map((clip) => ({ op: 'set', clip, gate: gateOn ? null : -18 })));
    });
  const toggleLoudness = () => run('loud', () => onEdit([{ op: 'set_project', loudness: project.loudness === 'social' ? 'off' : 'social' }]));
  const toggleDuck = () => run('duck', () => onEdit(music.map((clip) => ({ op: 'set', clip, duck: duckOn ? null : -14 }))));
  const setLook = (l: LookId | 'off') => run('look', () => onEdit(media.map((c) => ({ op: 'set', clip: c.id, color: l === 'off' ? null : { ...LOOKS[l] } }))));
  const punchIns = () =>
    run('punch', async () => {
      const r = await invoke('studio:punchIn', { id: project.id });
      ui.toast(`Added ${r.points} punch-in${r.points === 1 ? '' : 's'}.`, 'success');
    });
  const addEffect = () => run('sfx', async () => void (await invoke('studio:soundEffect', { id: project.id, kind: sfx, at: time })));
  const working = busy !== null;

  return (
    <div className="studio-card autopilot">
      <div className="studio-pane-head">
        <span>Autopilot</span>
        {working && <span className="spinner tiny" />}
      </div>
      <div className="auto-grid">
        <button className="btn sm" disabled={working || !voices.length} onClick={() => void removePauses()} title="Cut long pauses between sentences (on this PC)">
          <Icon name="scissors" size={13} /> Remove pauses
        </button>
        <button className="btn sm" disabled={working || !voices.length} onClick={() => void removeFillers()} title="Cut um, uh and retakes (needs the transcript)">
          <Icon name="scissors" size={13} /> Ums & retakes
        </button>
        <button className={`btn sm ${voiceOn ? 'on' : ''}`} aria-pressed={voiceOn} disabled={working || !voices.length} onClick={() => void toggleVoice()} title="Clearer voice: rumble cut, less boom, gentle compression">
          <Icon name="mic" size={13} /> Enhance voice
        </button>
        <button className={`btn sm ${gateOn ? 'on' : ''}`} aria-pressed={gateOn} disabled={working || !voices.length} onClick={() => void toggleGate()} title="Background noise between sentences goes down">
          <Icon name="mute" size={13} /> Quiet the gaps
        </button>
        <button className={`btn sm ${project.loudness === 'social' ? 'on' : ''}`} aria-pressed={project.loudness === 'social'} disabled={working} onClick={() => void toggleLoudness()} title="Export as loud as social apps expect (about -14 LUFS)">
          <Icon name="speaker" size={13} /> Social loudness
        </button>
        <button className="btn sm" disabled={working || !voices.length} onClick={() => void punchIns()} title="Jump closer at new sentences, like a second camera">
          <Icon name="film" size={13} /> Punch-ins
        </button>
        <button className={`btn sm ${duckOn ? 'on' : ''}`} aria-pressed={duckOn} disabled={working || !music.length} onClick={() => void toggleDuck()} title={music.length ? 'Music quieter while someone speaks' : 'Add music on an audio track first'}>
          <Icon name="music" size={13} /> Duck music
        </button>
      </div>
      <label className="insp-num wide auto-row">
        <span>Colour look</span>
        <select className="select" value={look} disabled={working || !media.length} onChange={(e) => void setLook(e.target.value as LookId | 'off')}>
          <option value="off">None</option>
          {(Object.keys(LOOKS) as LookId[]).map((k) => (
            <option key={k} value={k}>
              {LOOK_LABEL[k]}
            </option>
          ))}
          {look === 'custom' && <option value="custom">Custom</option>}
        </select>
      </label>
      <div className="auto-row auto-sfx">
        <select className="select" value={beatEvery} onChange={(e) => setBeatEvery(Number(e.target.value) as 1 | 2 | 4)} aria-label="Beats per clip">
          <option value={1}>Every beat</option>
          <option value={2}>Every 2 beats</option>
          <option value={4}>Every 4 beats</option>
        </select>
        <button className="btn sm" disabled={working || !hasMusic} onClick={() => void beatSync()} title={hasMusic ? 'Lay the clips on the music’s beat' : 'Add music first (Library → Audio → Add music)'}>
          <Icon name="music" size={13} /> Cut to beat
        </button>
      </div>
      <div className="auto-row auto-sfx">
        <select className="select" value={allCuts} onChange={(e) => setAllCuts(e.target.value as typeof allCuts)} aria-label="Transition for every cut">
          {TRANSITIONS.map((k) => (
            <option key={k} value={k}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={working || !cuts.length} onClick={() => void run('cuts', () => onEdit(cuts.map((clip) => ({ op: 'set', clip, transition: { kind: allCuts, seconds: allCuts === 'whip' || allCuts === 'flash' ? 0.35 : 0.6 } }))))} title={cuts.length ? `Put this transition on all ${cuts.length} cuts` : 'No cuts between clips yet'}>
          Every cut{cuts.length ? ` (${cuts.length})` : ''}
        </button>
      </div>
      <div className="auto-row auto-sfx">
        <select className="select" value={sfx} onChange={(e) => setSfx(e.target.value as (typeof SFX_KINDS)[number])} aria-label="Sound effect">
          {SFX_KINDS.map((k) => (
            <option key={k} value={k}>
              {k[0]!.toUpperCase() + k.slice(1)}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={working} onClick={() => void addEffect()} title="Add this sound effect at the playhead">
          <Icon name="plus" size={13} /> Effect here
        </button>
      </div>
    </div>
  );
}
