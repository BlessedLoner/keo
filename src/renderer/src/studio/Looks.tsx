import type { CSSProperties } from 'react';

/**
 * Keo's looks, for people who do not know yet what they want: each one shown as a small picture
 * in its own fonts and colours, and one click asks Keo to edit the video that way (it shows its
 * plan first).
 */
const LOOKS: Array<{ id: string; name: string; about: string; card: CSSProperties; lines: Array<{ text: string; style: CSSProperties }> }> = [
  {
    id: 'podcast-frame',
    name: 'Podcast frame',
    about: 'Rounded frame on dark, a mixed-font headline, bold words beside you, a follow card.',
    card: { background: '#0D0D0F' },
    lines: [
      { text: 'What nobody', style: { fontFamily: 'Montserrat', fontWeight: 900, color: '#fff', fontSize: 15 } },
      { text: 'tells you', style: { fontFamily: '"Instrument Serif"', fontStyle: 'italic', color: '#FFD23F', fontSize: 19 } },
    ],
  },
  {
    id: 'doc-serif',
    name: 'Documentary',
    about: 'Black and white, clean captions with key words in red serif italic, lists that build.',
    card: { background: 'linear-gradient(160deg, #3a3a3a, #0b0b0b)' },
    lines: [
      { text: 'The', style: { fontFamily: '"Playfair Display"', fontWeight: 700, color: '#fff', fontSize: 16 } },
      { text: 'truth', style: { fontFamily: '"Instrument Serif"', fontStyle: 'italic', color: '#E53935', fontSize: 22 } },
    ],
  },
  {
    id: 'bold-stack',
    name: 'Bold stacked',
    about: 'Full screen and punchy, big stacked captions popping in word by word, key words in colour.',
    card: { background: 'linear-gradient(160deg, #6b4b2a, #1d1410)' },
    lines: [
      { text: 'KEO IS', style: { fontFamily: 'Montserrat', fontWeight: 900, color: '#fff', fontSize: 12 } },
      { text: 'SMART', style: { fontFamily: 'Montserrat', fontWeight: 900, color: '#FFD23F', fontSize: 15 } },
    ],
  },
];

export function Looks({ onAskKeo }: { onAskKeo: (text: string) => void }) {
  return (
    <div className="keo-looks">
      <p className="small muted">Not sure what you want? Pick a look and Keo edits your video that way, showing you its plan first.</p>
      {LOOKS.map((l) => (
        <button
          key={l.id}
          className="keo-look"
          onClick={() => onAskKeo(`Edit my video in the ${l.id} style: transcribe it, look at my clips, show me your plan first, then make it and check it before you finish.`)}
          title={`Edit in the ${l.name} look`}
        >
          <span className="keo-look-card" style={l.card}>
            {l.lines.map((x) => (
              <span key={x.text} style={x.style}>
                {x.text}
              </span>
            ))}
          </span>
          <span className="keo-look-text">
            <strong>{l.name}</strong>
            <span className="small muted">{l.about}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
