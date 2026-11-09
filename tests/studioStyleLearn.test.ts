import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, type Asset } from '../src/shared/studio';
import { learnStyle } from '../src/shared/studioStyleLearn';
import { SettingsSchema } from '../src/shared/settings';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

describe('Learning the user’s style from a finished video', () => {
  it('finds title and caption fonts, the accent, the handle and the end card line — and only what is new', () => {
    n = 0;
    const asset: Asset = { id: 'as_talk0001', kind: 'video', path: 'C:\v\t.mp4', name: 't.mp4', duration: 20, width: 1080, height: 1920, hasAudio: true };
    let p = applyEdits({ ...newProject({ name: 'Mine', rand }), assets: [asset] }, [{ op: 'add_media', assetId: asset.id, start: 0, duration: 20 }], { rand }).project;
    p = applyEdits(p, [
      { op: 'add_text', text: 'Meet Keo', start: 0, duration: 3, style: { font: 'Anton', color: '#E8BD73' } },
      { op: 'add_captions', replace: true, style: { font: 'Montserrat' }, highlight: '#E8BD73', lines: [{ text: 'hello there', start: 3, end: 4 }] },
      { op: 'add_text', text: 'Follow for more\n@keo.ai', start: 18, duration: 2, style: { font: 'Anton' } },
    ], { rand }).project;
    const r = learnStyle(p, {});
    expect(r.patch).toEqual({ headlineFont: 'Anton', bodyFont: 'Montserrat', accent: '#E8BD73', handle: '@keo.ai', endText: 'Follow for more' });
    expect(r.found).toHaveLength(5);
    // Already in the brand kit: nothing to propose again.
    expect(learnStyle(p, { headlineFont: 'Anton', bodyFont: 'Montserrat', accent: '#e8bd73', handle: '@keo.ai', endText: 'Follow for more' }).found).toEqual([]);
  });

  it('voice-first is off unless the user turns it on', () => {
    expect(SettingsSchema.parse({}).voice.voiceFirst).toBe(false);
  });
});
