import { useState } from 'react';
import { studioPrice } from '@shared/aiPrices';
import type { Asset, MediaClip } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { Section } from './fields';
import { useStudioAi } from './StudioCredits';

/** About what a shot costs (Kling 3 Pro or Veo 3.1 Fast, silent), as in the main process. */
const PER_SECOND = { 'kling-3-pro': 0.112, 'veo-3.1-fast': 0.1 } as const;
const LENGTHS = { 'kling-3-pro': [3, 4, 5, 6, 7, 8, 9, 10], 'veo-3.1-fast': [4, 6, 8] } as const;
type Model = keyof typeof PER_SECOND;
const nearest = (m: Model, s: number) => LENGTHS[m].reduce((b, x) => (Math.abs(x - s) < Math.abs(b - s) ? x : b), LENGTHS[m][0]);
const cost = (m: Model, s: number) => Math.ceil(nearest(m, s) * PER_SECOND[m] * 100 - 1e-6) / 100;

/**
 * Redo or extend one shot (Video tab of a selected video clip): a new take of an AI shot in the
 * same place, or the shot made longer from its last frame. The price is shown before anything
 * is paid.
 */
export function ShotAgain({ projectId, clip, asset }: { projectId: string; clip: MediaClip; asset: Asset }) {
  const ui = useUi();
  const ai = useStudioAi();
  const via = ai.status?.via ?? null;
  const ready = !ai.status || via !== null;
  const recipe = asset.aiRecipe;
  const model: Model = recipe && recipe.model in PER_SECOND ? (recipe.model as Model) : 'kling-3-pro';
  const [prompt, setPrompt] = useState('');
  const [seconds, setSeconds] = useState(5);
  const [busy, setBusy] = useState<'redo' | 'extend' | null>(null);

  const go = async (mode: 'redo' | 'extend') => {
    const price = studioPrice(cost(model, mode === 'redo' ? (recipe?.seconds ?? 5) : seconds), via);
    const ok = await ui.confirm({
      title: mode === 'redo' ? 'Make a new take of this shot?' : `Make this shot ${nearest(model, seconds)} s longer?`,
      body:
        mode === 'redo'
          ? `Keo films the same shot again from its start picture${prompt.trim() ? ', with your new words' : ''}. The new take goes in this clip’s place; the old one stays in your media. About ${price}.`
          : `Keo takes this clip’s last frame and films what happens next${prompt.trim() ? ` (“${prompt.trim().slice(0, 80)}”)` : ''}. It goes right after this clip, and what follows moves along. About ${price}.`,
      confirmLabel: `${mode === 'redo' ? 'New take' : 'Extend'} (about ${price})`,
    });
    if (!ok) return;
    setBusy(mode);
    try {
      const r = await invoke('studio:shotAgain', { id: projectId, clip: clip.id, mode, ...(prompt.trim().length >= 3 ? { prompt: prompt.trim() } : {}), ...(mode === 'extend' ? { seconds } : {}) });
      ai.refresh();
      ui.toast(r.pending ? 'It is being filmed: it lands on the timeline by itself when ready.' : r.cached ? 'Made before: used again, nothing paid.' : mode === 'redo' ? 'The new take is in place.' : 'The shot is longer now.', 'success');
      setPrompt('');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="Redo or extend with AI">
      {!ready && <p className="small muted">Needs your Keo account: sign in under Settings → Providers → Keo account.</p>}
      <textarea
        className="textarea"
        rows={2}
        maxLength={2000}
        value={prompt}
        placeholder={recipe ? 'What should change? (optional: empty keeps the same words)' : 'What happens next in the shot?'}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={!!busy}
      />
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {recipe && (
          <button className="btn sm" disabled={!ready || !!busy} onClick={() => void go('redo')} title="Film this shot again from its start picture: a new take in the same place">
            {busy === 'redo' ? <span className="spinner tiny" /> : <Icon name="retry" size={13} />} New take (about {studioPrice(cost(model, recipe.seconds), via)})
          </button>
        )}
        <button className="btn sm" disabled={!ready || !!busy || (!recipe && prompt.trim().length < 3)} onClick={() => void go('extend')} title="Film what happens next, from this clip's last frame">
          {busy === 'extend' ? <span className="spinner tiny" /> : <Icon name="plus" size={13} />} Extend {nearest(model, seconds)} s (about {studioPrice(cost(model, seconds), via)})
        </button>
      </div>
      <label className="insp-num">
        <span>Extend by: {nearest(model, seconds)} s</span>
        <input type="range" min={3} max={10} step={1} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))} disabled={!!busy} />
      </label>
      {recipe && <p className="small muted">Take {recipe.take + 1} of this AI shot.</p>}
    </Section>
  );
}
