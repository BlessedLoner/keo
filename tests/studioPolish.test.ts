import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEdits, newProject, Project, type Asset, type MediaClip, type MotionClip, type TextClip } from '../src/shared/studio';
import { momentOps } from '../src/shared/studioMoments';
import { fixIssues, reviewEdit, timelineIssues } from '../src/shared/studioReview';
import { checkFixes, namesFor, proofreadPrompt } from '../src/shared/studioProofread';
import { captionLines, spreadWords, wavOf } from '../src/main/studio/captions';
import { StudioService } from '../src/main/studio/studioService';
import { speechLike } from './fakeSpeechSound';
import { tempDir } from './helpers';

let n = 0;
const rand = () => `r${String(++n).padStart(7, '0')}`;

/** A 30-second vertical talking video. */
function talk(): Project {
  n = 0;
  const p0 = { ...newProject({ name: 'Podcast', rand }), width: 1080, height: 1920 };
  const asset: Asset = { id: 'as_talk0001', kind: 'video', path: 'C:\\v\\talk.mp4', name: 'talk.mp4', duration: 30, width: 1080, height: 1920, hasAudio: true };
  return applyEdits({ ...p0, assets: [asset] }, [{ op: 'add_media', assetId: asset.id, start: 0, duration: 30 }], { rand }).project;
}
const main = (p: Project) => p.tracks[0]!.clips[0] as MediaClip;
const cutout = (p: Project) => p.tracks.flatMap((t) => t.clips).find((c) => c.type === 'media' && c.cutout) as MediaClip;

describe('Studio polish: the cut-out follows the talking video', () => {
  it('a text-behind cut-out takes the mirror, zoom and framing the talking clip gets later', () => {
    let p = talk();
    p = applyEdits(p, momentOps(p, 'text-behind', { at: 10, duration: 3, text: 'Kira' }), { rand }).project;
    expect(cutout(p).flipX).toBeUndefined();
    // Later: the video is mirrored, framed smaller and punched in (as Keo did on the user's podcast).
    p = applyEdits(p, [{ op: 'set', clip: main(p).id, flipX: true, transform: { x: 0.5, y: 0.55, scale: 0.84 }, zooms: [{ at: 4, scale: 1.08, x: 0.5, y: 0.42, ease: 'cut' }, { at: 11.5, scale: 1.2, x: 0.5, y: 0.4, ease: 'cut' }] }], { rand }).project;
    const c = cutout(p);
    expect(c.flipX).toBe(true);
    expect(c.transform.scale).toBe(0.84);
    // At its start the zoom is where the talking clip's is (1.08 since 4 s), then the 1.2 punch 1.5 s in.
    expect(c.zooms?.[0]).toMatchObject({ at: 0, scale: 1.08 });
    expect(c.zooms?.[1]).toMatchObject({ at: 1.5, scale: 1.2 });
  });
});

describe('Studio polish: misheard words', () => {
  it('replace_words also puts right motion graphics (their text and list items)', () => {
    let p = talk();
    p = applyEdits(p, [
      { op: 'add_motion', piece: 'chips', text: 'Meet KUI', items: ['KUI voice', 'Other'], start: 1, duration: 3, place: 'auto' },
      { op: 'add_text', text: 'KUI is here', start: 5, duration: 2 },
    ], { rand }).project;
    const r = applyEdits(p, [{ op: 'replace_words', find: 'KUI', replace: 'Keo' }], { rand });
    const m = r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'motion') as MotionClip;
    expect(m.text).toBe('Meet Keo');
    expect(m.items).toEqual(['Keo voice', 'Other']);
    expect((r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text') as TextClip).text).toBe('Keo is here');
    expect(r.changes[0]).toContain('3 times');
  });

  it('keeps only real, small fixes found in the transcript (never a rewrite)', () => {
    const transcript = 'I want to tell you about KUI and those that has been flowing me know';
    const fixes = checkFixes(
      {
        fixes: [
          { heard: 'KUI', meant: 'Keo' },
          { heard: 'flowing me', meant: 'following me' },
          // Not in the transcript, a grammar rewrite of a long stretch, the same word, and junk.
          { heard: 'Kira', meant: 'Keo' },
          { heard: 'those that has been flowing me', meant: 'the people who have followed me on my journey so far today' },
          { heard: 'know', meant: 'know' },
          { nope: 1 },
        ],
      },
      transcript,
    );
    expect(fixes).toEqual([
      { heard: 'KUI', meant: 'Keo' },
      { heard: 'flowing me', meant: 'following me' },
    ]);
    expect(checkFixes('nonsense', transcript)).toEqual([]);
  });

  it('names come from the brand kit: "@keo.ai" means Keo', () => {
    expect(namesFor({ handle: '@keo.ai', project: 'My video' })).toEqual(['Keo']);
    expect(namesFor({ brandName: 'Studio Nine', handle: '@studio_nine', spellings: [{ say: 'Kira' }], project: 'Launch day' })).toEqual(['Studio Nine', 'Studio', 'Kira', 'Launch day']);
    expect(proofreadPrompt(['Keo'])).toContain('Keo');
    expect(proofreadPrompt([])).toMatch(/Never rewrite/);
  });

  it('a fresh transcript is proofread before anything uses it, and fixWords reaches the captions', async () => {
    const dir = tempDir('keo-proofread-');
    const sound = wavOf(speechLike(20, [[1, 6]]), 16000).toString('base64');
    const asked: Array<{ text: string; names: string[] }> = [];
    const s: StudioService = new StudioService({
      dir: path.join(dir, 'studio'),
      log: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined } as never,
      exportsDir: () => path.join(dir, 'Videos'),
      probe: async () => ({ kind: 'video', duration: 20, width: 1080, height: 1920, hasAudio: true }),
      changed: () => undefined,
      retryDelayMs: 0,
      proofread: async (text, names) => {
        asked.push({ text, names });
        return [{ heard: 'KUI', meant: 'Keo' }];
      },
      sendJob: (jobId, job) => setTimeout(() => s.jobDone(jobId, job.kind === 'asset_audio' ? { wavBase64: sound } : null, null), 0),
    });
    const p = s.create('Talk', 'vertical');
    const file = path.join(dir, 'talk.mp4');
    fs.writeFileSync(file, 'x');
    const { added } = await s.importFiles(p.id, [file]);
    s.edit(p.id, [{ op: 'add_media', assetId: added[0]!.id, start: 0, duration: 20 }]);
    const r = await s.transcribe(p.id, { text: async () => 'meet KUI your assistant' }, { signal: new AbortController().signal });
    expect(asked[0]!.text).toBe('meet KUI your assistant');
    expect(r.fixed).toEqual([{ heard: 'KUI', meant: 'Keo' }]);
    expect(s.get(p.id).assets[0]!.words!.map((w) => w.text).join(' ')).toBe('meet Keo your assistant');
    // A title made before (by hand) is put right too, along with the transcript.
    s.edit(p.id, [{ op: 'add_text', text: 'Meet Kira', start: 0, duration: 2 }]);
    const f = s.fixWords(p.id, [{ heard: 'Kira', meant: 'Keo' }]);
    expect(f.inText).toBe(1);
    expect(s.get(p.id).tracks.flatMap((t) => t.clips).some((c) => c.type === 'text' && c.text === 'Meet Keo')).toBe(true);
  });
});

describe('Studio polish: captions never hang', () => {
  it('words spread over unheard speech last only as long as they take to say', () => {
    // Three words heard over 14 s of mumbling.
    const words = spreadWords("I've got the", [{ start: 0, end: 14 }]);
    for (const w of words) expect(w.end - w.start).toBeLessThan(1.2);
    const lines = captionLines([{ text: "I've", start: 0, end: 4.6 }, { text: 'got', start: 4.6, end: 9.2 }, { text: 'the', start: 9.2, end: 14 }]);
    for (const l of lines) expect(l.end - l.start).toBeLessThan(2.5);
  });
});

describe('Studio polish: the review sees what an editor sees', () => {
  it('stuck captions, the same words twice at once, and blank frames', () => {
    let p = talk();
    p = applyEdits(p, [
      { op: 'add_captions', replace: true, lines: [{ text: 'I just met', start: 2, end: 6, words: [{ text: 'I', start: 2, end: 2.6 }, { text: 'just', start: 2.6, end: 4.6 }, { text: 'met', start: 4.6, end: 6 }] }, { text: 'hello there', start: 7, end: 7.8, words: [{ text: 'hello', start: 7, end: 7.4 }, { text: 'there', start: 7.4, end: 7.8 }] }] },
      { op: 'add_text', text: 'Meet Keo — your personal AI assistant', start: 0, duration: 4 },
      { op: 'add_motion', piece: 'headline', text: 'Meet Keo', start: 0.3, duration: 3, place: 'auto' },
      { op: 'add_text', text: 'Follow for more', start: 30.5, duration: 2.5 },
    ], { rand }).project;
    const issues = timelineIssues(p);
    const kinds = issues.map((i) => i.kind);
    expect(issues.filter((i) => i.kind === 'stuck').map((i) => i.at)).toEqual([2]);
    expect(kinds).toContain('same-words');
    const blank = issues.find((i) => i.kind === 'blank')!;
    expect(blank.at).toBe(30);
    // A clean edit has none of these.
    expect(timelineIssues(talk())).toEqual([]);
  });
});

describe('Studio polish: Keo fixes what the check finds', () => {
  it('trims stuck captions, drops the doubled title and designs the plain ending, in one go', () => {
    let p = talk();
    p = applyEdits(p, [
      { op: 'add_captions', replace: true, lines: [{ text: 'I just met', start: 2, end: 6, words: [{ text: 'I', start: 2, end: 2.6 }, { text: 'just', start: 2.6, end: 4.6 }, { text: 'met', start: 4.6, end: 6 }] }] },
      { op: 'add_text', text: 'Meet Keo — your personal AI assistant', start: 0, duration: 4 },
      { op: 'add_motion', piece: 'headline', text: 'Meet Keo', start: 0.3, duration: 3, place: 'auto' },
      { op: 'add_text', text: 'Follow for more', start: 30.5, duration: 2.5 },
    ], { rand }).project;
    const issues = timelineIssues(p);
    expect(issues.every((i) => i.ops?.length)).toBe(true);
    const r = fixIssues(p, issues, { rand });
    expect(r.skipped).toEqual([]);
    const after = timelineIssues(r.project);
    expect(after.map((i) => i.kind)).toEqual([]);
    // The ending: the words start where the video ends, over a backdrop.
    const card = r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text' && c.text === 'Follow for more')!;
    expect(card.start).toBe(30);
    expect(r.project.tracks.flatMap((t) => t.clips).some((c) => c.type === 'motion' && c.piece === 'backdrop' && c.start === 30)).toBe(true);
  });

  it('moves text off the face (above the head when there is room) and shrinks a picture on it', () => {
    let p = talk();
    p = applyEdits(p, [{ op: 'add_text', text: 'Big title', start: 1, duration: 3, transform: { x: 0.5, y: 0.4 } }], { rand }).project;
    const text = p.tracks.flatMap((t) => t.clips).find((c) => c.type === 'text')!;
    const issues = reviewEdit(p, [{ t: 2, person: { x0: 0.25, y0: 0.3, x1: 0.75, y1: 1 }, texts: [{ clip: text.id, track: 'Text', box: { x0: 0.3, y0: 0.36, x1: 0.7, y1: 0.44 } }] }]);
    const face = issues.find((i) => i.kind === 'face')!;
    const r = fixIssues(p, [face], { rand });
    const moved = r.project.tracks.flatMap((t) => t.clips).find((c) => c.id === text.id)!;
    // Its box would end just above the head (y 0.3).
    expect(moved.type === 'text' && moved.transform.y).toBeCloseTo(0.23, 2);
  });
});
