import { useEffect, useState } from 'react';
import { KEO_FONTS, SYSTEM_FONTS } from '@shared/studio';
import type { Brand, BrandPatch } from '@shared/studioBrand';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { Color, Section } from './fields';

/**
 * The user's brand kit: what Keo uses on every video (end card name and line, colour, fonts,
 * favourite style). Keo can fill it in too when the user tells it; here they see and change it.
 */
export function BrandKit() {
  const ui = useUi();
  const [brand, setBrand] = useState<Brand>({});
  const [draft, setDraft] = useState<Brand>({});
  useEffect(() => {
    void invoke('studio:brand', {})
      .then((b) => {
        setBrand(b);
        setDraft(b);
      })
      .catch(() => undefined);
  }, []);
  const save = async (patch: BrandPatch) => {
    try {
      const b = await invoke('studio:brand', { patch });
      setBrand(b);
      setDraft(b);
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const text = (key: 'name' | 'handle' | 'endText', label: string, placeholder: string, max: number) => (
    <label className="insp-num wide">
      <span>{label}</span>
      <input
        className="input"
        value={draft[key] ?? ''}
        placeholder={placeholder}
        maxLength={max}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          const v = (draft[key] ?? '').trim();
          if (v !== (brand[key] ?? '')) void save({ [key]: v || null });
        }}
      />
    </label>
  );
  const fonts = [...KEO_FONTS, ...SYSTEM_FONTS];
  return (
    <Section title="Brand kit">
      <p className="small muted">Keo uses these on every video (end cards, colours, fonts), so it does not have to ask. Kept on this PC.</p>
      {text('name', 'Name', 'Your name or brand', 60)}
      {text('handle', 'Handle', '@yourname', 60)}
      {text('endText', 'End card line', 'Follow for more', 120)}
      <div className="insp-grid">
        <Color label="Accent colour" value={brand.accent ?? '#E53935'} onCommit={(v) => void save({ accent: v })} />
        <label className="insp-num">
          <span>Favourite style</span>
          <select className="select" value={brand.style ?? ''} onChange={(e) => void save({ style: (e.target.value || null) as Brand['style'] | null })}>
            <option value="">None yet</option>
            <option value="podcast-frame">Podcast frame</option>
            <option value="doc-serif">Documentary serif</option>
          </select>
        </label>
      </div>
      <label className="insp-num wide">
        <span>Headline font</span>
        <select className="select" value={brand.headlineFont ?? ''} onChange={(e) => void save({ headlineFont: e.target.value || null })}>
          <option value="">Keo chooses</option>
          {fonts.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </label>
    </Section>
  );
}
