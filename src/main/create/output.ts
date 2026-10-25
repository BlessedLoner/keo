import fs from 'node:fs';
import path from 'node:path';

/** File names Windows accepts: no reserved characters or device names, a sensible length, the right extension. */
export function safeFileName(name: string, ext: string): string {
  let base = name
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ') // eslint-disable-line no-control-regex
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120)
    .trim();
  if (!base) base = 'Untitled';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = `${base} file`;
  return `${base}${ext}`;
}

/** The name itself when free, else "name (2).ext", "name (3).ext"… */
export function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const p = path.join(dir, n === 1 ? fileName : `${base} (${n})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('Too many files with this name in that folder.');
}

/** Written next to the target and renamed into place, so a half-written file never appears. */
export function writeAtomic(target: string, data: Buffer | string): void {
  const tmp = `${target}.keo-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

export type CreatedKind = 'document' | 'presentation' | 'spreadsheet' | 'web_app' | 'model_3d';

export interface CreatedFile {
  path: string;
  kind: CreatedKind;
  title: string;
  createdAt: string;
  /** The spec it was made from (web pages: without the HTML, which is the file itself). */
  spec: unknown;
}

/**
 * The files Keo made, newest first (kept in Keo's data folder): only these can be regenerated in
 * place or opened with create__open, and their specs let the model change one and make it again.
 */
export class CreatedFiles {
  constructor(
    private readonly file: string,
    private readonly max = 200,
  ) {}

  list(): CreatedFile[] {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8')) as CreatedFile[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  get(p: string): CreatedFile | null {
    const key = path.resolve(p).toLowerCase();
    return this.list().find((f) => path.resolve(f.path).toLowerCase() === key) ?? null;
  }

  add(f: CreatedFile): void {
    const key = path.resolve(f.path).toLowerCase();
    const rest = this.list().filter((x) => path.resolve(x.path).toLowerCase() !== key);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    writeAtomic(this.file, JSON.stringify([f, ...rest].slice(0, this.max)));
  }
}
