import path from 'node:path';

/**
 * The user's main folders, by the names people (and the model) use for them. Keo is told their real
 * paths, and a tool input that names one ("Documents/Scorecard Test", "Downloads", "~/Desktop/a.png")
 * is turned into the full path before the tool checks it — so no tool ever has to ask the user
 * where their Documents folder is.
 */
export type KnownFolders = Record<'home' | 'desktop' | 'documents' | 'downloads' | 'pictures' | 'videos' | 'music', string>;

const NAMES: Record<string, keyof KnownFolders> = {
  desktop: 'desktop',
  documents: 'documents',
  'my documents': 'documents',
  downloads: 'downloads',
  pictures: 'pictures',
  photos: 'pictures',
  videos: 'videos',
  music: 'music',
  '~': 'home',
};

/** Fields of tool inputs that hold a file or folder path. */
// (Not "to", "from" or "target": those also name people and chats in message tools.)
const PATH_KEY = /^(path|paths|attachments|folder|folders|file|files|src|source|dest|destination|dir|directory|outputFolder|picture|pictures|image|images|video|audio)$/i;

/** The full path for a value that starts with a main folder's name, or null when it does not. */
export function knownPath(value: string, k: KnownFolders): string | null {
  const v = value.trim();
  if (!v || path.isAbsolute(v) || /^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  const m = /^(~|[A-Za-z ]+?)(?:[\\/](.*))?$/.exec(v);
  if (!m) return null;
  const key = NAMES[m[1]!.trim().toLowerCase()];
  if (!key) return null;
  const rest = (m[2] ?? '').replace(/^[\\/]+/, '');
  return rest ? path.join(k[key], ...rest.split(/[\\/]+/)) : k[key];
}

/** A tool's input with every path field that names a main folder turned into the full path. */
export function withKnownPaths(input: unknown, k: KnownFolders, depth = 0): unknown {
  if (depth > 4 || !input || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((x) => withKnownPaths(x, k, depth + 1));
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(input as Record<string, unknown>)) {
    let next = v;
    if (PATH_KEY.test(key) && typeof v === 'string') next = knownPath(v, k) ?? v;
    else if (PATH_KEY.test(key) && Array.isArray(v)) next = v.map((x) => (typeof x === 'string' ? (knownPath(x, k) ?? x) : x));
    else if (v && typeof v === 'object') next = withKnownPaths(v, k, depth + 1);
    if (next !== v) changed = true;
    out[key] = next;
  }
  return changed ? out : input;
}

/** The line Keo is given each turn. */
export function knownFoldersLine(k: KnownFolders): string {
  return `The user's folders (use these full paths; "Documents/…" also works in any path): Desktop ${k.desktop}; Documents ${k.documents}; Downloads ${k.downloads}; Pictures ${k.pictures}; Videos ${k.videos}; Music ${k.music}.`;
}
