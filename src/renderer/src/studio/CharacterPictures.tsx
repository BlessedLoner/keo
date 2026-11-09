import { useEffect, useState } from 'react';
import { CHARACTER_PICTURE_USD, REAL_PICTURE_USD, studioPrice } from '@shared/aiPrices';
import type { Character } from '@shared/studioCharacters';
import type { Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { invoke } from '../lib/api';
import { mediaUrl } from './media';
import { useStudioAi } from './StudioCredits';

/**
 * "My character in these pictures": the user picks a character and the project's pictures, and per
 * picture keeps the clothes or describes a new outfit. Keo does the rest in chat, visibly: it looks
 * at the pictures, shows the price for approval, and the new pictures land over the originals.
 */
export function CharacterPictures({ project, onAskKeo }: { project: Project; onAskKeo: (text: string) => void }) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [character, setCharacter] = useState('');
  const [chosen, setChosen] = useState<Record<string, { on: boolean; outfit: 'keep' | 'cute' | 'own'; text: string; change: string }>>({});
  const [draft, setDraft] = useState(false);
  const ai = useStudioAi();
  useEffect(() => {
    void invoke('studio:characters', { action: 'list' })
      .then((list) => {
        const usable = list.filter((c) => c.pictures.length > 0);
        setCharacters(usable);
        setCharacter((c) => c || usable[0]?.id || '');
      })
      .catch(() => undefined);
  }, []);
  const who = characters.find((c) => c.id === character);
  // The pictures Keo already made of the character are left out.
  const made = (name: string) => !!who && name.replace(/\.[a-z0-9]+$/i, '').replace(/ \(\d+\)$/, '').replace(/ \(new outfit\)$/, '').endsWith(` - ${who.name}`);
  const pictures = project.assets.filter((a) => a.kind === 'image' && !made(a.name));
  const picked = pictures.filter((a) => chosen[a.id]?.on);
  const price = studioPrice(picked.length * (draft ? CHARACTER_PICTURE_USD : REAL_PICTURE_USD), ai.status?.via === 'own' ? 'own' : 'keo');
  const set = (id: string, patch: Partial<{ on: boolean; outfit: 'keep' | 'cute' | 'own'; text: string; change: string }>) => setChosen((c) => ({ ...c, [id]: { on: false, outfit: 'keep', text: '', change: '', ...c[id], ...patch } }));

  const ask = () => {
    if (!who) return;
    // The exact request, so Keo makes it straight away (the picture model sees the pictures itself).
    const jobs = picked.map((a) => {
      const c = chosen[a.id]!;
      const outfit = c.outfit === 'cute' ? 'cute' : c.outfit === 'own' && c.text.trim().length > 1 ? c.text.trim() : undefined;
      return { assetId: a.id, ...(outfit ? { outfit } : {}), ...(c.change.trim().length > 1 ? { change: c.change.trim() } : {}) };
    });
    const said = picked.map((a, i) => {
      const c = chosen[a.id]!;
      const outfit = c.outfit === 'keep' ? 'same clothes' : c.outfit === 'cute' ? 'a cute, feminine outfit' : `outfit: ${c.text.trim()}`;
      return `${i + 1}. ${a.name}: ${outfit}${c.change.trim() ? `; also: ${c.change.trim()}` : ''}`;
    });
    onAskKeo(
      `Put my character ${who.name} into these pictures, keeping their exact face, body, hair, tattoos and marks, with the same background and light:\n${said.join('\n')}\nRun studio__character_pictures now with exactly: ${JSON.stringify({ character: who.id, pictures: jobs, quality: draft ? 'draft' : 'real' })}. No need to look at the pictures first.`,
    );
  };

  if (!pictures.length) return <p className="small muted" style={{ margin: '0 12px' }}>Import the pictures you want to change first (Media → Import).</p>;
  if (!characters.length) return <p className="small muted" style={{ margin: '0 12px' }}>Make your character first: Studio → Characters → New character, with one or two clear photos.</p>;
  return (
    <div className="char-pics">
      <label className="small">
        Character{' '}
        <select value={character} onChange={(e) => setCharacter(e.target.value)}>
          {characters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <p className="small muted">Tick the pictures to change. {who?.name ?? 'Your character'} keeps their own face, body, hair and tattoos; for each picture keep the clothes or pick a new outfit, and add any other change (pose, smile…).</p>
      <div className="char-pics-grid">
        {pictures.map((a) => {
          const c = chosen[a.id];
          return (
            <div key={a.id} className={`char-pics-item${c?.on ? ' on' : ''}`}>
              <button type="button" className="char-pics-thumb" onClick={() => set(a.id, { on: !c?.on })} title={a.name}>
                <img src={mediaUrl(project.id, a.id)} alt={a.name} draggable={false} />
                {c?.on && (
                  <span className="char-pics-tick">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
              {c?.on && (
                <>
                  <select value={c.outfit} onChange={(e) => set(a.id, { outfit: e.target.value as 'keep' | 'cute' | 'own' })}>
                    <option value="keep">Same clothes</option>
                    <option value="cute">Cute &amp; feminine (Keo picks)</option>
                    <option value="own">My own outfit…</option>
                  </select>
                  {c.outfit === 'own' && <input value={c.text} maxLength={200} placeholder="e.g. pink knit cardigan, white lace top" onChange={(e) => set(a.id, { text: e.target.value })} />}
                  <input value={c.change} maxLength={200} placeholder="Other changes (optional): pose, smile…" title="Anything else to change, e.g. sitting on the bed, hand on hip, smiling" onChange={(e) => set(a.id, { change: e.target.value })} />
                </>
              )}
            </div>
          );
        })}
      </div>
      <label className="small">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Draft (cheaper, rougher)
      </label>
      <button className="btn primary sm" disabled={!picked.length || !who} onClick={ask} title="Keo shows you the price to approve, then makes them">
        <Icon name="sparkle" size={13} /> Put {who?.name ?? 'my character'} in {picked.length || ''} picture{picked.length === 1 ? '' : 's'}
        {picked.length ? ` · about ${price}` : ''}
      </button>
    </div>
  );
}
