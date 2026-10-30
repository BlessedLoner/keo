import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EFFECT_KINDS, findSounds, guessSound, MUSIC_GENRES, type EffectKind, type MusicGenre, type Sound } from '../../shared/studioSounds';
import { SFX, type SfxKind } from './sfx';

/**
 * The user's sound library, shared by all their Studio projects: music and sound effects they
 * add are copied into Keo's own folder (so they stay when the original moves), sorted by kind
 * and genre, and searchable. Keo's own sound effects are listed with them.
 */

const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.wma']);
const BUILT_IN_GENRE: Record<SfxKind, EffectKind> = { whoosh: 'whoosh', pop: 'pop', click: 'click', ding: 'ding', riser: 'riser', boom: 'impact', swipe: 'swipe' };

export class SoundLibraryError extends Error {}

export class SoundLibrary {
  constructor(
    private readonly d: {
      dir: string;
      /** A sound file's length in seconds (null: not a sound Keo can use). */
      measure: (file: string) => Promise<number | null>;
      now?: () => Date;
    },
  ) {}

  private get index(): string {
    return path.join(this.d.dir, 'sounds.json');
  }

  private read(): Array<Sound & { file: string }> {
    try {
      return JSON.parse(fs.readFileSync(this.index, 'utf8')) as Array<Sound & { file: string }>;
    } catch {
      return [];
    }
  }

  private write(list: Array<Sound & { file: string }>): void {
    fs.mkdirSync(this.d.dir, { recursive: true });
    const tmp = `${this.index}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list));
    fs.renameSync(tmp, this.index);
  }

  /** Keo's own sound effects, as library entries. */
  private builtIns(): Sound[] {
    return (Object.keys(SFX) as SfxKind[]).map((k) => ({ id: `sfx_${k}`, name: `${SFX[k].label} (Keo)`, kind: 'effect', genre: BUILT_IN_GENRE[k], tags: ['keo'], duration: SFX[k].seconds, addedAt: '', builtIn: true }));
  }

  list(q: { query?: string; kind?: 'music' | 'effect'; genre?: string } = {}): Sound[] {
    const mine = this.read().map(({ file: _f, ...s }) => s);
    return findSounds([...mine, ...this.builtIns()], q);
  }

  /** The file behind one of the user's sounds (null: a built-in, or none). */
  file(id: string): string | null {
    const s = this.read().find((x) => x.id === id);
    return s && fs.existsSync(s.file) ? s.file : null;
  }

  get(id: string): Sound | null {
    return this.list().find((s) => s.id === id) ?? null;
  }

  /** Copies sound files into the library (each once, by content), guessing what each is. */
  async add(files: string[], o: { kind?: 'music' | 'effect'; genre?: MusicGenre | EffectKind } = {}): Promise<{ added: Sound[]; skipped: string[] }> {
    const list = this.read();
    const added: Sound[] = [];
    const skipped: string[] = [];
    const dir = path.join(this.d.dir, 'files');
    for (const raw of files) {
      const src = path.resolve(raw);
      const name = path.basename(src);
      if (!AUDIO_EXT.has(path.extname(src).toLowerCase()) || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
        skipped.push(`${name} (not a sound file: MP3, M4A, WAV, OGG, FLAC…)`);
        continue;
      }
      const hash = crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex').slice(0, 16);
      if (list.some((s) => path.basename(s.file).startsWith(hash))) {
        skipped.push(`${name} (already in your sounds)`);
        continue;
      }
      const seconds = await this.d.measure(src).catch(() => null);
      if (!seconds || seconds <= 0) {
        skipped.push(`${name} (Keo could not read it)`);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${hash}${path.extname(src).toLowerCase()}`);
      fs.copyFileSync(src, file);
      const guess = guessSound(name, seconds);
      const kind = o.kind ?? guess.kind;
      const genre = o.genre ?? (kind === guess.kind ? guess.genre : 'other');
      const s: Sound & { file: string } = {
        id: `sn_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`,
        name: name.replace(/\.[^.]+$/, '').slice(0, 120),
        kind,
        genre,
        tags: [],
        duration: Math.round(seconds * 1000) / 1000,
        addedAt: (this.d.now?.() ?? new Date()).toISOString(),
        file,
      };
      list.push(s);
      const { file: _f, ...shown } = s;
      added.push(shown);
    }
    if (added.length) this.write(list);
    return { added, skipped };
  }

  /** Renames or re-sorts one of the user's sounds. */
  update(id: string, patch: { name?: string; kind?: 'music' | 'effect'; genre?: string; tags?: string[] }): Sound {
    const list = this.read();
    const s = list.find((x) => x.id === id);
    if (!s) throw new SoundLibraryError(id.startsWith('sfx_') ? 'Keo’s own sound effects cannot be changed.' : 'That sound is not in your library.');
    if (patch.name?.trim()) s.name = patch.name.trim().slice(0, 120);
    if (patch.kind) s.kind = patch.kind;
    if (patch.genre) {
      const ok = s.kind === 'music' ? (MUSIC_GENRES as readonly string[]).includes(patch.genre) : (EFFECT_KINDS as readonly string[]).includes(patch.genre);
      if (!ok) throw new SoundLibraryError(`“${patch.genre}” is not a ${s.kind === 'music' ? 'music genre' : 'kind of sound effect'} Keo knows.`);
      s.genre = patch.genre as Sound['genre'];
    } else if (patch.kind) s.genre = 'other';
    if (patch.tags) s.tags = [...new Set(patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    this.write(list);
    const { file: _f, ...shown } = s;
    return shown;
  }

  /** Takes a sound out of the library (projects already using it keep working: they have their own copy of the media entry). */
  remove(id: string): void {
    const list = this.read();
    const s = list.find((x) => x.id === id);
    if (!s) throw new SoundLibraryError('That sound is not in your library.');
    this.write(list.filter((x) => x !== s));
  }
}
