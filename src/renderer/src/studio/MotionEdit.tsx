import { useState } from 'react';
import { needsAnalysis, type Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * The motion edit, one click: Keo edits the whole talking video (camera moves, keyword scenes,
 * framed graphics, pops off the face, whooshes). The same edit Keo makes from the chat; making it
 * again replaces it, and it is one undo.
 */
export function MotionEdit({ project }: { project: Project }) {
  const ui = useUi();
  const [look, setLook] = useState<'mix' | 'light' | 'dark'>('mix');
  const [energy, setEnergy] = useState<'calm' | 'normal' | 'high'>('normal');
  const [busy, setBusy] = useState(false);
  const talking = project.assets.some((a) => a.kind === 'video' && a.hasAudio && project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && c.assetId === a.id)));
  const made = project.tracks.some((t) => t.name === 'Motion edit' && t.clips.length > 0);

  const go = async () => {
    setBusy(true);
    try {
      if (needsAnalysis(project, 'words').length) {
        const src = await invoke('studio:captionSource', {});
        if (!src.destination) throw new Error(src.reason ?? 'Speech-to-text is not available.');
        const ok = await ui.confirm({
          title: 'Motion edit this video?',
          body: `Keo first turns the speech into text (it sends this video’s sound to ${src.destination}), then your chosen AI model reads the text to pick the moments, and Keo edits the whole video on your words. You can undo it in one step.`,
          confirmLabel: 'Edit it',
        });
        if (!ok) return;
        await invoke('studio:transcribe', { id: project.id });
      }
      const r = await invoke('studio:motionEdit', { id: project.id, look, energy });
      const n = (k: string) => r.placed.filter((x) => x.kind === k).length;
      ui.toast(`Motion edit done: ${n('scene')} scene${n('scene') === 1 ? '' : 's'}, ${n('frame')} framed, ${n('pop')} graphic${n('pop') === 1 ? '' : 's'}, ${n('punch')} punch-in${n('punch') === 1 ? '' : 's'}, camera moves all the way through${r.planner === 'keo' ? ' (planned by Keo on this PC: your AI model was not available)' : ''}.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-card motion-edit">
      <div className="studio-pane-head">
        <span>Motion edit</span>
        {busy && <span className="spinner tiny" />}
      </div>
      <p className="small muted">Keo edits the whole video on what you say: the camera moves with you, key words cut to animated scenes, you shrink into a card while a list or number builds, graphics pop beside you (never on your face), with whooshes.</p>
      <div className="insp-grid">
        <label className="insp-num">
          <span>Look</span>
          <select className="select" value={look} disabled={busy} onChange={(e) => setLook(e.target.value as typeof look)}>
            <option value="mix">Light + dark</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="insp-num">
          <span>Energy</span>
          <select className="select" value={energy} disabled={busy} onChange={(e) => setEnergy(e.target.value as typeof energy)}>
            <option value="calm">Calm</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
      </div>
      <button className="btn primary sm" disabled={busy || !talking} onClick={() => void go()} title={talking ? 'Edit the whole video with motion (one undo)' : 'Put a talking video on the timeline first'}>
        <Icon name="sparkle" size={13} /> {made ? 'Make the motion edit again' : 'Motion edit my whole video'}
      </button>
      <p className="small muted">Your chosen AI model reads the transcript (text only) to pick the moments. For your own words and moments, ask Keo: “Motion edit my podcast, make a scene when I say …”.</p>
    </div>
  );
}
