import { useEffect, useState } from 'react';
import { CHARACTER_VOICES, type Character, type CharacterPatch } from '@shared/studioCharacters';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';

/**
 * The user's characters for faceless videos: who they are, what they look like (words and up to
 * four pictures) and how they sound. A script line starting with a character's name is theirs.
 */
export function Characters({ list, onChange }: { list: Character[]; onChange: (list: Character[]) => void }) {
  const ui = useUi();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const act = async (input: { action: 'list' | 'save' | 'delete' | 'addPicture' | 'removePicture'; patch?: CharacterPatch; id?: string; picture?: string }) => {
    try {
      onChange(await invoke('studio:characters', input));
      return true;
    } catch (e) {
      ui.error(errText(e));
      return false;
    }
  };
  const current = editing && editing !== 'new' ? list.find((c) => c.id === editing) : null;
  return (
    <div className="characters">
      <p className="muted small">
        Your characters, for every video. Start a script paragraph with a name and a colon (“Kira: Welcome back!”) and that line is read in their voice, with their picture when the scene has none.
      </p>
      <div className="character-grid">
        {list.map((c) => (
          <button key={c.id} className={`character-card${editing === c.id ? ' active' : ''}`} onClick={() => setEditing(c.id)} title={`Edit ${c.name}`}>
            {c.pictures.length ? <img src={`app://keo/character/${c.id}/0?v=${encodeURIComponent(c.pictures[0]!)}`} alt="" /> : <span className="character-blank">{c.name.slice(0, 1).toUpperCase()}</span>}
            <strong>{c.name}</strong>
            <span className="small muted">{CHARACTER_VOICES.find((v) => v.id === c.voice)?.label ?? c.voice}</span>
          </button>
        ))}
        <button className="character-card add" onClick={() => setEditing('new')} title="Add a character">
          <span className="character-blank">
            <Icon name="plus" size={20} />
          </span>
          <strong>Add a character</strong>
        </button>
      </div>
      {editing && (
        <CharacterEditor
          key={editing}
          character={current ?? null}
          onSave={async (patch) => {
            const ok = await act({ action: 'save', patch: current ? { ...patch, id: current.id } : patch });
            if (ok && !current) setEditing(null);
          }}
          onDelete={async () => {
            if (!current) return;
            if (!(await ui.confirm({ title: `Remove ${current.name}?`, body: 'Their pictures kept by Keo are removed too. Videos already made keep them.', confirmLabel: 'Remove' }))) return;
            if (await act({ action: 'delete', id: current.id })) setEditing(null);
          }}
          onAddPicture={() => current && void act({ action: 'addPicture', id: current.id })}
          onRemovePicture={(picture) => current && void act({ action: 'removePicture', id: current.id, picture })}
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
  onClose,
}: {
  character: Character | null;
  onSave: (patch: { name: string; look: string; voice: string; notes: string }) => Promise<void>;
  onDelete: () => Promise<void>;
  onAddPicture: () => void;
  onRemovePicture: (picture: string) => void;
  onClose: () => void;
}) {
  const ui = useUi();
  const [name, setName] = useState(character?.name ?? '');
  const [look, setLook] = useState(character?.look ?? '');
  const [voice, setVoice] = useState(character?.voice ?? 'female');
  const [notes, setNotes] = useState(character?.notes ?? '');
  const [hearing, setHearing] = useState(false);
  useEffect(() => {
    setName(character?.name ?? '');
    setLook(character?.look ?? '');
    setVoice(character?.voice ?? 'female');
    setNotes(character?.notes ?? '');
  }, [character?.id, character?.name, character?.look, character?.voice, character?.notes]);
  const hear = async () => {
    setHearing(true);
    try {
      const r = await invoke('studio:characterVoice', { voice, text: `Hi, I'm ${name.trim() || 'your character'}. This is how I sound.` });
      await new Audio(`data:${r.mimeType};base64,${r.base64}`).play();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setHearing(false);
    }
  };
  return (
    <div className="character-editor">
      <div className="faceless-grid">
        <div className="field">
          <label htmlFor="ch-name">Name</label>
          <input id="ch-name" className="input" value={name} maxLength={40} placeholder="Kira" onChange={(e) => setName(e.target.value)} />
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
            <button className="btn sm" onClick={() => void hear()} disabled={hearing} title="Hear this voice say one line">
              {hearing ? <span className="spinner tiny" /> : <Icon name="speaker" size={13} />} Hear it
            </button>
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="ch-look">Looks</label>
        <input id="ch-look" className="input" value={look} maxLength={500} placeholder="young woman, long blonde hair, black evening dress, warm smile" onChange={(e) => setLook(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ch-notes">Personality and way of speaking</label>
        <textarea id="ch-notes" className="textarea" rows={2} value={notes} maxLength={800} placeholder="Confident, playful, short sentences, talks to the viewer like a friend" onChange={(e) => setNotes(e.target.value)} />
      </div>
      {character && (
        <div className="field">
          <label>Pictures (up to 4: the first is the main one)</label>
          <div className="character-pictures">
            {character.pictures.map((p, i) => (
              <span key={p} className="character-picture">
                <img src={`app://keo/character/${character.id}/${i}?v=${encodeURIComponent(p)}`} alt={`${character.name} ${i + 1}`} />
                <button className="btn icon sm" onClick={() => onRemovePicture(p)} title="Remove this picture" aria-label="Remove this picture">
                  ×
                </button>
              </span>
            ))}
            {character.pictures.length < 4 && (
              <button className="btn sm" onClick={onAddPicture}>
                <Icon name="plus" size={13} /> Add pictures
              </button>
            )}
          </div>
        </div>
      )}
      {!character && <p className="small muted">Save the character, then add their pictures.</p>}
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" disabled={!name.trim()} onClick={() => void onSave({ name: name.trim(), look: look.trim(), voice, notes: notes.trim() })}>
          {character ? 'Save changes' : 'Save character'}
        </button>
        <button className="btn sm ghost" onClick={onClose}>
          Close
        </button>
        <span className="spacer" />
        {character && (
          <button className="btn sm danger" onClick={() => void onDelete()}>
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
