import { useCallback, useEffect, useState } from 'react';
import type { Project } from '@shared/studio';
import { rhythm, type Recipe } from '@shared/studioRecipe';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * Templates: a video whose edit the user likes is learned as a recipe (its cuts and rhythm, camera
 * and screen shots, captions, end card and sound), kept for every project, and made again with
 * this project's clips, by a click or by Keo.
 */

const KIND_LABEL: Record<Recipe['shots'][number]['kind'], string> = { camera: 'camera', screen: 'screen', graphic: 'graphic', 'end-card': 'end card' };

export function Templates({ project, onAskKeo }: { project: Project; onAskKeo: (text: string) => void }) {
  const ui = useUi();
  const videos = project.assets.filter((a) => a.kind === 'video');
  const [source, setSource] = useState('');
  const [list, setList] = useState<Recipe[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [endText, setEndText] = useState('');
  const load = useCallback(() => void invoke('studio:templates', {}).then(setList).catch(() => undefined), []);
  useEffect(load, [load]);
  const chosen = source || videos.at(-1)?.id || '';
  const learn = async () => {
    if (!chosen) return;
    setBusy('learn');
    try {
      const r = await invoke('studio:learnTemplate', { id: project.id, assetId: chosen });
      ui.toast(`Learned “${r.name}”: ${r.shots.length} shots, a cut every ${rhythm(r).median.toFixed(1)} s.`, 'success');
      load();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const use = async (r: Recipe) => {
    setBusy(r.id);
    try {
      const out = await invoke('studio:applyTemplate', { id: project.id, recipe: r.id, ...(endText.trim() ? { endText: endText.trim() } : {}) });
      ui.toast(`Edited like “${r.name}”: ${out.cutaways} cutaways${out.music ? `, music “${out.music}”` : ''}${out.needsWords ? '. Add captions next (Captions → Auto captions).' : '.'}`, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="studio-card templates">
      <div className="studio-pane-head">
        <span>Templates</span>
      </div>
      <p className="small muted">Import a video whose edit you like, then learn it. Keo can make the same edit with your own clips: your talking video, your screen recordings, captions, look, end card and sound.</p>
      {videos.length > 0 ? (
        <div className="tpl-learn">
          <select className="select" value={chosen} onChange={(e) => setSource(e.target.value)} aria-label="Template video">
            {videos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="btn sm primary" disabled={!!busy} onClick={() => void learn()} title="Measure its cuts, rhythm, shot kinds and sound on this PC">
            {busy === 'learn' ? <span className="spinner tiny" /> : <Icon name="sparkle" size={13} />} {busy === 'learn' ? 'Learning…' : 'Learn'}
          </button>
        </div>
      ) : (
        <p className="small muted">Import the template video first (Media → Import).</p>
      )}
      {chosen && (
        <button
          className="btn sm"
          onClick={() => {
            const name = videos.find((a) => a.id === chosen)?.name ?? 'the template';
            onAskKeo(`Study “${name}” carefully (study_template), learn it as a template with what you see (captions, look, end card, shot kinds), then edit my other clips exactly like it: my talking video carries the voice, my screen recordings cut in at its rhythm, captions in its style, its look, its end card and music and sound effects from my library. Ask me for the end card text first.`);
          }}
        >
          Ask Keo to edit like this video
        </button>
      )}
      {list.length > 0 && (
        <>
          <label className="insp-num wide" style={{ marginTop: 10 }}>
            <span>End card text (website or handle)</span>
            <input className="input" value={endText} maxLength={120} placeholder="e.g. keo.app" onChange={(e) => setEndText(e.target.value)} />
          </label>
          <ul className="tpl-list">
            {list.map((r) => {
              const rh = rhythm(r);
              const kinds = [...new Set(r.shots.map((s) => KIND_LABEL[s.kind]))].join(', ');
              return (
                <li key={r.id}>
                  <div className="grow">
                    <strong>{r.name}</strong>
                    <span className="small muted">
                      {r.shots.length} shots · a cut every {rh.median.toFixed(1)} s · {kinds}
                      {r.captions.on ? ' · captions' : ''}
                      {r.endCard.on ? ' · end card' : ''}
                      {r.audio.music ? ' · music' : ''}
                      {r.audio.whooshOnCuts ? ' · whooshes' : ''}
                    </span>
                  </div>
                  <button className="btn sm primary" disabled={!!busy} onClick={() => void use(r)} title="Make this edit with this project’s clips (you watch it happen)">
                    {busy === r.id ? <span className="spinner tiny" /> : null} Use
                  </button>
                  <button className="btn icon sm ghost" title="Forget this template" onClick={() => void invoke('studio:deleteTemplate', { recipe: r.id }).then(load).catch((e) => ui.error(errText(e)))}>
                    <Icon name="x" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
