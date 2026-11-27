import { findClip, type Project } from './studio';

/** A short name for a layer the user can recognise ("Caption “so I built…”", "Headline “Keo Studio”"). */
export function layerLabel(p: Project, id: string): string {
  const f = findClip(p, id);
  if (!f) return 'a layer';
  const c = f.clip;
  const words = (s: string) => (s.length > 34 ? `${s.slice(0, 32)}…` : s);
  const track = f.track.name;
  if (c.type === 'text') return `${/caption/i.test(track) ? 'Caption' : 'Text'} “${words(c.text)}”`;
  if (c.type === 'motion') return `${c.piece === 'design' ? 'Motion graphic' : c.piece.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase())} “${words(c.text)}”`;
  if (c.type === 'shape') return `Shape (${track})`;
  if (c.type === 'media') {
    const a = p.assets.find((x) => x.id === c.assetId);
    return `${a?.kind === 'image' ? 'Picture' : 'Video'} “${words(a?.name ?? track)}”${/cutaway|screen|b-roll/i.test(track) ? ` (${track})` : ''}`;
  }
  return track;
}
