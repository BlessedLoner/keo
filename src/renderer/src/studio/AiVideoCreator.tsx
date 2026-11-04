import { useEffect, useMemo, useState } from 'react';
import { studioPrice } from '@shared/aiPrices';
import { aiVideoCost, castIn, SHOT_MODELS, type AiShot, type ShotModelId } from '@shared/studioAiVideo';
import type { Character } from '@shared/studioCharacters';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { StudioCredits, useStudioAi } from './StudioCredits';

type Format = 'vertical' | 'landscape' | 'square';

/**
 * Real AI video from a description (the way Sora, Veo or Kling are prompted): the user describes
 * the video and picks their characters; Keo plans it as shots, the user reads and changes each
 * shot and sees the full price, then Keo makes each shot's first frame with the characters' own
 * faces and films every shot with an AI video model. Shots land on the timeline as they finish.
 */
export function AiVideoCreator({ initial, onDone, onCancel, onCharacters }: { initial?: string; onDone: (projectId: string) => void; onCancel: () => void; onCharacters: () => void }) {
  const ui = useUi();
  const ai = useStudioAi();
  const via = ai.status?.via ?? null;
  const [description, setDescription] = useState(initial ?? '');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [cast, setCast] = useState<string[]>([]);
  const [castTouched, setCastTouched] = useState(false);
  const [seconds, setSeconds] = useState(20);
  const [format, setFormat] = useState<Format>('vertical');
  const [model, setModel] = useState<ShotModelId>('kling-3-pro');
  const [audio, setAudio] = useState(false);
  const [plan, setPlan] = useState<{ title: string; style: string; shots: AiShot[] } | null>(null);
  const [busy, setBusy] = useState<'plan' | 'make' | null>(null);

  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then(setCharacters)
      .catch(() => undefined);
  }, []);
  // The characters named in the description are in it (until the user picks for themselves).
  const named = useMemo(() => castIn(description, characters), [description, characters]);
  useEffect(() => {
    if (!castTouched) setCast(named.slice(0, 3));
  }, [named, castTouched]);

  const cost = plan ? aiVideoCost({ model, audio, shots: plan.shots }) : aiVideoCost({ model, audio, shots: Array.from({ length: Math.max(1, Math.round(seconds / 5)) }, () => ({ frame: 'x'.repeat(10), motion: 'x'.repeat(5), seconds: 5, cast: [] })) });
  const price = studioPrice(cost.usd, via);
  const noFaces = cast.filter((id) => !characters.find((c) => c.id === id)?.pictures.length);

  const planShots = async () => {
    setBusy('plan');
    try {
      setPlan(await invoke('studio:aiVideoPlan', { description: description.trim(), seconds, model, cast }));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const make = async () => {
    if (!plan) return;
    const ok = await ui.confirm({
      title: `Make this ${cost.seconds}-second AI video?`,
      body: `Keo makes the first frame of each of the ${plan.shots.length} shots${cast.length ? ` with ${cast.map((id) => characters.find((c) => c.id === id)?.name).join(' and ')}’s own face` : ''}, then films every shot with ${SHOT_MODELS[model].label.split(':')[0]}${audio ? ' with its own sound' : ''}. About ${price} in all. The frames appear on the timeline within a few minutes; the filmed shots go over them as they finish, usually in 5 to 10 minutes (keep working meanwhile).`,
      confirmLabel: `Make it (about ${price})`,
    });
    if (!ok) return;
    setBusy('make');
    try {
      const r = await invoke('studio:aiVideoMake', { plan: { title: plan.title, style: plan.style, format, model, audio, shots: plan.shots } });
      ai.refresh();
      ui.toast(r.pending ? `The frames are ready. ${r.pending} shot${r.pending === 1 ? ' is' : 's are'} being filmed and arrive by themselves.` : 'Your AI video is ready.', 'success');
      onDone(r.projectId);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };
  const editShot = (i: number, patch: Partial<AiShot>) => setPlan((p) => (p ? { ...p, shots: p.shots.map((s, k) => (k === i ? { ...s, ...patch } : s)) } : p));

  return (
    <div className="studio-empty">
      <div className="studio-new faceless ai-video">
        <Icon name="film" size={30} />
        <h2>Real AI video from a description</h2>
        <p className="muted">
          Describe the video the way you would to a film crew: who, where, what happens, the camera and the look. Keo plans it as shots, makes each first frame with your character’s own face, and films every shot with an AI video model.
        </p>
        <StudioCredits status={ai.status} compact />
        <div className="field">
          <label htmlFor="av-desc">Description</label>
          <textarea
            id="av-desc"
            className="textarea"
            rows={8}
            maxLength={8000}
            value={description}
            disabled={!!busy}
            placeholder="Kira sits at an outdoor café in Paris in a black designer dress, her fluffy Alaskan Malamute beside her. The camera slowly moves towards her; she strokes the dog, sips her coffee and smiles at the camera. Warm afternoon sun, cinematic, photorealistic."
            onChange={(e) => {
              setDescription(e.target.value);
              setPlan(null);
            }}
          />
        </div>
        <div className="field">
          <label>Characters in it (their pictures give the faces)</label>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {characters.map((c) => {
              const on = cast.includes(c.id);
              return (
                <button
                  key={c.id}
                  className={`chip-btn${on ? ' on' : ''}`}
                  disabled={!!busy || (!on && cast.length >= 3)}
                  onClick={() => {
                    setCastTouched(true);
                    setPlan(null);
                    setCast((x) => (on ? x.filter((y) => y !== c.id) : [...x, c.id]));
                  }}
                >
                  {c.pictures.length ? <img src={`app://keo/character/${c.id}/0?v=${encodeURIComponent(c.pictures[0]!)}`} alt="" /> : null}
                  {c.name}
                </button>
              );
            })}
            <button className="btn sm ghost" onClick={onCharacters} disabled={!!busy}>
              <Icon name="plus" size={12} /> {characters.length ? 'Manage characters' : 'Add a character'}
            </button>
          </div>
          {noFaces.length > 0 && <span className="small warn-text">{noFaces.map((id) => characters.find((c) => c.id === id)?.name).join(', ')} has no picture yet: add one, or their face will not stay the same.</span>}
        </div>
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="av-len">Length: about {seconds} s</label>
            <input id="av-len" type="range" min={5} max={60} step={5} value={seconds} disabled={!!busy} onChange={(e) => { setSeconds(Number(e.target.value)); setPlan(null); }} />
          </div>
          <div className="field">
            <label htmlFor="av-format">Shape</label>
            <select id="av-format" className="select" value={format} disabled={!!busy} onChange={(e) => setFormat(e.target.value as Format)}>
              <option value="vertical">Vertical 9:16 (TikTok, Reels, Shorts)</option>
              <option value="landscape">Landscape 16:9 (YouTube)</option>
              <option value="square">Square 1:1</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="av-model">AI video model</label>
            <select id="av-model" className="select" value={model} disabled={!!busy} onChange={(e) => { setModel(e.target.value as ShotModelId); setPlan(null); }}>
              {(Object.keys(SHOT_MODELS) as ShotModelId[]).map((m) => (
                <option key={m} value={m}>
                  {SHOT_MODELS[m].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="av-audio">Sound</label>
            <select id="av-audio" className="select" value={audio ? 'on' : 'off'} disabled={!!busy} onChange={(e) => setAudio(e.target.value === 'on')}>
              <option value="off">Silent (add music or a voice in Studio)</option>
              <option value="on">Made by the AI (ambience, steps, voices): about 1.5× the price</option>
            </select>
          </div>
        </div>

        {plan && (
          <div className="ai-shots">
            <div className="row">
              <strong>{plan.title}</strong>
              <span className="grow" />
              <span className="small muted">
                {plan.shots.length} shots · {cost.seconds} s · about <strong>{price}</strong>
              </span>
            </div>
            {plan.shots.map((s, i) => (
              <div key={i} className="ai-shot">
                <div className="row small">
                  <strong>Shot {i + 1}</strong>
                  <span className="muted">
                    {s.seconds} s{s.cast.length ? ` · ${s.cast.map((id) => characters.find((c) => c.id === id)?.name).filter(Boolean).join(', ')}` : ''}
                  </span>
                  <span className="grow" />
                  {plan.shots.length > 1 && (
                    <button className="btn icon sm ghost" title="Remove this shot" aria-label={`Remove shot ${i + 1}`} disabled={!!busy} onClick={() => setPlan((p) => (p ? { ...p, shots: p.shots.filter((_, k) => k !== i) } : p))}>
                      ×
                    </button>
                  )}
                </div>
                <label className="small muted">First frame</label>
                <textarea className="textarea" rows={2} value={s.frame} maxLength={1500} disabled={!!busy} onChange={(e) => editShot(i, { frame: e.target.value })} />
                <label className="small muted">What moves</label>
                <textarea className="textarea" rows={1} value={s.motion} maxLength={1000} disabled={!!busy} onChange={(e) => editShot(i, { motion: e.target.value })} />
              </div>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" onClick={onCancel} disabled={busy === 'make'}>
            Cancel
          </button>
          {!plan ? (
            <button className="btn primary" disabled={description.trim().length < 10 || !!busy || via === null} onClick={() => void planShots()}>
              {busy === 'plan' ? <span className="spinner tiny" /> : <Icon name="sparkle" size={14} />} {busy === 'plan' ? 'Planning the shots…' : `Plan the shots (about ${price} to make)`}
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => void planShots()} disabled={!!busy}>
                Plan again
              </button>
              <button className="btn primary" disabled={!!busy || plan.shots.some((s) => s.frame.trim().length < 10 || s.motion.trim().length < 5)} onClick={() => void make()}>
                {busy === 'make' ? <span className="spinner tiny" /> : <Icon name="film" size={14} />} {busy === 'make' ? 'Making the frames…' : `Make the video (about ${price})`}
              </button>
            </>
          )}
        </div>
        {busy === 'make' && <p className="small muted">Keo is making the first frame of each shot with the same face and place: they appear on the timeline when you open the project. Then every shot is filmed at once.</p>}
      </div>
    </div>
  );
}
