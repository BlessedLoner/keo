import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { manageFileCapabilities } from '../src/main/capabilities/manageFiles';
import { tempDir } from './helpers';

const ctx = { signal: new AbortController().signal } as never;

function setup() {
  const home = tempDir('keo-home-');
  const known = { home, desktop: path.join(home, 'Desktop'), documents: path.join(home, 'Documents'), downloads: path.join(home, 'Downloads'), pictures: path.join(home, 'Pictures'), videos: path.join(home, 'Videos'), music: path.join(home, 'Music') };
  for (const k of Object.values(known)) fs.mkdirSync(k, { recursive: true });
  const trashed: string[] = [];
  const caps = manageFileCapabilities({
    allowed: (p) => (path.resolve(p) + path.sep).toLowerCase().startsWith((home + path.sep).toLowerCase()),
    enabled: () => true,
    known: () => known,
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { recursive: true, force: true });
    },
    undoFile: path.join(home, '.keo', 'undo.json'),
  });
  const manage = caps.find((c) => c.id === 'files.manage')!;
  const undo = caps.find((c) => c.id === 'files.undo')!;
  const run = async (actions: unknown[]) => (await manage.execute(manage.input.parse({ actions }) as never, ctx)) as { done: string[]; failed: string[] };
  return { home, known, trashed, manage, undo, run };
}

describe('working with files and folders', () => {
  it('makes a folder in Documents by name (the job that failed on screen), never overwriting one that exists', async () => {
    const { known, run } = setup();
    const r = await run([{ op: 'make_folder', path: 'Documents/New Keo Test' }]);
    expect(fs.statSync(path.join(known.documents, 'New Keo Test')).isDirectory()).toBe(true);
    expect(r.done[0]).toMatch(/made .*New Keo Test/);
    expect((await run([{ op: 'make_folder', path: 'Documents/New Keo Test' }])).done[0]).toMatch(/already exists/);
  });

  it('renames, copies, moves and duplicates many things in one call; a taken name becomes "name (2)"', async () => {
    const { known, run } = setup();
    fs.writeFileSync(path.join(known.downloads, 'cv.pdf'), 'cv');
    fs.writeFileSync(path.join(known.downloads, 'photo.jpg'), 'img');
    fs.mkdirSync(path.join(known.documents, 'Work'));
    fs.writeFileSync(path.join(known.documents, 'Work', 'cv.pdf'), 'older cv');
    const r = await run([
      { op: 'copy', from: 'Downloads/cv.pdf', to: 'Documents/Work' },
      { op: 'move', from: 'Downloads/photo.jpg', to: 'Pictures/Trip 2026' },
      { op: 'duplicate', path: 'Documents/Work' },
      { op: 'rename', path: 'Downloads/cv.pdf', name: 'My CV.pdf' },
    ]);
    expect(r.failed).toEqual([]);
    expect(fs.readFileSync(path.join(known.documents, 'Work', 'cv.pdf'), 'utf8')).toBe('older cv'); // never overwritten
    expect(fs.readFileSync(path.join(known.documents, 'Work', 'cv (2).pdf'), 'utf8')).toBe('cv');
    expect(fs.existsSync(path.join(known.pictures, 'Trip 2026', 'photo.jpg'))).toBe(true);
    expect(fs.existsSync(path.join(known.downloads, 'photo.jpg'))).toBe(false);
    expect(fs.existsSync(path.join(known.documents, 'Work (2)', 'cv (2).pdf'))).toBe(true);
    expect(fs.existsSync(path.join(known.downloads, 'My CV.pdf'))).toBe(true);
  });

  it('sorts a folder into Images, Documents, Videos… and undo puts everything back as it was', async () => {
    const { known, run, undo } = setup();
    for (const f of ['a.jpg', 'b.PNG', 'notes.docx', 'clip.mp4', 'song.mp3', 'stuff.zip', 'odd.xyz']) fs.writeFileSync(path.join(known.downloads, f), f);
    fs.mkdirSync(path.join(known.downloads, 'Keep me'));
    const r = await run([{ op: 'sort', folder: 'Downloads', by: 'type' }]);
    expect(r.done[0]).toMatch(/sorted 7 files/);
    expect(fs.readdirSync(path.join(known.downloads, 'Images')).sort()).toEqual(['a.jpg', 'b.PNG']);
    expect(fs.readdirSync(path.join(known.downloads, 'Documents'))).toEqual(['notes.docx']);
    expect(fs.readdirSync(path.join(known.downloads, 'Other'))).toEqual(['odd.xyz']);
    expect(fs.existsSync(path.join(known.downloads, 'Keep me'))).toBe(true); // folders are left alone
    const back = await undo.execute(undo.input.parse({}) as never, ctx);
    expect(await undo.verify!({} as never, back as never, ctx)).toMatchObject({ verified: true });
    expect(fs.readdirSync(known.downloads).sort()).toEqual(['Keep me', 'a.jpg', 'b.PNG', 'clip.mp4', 'notes.docx', 'odd.xyz', 'song.mp3', 'stuff.zip']);
  });

  it('sends to the Recycle Bin only when asked (and asks the user first); stays inside the user\'s folders; Windows\' own folders keep their place', async () => {
    const { home, known, trashed, manage, run } = setup();
    fs.writeFileSync(path.join(known.desktop, 'old.txt'), 'x');
    const del = manage.input.parse({ actions: [{ op: 'delete', path: 'Desktop/old.txt' }] });
    expect(manage.autonomy?.(del as never)).toMatchObject({ tier: 'important' });
    expect(manage.autonomy?.(manage.input.parse({ actions: [{ op: 'make_folder', path: 'Desktop/New' }] }) as never)).toMatchObject({ tier: 'routine' });
    await run([{ op: 'delete', path: 'Desktop/old.txt' }]);
    expect(trashed).toEqual([path.join(known.desktop, 'old.txt')]);
    const outside = path.join(path.dirname(home), 'not-mine');
    await expect(run([{ op: 'make_folder', path: outside }])).rejects.toThrow(/outside the folders Keo may work in/);
    await expect(run([{ op: 'move', from: 'Documents', to: 'Desktop' }])).rejects.toThrow(/Windows’ own folders/);
    await expect(run([{ op: 'rename', path: 'Desktop', name: 'x' }])).rejects.toThrow(/keeps its name/);
    await expect(run([{ op: 'make_folder', path: 'relative/thing' }])).rejects.toThrow(/not a full path or a known folder/);
  });
});
