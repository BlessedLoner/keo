import { useEffect, useMemo, useState } from 'react';
import { FORMATS, LOOKS, type FormatId, type LookId } from '@shared/studio';
import { scenesFromScript, type Storyboard } from '@shared/studioFaceless';
import type { Character } from '@shared/studioCharacters';
import { Characters } from './Characters';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';

/**
 * The faceless creator in Studio: a script (one scene per paragraph) becomes a video with a voice,
 * a moving picture per scene, transitions, captions and sound effects.
 */

type Step = { label: string; status: 'pending' | 'running' | 'done' | 'skipped' | 'failed'; note?: string };

const EXAMPLE = `Did you know the ocean makes most of the air you breathe?
[title: Every second breath]

Tiny plants called phytoplankton float near the surface, turning sunlight into oxygen.
[picture: glowing green phytoplankton in sunlit blue water, macro photo]

Every second breath you take comes from them.

So next time you see the sea, say thank you.`;

const VOICES = [
  { id: 'female', label: 'Keo voice — female' },
  { id: 'male', label: 'Keo voice — male' },
  { id: 'nova', label: 'OpenAI — Nova' },
  { id: 'shimmer', label: 'OpenAI — Shimmer' },
  { id: 'onyx', label: 'OpenAI — Onyx' },
  { id: 'echo', label: 'OpenAI — Echo' },
  { id: 'fable', label: 'OpenAI — Fable' },
  { id: 'alloy', label: 'OpenAI — Alloy' },
];

export function FacelessCreator({ onDone, onCancel, startTab = 'script' }: { onDone: (projectId: string) => void; onCancel: () => void; startTab?: 'script' | 'characters' }) {
  const ui = useUi();
  const [title, setTitle] = useState('My faceless video');
  const [format, setFormat] = useState<FormatId>('vertical');
  const [script, setScript] = useState('');
  const [voice, setVoice] = useState('female');
  const [pictureStyle, setPictureStyle] = useState('cinematic photo, rich colour, soft light');
  const [captions, setCaptions] = useState<Storyboard['captions']>('bold');
  const [look, setLook] = useState<LookId | 'off'>('off');
  const [sfx, setSfx] = useState(true);
  const [plan, setPlan] = useState<{ voice: string | null; pictures: string | null; aiPictures: number; narrations: number; reason: string | null; characterPictures: number; characterCostUsd: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [tab, setTab] = useState<'script' | 'characters'>(startTab);
  const [characters, setCharacters] = useState<Character[]>([]);
  // Loaded again whenever the tab changes (Keo may have added a character from the chat).
  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then(setCharacters)
      .catch(() => undefined);
  }, [tab]);

  // Paragraphs starting with a character's name are theirs; the cast is whoever speaks.
  const scenes = useMemo(() => (script.trim() ? scenesFromScript(script, characters) : []), [script, characters]);
  const cast = [...new Set(scenes.map((sc) => sc.speaker).filter((x): x is string => !!x))];
  const board: Storyboard | null = scenes.length ? { title: title.trim() || 'Faceless video', format, voice, pictureStyle, captions, look, musicVolume: 0.25, soundEffects: sfx, scenes, ...(cast.length ? { cast } : {}) } : null;

  // What it will use and send (updated as the script changes).
  useEffect(() => {
    if (!board) return setPlan(null);
    const t = setTimeout(() => void invoke('studio:facelessPlan', board).then(setPlan).catch(() => setPlan(null)), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [script, voice, format, characters]);
  useEffect(
    () =>
      subscribe('studio:progress', (m) => {
        if (busy && m.stage === 'checklist' && m.steps) setSteps(m.steps);
      }),
    [busy],
  );

  const words = script.split(/\s+/).filter(Boolean).length;
  const create = async () => {
    if (!board || !plan) return;
    if (plan.reason) return ui.error(plan.reason);
    const sends = [
      plan.voice ? `the narration to ${plan.voice} for the voice` : null,
      plan.aiPictures ? `${plan.aiPictures} picture description${plan.aiPictures === 1 ? '' : 's'} to ${plan.pictures}` : null,
      plan.characterPictures ? `${plan.characterPictures} picture${plan.characterPictures === 1 ? '' : 's'} of your characters with their descriptions to fal.ai (about $${plan.characterCostUsd.toFixed(2)} from your fal.ai account)` : null,
    ]
      .filter(Boolean)
      .join(', ');
    const ok = await ui.confirm({
      title: 'Make this video?',
      body: `Keo sends ${sends}. ${plan.narrations} voice clip${plan.narrations === 1 ? '' : 's'}${plan.aiPictures ? ` and ${plan.aiPictures} picture${plan.aiPictures === 1 ? '' : 's'}` : ''} count toward your plan (or your own OpenAI account). It takes a minute or two.`,
      confirmLabel: 'Make the video',
    });
    if (!ok) return;
    setBusy(true);
    setSteps(null);
    try {
      const r = await invoke('studio:faceless', board);
      ui.toast(`Made “${board.title}”: ${r.scenes} scenes, ${r.duration.toFixed(0)} s.`, 'success');
      onDone(r.projectId);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="studio-empty">
      <div className="studio-new faceless">
        <Icon name="film" size={30} />
        <h2>Faceless video</h2>
        <p className="muted">Write the script — one scene per paragraph. Keo reads it in a voice, makes a picture for each scene, moves it, adds transitions and captions. Or ask Keo in the chat to write the script for you.</p>
        <div className="side-tabs faceless-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'script'} className={tab === 'script' ? 'active' : ''} onClick={() => setTab('script')}>
            Script
          </button>
          <button role="tab" aria-selected={tab === 'characters'} className={tab === 'characters' ? 'active' : ''} onClick={() => setTab('characters')}>
            Characters{characters.length ? ` (${characters.length})` : ''}
          </button>
        </div>
        {tab === 'characters' && <Characters list={characters} onChange={setCharacters} />}
        {tab === 'script' && (
        <>
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="fl-title">Title</label>
            <input id="fl-title" className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="fl-format">Format</label>
            <select id="fl-format" className="select" value={format} onChange={(e) => setFormat(e.target.value as FormatId)} disabled={busy}>
              {(Object.keys(FORMATS) as FormatId[]).map((f) => (
                <option key={f} value={f}>
                  {FORMATS[f].label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="fl-script">
            Script <span className="muted small">· {scenes.length} scene{scenes.length === 1 ? '' : 's'}, about {Math.round(words / 2.6)} s · optional lines: [picture: …] [title: …]</span>
          </label>
          <textarea id="fl-script" className="textarea" rows={9} value={script} placeholder={EXAMPLE} maxLength={60000} onChange={(e) => setScript(e.target.value)} disabled={busy} />
          {!script && (
            <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setScript(EXAMPLE)}>
              Use the example
            </button>
          )}
          {characters.length > 0 && (
            <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
              <span className="muted">Add a line for:</span>
              {characters.map((c) => (
                <button key={c.id} className={`btn sm${cast.includes(c.id) ? ' primary' : ''}`} disabled={busy} onClick={() => setScript((t) => `${t.trim() ? `${t.trimEnd()}\n\n` : ''}${c.name}: `)} title={`A new paragraph spoken by ${c.name}`}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="fl-voice">{cast.length ? 'Narrator voice (other lines)' : 'Voice'}</label>
            <select id="fl-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)} disabled={busy}>
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="fl-style">Picture style</label>
            <input id="fl-style" className="input" value={pictureStyle} maxLength={300} onChange={(e) => setPictureStyle(e.target.value)} disabled={busy} />
          </div>
          <div className="field">
            <label htmlFor="fl-captions">Captions</label>
            <select id="fl-captions" className="select" value={captions} onChange={(e) => setCaptions(e.target.value as Storyboard['captions'])} disabled={busy}>
              <option value="bold">Bold, word by word</option>
              <option value="karaoke">Karaoke (2 words)</option>
              <option value="clean">Clean subtitles</option>
              <option value="none">None</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="fl-look">Colour look</label>
            <select id="fl-look" className="select" value={look} onChange={(e) => setLook(e.target.value as LookId | 'off')} disabled={busy}>
              <option value="off">None</option>
              {(Object.keys(LOOKS) as LookId[]).map((k) => (
                <option key={k} value={k}>
                  {k[0]!.toUpperCase() + k.slice(1).replace('-', ' & ')}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="insp-check" style={{ justifyContent: 'flex-start' }}>
          <input type="checkbox" checked={sfx} onChange={(e) => setSfx(e.target.checked)} disabled={busy} /> Whoosh on transitions
        </label>
        </>
        )}
        {plan && (
          <p className={`small ${plan.reason ? 'warn-text' : 'muted'}`}>
            {plan.reason ?? `Voice: ${plan.voice} · ${plan.aiPictures ? `${plan.aiPictures} AI picture${plan.aiPictures === 1 ? '' : 's'}: ${plan.pictures}` : 'no AI pictures'}${plan.characterPictures ? ` · ${plan.characterPictures} same-face picture${plan.characterPictures === 1 ? '' : 's'} of your characters: fal.ai, about $${plan.characterCostUsd.toFixed(2)}` : ''}`}
          </p>
        )}
        {steps && (
          <ol className="checklist faceless-steps">
            {steps.map((s, i) => (
              <li key={i} className={s.status}>
                <span className="check-mark">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'skipped' ? '–' : s.status === 'running' ? <span className="spinner tiny" /> : ''}</span>
                <span>
                  {s.label}
                  {s.note && <span className="small muted"> — {s.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !board || !!plan?.reason} onClick={() => void create()}>
            {busy ? <span className="spinner tiny" /> : <Icon name="film" size={14} />} {busy ? 'Making the video…' : 'Make the video'}
          </button>
        </div>
      </div>
    </div>
  );
}
