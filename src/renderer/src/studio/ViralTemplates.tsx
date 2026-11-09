import { useState } from 'react';
import { needsAnalysis, type Project } from '@shared/studio';
import { VIRAL_TEMPLATES, type ViralId } from '@shared/studioViral';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Viral templates, one click: the structure short videos that travel are built on, made from the
 * user's own talking video (their words), with the hook and the brand end card. One undo.
 */
export function ViralTemplates({ project }: { project: Project }) {
  const ui = useUi();
  const [pick, setPick] = useState<ViralId>('hook-payoff');
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState(false);
  const talking = project.assets.some((a) => a.kind === 'video' && a.hasAudio && project.tracks.some((t) => t.clips.some((c) => c.type === 'media' && c.assetId === a.id)));

  const go = async () => {
    setBusy(true);
    try {
      if (needsAnalysis(project, 'words').length) {
        const src = await invoke('studio:captionSource', {});
        if (!src.destination) throw new Error(src.reason ?? 'Speech-to-text is not available.');
        const ok = await ui.confirm({
          title: `Use “${VIRAL_TEMPLATES[pick].label}”?`,
          body: `Keo first turns the speech into text (it sends this video’s sound to ${src.destination}), then edits the whole video on your words. You can undo it in one step.`,
          confirmLabel: 'Edit it',
        });
        if (!ok) return;
        await invoke('studio:transcribe', { id: project.id });
      }
      const r = await invoke('studio:viral', { id: project.id, template: pick, ...(hook.trim() ? { hook: hook.trim() } : {}) });
      ui.toast(`${VIRAL_TEMPLATES[pick].label}: ${r.placed} moments placed${r.endCard ? ', end card added' : ''}.${r.note ? ` ${r.note}` : ''}`, r.note ? 'info' : 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-card viral-templates">
      <div className="studio-pane-head">
        <span>Viral templates</span>
        {busy && <span className="spinner tiny" />}
      </div>
      <div className="viral-list" role="radiogroup" aria-label="Template">
        {(Object.keys(VIRAL_TEMPLATES) as ViralId[]).map((id) => (
          <button key={id} role="radio" aria-checked={pick === id} className={`viral-item${pick === id ? ' on' : ''}`} disabled={busy} onClick={() => setPick(id)}>
            <b>{VIRAL_TEMPLATES[id].label}</b>
            <span className="small muted">{VIRAL_TEMPLATES[id].use}</span>
          </button>
        ))}
      </div>
      <label className="small muted" htmlFor="viral-hook">Opening line (optional, else Keo uses your first sentence)</label>
      <input id="viral-hook" className="input" value={hook} maxLength={120} disabled={busy} placeholder="Nobody tells you this about AI" onChange={(e) => setHook(e.target.value)} />
      <button className="btn primary sm" disabled={busy || !talking} onClick={() => void go()} title={talking ? 'Edit the whole video with this template (one undo)' : 'Put a talking video on the timeline first'}>
        <Icon name="rocket" size={13} /> Use this template
      </button>
    </div>
  );
}
