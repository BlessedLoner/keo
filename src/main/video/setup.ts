import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { VideoToolsSetup } from '../../shared/domain';
import { LINKS } from '../../shared/release';
import { listZip, extractEntry, type ZipEntry } from './unzip';

/**
 * "Set up video tools": on the user's click only, Keo downloads one pinned Windows build of
 * ffmpeg, checks it against the SHA-256 written here, and unpacks ffmpeg.exe and ffprobe.exe
 * into its own data folder (no installer, no admin, no PATH change). A stopped download is
 * kept and continued on the next try; a cancelled or refused one is deleted.
 */
export interface FfmpegBuild {
  version: string;
  /** Who made the build (shown to the user). */
  publisher: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  licence: string;
  /** Where the ffmpeg source code is (the licence notice links here). */
  sourceUrl: string;
  /** The build's own page (its sources and configuration). */
  buildUrl: string;
}

/**
 * Gyan Doshi's "essentials" release build, linked from ffmpeg.org's download page, from the
 * builder's GitHub release. Size and SHA-256 are the ones GitHub publishes for the asset.
 * To move to a newer version, change all of these together.
 */
export const FFMPEG_BUILD: FfmpegBuild = {
  version: '9.0.2',
  publisher: 'Gyan Doshi (gyan.dev), linked from ffmpeg.org',
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  sizeBytes: 114_768_076,
  sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
  licence: 'GNU GPL version 3',
  sourceUrl: LINKS.ffmpegSource,
  buildUrl: LINKS.ffmpegBuild,
};

export type SetupState = VideoToolsSetup;

type Fetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface SetupDeps {
  /** Keo's tools folder (userData\tools). */
  root: string;
  fetch?: Fetch;
  build?: FfmpegBuild;
  /** An audit entry (kind video.tools_setup). */
  audit: (decision: string, detail: Record<string, unknown>) => void;
  changed: (s: SetupState) => void;
  /** No data for this long ends the attempt (the part downloaded so far is kept). */
  stallMs?: number;
  /** Free bytes on the drive of `dir` (null when unknown). */
  freeBytes?: (dir: string) => number | null;
}

class Stop extends Error {
  constructor(
    message: string,
    readonly keepPart: boolean,
    readonly decision: 'failed' | 'refused',
  ) {
    super(message);
  }
}

const MB = (b: number) => `${Math.round(b / 1_000_000)} MB`;
const MARKER = 'keo-ffmpeg.json';

export class FfmpegSetup {
  private readonly build: FfmpegBuild;
  private readonly fetch: Fetch;
  private st: Omit<SetupState, 'installed' | 'build'> = { phase: 'idle', receivedBytes: 0, totalBytes: 0, message: '', canResume: false };
  private ac: AbortController | null = null;
  private job: Promise<void> | null = null;
  private lastPush = 0;

  constructor(private readonly d: SetupDeps) {
    this.build = d.build ?? FFMPEG_BUILD;
    this.fetch = d.fetch ?? ((url, init) => fetch(url, init));
    this.st.totalBytes = this.build.sizeBytes;
    if (fs.existsSync(this.partFile)) Object.assign(this.st, { canResume: true, receivedBytes: fs.statSync(this.partFile).size });
  }

  /** Where Keo's own ffmpeg.exe and ffprobe.exe are. */
  get dir(): string {
    return path.join(this.d.root, 'ffmpeg');
  }

  private get partFile(): string {
    return path.join(this.d.root, 'downloads', `ffmpeg-${this.build.version}.zip.part`);
  }

  private get stagingDir(): string {
    return path.join(this.d.root, 'ffmpeg.new');
  }

  installed(): { version: string; dir: string } | null {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, MARKER), 'utf8')) as { version?: unknown };
      if (!fs.existsSync(path.join(this.dir, 'ffmpeg.exe')) || !fs.existsSync(path.join(this.dir, 'ffprobe.exe'))) return null;
      return { version: typeof m.version === 'string' ? m.version : 'unknown', dir: this.dir };
    } catch {
      return null;
    }
  }

  state(): SetupState {
    const b = this.build;
    return { ...this.st, installed: this.installed(), build: { version: b.version, sizeBytes: b.sizeBytes, publisher: b.publisher, licence: b.licence, sourceUrl: b.sourceUrl, buildUrl: b.buildUrl } };
  }

  get running(): boolean {
    return this.job !== null;
  }

  /** Starts the download (the user's click). Returns at once; progress comes through `changed`. */
  start(): SetupState {
    if (this.job) return this.state();
    this.ac = new AbortController();
    this.set({ phase: 'downloading', message: 'Starting the download…' }, true);
    this.job = this.run(this.ac.signal).finally(() => {
      this.job = null;
      this.ac = null;
    });
    return this.state();
  }

  /** Resolves when the current attempt has ended (tests). */
  async wait(): Promise<SetupState> {
    await this.job;
    return this.state();
  }

  cancel(): SetupState {
    this.ac?.abort();
    return this.state();
  }

  /** Deletes Keo's own copy (and any kept download). */
  remove(): SetupState {
    if (this.job) return this.state();
    const had = this.installed();
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.rmSync(this.partFile, { force: true });
    this.d.audit('removed', { version: had?.version ?? null });
    this.set({ phase: 'idle', receivedBytes: 0, message: 'Keo’s copy of ffmpeg was removed.', canResume: false }, true);
    return this.state();
  }

  private set(p: Partial<SetupState>, force = false): void {
    Object.assign(this.st, p);
    const now = Date.now();
    if (force || now - this.lastPush > 250) {
      this.lastPush = now;
      this.d.changed(this.state());
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    const b = this.build;
    const host = new URL(b.url).host;
    this.d.audit('started', { version: b.version, host, sizeBytes: b.sizeBytes });
    try {
      fs.mkdirSync(path.dirname(this.partFile), { recursive: true });
      fs.rmSync(this.stagingDir, { recursive: true, force: true });
      const free = this.d.freeBytes?.(this.d.root) ?? null;
      const need = b.sizeBytes * 3;
      if (free !== null && free < need) throw new Stop(`There is not enough free space for the video tools (about ${MB(need)} needed, ${MB(free)} free). Nothing was downloaded.`, true, 'failed');
      await this.download(signal);
      this.set({ phase: 'checking', message: 'Checking the download…' }, true);
      const hash = await sha256File(this.partFile, signal);
      if (hash !== b.sha256.toLowerCase()) {
        throw new Stop('The download did not match the published checksum, so Keo did not use it and deleted it. Nothing was installed.', false, 'refused');
      }
      this.set({ phase: 'unpacking', message: 'Unpacking ffmpeg…' }, true);
      await this.unpack(signal);
      fs.rmSync(this.partFile, { force: true });
      this.d.audit('installed', { version: b.version, host, sha256: b.sha256, dir: this.dir });
      this.set({ phase: 'done', receivedBytes: b.sizeBytes, canResume: false, message: `Video tools are ready (ffmpeg ${b.version}, in Keo’s own folder).` }, true);
    } catch (e) {
      fs.rmSync(this.stagingDir, { recursive: true, force: true });
      if (signal.aborted) {
        fs.rmSync(this.partFile, { force: true });
        this.d.audit('cancelled', { version: b.version, receivedBytes: this.st.receivedBytes });
        this.set({ phase: 'cancelled', receivedBytes: 0, canResume: false, message: 'Cancelled. The partial download was deleted; nothing was installed.' }, true);
        return;
      }
      const stop = e instanceof Stop ? e : new Stop(`The download stopped: ${e instanceof Error ? e.message : String(e)}.`, true, 'failed');
      if (!stop.keepPart) fs.rmSync(this.partFile, { force: true });
      const kept = stop.keepPart && fs.existsSync(this.partFile) && fs.statSync(this.partFile).size > 0;
      this.d.audit(stop.decision, { version: b.version, reason: stop.message, receivedBytes: this.st.receivedBytes });
      this.set({ phase: 'failed', canResume: kept, receivedBytes: kept ? this.st.receivedBytes : 0, message: stop.message + (kept ? ` ${MB(this.st.receivedBytes)} of ${MB(b.sizeBytes)} is kept; Try again continues from there.` : '') }, true);
    }
  }

  private async download(signal: AbortSignal, restarted = false): Promise<void> {
    const b = this.build;
    let have = fs.existsSync(this.partFile) ? fs.statSync(this.partFile).size : 0;
    if (have > b.sizeBytes) {
      fs.rmSync(this.partFile, { force: true });
      have = 0;
    }
    this.set({ receivedBytes: have, message: have ? `Continuing the download at ${MB(have)} of ${MB(b.sizeBytes)}…` : `Downloading ffmpeg ${b.version} (${MB(b.sizeBytes)})…` }, true);
    if (have === b.sizeBytes) return;

    // Our own controller: the user's cancel, or no data for a while.
    const inner = new AbortController();
    const onCancel = () => inner.abort();
    signal.addEventListener('abort', onCancel, { once: true });
    const stallMs = this.d.stallMs ?? 30_000;
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        inner.abort();
      }, stallMs);
    };
    let out: fs.WriteStream | null = null;
    try {
      arm();
      const res = await this.fetch(b.url, { headers: { 'User-Agent': 'Keo-Desktop', ...(have ? { Range: `bytes=${have}-` } : {}) }, signal: inner.signal });
      if (res.status === 416 && !restarted) {
        fs.rmSync(this.partFile, { force: true });
        clearTimeout(timer);
        return await this.download(signal, true);
      }
      if (res.status !== 200 && res.status !== 206) throw new Stop(`The download server answered ${res.status}. Try again later.`, true, 'failed');
      const append = res.status === 206 && have > 0;
      if (append) {
        const total = res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1];
        if (total && Number(total) !== b.sizeBytes) throw new Stop(`The server offered a file of ${MB(Number(total))} instead of ${MB(b.sizeBytes)}, so Keo did not use it.`, false, 'refused');
      } else {
        have = 0;
        const len = res.headers.get('content-length');
        if (len && Number(len) !== b.sizeBytes) throw new Stop(`The server offered a file of ${MB(Number(len))} instead of ${MB(b.sizeBytes)}, so Keo did not use it.`, false, 'refused');
      }
      if (!res.body) throw new Stop('The download server sent nothing. Try again later.', true, 'failed');
      out = fs.createWriteStream(this.partFile, { flags: append ? 'a' : 'w' });
      let got = have;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        arm();
        got += chunk.length;
        if (got > b.sizeBytes) throw new Stop('The download is larger than the published file, so Keo did not use it.', false, 'refused');
        if (!out.write(chunk)) await once(out, 'drain');
        this.set({ receivedBytes: got, message: `Downloading ffmpeg ${b.version}: ${MB(got)} of ${MB(b.sizeBytes)}…` });
      }
      await closeStream(out);
      out = null;
      if (got !== b.sizeBytes) throw new Stop(`The download stopped at ${MB(got)} of ${MB(b.sizeBytes)}.`, true, 'failed');
      this.set({ receivedBytes: got }, true);
    } catch (e) {
      if (out) await closeStream(out).catch(() => undefined);
      if (stalled && !signal.aborted) throw new Stop(`The download got no data for ${Math.round(stallMs / 1000)} s (slow or broken connection).`, true, 'failed');
      if (e instanceof Stop || signal.aborted) throw e;
      throw new Stop(`The download failed (${e instanceof Error ? e.message : String(e)}). Check the internet connection.`, true, 'failed');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onCancel);
    }
  }

  private async unpack(signal: AbortSignal): Promise<void> {
    const b = this.build;
    const entries = await listZip(this.partFile);
    // The archive holds one top folder: <name>/bin/ffmpeg.exe, <name>/bin/ffprobe.exe, <name>/LICENSE.
    const find = (re: RegExp): ZipEntry | undefined => entries.find((e) => re.test(e.name));
    const ffmpeg = find(/^[^/]+\/bin\/ffmpeg\.exe$/i);
    const ffprobe = find(/^[^/]+\/bin\/ffprobe\.exe$/i);
    const licence = find(/^[^/]+\/LICENSE(\.txt)?$/i);
    if (!ffmpeg || !ffprobe) throw new Stop('The download does not contain ffmpeg.exe and ffprobe.exe. Nothing was installed.', false, 'refused');
    const stage = this.stagingDir;
    fs.mkdirSync(stage, { recursive: true });
    await extractEntry(this.partFile, ffmpeg, path.join(stage, 'ffmpeg.exe'), signal);
    await extractEntry(this.partFile, ffprobe, path.join(stage, 'ffprobe.exe'), signal);
    if (licence) await extractEntry(this.partFile, licence, path.join(stage, 'LICENSE.txt'), signal);
    fs.writeFileSync(path.join(stage, 'NOTICE.txt'), licenceNotice(b), 'utf8');
    fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ version: b.version, url: b.url, sha256: b.sha256, installedAt: new Date().toISOString() }, null, 1));
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.renameSync(stage, this.dir);
  }
}

export function licenceNotice(b: FfmpegBuild): string {
  return [
    `ffmpeg ${b.version} (ffmpeg.exe and ffprobe.exe in this folder)`,
    '',
    `This is FFmpeg (https://ffmpeg.org), built for Windows by ${b.publisher}.`,
    `It is licensed under the ${b.licence}; the licence text is in LICENSE.txt.`,
    `FFmpeg's source code: ${b.sourceUrl}`,
    `This build, its configuration and the sources of the libraries in it: ${b.buildUrl}`,
    `Downloaded by Keo, on your request, from ${b.url}`,
    `SHA-256 of the download: ${b.sha256}`,
    '',
    'Keo runs these programs as separate processes; it does not change them.',
    '',
  ].join('\r\n');
}

async function sha256File(file: string, signal: AbortSignal): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) h.update(chunk as Buffer);
  return h.digest('hex');
}

function closeStream(s: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.end(() => resolve());
  });
}
