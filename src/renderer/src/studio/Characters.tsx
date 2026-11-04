import { useRef, useState } from 'react';
import { CHARACTER_PICTURE_USD, OWN_VOICE_PER_1K_CHARS, studioPrice } from '@shared/aiPrices';
import { CHARACTER_VOICES, type Character, type CharacterPatch } from '@shared/studioCharacters';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { useStudioAi } from './StudioCredits';
import { recordVoice, voiceSample } from './voiceSample';

type Fields = { name: string; look: string; voice: string; notes: string };
type Act = { action: 'list' | 'save' | 'delete' | 'addPicture' | 'removePicture' | 'createPicture' | 'morePose' | 'setVoice' | 'removeVoice' | 'designVoice'; patch?: CharacterPatch; id?: string; picture?: string; pose?: string; audio?: string; about?: string };

/**
 * The user's characters for faceless videos: who they are, what they look like (words and up to
 * four pictures) and how they sound. A script line starting with a character's name is theirs.
 *
 * One form does it all: a new character's pictures can be added or made before it is ever saved
 * (the first picture saves what is filled in, and the form stays open on it).
 */
export function Characters({ list, onChange }: { list: Character[]; onChange: (list: Character[]) => void }) {
  const ui = useUi();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  // Stays the same while a new character becomes a saved one, so the form is not reset.
  const [formKey, setFormKey] = useState(0);
  const [making, setMaking] = useState<string | null>(null);
  const ai = useStudioAi();
  const price = (usd: number) => studioPrice(usd, ai.status?.via ?? null);
  const listRef = useRef(list);
  listRef.current = list;
  const act = async (input: Act): Promise<Character[] | null> => {
    try {
      const next = await invoke('studio:characters', input);
      onChange(next);
      listRef.current = next;
      return next;
    } catch (e) {
      ui.error(errText(e));
      return null;
    }
  };
  const open = (id: string | 'new') => {
    setEditing(id);
    setFormKey((k) => k + 1);
  };
  const current = editing && editing !== 'new' ? list.find((c) => c.id === editing) ?? null : null;

  /** The character as the form shows it, saved: its id (a new one is made now), or null. */
  const saved = async (f: Fields): Promise<string | null> => {
    if (!f.name.trim()) {
      ui.error('Give the character a name first.');
      return null;
    }
    // Their own voice is set when its sample is added: until then the voice they had stays.
    const voice = f.voice === 'own' && !current?.voiceSample ? (current && current.voice !== 'own' ? current.voice : 'female') : f.voice;
    const patch = { name: f.name.trim(), look: f.look.trim(), voice, notes: f.notes.trim() };
    if (current) {
      const same = current.name === patch.name && current.look === patch.look && current.voice === patch.voice && current.notes === patch.notes;
      if (same) return current.id;
      return (await act({ action: 'save', patch: { ...patch, id: current.id } })) ? current.id : null;
    }
    const before = new Set(listRef.current.map((c) => c.id));
    const next = await act({ action: 'save', patch });
    const made = next?.find((c) => !before.has(c.id));
    if (!made) return null;
    setEditing(made.id);
    return made.id;
  };

  return (
    <div className="characters">
      <p className="muted small">
        Your characters, for every video. Start a script paragraph with a name and a colon (“Kira: Welcome back!”) and that line is read in their voice, with their picture when the scene has none.
      </p>
      <div className="character-grid">
        {list.map((c) => (
          <button key={c.id} className={`character-card${editing === c.id ? ' active' : ''}`} onClick={() => open(c.id)} title={`Edit ${c.name}`}>
            {c.pictures.length ? <img src={`app://keo/character/${c.id}/0?v=${encodeURIComponent(c.pictures[0]!)}`} alt="" /> : <span className="character-blank">{c.name.slice(0, 1).toUpperCase()}</span>}
            <strong>{c.name}</strong>
            <span className="small muted">{CHARACTER_VOICES.find((v) => v.id === c.voice)?.label ?? c.voice}</span>
          </button>
        ))}
        <button className={`character-card add${editing === 'new' ? ' active' : ''}`} onClick={() => open('new')} title="Add a character">
          <span className="character-blank">
            <Icon name="plus" size={20} />
          </span>
          <strong>Add a character</strong>
        </button>
      </div>
      {editing && (
        <CharacterEditor
          key={formKey}
          character={current}
          making={making}
          onSave={async (f) => {
            const id = await saved(f);
            if (!id) return;
            ui.toast(`${f.name.trim()} is saved.`, 'success');
            setEditing(null);
          }}
          onDelete={async () => {
            if (!current) return;
            if (!(await ui.confirm({ title: `Remove ${current.name}?`, body: 'Their pictures kept by Keo are removed too. Videos already made keep them.', confirmLabel: 'Remove' }))) return;
            if (await act({ action: 'delete', id: current.id })) {
              ui.toast(`${current.name} is removed.`, 'success');
              setEditing(null);
            }
          }}
          onAddPicture={async (f) => {
            const id = await saved(f);
            if (id) await act({ action: 'addPicture', id });
          }}
          onCreatePicture={async (f) => {
            if (!f.look.trim()) {
              ui.error('Describe their looks first: the picture is made from those words.');
              return;
            }
            const ok = await ui.confirm({
              title: `Make a picture of ${f.name.trim() || 'this character'}?`,
              body: `Keo makes a portrait from their looks (“${f.look.trim()}”). It counts toward your Keo plan.`,
              confirmLabel: 'Make the picture',
            });
            if (!ok) return;
            const id = await saved(f);
            if (!id) return;
            setMaking('Making a portrait from their looks… about half a minute.');
            await act({ action: 'createPicture', id });
            setMaking(null);
          }}
          onMorePose={async (f) => {
            const pose = await ui.prompt({
              title: `Another picture of ${f.name.trim()}`,
              label: `What should the new picture show? The face stays the same. (about ${price(CHARACTER_PICTURE_USD)})`,
              initial: 'sitting in a café, laughing, warm evening light',
              confirmLabel: 'Make it',
            });
            if (!pose?.trim()) return;
            const id = await saved(f);
            if (!id) return;
            setMaking('Making a new picture with the same face… about half a minute.');
            await act({ action: 'morePose', id, pose: pose.trim() });
            setMaking(null);
          }}
          onVoiceSample={async (f, blob) => {
            let sample: { base64: string; seconds: number };
            try {
              sample = await voiceSample(blob);
            } catch (e) {
              ui.error(errText(e));
              return;
            }
            const id = await saved(f);
            if (!id) return;
            if (await act({ action: 'setVoice', id, audio: sample.base64 })) ui.toast(`${f.name.trim()}’s voice is set (${Math.round(sample.seconds)} s sample).`, 'success');
          }}
          onDesignVoice={async (f) => {
            const about = await ui.prompt({
              title: `Design a voice for ${f.name.trim()}`,
              label: `Describe the voice: age, accent, tone, pace. (about ${price(0.005)})`,
              initial: current?.voiceAbout ?? 'warm young woman, light British accent, confident and playful, medium pace',
              confirmLabel: 'Design it',
            });
            if (!about || about.trim().length < 5) return;
            const id = await saved(f);
            if (!id) return;
            setMaking('Designing the voice… about half a minute.');
            const ok = await act({ action: 'designVoice', id, about: about.trim() });
            setMaking(null);
            if (ok) ui.toast(`${f.name.trim()}’s new voice is ready: press Hear it.`, 'success');
          }}
          onRemoveVoice={() => current && void act({ action: 'removeVoice', id: current.id })}
          onRemovePicture={(picture) => current && void act({ action: 'removePicture', id: current.id, picture })}
          voicePrice={price((100 / 1000) * OWN_VOICE_PER_1K_CHARS)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function CharacterEditor({
  character,
  onSave,
  onDelete,
  onAddPicture,
  onRemovePicture,
  onVoiceSample,
  onDesignVoice,
  onRemoveVoice,
  voicePrice,
  onClose,
  making,
  onCreatePicture,
  onMorePose,
}: {
  character: Character | null;
  making: string | null;
  onSave: (f: Fields) => Promise<void>;
  onDelete: () => Promise<void>;
  onAddPicture: (f: Fields) => Promise<void>;
  onCreatePicture: (f: Fields) => Promise<void>;
  onMorePose: (f: Fields) => Promise<void>;
  onRemovePicture: (picture: string) => void;
  onVoiceSample: (f: Fields, blob: Blob) => Promise<void>;
  onDesignVoice: (f: Fields) => Promise<void>;
  onRemoveVoice: () => void;
  voicePrice: string;
  onClose: () => void;
}) {
  const ui = useUi();
  const [name, setName] = useState(character?.name ?? '');
  const [look, setLook] = useState(character?.look ?? '');
  const [voice, setVoice] = useState(character?.voice ?? 'female');
  const [notes, setNotes] = useState(character?.notes ?? '');
  const [hearing, setHearing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState<{ stop: () => void; seconds: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasOwn = !!character?.voiceSample;
  const fields: Fields = { name, look, voice, notes };
  const pictures = character?.pictures ?? [];
  const busy = !!making || saving || !!recording;
  const dirty = !character || character.name !== name.trim() || character.look !== look.trim() || (character.voice !== voice && !(voice === 'own' && !hasOwn)) || character.notes !== notes.trim();
  const record = async () => {
    try {
      const r = await recordVoice((seconds) => setRecording((x) => (x ? { ...x, seconds } : x)));
      setRecording({ stop: r.stop, seconds: 0 });
      const blob = await r.done;
      setRecording(null);
      await onVoiceSample(fields, blob);
    } catch (e) {
      setRecording(null);
      ui.error(errText(e));
    }
  };
  const hear = async () => {
    setHearing(true);
    try {
      const r = await invoke('studio:characterVoice', { voice, text: `Hi, I'm ${name.trim() || 'your character'}. This is how I sound.`, ...(voice === 'own' && character ? { character: character.id } : {}) });
      await new Audio(`data:${r.mimeType};base64,${r.base64}`).play();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setHearing(false);
    }
  };
  const save = async () => {
    setSaving(true);
    await onSave(fields);
    setSaving(false);
  };
  return (
    <div className="character-editor">
      <h3 className="character-editor-title">{character ? `Edit ${character.name}` : 'New character'}</h3>
      <div className="faceless-grid">
        <div className="field">
          <label htmlFor="ch-name">Name</label>
          <input id="ch-name" className="input" value={name} maxLength={40} placeholder="Kira" autoFocus={!character} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ch-voice">Voice</label>
          <div className="row" style={{ gap: 6 }}>
            <select id="ch-voice" className="select" value={voice} onChange={(e) => setVoice(e.target.value)}>
              {CHARACTER_VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
            <button className="btn sm" onClick={() => void hear()} disabled={hearing || (voice === 'own' && !hasOwn)} title="Hear this voice say one line">
              {hearing ? <span className="spinner tiny" /> : <Icon name="speaker" size={13} />} Hear it
            </button>
          </div>
        </div>
      </div>
      {voice === 'own' && (
        <div className="character-voice">
          <p className="small">
            {hasOwn ? (
              <>
                <Icon name="check" size={12} /> {character?.voiceAbout ? `Designed voice: “${character.voiceAbout}”.` : 'Their voice is set from your sample.'} Every line is spoken like it (about {voicePrice} per 100 letters).
              </>
            ) : (
              'Give them a voice of their own: 5 to 30 seconds of one person talking clearly, with no music. Use only your own voice or one you have permission to use.'
            )}
          </p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.ogg"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void onVoiceSample(fields, file);
              }}
            />
            <button className="btn sm" onClick={() => fileRef.current?.click()} disabled={busy || !name.trim()}>
              <Icon name="plus" size={13} /> Upload a voice file
            </button>
            {recording ? (
              <button className="btn sm danger" onClick={recording.stop}>
                <span className="rec-dot" /> Stop ({Math.floor(recording.seconds)} s)
              </button>
            ) : (
              <button className="btn sm" onClick={() => void record()} disabled={busy || !name.trim()} title="Read anything aloud for 10 to 30 seconds">
                <Icon name="mic" size={13} /> Record
              </button>
            )}
            <button className="btn sm" onClick={() => void onDesignVoice(fields)} disabled={busy || !name.trim()} title="Describe a voice and Keo makes it">
              <Icon name="sparkle" size={13} /> Design a voice
            </button>
            {hasOwn && (
              <button className="btn sm ghost" onClick={onRemoveVoice} disabled={busy}>
                Remove their voice
              </button>
            )}
          </div>
          {recording && <p className="small muted">Read anything aloud in the voice you want, naturally, for 10 to 30 seconds. Recording stops by itself at 30 s.</p>}
        </div>
      )}
      <div className="field">
        <label htmlFor="ch-look">Looks</label>
        <input id="ch-look" className="input" value={look} maxLength={500} placeholder="young woman, long blonde hair, black evening dress, warm smile" onChange={(e) => setLook(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ch-notes">Personality and way of speaking</label>
        <textarea id="ch-notes" className="textarea" rows={2} value={notes} maxLength={800} placeholder="Confident, playful, short sentences, talks to the viewer like a friend" onChange={(e) => setNotes(e.target.value)} />
      </div>
      <div className="field">
        <label>Pictures (up to 4: the first is the main one, used for every scene and video)</label>
        <div className="character-pictures">
          {character &&
            pictures.map((p, i) => (
              <span key={p} className="character-picture">
                <img src={`app://keo/character/${character.id}/${i}?v=${encodeURIComponent(p)}`} alt={`${character.name} ${i + 1}`} />
                {i === 0 && <span className="character-main">Main</span>}
                <button className="btn icon sm" onClick={() => onRemovePicture(p)} disabled={busy} title="Remove this picture" aria-label="Remove this picture">
                  ×
                </button>
              </span>
            ))}
          {making && (
            <span className="character-picture making" aria-live="polite">
              <span className="spinner" />
            </span>
          )}
          {pictures.length < 4 && (
            <div className="character-picture-actions">
              <button className="btn sm" onClick={() => void onAddPicture(fields)} disabled={busy || !name.trim()} title="Use pictures you already have">
                <Icon name="plus" size={13} /> Upload pictures
              </button>
              <button className="btn sm" onClick={() => void onCreatePicture(fields)} disabled={busy || !name.trim()} title="Make a portrait from their looks">
                <Icon name="sparkle" size={13} /> Create a picture
              </button>
              {pictures.length > 0 && (
                <button className="btn sm" onClick={() => void onMorePose(fields)} disabled={busy} title="Another picture with the same face, in a new pose or place">
                  <Icon name="sparkle" size={13} /> More poses
                </button>
              )}
            </div>
          )}
        </div>
        {making ? <p className="small muted">{making}</p> : !name.trim() ? <p className="small muted">Give them a name, then upload or create their pictures.</p> : null}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!name.trim() || busy || (!!character && !dirty)} onClick={() => void save()}>
          {saving ? <span className="spinner tiny" /> : <Icon name="check" size={13} />} {character ? (dirty ? 'Save changes' : 'Saved') : 'Save character'}
        </button>
        <button className="btn sm ghost" onClick={onClose} disabled={busy}>
          {character && !dirty ? 'Done' : 'Close'}
        </button>
        <span className="spacer" />
        {character && (
          <button className="btn sm danger" onClick={() => void onDelete()} disabled={busy}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
