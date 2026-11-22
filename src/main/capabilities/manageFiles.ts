import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CapabilityError, defineCapability, type AnyCapability } from './types';
import { looksSecret } from './findFiles';

/**
 * Working with files and folders the way a person who knows Windows does, but directly and exactly:
 * make folders, rename, copy, move, duplicate, send to the Recycle Bin, and sort a folder by type or
 * month — many in one step, only inside the user's own folders, never overwriting anything, and
 * every batch can be undone. Much faster and surer than doing it on the screen in File Explorer.
 */
export interface ManageFilesDeps {
  /** Whether a path is inside the folders Keo may work in (the same folders as file search). */
  allowed(p: string): boolean;
  enabled(): boolean;
  /** The user's real known folders (Documents may live in OneDrive). */
  known(): Record<'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music' | 'home', string>;
  /** Sends a file or folder to the Recycle Bin (restorable). */
  trash(p: string): Promise<void>;
  /** Where the undo list is kept (tests may omit it). */
  undoFile?: string;
}

const KINDS: Array<[string, RegExp]> = [
  ['Images', /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg|tiff?|avif|raw|cr2|nef|psd)$/i],
  ['Videos', /\.(mp4|mov|avi|mkv|webm|m4v|wmv|flv|3gp|mts)$/i],
  ['Music', /\.(mp3|wav|m4a|flac|aac|ogg|wma|opus|aiff)$/i],
  ['Documents', /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|epub|pages|numbers|key)$/i],
  ['Archives', /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i],
  ['Installers', /\.(exe|msi|msix|appx)$/i],
];
const kindOf = (file: string) => KINDS.find(([, re]) => re.test(file))?.[0] ?? 'Other';

const Path = z.string().trim().min(1).max(1000).describe('A full path, or a known folder name followed by the rest: "Documents/New Keo Test", "Downloads/report.pdf", "Desktop". Known: Desktop, Documents, Downloads, Pictures, Videos, Music, Home.');
const Action = z.discriminatedUnion('op', [
  z.object({ op: z.literal('make_folder'), path: Path }).strict(),
  z.object({ op: z.literal('rename'), path: Path, name: z.string().trim().min(1).max(200).describe('The new name only (keep the extension for a file)') }).strict(),
  z.object({ op: z.literal('copy'), from: Path, to: Path.describe('The folder to copy into') }).strict(),
  z.object({ op: z.literal('move'), from: Path, to: Path.describe('The folder to move into') }).strict(),
  z.object({ op: z.literal('duplicate'), path: Path }).strict(),
  z.object({ op: z.literal('delete'), path: Path }).strict(),
  z.object({ op: z.literal('sort'), folder: Path, by: z.enum(['type', 'month']).default('type') }).strict(),
]);
type Action = z.infer<typeof Action>;

/** One thing done, and how to take it back. */
interface Undo {
  kind: 'remove_created' | 'move_back' | 'rename_back' | 'trashed';
  from: string;
  to: string;
}

const BAD_NAME = /[<>:"/\\|?*]|^\.+$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export function manageFileCapabilities(d: ManageFilesDeps): AnyCapability[] {
  const off = () => (d.enabled() ? null : 'Working with files is off. The user can turn on finding files in Settings → Files (“Let Keo find my files”).');

  /** A path as the user or model said it → the real full path (known folders resolved). */
  const resolve = (p: string): string => {
    const clean = p.replace(/^["']|["']$/g, '').replace(/\//g, '\\').trim();
    const known = d.known();
    const m = /^(desktop|documents|my documents|downloads|pictures|videos|music|home)(?:\\(.*))?$/i.exec(clean);
    if (m) {
      const key = m[1]!.toLowerCase().replace('my documents', 'documents') as keyof typeof known;
      return path.resolve(known[key], m[2] ?? '');
    }
    if (!path.isAbsolute(clean)) throw new CapabilityError('invalid_input', `“${p}” is not a full path or a known folder (Desktop, Documents, Downloads, Pictures, Videos, Music).`, { dispatched: 'no' });
    return path.resolve(clean);
  };
  const guard = (full: string, what: string) => {
    if (!d.allowed(full)) throw new CapabilityError('not_allowed', `${what} (${full}) is outside the folders Keo may work in (Settings → Files).`, { dispatched: 'no' });
    if (looksSecret(full)) throw new CapabilityError('not_allowed', `${path.basename(full)} looks like it holds passwords or keys: Keo does not move or change it.`, { dispatched: 'no' });
  };
  const known = () => Object.values(d.known()).map((k) => path.resolve(k).toLowerCase());
  const isKnownRoot = (full: string) => known().includes(path.resolve(full).toLowerCase());

  /** A free name next to it: "name (2).ext", "name (3).ext"… (never overwrites). */
  const free = (target: string): string => {
    if (!fs.existsSync(target)) return target;
    const dir = path.dirname(target);
    const ext = fs.existsSync(target) && fs.statSync(target).isDirectory() ? '' : path.extname(target);
    const base = path.basename(target, ext);
    for (let n = 2; n < 1000; n++) {
      const t = path.join(dir, `${base} (${n})${ext}`);
      if (!fs.existsSync(t)) return t;
    }
    throw new CapabilityError('no_free_name', `Too many copies of ${base} already.`, { dispatched: 'no' });
  };
  const moveItem = (from: string, to: string) => {
    try {
      fs.renameSync(from, to);
    } catch (e) {
      // Another drive: copy, then remove the original.
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
      fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };

  // ---- the undo list (last 20 batches)
  const loadUndo = (): Array<{ at: string; summary: string; steps: Undo[] }> => {
    try {
      return d.undoFile && fs.existsSync(d.undoFile) ? (JSON.parse(fs.readFileSync(d.undoFile, 'utf8')) as Array<{ at: string; summary: string; steps: Undo[] }>) : memory;
    } catch {
      return memory;
    }
  };
  let memory: Array<{ at: string; summary: string; steps: Undo[] }> = [];
  const saveUndo = (all: Array<{ at: string; summary: string; steps: Undo[] }>) => {
    memory = all.slice(-20);
    if (d.undoFile) {
      try {
        fs.mkdirSync(path.dirname(d.undoFile), { recursive: true });
        fs.writeFileSync(d.undoFile, JSON.stringify(memory));
      } catch {
        /* kept in memory */
      }
    }
  };

  /** How many files an action touches (for asking first when it is a lot). */
  const countOf = (a: Action): number => {
    try {
      if (a.op === 'sort') return fs.readdirSync(resolve(a.folder)).length;
      if (a.op === 'move' || a.op === 'copy') {
        const f = resolve(a.from);
        return fs.existsSync(f) && fs.statSync(f).isDirectory() ? fs.readdirSync(f).length + 1 : 1;
      }
    } catch {
      /* unknown */
    }
    return 1;
  };
  const label = (a: Action): string =>
    a.op === 'make_folder'
      ? `make the folder ${a.path}`
      : a.op === 'rename'
        ? `rename ${a.path} to “${a.name}”`
        : a.op === 'copy'
          ? `copy ${a.from} into ${a.to}`
          : a.op === 'move'
            ? `move ${a.from} into ${a.to}`
            : a.op === 'duplicate'
              ? `duplicate ${a.path}`
              : a.op === 'delete'
                ? `send ${a.path} to the Recycle Bin`
                : `sort ${a.folder} into folders by ${a.by}`;

  const manage = defineCapability({
    id: 'files.manage',
    version: '1.0.0',
    title: 'Work with files and folders',
    description:
      'Make folders, rename, copy, move, duplicate, send to the Recycle Bin, and sort a folder into subfolders by type (Images, Videos, Music, Documents, Archives, Installers, Other) or by month — up to 50 actions in ONE call, done directly and exactly (never on the screen in File Explorer). Paths: full paths, or a known folder followed by the rest: "Documents/New Keo Test", "Downloads/report.pdf", "Pictures". copy and move put the item INTO the "to" folder (made if missing). Nothing is ever overwritten: a name already taken becomes "name (2)". Use files__search first to find a file the user describes. Every call can be undone with files__undo. Use this for any request about organising, creating, renaming or moving files and folders; show the result with files__reveal if the user wants to see it.',
    input: z.object({ actions: z.array(Action).min(1).max(50) }).strict(),
    output: z.object({ done: z.array(z.string()), failed: z.array(z.string()), undo: z.string() }),
    risk: 'medium',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Each result is checked on disk (the new folder, file or place exists).',
    unavailableReason: off,
    // Small everyday changes run as asked; deleting, or moving or sorting many files, asks first.
    autonomy: (i) => {
      if (i.actions.some((a) => a.op === 'delete')) return { tier: 'important' as const, reason: 'it sends files to the Recycle Bin' };
      const many = i.actions.reduce((n, a) => n + countOf(a), 0);
      return many > 20 ? { tier: 'important' as const, reason: `it moves or sorts about ${many} files` } : { tier: 'routine' as const };
    },
    preview: (i) => ({
      summary: i.actions.length === 1 ? label(i.actions[0]!).replace(/^./, (c) => c.toUpperCase()) : `${i.actions.length} changes to your files`,
      target: null,
      consequences: [...i.actions.slice(0, 12).map(label), ...(i.actions.length > 12 ? [`…and ${i.actions.length - 12} more`] : []), 'Nothing is overwritten; it can all be undone.'],
      dataExport: null,
    }),
    auditView: (i) => ({ ops: i.actions.map((a) => a.op) }),
    async execute(i) {
      const done: string[] = [];
      const failed: string[] = [];
      const undo: Undo[] = [];
      for (const a of i.actions) {
        try {
          if (a.op === 'make_folder') {
            const p = resolve(a.path);
            guard(p, 'The new folder');
            if (fs.existsSync(p)) {
              done.push(`${p} already exists`);
              continue;
            }
            // Folders that did not exist yet along the way are made too (and undone together).
            let top = p;
            while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
            fs.mkdirSync(p, { recursive: true });
            undo.push({ kind: 'remove_created', from: top, to: '' });
            done.push(`made ${p}`);
          } else if (a.op === 'rename') {
            const p = resolve(a.path);
            guard(p, 'The item');
            if (!fs.existsSync(p)) throw new Error(`${p} does not exist`);
            if (isKnownRoot(p)) throw new Error(`${p} is one of Windows’ own folders: it keeps its name`);
            if (BAD_NAME.test(a.name)) throw new Error(`“${a.name}” is not a name Windows allows`);
            const to = free(path.join(path.dirname(p), a.name));
            fs.renameSync(p, to);
            undo.push({ kind: 'rename_back', from: to, to: p });
            done.push(`renamed ${p} to ${path.basename(to)}`);
          } else if (a.op === 'copy' || a.op === 'move' || a.op === 'duplicate') {
            const from = resolve(a.op === 'duplicate' ? a.path : a.from);
            guard(from, 'The item');
            if (!fs.existsSync(from)) throw new Error(`${from} does not exist`);
            if (a.op === 'move' && isKnownRoot(from)) throw new Error(`${from} is one of Windows’ own folders: it stays where it is`);
            const dir = a.op === 'duplicate' ? path.dirname(from) : resolve(a.to);
            guard(dir, 'The destination');
            if ((dir + path.sep).toLowerCase().startsWith(from.toLowerCase() + path.sep)) throw new Error(`a folder cannot go inside itself (${from} → ${dir})`);
            if (!fs.existsSync(dir)) {
              let top = dir;
              while (!fs.existsSync(path.dirname(top))) top = path.dirname(top);
              fs.mkdirSync(dir, { recursive: true });
              undo.push({ kind: 'remove_created', from: top, to: '' });
            }
            const to = free(path.join(dir, path.basename(from)));
            if (a.op === 'move') {
              moveItem(from, to);
              undo.push({ kind: 'move_back', from: to, to: from });
              done.push(`moved ${from} to ${to}`);
            } else {
              fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
              undo.push({ kind: 'remove_created', from: to, to: '' });
              done.push(`${a.op === 'copy' ? 'copied' : 'duplicated'} ${from} as ${to}`);
            }
          } else if (a.op === 'delete') {
            const p = resolve(a.path);
            guard(p, 'The item');
            if (!fs.existsSync(p)) throw new Error(`${p} does not exist`);
            if (isKnownRoot(p)) throw new Error(`${p} is one of Windows’ own folders: Keo does not remove it`);
            await d.trash(p);
            undo.push({ kind: 'trashed', from: p, to: '' });
            done.push(`sent ${p} to the Recycle Bin`);
          } else if (a.op === 'sort') {
            const folder = resolve(a.folder);
            guard(folder, 'The folder');
            if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder`);
            let moved = 0;
            const groups = new Map<string, number>();
            for (const name of fs.readdirSync(folder)) {
              const from = path.join(folder, name);
              const st = fs.statSync(from);
              if (!st.isFile() || looksSecret(from) || name.startsWith('.') || /^desktop\.ini$/i.test(name)) continue;
              const group = a.by === 'type' ? kindOf(name) : st.mtime.toISOString().slice(0, 7);
              const dir = path.join(folder, group);
              if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir);
                undo.push({ kind: 'remove_created', from: dir, to: '' });
              }
              const to = free(path.join(dir, name));
              moveItem(from, to);
              undo.push({ kind: 'move_back', from: to, to: from });
              groups.set(group, (groups.get(group) ?? 0) + 1);
              moved++;
            }
            done.push(`sorted ${moved} files in ${folder}: ${[...groups].map(([g, n]) => `${n} into ${g}`).join(', ') || 'nothing to sort'}`);
          }
        } catch (e) {
          failed.push(`${label(a)}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (undo.length) saveUndo([...loadUndo(), { at: new Date().toISOString(), summary: done.slice(0, 3).join('; '), steps: undo }]);
      if (!done.length) throw new CapabilityError('files_failed', failed.join(' '), { dispatched: 'no' });
      return { done, failed, undo: undo.length ? 'files__undo takes this back.' : 'Nothing changed.' };
    },
    async verify(_i, o) {
      return o.failed.length ? { verified: false, detail: `Some did not work: ${o.failed.join(' ')}` } : { verified: true, detail: o.done.join('; ').slice(0, 400) };
    },
  });

  const undo = defineCapability({
    id: 'files.undo',
    version: '1.0.0',
    title: 'Undo the last change to files',
    description: 'Takes back the last files__manage call (or the last n): moved items go back, new folders and copies that are still empty or untouched are removed, renamed items get their names back. Items sent to the Recycle Bin are restored from there by the user (say so).',
    input: z.object({ batches: z.number().int().min(1).max(20).default(1) }).strict(),
    output: z.object({ undone: z.array(z.string()), left: z.array(z.string()), check: z.array(z.object({ path: z.string(), there: z.boolean() })) }),
    risk: 'medium',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 10 * 60_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Each item is checked back in its old place.',
    unavailableReason: off,
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Undo the last ${i.batches > 1 ? `${i.batches} changes` : 'change'} to your files`, target: null, consequences: loadUndo().slice(-i.batches).map((b) => b.summary), dataExport: null }),
    auditView: (i) => ({ batches: i.batches }),
    async execute(i) {
      const all = loadUndo();
      if (!all.length) throw new CapabilityError('nothing_to_undo', 'There is nothing to undo.', { dispatched: 'no' });
      const take = all.splice(-i.batches);
      const undone: string[] = [];
      const left: string[] = [];
      const check: Array<{ path: string; there: boolean }> = [];
      for (const batch of take.reverse())
        for (const u of [...batch.steps].reverse()) {
          try {
            if (u.kind === 'move_back' || u.kind === 'rename_back') {
              if (!fs.existsSync(u.from)) throw new Error(`${u.from} is no longer there`);
              if (fs.existsSync(u.to)) throw new Error(`${u.to} is taken again`);
              fs.mkdirSync(path.dirname(u.to), { recursive: true });
              moveItem(u.from, u.to);
              undone.push(`${path.basename(u.from)} back to ${u.to}`);
              check.push({ path: u.to, there: true });
            } else if (u.kind === 'remove_created') {
              if (!fs.existsSync(u.from)) continue;
              // A new folder is removed only when empty (the user may have put things in it since).
              if (fs.statSync(u.from).isDirectory() && fs.readdirSync(u.from).length) throw new Error(`${u.from} has files in it now: left in place`);
              fs.rmSync(u.from, { recursive: true, force: true });
              undone.push(`removed ${u.from}`);
              check.push({ path: u.from, there: false });
            } else left.push(`${u.from} is in the Recycle Bin: restore it from there`);
          } catch (e) {
            left.push(e instanceof Error ? e.message : String(e));
          }
        }
      saveUndo(all);
      return { undone, left, check };
    },
    async verify(_i, o) {
      const wrong = o.check.filter((c) => fs.existsSync(c.path) !== c.there).map((c) => (c.there ? `${c.path} is not back` : `${c.path} is still there`));
      if (wrong.length) return { verified: false, detail: wrong.join('; ') };
      return { verified: true, detail: [o.undone.join('; ') || 'Nothing to put back.', ...o.left].join(' ').slice(0, 400) };
    },
  });

  return [manage, undo];
}
