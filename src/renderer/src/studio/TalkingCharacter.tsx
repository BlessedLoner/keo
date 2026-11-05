import { useEffect, useState } from 'react';
import { studioPrice, TALK_MAX_SECONDS, talkCost, type TalkQuality } from '@shared/aiPrices';
import { speakingSeconds } from '@shared/audioLength';
import { FORMATS, type Asset, type FormatId } from '@shared/studio';
import type { Character } from '@shared/studioCharacters';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { StudioCredits, useStudioAi } from './StudioCredits';

/**
 * Talking character: one of the user's characters says a script in their voice (or lip-syncs a
 * recording the user picks), with real lip-sync. Keo makes a new project, shows the price before
 * anything is paid, then each step as it happens; the clip lands on the timeline.
 */
export function TalkingCharacter({ onDone, onCancel, onCharacters }: { onDone: (projectId: string) => void; onCancel: () => void; onCharacters: () => void }) {
  const ui = useUi();
  const ai = useStudioAi();
  const via = ai.status?.via ?? null;
  const ready = !ai.status || via !== null;
  const [characters, setCharacters] = useState<Character[]>([]);
  const [character, setCharacter] = useState('');
  const [format, setFormat] = useState<FormatId>('vertical');
  const [source, setSource] = useState<'script' | 'recording'>('script');
  const [text, setText] = useState('');
  const [recording, setRecording] = useState<{ projectId: string; asset: Asset } | null>(null);
  const [scene, setScene] = useState('');
  const [manner, setManner] = useState('');
  const [quality, setQuality] = useState<TalkQuality>('pro');
  const [busy, setBusy] = useState<'pick' | 'make' | null>(null);
  const [steps, setSteps] = useState<Array<{ label: string; status: string; note?: string }> | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then((list) => {
        const usable = list.filter((c) => c.pictures.length > 0);
        setCharacters(usable);
        setCharacter((c) => c || usable[0]?.id || '');
      })
      .catch(() => undefined);
  }, []);
  const watching = projectId ?? recording?.projectId ?? null;
  useEffect(
    () =>
      subscribe('studio:progress', (m) => {
        if (m.projectId === watching && m.stage === 'checklist' && m.steps) setSteps(m.steps);
      }),
    [watching],
  );

  const who = characters.find((c) => c.id === character);
  const seconds = source === 'recording' ? (recording?.asset.duration ?? 0) : speakingSeconds(text);
  const tooLong = seconds > TALK_MAX_SECONDS + 0.5;
  // A new picture is made when there is a scene; the exact check (the picture's shape) is done when it runs.
  const price = seconds ? talkCost(seconds, quality, { picture: !!scene.trim() }) : 0;

  /** A new project of the chosen shape (named after the character). */
  const newProject = async () => {
    const p = await invoke('studio:create', { name: `${who?.name ?? 'Character'} talking`, format });
    return p.id;
  };

  const pickRecording = async () => {
    setBusy('pick');
    try {
      const id = recording?.projectId ?? (await newProject());
      const r = await invoke('studio:import', { id });
      const sound = r.added.find((a) => a.hasAudio);
      if (!sound) {
        if (!recording) await invoke('studio:delete', { id }).catch(() => undefined);
        if (r.added.length || r.skipped.length) ui.error('Choose a recording (WAV, MP3, M4A) or a video with sound.');
        return;
      }
      setRecording({ projectId: id, asset: sound });
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const make = async () => {
    if (!who) return;
    const ok = await ui.confirm({
      title: `Make ${who.name} talk?`,
      body: `Keo ${source === 'script' ? `has ${who.name} say your script in their voice` : `uses the recording “${recording?.asset.name}”`}${scene.trim() ? `, makes a realistic picture of ${who.name} in the scene` : ''}, and brings ${who.name}’s picture to life with the lips in sync (${quality === 'pro' ? 'Pro quality' : 'Standard quality'}): about ${Math.round(seconds)} s for about ${studioPrice(price, via)}${!scene.trim() ? ' (a little more if their picture needs re-framing for this shape)' : ''}. The picture and the voice are sent to the AI service. It takes a few minutes: the clip lands on the timeline by itself.`,
      confirmLabel: `Make it (about ${studioPrice(price, via)})`,
    });
    if (!ok) return;
    setBusy('make');
    setSteps(null);
    try {
      const id = recording?.projectId ?? (await newProject());
      setProjectId(id);
      const r = await invoke('studio:talk', {
        id,
        character: who.id,
        quality,
        at: 0,
        ...(source === 'script' ? { text: text.trim() } : recording ? { audioAsset: recording.asset.id } : {}),
        ...(scene.trim().length >= 3 ? { scene: scene.trim() } : {}),
        ...(manner.trim() ? { prompt: manner.trim() } : {}),
      });
      ai.refresh();
      ui.toast(r.pending ? `Keo is making it: ${who.name} lands on the timeline by itself when ready.` : r.cached ? 'Made before: used again, nothing paid.' : `Done: ${who.name} is talking.`, 'success');
      onDone(id);
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const can = !!who && ready && !busy && seconds > 0 && !tooLong && (source === 'script' ? text.trim().length > 0 : !!recording);
  return (
    <div className="studio-empty">
      <div className="studio-new faceless">
        <Icon name="mic" size={30} />
        <h2>Make your character talk</h2>
        <p className="muted">Your character says your script in their own voice, with real lip-sync: their face, their voice, every video. Or pick a recording and they lip-sync to it.</p>
        <StudioCredits status={ai.status} compact />
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="tk-char">Character</label>
            {characters.length ? (
              <select id="tk-char" className="select" value={character} onChange={(e) => setCharacter(e.target.value)} disabled={!!busy}>
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
            <label htmlFor="tk-format">Shape</label>
            <select id="tk-format" className="select" value={format} onChange={(e) => setFormat(e.target.value as FormatId)} disabled={!!busy || !!recording}>
              {(Object.keys(FORMATS) as FormatId[]).map((f) => (
                <option key={f} value={f}>
                  {FORMATS[f].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="tk-quality">Quality</label>
            <select id="tk-quality" className="select" value={quality} onChange={(e) => setQuality(e.target.value as TalkQuality)} disabled={!!busy}>
              <option value="pro">Pro: most natural (recommended)</option>
              <option value="standard">Standard: about half the price</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="tk-source">What they say</label>
            <select id="tk-source" className="select" value={source} onChange={(e) => setSource(e.target.value as 'script' | 'recording')} disabled={!!busy}>
              <option value="script">A script, in their voice</option>
              <option value="recording">A recording (lip-sync to it)</option>
            </select>
          </div>
        </div>
        {who && (
          <div className="clone-who">
            <img src={`app://keo/character/${who.id}/0?v=${encodeURIComponent(who.pictures[0]!)}`} alt="" />
            <span className="small muted">
              {who.name}’s main picture comes to life{who.voice === 'own' ? ` and speaks in ${who.name}’s own voice` : ''}.
            </span>
          </div>
        )}
        {source === 'script' ? (
          <div className="field">
            <label htmlFor="tk-text">Script{seconds ? ` · about ${Math.round(seconds)} s` : ''}</label>
            <textarea id="tk-text" className="textarea" rows={5} maxLength={1500} value={text} placeholder={`What ${who?.name ?? 'your character'} says…`} onChange={(e) => setText(e.target.value)} disabled={!!busy} />
          </div>
        ) : (
          <div className="field">
            <label>Recording</label>
            {recording ? (
              <p className="small">
                <strong>{recording.asset.name}</strong> · {Math.round(recording.asset.duration)} s{' '}
                <button className="btn sm ghost" onClick={() => void pickRecording()} disabled={!!busy}>
                  Choose another
                </button>
              </p>
            ) : (
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => void pickRecording()} disabled={!!busy}>
                {busy === 'pick' ? <span className="spinner tiny" /> : <Icon name="plus" size={13} />} Choose the recording
              </button>
            )}
          </div>
        )}
        <div className="faceless-grid">
          <div className="field">
            <label htmlFor="tk-scene">Scene (optional)</label>
            <input id="tk-scene" className="input" maxLength={300} value={scene} placeholder="e.g. a cosy podcast studio with a microphone" onChange={(e) => setScene(e.target.value)} disabled={!!busy} />
          </div>
          <div className="field">
            <label htmlFor="tk-manner">How they speak (optional)</label>
            <input id="tk-manner" className="input" maxLength={300} value={manner} placeholder="e.g. smiling, warm, small hand gestures" onChange={(e) => setManner(e.target.value)} disabled={!!busy} />
          </div>
        </div>
        {seconds > 0 && (
          <p className="small">
            {tooLong ? (
              <span className="bad">
                That is about {Math.round(seconds)} s: a talking clip is up to {TALK_MAX_SECONDS} s. Shorten it, or ask Keo in the chat to make it in parts.
              </span>
            ) : (
              <>
                About <strong>{studioPrice(price, via)}</strong> for about {Math.round(seconds)} s
                <span className="muted"> ({quality === 'pro' ? 'Pro' : 'Standard'}{scene.trim() ? ', with a new picture in the scene' : ''})</span>
              </>
            )}
          </p>
        )}
        {busy === 'make' && (
          <ol className="checklist clone-steps" aria-live="polite">
            {(steps ?? [{ label: 'Getting ready', status: 'running' }]).map((s, i) => (
              <li key={i} className={s.status}>
                <span className="check-mark">{s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'running' ? <span className="spinner tiny" /> : ''}</span>
                <span>
                  {s.label}
                  {s.note && <span className="small muted"> — {s.note}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
          <button className="btn" onClick={onCancel} disabled={busy === 'make'}>
            Cancel
          </button>
          <button className="btn primary" disabled={!can} onClick={() => void make()}>
            {busy === 'make' ? <span className="spinner tiny" /> : <Icon name="mic" size={13} />} Make {who?.name ?? 'them'} talk
          </button>
        </div>
      </div>
    </div>
  );
}
