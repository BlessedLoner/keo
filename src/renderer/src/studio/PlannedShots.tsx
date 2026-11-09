import { useState } from 'react';
import { CHARACTER_PICTURE_USD, REAL_PICTURE_USD, studioPrice } from '@shared/aiPrices';
import type { Asset, Project } from '@shared/studio';
import { filmCost, SHOT_MODELS, shotRisks, TEST_SECONDS } from '@shared/studioAiVideo';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { mediaUrl } from './media';
import { useStudioAi } from './StudioCredits';

type Plan = NonNullable<Asset['aiPlan']>;

/** The planned AI shots of a project: frames on the timeline, waiting to be checked and filmed. */
export function plannedShots(p: Project): Array<{ asset: Asset; plan: Plan; at: number; clip: string }> {
  const clips = p.tracks.flatMap((t) => t.clips);
  return p.assets
    .flatMap((a) => {
      if (!a.aiPlan) return [];
      const c = clips.find((x) => x.type === 'media' && x.assetId === a.id);
      return c ? [{ asset: a, plan: a.aiPlan, at: c.start, clip: c.id }] : [];
    })
    .sort((x, y) => x.plan.index - y.plan.index);
}

/**
 * Look first, then pay for motion: each planned shot's frame with what could go wrong, and three
 * buttons with their price — make the picture again, a short silent motion test, or the full shot
 * (it takes the test's place). Nothing is filmed or paid until the user clicks.
 */
export function PlannedShots({ project, onGo }: { project: Project; onGo: (t: number) => void }) {
  const ui = useUi();
  const ai = useStudioAi();
  const via = ai.status?.via ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const shots = plannedShots(project);
  if (!shots.length) return null;
  const left = shots.filter((s) => s.plan.filmed !== 'final');
  if (!left.length) return null;
  const price = (usd: number) => studioPrice(usd, via);
  const allUsd = left.reduce((t, s) => t + filmCost(s.plan.model, s.plan.seconds, s.plan.audio), 0);
  const untested = shots.filter((s) => s.plan.filmed === 'no');
  const testAllUsd = untested.reduce((t, s) => t + filmCost(s.plan.model, s.plan.seconds, s.plan.audio, true), 0);

  const run = async (key: string, f: () => Promise<string>) => {
    setBusy(key);
    try {
      ui.toast(await f(), 'success');
      ai.refresh();
    } catch (e) {
      if (!(e instanceof Cancelled)) ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const film = (assets: string[] | undefined, test: boolean, usd: number, label: string) =>
    run(`${test ? 'test' : 'film'}:${assets?.join(',') ?? 'all'}`, async () => {
      // Bigger spends are confirmed: the price is on the button, this says it once more.
      if (usdToBig(usd)) {
        const ok = await ui.confirm({ title: `${label}?`, body: `About ${price(usd)}. The clips land over their frames as they finish (usually a few minutes); keep working meanwhile.`, confirmLabel: `${label} (about ${price(usd)})` });
        if (!ok) throw new Cancelled();
      }
      const r = await invoke('studio:aiFilm', { id: project.id, test, ...(assets ? { assets } : {}) });
      return test ? `Testing the motion of ${r.shots} shot${r.shots === 1 ? '' : 's'}: play each test when it lands.` : `Filming ${r.shots} shot${r.shots === 1 ? '' : 's'}: they land over their frames as they finish.`;
    });

  return (
    <div className="planned-shots">
      <div className="planned-head">
        <Icon name="film" size={14} />
        <strong>Check your frames, then film</strong>
        <span className="small muted">Nothing is filmed or paid until you click. A motion test is short and silent; the full shot then takes its place.</span>
        <span className="grow" />
        {untested.length > 1 && (
          <button className="btn sm" disabled={!!busy} onClick={() => void film(undefined, true, testAllUsd, `Test all ${untested.length} shots`)}>
            Test all · {price(testAllUsd)}
          </button>
        )}
        <button className="btn sm primary" disabled={!!busy} onClick={() => void film(undefined, false, allUsd, `Film all ${left.length} shots`)}>
          <Icon name="film" size={12} /> Film all {left.length} · {price(allUsd)}
        </button>
        <button className="btn icon sm ghost" onClick={() => setOpen((v) => !v)} title={open ? 'Fold' : 'Show the shots'}>
          <Icon name={open ? 'x' : 'expand'} size={12} />
        </button>
      </div>
      {open && (
        <div className="planned-list">
          {shots.map((s) => {
            const risks = shotRisks({ frame: s.plan.frame, motion: s.plan.motion, seconds: s.plan.seconds, cast: s.plan.cast });
            const testUsd = filmCost(s.plan.model, s.plan.seconds, s.plan.audio, true);
            const fullUsd = filmCost(s.plan.model, s.plan.seconds, s.plan.audio);
            const redoUsd = s.plan.realism === 'draft' ? CHARACTER_PICTURE_USD : REAL_PICTURE_USD;
            const id = s.asset.id;
            return (
              <div key={id} className={`planned-shot ${s.plan.filmed}`}>
                <button className="planned-thumb" onClick={() => onGo(s.at)} title="Go to this shot">
                  <img src={mediaUrl(project.id, id)} alt={`Shot ${s.plan.index + 1}`} />
                  <span className="planned-n">{s.plan.index + 1}</span>
                  {s.plan.filmed !== 'no' && <span className={`planned-state ${s.plan.filmed}`}>{s.plan.filmed === 'test' ? 'Tested' : 'Filmed'}</span>}
                </button>
                <div className="planned-body">
                  <div className="small planned-motion" title={s.plan.motion}>{s.plan.motion}</div>
                  {risks.map((r) => (
                    <div key={r} className="small warn-text">⚠ {r}</div>
                  ))}
                  <div className="planned-actions">
                    <button className="btn sm ghost" disabled={!!busy} onClick={() => void run(`redo:${id}`, async () => (await invoke('studio:aiRedoFrame', { id: project.id, asset: id }), 'A new picture for this shot is on the timeline.'))} title="Make this picture again (same words and faces)">
                      {busy === `redo:${id}` ? <span className="spinner tiny" /> : <Icon name="retry" size={12} />} Redo picture · {price(redoUsd)}
                    </button>
                    {s.plan.filmed === 'no' && (
                      <button className="btn sm" disabled={!!busy} onClick={() => void film([id], true, testUsd, 'Test the motion')} title={`${TEST_SECONDS[s.plan.model]} seconds, silent: see if the movement works before paying for the full shot`}>
                        {busy === `test:${id}` ? <span className="spinner tiny" /> : <Icon name="play" size={12} />} Test {TEST_SECONDS[s.plan.model]} s · {price(testUsd)}
                      </button>
                    )}
                    {s.plan.filmed !== 'final' && (
                      <button className="btn sm primary" disabled={!!busy} onClick={() => void film([id], false, fullUsd, 'Film this shot')} title={`${s.plan.seconds} seconds with ${SHOT_MODELS[s.plan.model].label.split(':')[0]}${s.plan.audio ? ', with sound' : ''}`}>
                        {busy === `film:${id}` ? <span className="spinner tiny" /> : <Icon name="film" size={12} />} Film {s.plan.seconds} s · {price(fullUsd)}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

class Cancelled extends Error {}
/** Above about 150 credits ($0.75 of fal.ai's price) a spend is confirmed once more. */
const usdToBig = (usd: number) => usd > 0.75;
