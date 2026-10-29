import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../logging/logger';
import { detectBeats } from '../video/ffmpeg';
import { applyEdits, describeProject, EditError, ExportOptions, exportSize, findClip, isAV, needsAnalysis, sourceSpan, type AudioClip, type MediaClip, newProject, Project, projectDuration, timelineWords, type Asset, type AssetKind, type EditOp, type FormatId, type ProjectSummary, type RenderJob, type TextStyle } from '../../shared/studio';
import { refineCut, sceneCandidates, sceneSplitTimes } from '../../shared/studioScenes';

export type { ProjectSummary, RenderJob };
import { captionLines, pieces, readWav, spreadWords, voicedSpans, wavOf, type CaptionLine, type Word } from './captions';
import { planCleanup, punchIns, type CleanupPlan } from './cleanup';
import { SFX, sfxWav, type SfxKind } from './sfx';
import { keyBefore, Mp4Reader, Mp4Writer, type Mp4Track, type WriterAudio, type WriterVideo } from './mp4';

/**
 * Keo Studio's projects and media, in the account's own folder (studio\<project id>.json). The
 * Studio page and Keo's tools both edit through here: every change is checked (see applyEdits),
 * saved, and can be undone. Rendering (previews, frames for Keo to look at, exports) happens in a
 * Keo window with the PC's own video codecs; this service feeds it the clips' compressed frames and
 * writes the finished MP4.
 */


export interface ProbeResult {
  kind: AssetKind;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}


export interface StudioDeps {
  /** The account folder's studio directory. */
  dir: string;
  log: Logger;
  /** Where finished videos go (Videos\Keo). */
  exportsDir: () => string;
  /** Sends a job to the render window; the window answers through jobDone. */
  sendJob?: (jobId: string, job: RenderJob) => void;
  /** Pictures and non-MP4 media (sizes and lengths); MP4/MOV/M4A are read here directly. */
  probe?: (file: string) => Promise<ProbeResult | null>;
  /** Something about a project changed (the Studio page shows it). */
  changed?: (p: Project) => void;
  now?: () => Date;
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wmv', '.3gp', '.mts']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.opus', '.flac', '.wma']);
const MP4_EXT = new Set(['.mp4', '.mov', '.m4v', '.m4a', '.3gp']);
const UNDO_DEPTH = 60;

export class StudioError extends Error {}

export function kindOfFile(file: string): AssetKind | null {
  const ext = path.extname(file).toLowerCase();
  return VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : AUDIO_EXT.has(ext) ? 'audio' : null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export class StudioService {
  private readonly undo = new Map<string, Project[]>();
  private readonly redo = new Map<string, Project[]>();
  private readonly readers = new Map<string, Mp4Reader | null>();
  private readonly jobs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly exports = new Map<string, { writer: Mp4Writer; file: string; projectId: string }>();
  /** The export running for each project (to stop it). */
  private readonly running = new Map<string, string>();

  /** Stops a project's running export (the render window stops at the next frame; nothing is saved). */
  cancelExport(id: string): boolean {
    const exportId = this.running.get(id);
    if (!exportId || !this.d.sendJob) return false;
    this.d.sendJob(`job_${crypto.randomBytes(6).toString('hex')}`, { kind: 'cancel', exportId });
    return true;
  }

  /** File names the user chose for exports that are running. */
  private readonly exportNames = new Map<string, string>();
  /** Exports that are Keo's own working files (a reversed copy): their folder and exact file name. */
  private readonly exportTargets = new Map<string, string>();
  /** The project open in the Studio page (Keo's tools act on it unless they name another). */
  current: string | null = null;

  constructor(private readonly d: StudioDeps) {
    fs.mkdirSync(d.dir, { recursive: true });
  }

  private file(id: string): string {
    if (!/^pr_[A-Za-z0-9]{4,24}$/.test(id)) throw new StudioError('That is not a Studio project id.');
    return path.join(this.d.dir, `${id}.json`);
  }

  list(): ProjectSummary[] {
    const out: ProjectSummary[] = [];
    for (const f of fs.readdirSync(this.d.dir)) {
      if (!/^pr_[A-Za-z0-9]+\.json$/.test(f)) continue;
      try {
        const p = Project.parse(JSON.parse(fs.readFileSync(path.join(this.d.dir, f), 'utf8')));
        const first = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media').sort((x, y) => x.start - y.start)[0];
        const cover = (first?.type === 'media' ? p.assets.find((a) => a.id === first.assetId) : undefined) ?? p.assets.find((a) => a.kind !== 'audio') ?? null;
        out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, width: p.width, height: p.height, duration: projectDuration(p), clips: p.tracks.reduce((n, t) => n + t.clips.length, 0), cover: cover ? { ...cover, words: undefined, speech: undefined, beats: undefined, scenes: undefined } : null });
      } catch {
        /* a damaged file is left alone */
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project {
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new StudioError('That Studio project does not exist (any more).');
    try {
      return Project.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
    } catch {
      // A damaged file: the newest backup that reads back, put in its place.
      for (const b of this.backups(id)) {
        try {
          const p = Project.parse(JSON.parse(fs.readFileSync(b, 'utf8')));
          fs.copyFileSync(f, `${f}.damaged`);
          fs.writeFileSync(f, JSON.stringify(p));
          this.d.log.warn('studio.restored_backup', {});
          return p;
        } catch {
          /* try an older one */
        }
      }
      throw new StudioError('That Studio project’s file is damaged and no backup could be read.');
    }
  }

  /** A project's backups, newest first. */
  private backups(id: string): string[] {
    const dir = path.join(this.d.dir, 'backups', id);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json'))
      .sort()
      .reverse()
      .map((n) => path.join(dir, n));
  }

  /** Every 5 minutes of editing, a copy of the project as it was (the last 10 are kept). */
  private readonly lastBackup = new Map<string, number>();
  private backup(id: string, file: string): void {
    const now = (this.d.now?.() ?? new Date()).getTime();
    if (now - (this.lastBackup.get(id) ?? 0) < 5 * 60_000 || !fs.existsSync(file)) return;
    this.lastBackup.set(id, now);
    try {
      const dir = path.join(this.d.dir, 'backups', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`));
      for (const old of this.backups(id).slice(10)) fs.rmSync(old, { force: true });
    } catch {
      /* a backup is a convenience; saving goes on */
    }
  }

  private save(p: Project): void {
    const f = this.file(p.id);
    this.backup(p.id, f);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p));
    fs.renameSync(tmp, f);
    this.d.changed?.(p);
  }

  create(name: string, format: FormatId = 'vertical'): Project {
    const p = newProject({ name, format, ...(this.d.now ? { now: this.d.now() } : {}), rand: () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10) });
    this.save(p);
    this.current = p.id;
    this.d.log.info('studio.created', { format });
    return p;
  }

  open(id: string): Project {
    const p = this.get(id);
    this.current = id;
    return p;
  }

  /** A template's slots: the videos and pictures on its video tracks, in the order they play. */
  templateSlots(p: Project): MediaClip[] {
    return p.tracks
      .filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
      .filter((c): c is MediaClip => c.type === 'media')
      .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }

  /**
   * A new project made from a template (any project): the same edit, with these files in its video
   * slots in order (extra slots keep the template's own media). One project, fully undoable.
   */
  async fromTemplate(templateId: string, files: string[], name?: string): Promise<{ project: Project; filled: number; slots: number }> {
    const tpl = this.get(templateId);
    const slots = this.templateSlots(tpl);
    if (!slots.length) throw new StudioError('That project has no videos or pictures to replace: it cannot be used as a template.');
    const copy = this.duplicate(templateId);
    const named = Project.parse({ ...copy, name: (name ?? `${tpl.name} — my version`).slice(0, 120) });
    this.save(named);
    const imported = await this.importFiles(named.id, files);
    const visual = imported.added.filter((a) => a.kind !== 'audio');
    if (!visual.length) {
      this.delete(named.id);
      throw new StudioError(imported.skipped.length ? `Keo could not use those files: ${imported.skipped.slice(0, 2).join('; ')}` : 'Choose videos or pictures to put in the template.');
    }
    const ops: EditOp[] = this.templateSlots(this.get(named.id))
      .slice(0, visual.length)
      .map((c, i) => ({ op: 'replace_media' as const, clip: c.id, assetId: visual[i]!.id }));
    const r = this.edit(named.id, ops);
    this.current = named.id;
    this.d.log.info('studio.template_used', { slots: slots.length, filled: ops.length });
    return { project: r.project, filled: ops.length, slots: slots.length };
  }

  /** A copy of a project (its timeline and media list; the media files themselves are shared). */
  duplicate(id: string): Project {
    const p = this.get(id);
    const copy = Project.parse({ ...structuredClone(p), id: `pr_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, name: `${p.name} (copy)`.slice(0, 120), createdAt: (this.d.now?.() ?? new Date()).toISOString(), updatedAt: (this.d.now?.() ?? new Date()).toISOString() });
    this.save(copy);
    this.d.log.info('studio.duplicated', {});
    return copy;
  }

  delete(id: string): void {
    fs.rmSync(this.file(id), { force: true });
    fs.rmSync(path.join(this.d.dir, 'backups', id), { recursive: true, force: true });
    this.undo.delete(id);
    this.redo.delete(id);
    if (this.current === id) this.current = null;
  }

  /** The project Keo's tools work on: the one named, else the one open in Studio. */
  resolve(id?: string | null): Project {
    const pid = id ?? this.current;
    if (!pid) throw new StudioError('No Studio project is open. Open or create one first (studio__open).');
    return this.get(pid);
  }

  /** Applies edits (all or none), saves, and remembers the previous version for undo. */
  edit(id: string, ops: EditOp[]): { project: Project; changes: string[] } {
    const before = this.get(id);
    let r: { project: Project; changes: string[] };
    try {
      r = applyEdits(before, ops, { rand: () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10), ...(this.d.now ? { now: this.d.now() } : {}) });
    } catch (e) {
      if (e instanceof EditError) throw new StudioError(e.message);
      throw e;
    }
    const stack = this.undo.get(id) ?? [];
    stack.push(before);
    if (stack.length > UNDO_DEPTH) stack.shift();
    this.undo.set(id, stack);
    this.redo.delete(id);
    this.label(id, describeChanges(r.changes));
    this.save(r.project);
    return r;
  }

  /** What each step in the undo list did (in the same order as the undo stack). */
  private readonly undoLabels = new Map<string, string[]>();
  private readonly redoLabels = new Map<string, string[]>();
  private label(id: string, text: string): void {
    const l = this.undoLabels.get(id) ?? [];
    l.push(text);
    while (l.length > (this.undo.get(id)?.length ?? 0)) l.shift();
    this.undoLabels.set(id, l);
    this.redoLabels.delete(id);
  }

  undoEdit(id: string): Project {
    const stack = this.undo.get(id);
    const prev = stack?.pop();
    if (!prev) throw new StudioError('There is nothing to undo.');
    const r = this.redo.get(id) ?? [];
    r.push(this.get(id));
    this.redo.set(id, r);
    const done = this.undoLabels.get(id)?.pop();
    this.redoLabels.set(id, [...(this.redoLabels.get(id) ?? []), done ?? 'A change']);
    this.save(prev);
    return prev;
  }

  redoEdit(id: string): Project {
    const next = this.redo.get(id)?.pop();
    if (!next) throw new StudioError('There is nothing to redo.');
    const u = this.undo.get(id) ?? [];
    u.push(this.get(id));
    this.undo.set(id, u);
    const again = this.redoLabels.get(id)?.pop();
    this.undoLabels.set(id, [...(this.undoLabels.get(id) ?? []), again ?? 'A change']);
    this.save(next);
    return next;
  }

  canUndo(id: string): { undo: boolean; redo: boolean; undoLabels: string[]; redoLabels: string[] } {
    const u = this.undo.get(id)?.length ?? 0;
    const labels = this.undoLabels.get(id) ?? [];
    // Steps made before labels existed (or by imports) show as "A change".
    const undoLabels = [...Array.from({ length: Math.max(0, u - labels.length) }, () => 'A change'), ...labels].slice(-u || 0);
    return { undo: u > 0, redo: !!this.redo.get(id)?.length, undoLabels: undoLabels.reverse().slice(0, 20), redoLabels: [...(this.redoLabels.get(id) ?? [])].reverse().slice(0, 20) };
  }

  /** Adds files from this PC to the project (each once), measuring them first. */
  async importFiles(id: string, files: string[]): Promise<{ project: Project; added: Asset[]; skipped: string[] }> {
    const p = this.get(id);
    const added: Asset[] = [];
    const skipped: string[] = [];
    for (const raw of files) {
      const file = path.resolve(raw);
      if (p.assets.some((a) => path.resolve(a.path).toLowerCase() === file.toLowerCase())) continue;
      const kind = kindOfFile(file);
      if (!kind || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        skipped.push(`${path.basename(file)} (not a video, picture or sound file Keo can use)`);
        continue;
      }
      const info = await this.probeFile(file, kind).catch(() => null);
      if (!info) {
        skipped.push(`${path.basename(file)} (Keo could not read it)`);
        continue;
      }
      const asset: Asset = { id: `as_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, kind: info.kind, path: file, name: path.basename(file).slice(0, 260), duration: Math.round(info.duration * 1000) / 1000, width: info.width, height: info.height, hasAudio: info.hasAudio };
      added.push(asset);
    }
    if (!added.length) return { project: p, added, skipped };
    const stack = this.undo.get(id) ?? [];
    stack.push(p);
    this.undo.set(id, stack);
    this.label(id, 'Added media');
    const next = Project.parse({ ...p, assets: [...p.assets, ...added], updatedAt: (this.d.now?.() ?? new Date()).toISOString() });
    this.save(next);
    this.d.log.info('studio.imported', { files: added.length, skipped: skipped.length });
    return { project: next, added, skipped };
  }

  private async probeFile(file: string, kind: AssetKind): Promise<ProbeResult | null> {
    if (MP4_EXT.has(path.extname(file).toLowerCase())) {
      const r = Mp4Reader.open(file);
      if (r) {
        try {
          const v = r.video();
          const a = r.audio();
          if (v) return { kind: 'video', duration: Math.max(v.duration, a?.duration ?? 0), width: v.width, height: v.height, hasAudio: !!a };
          if (a) return { kind: 'audio', duration: a.duration, width: 0, height: 0, hasAudio: true };
        } finally {
          r.close();
        }
      }
    }
    const p = await this.d.probe?.(file);
    return p ? { ...p, kind: p.kind ?? kind } : null;
  }

  private readonly probes = new Map<string, string>();

  /** Measures a file in the render window (pictures, MP3, WebM…): it is served for a minute under a one-off token. */
  async probeInWindow(file: string): Promise<ProbeResult | null> {
    if (!this.d.sendJob) return null;
    const token = crypto.randomBytes(12).toString('hex');
    this.probes.set(token, file);
    try {
      return await this.runJob<ProbeResult | null>({ kind: 'probe', url: `app://keo/probe/${token}` }, 60_000);
    } finally {
      this.probes.delete(token);
    }
  }

  /** The file behind a probe token (for the media protocol). */
  probeTarget(token: string): string | null {
    return this.probes.get(token) ?? null;
  }

  /** The file of a project's media (for the media protocol): only media in that project. */
  assetFile(projectId: string, assetId: string): string | null {
    try {
      const a = this.get(projectId).assets.find((x) => x.id === assetId);
      return a && fs.existsSync(a.path) ? a.path : null;
    } catch {
      return null;
    }
  }

  describe(id?: string): string {
    return describeProject(this.resolve(id));
  }

  // ---------------------------------------------------------------- compressed frames for the render window

  private reader(projectId: string, assetId: string): Mp4Reader | null {
    const key = `${projectId}/${assetId}`;
    if (this.readers.has(key)) return this.readers.get(key)!;
    const file = this.assetFile(projectId, assetId);
    const r = file && MP4_EXT.has(path.extname(file).toLowerCase()) ? Mp4Reader.open(file) : null;
    if (this.readers.size > 24) {
      const [k, old] = this.readers.entries().next().value!;
      old?.close();
      this.readers.delete(k);
    }
    this.readers.set(key, r);
    return r;
  }

  /** How the render window can decode a clip's video itself (null: it uses the media element). */
  videoTrack(projectId: string, assetId: string): { codec: string; description: Uint8Array | null; width: number; height: number; samples: number; keyTimes: number[] } | null {
    const t = this.reader(projectId, assetId)?.video();
    if (!t?.codec) return null;
    return { codec: t.codec, description: t.description ? new Uint8Array(t.description) : null, width: t.width, height: t.height, samples: t.samples.length, keyTimes: t.samples.filter((s) => s.key).map((s) => s.time) };
  }

  /** Compressed video frames in decode order, starting at the key frame before `time` (or at `from`). */
  videoSamples(projectId: string, assetId: string, o: { time?: number; from?: number; count: number }): { from: number; samples: Array<{ data: Uint8Array; time: number; duration: number; key: boolean }> } {
    const r = this.reader(projectId, assetId);
    const t: Mp4Track | null = r?.video() ?? null;
    if (!r || !t) throw new StudioError('That media has no video Keo can read directly.');
    const from = o.from ?? keyBefore(t, o.time ?? 0);
    const count = Math.max(1, Math.min(240, o.count));
    const samples = t.samples.slice(from, from + count).map((s) => ({ data: new Uint8Array(r.sample(s)), time: s.time, duration: s.duration, key: s.key }));
    return { from, samples };
  }

  // ---------------------------------------------------------------- jobs in the render window

  runJob<T>(job: RenderJob, timeoutMs: number): Promise<T> {
    if (!this.d.sendJob) return Promise.reject(new StudioError('Keo’s video renderer is not available here.'));
    const jobId = `job_${crypto.randomBytes(6).toString('hex')}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.jobs.delete(jobId);
        reject(new StudioError('Keo’s video renderer took too long.'));
      }, timeoutMs);
      this.jobs.set(jobId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.d.sendJob!(jobId, job);
    });
  }

  jobDone(jobId: string, result: unknown, error: string | null): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    clearTimeout(j.timer);
    this.jobs.delete(jobId);
    if (error) j.reject(new StudioError(error));
    else j.resolve(result);
  }

  /** A few frames of the timeline as PNGs (for Keo to look at its own work). */
  /**
   * Frames of one media file of a project (not the timeline): for studying a template video.
   * Drawn through a short-lived project of just that file, never shown in the Studio list.
   */
  async assetFrames(id: string, assetId: string, times: number[], width = 512): Promise<Array<{ time: number; png: Buffer }>> {
    const p = this.get(id);
    const a = p.assets.find((x) => x.id === assetId);
    if (!a || a.kind === 'audio') throw new StudioError('That is not a video or picture of this project.');
    const tmp = Project.parse({
      ...newProject({ name: 'Template frames', rand: () => crypto.randomBytes(6).toString('hex').slice(0, 10) }),
      width: Math.max(16, Math.round((a.width || 1080) / 2) * 2),
      height: Math.max(16, Math.round((a.height || 1920) / 2) * 2),
      assets: [a],
    });
    const withClip = applyEdits(tmp, [{ op: 'add_media', assetId: a.id, start: 0, duration: a.kind === 'image' ? 1 : Math.max(0.04, a.duration), fit: 'contain' }]).project;
    const file = this.file(withClip.id);
    fs.writeFileSync(file, JSON.stringify(withClip));
    try {
      const out: Array<{ time: number; png: Buffer }> = [];
      const list = times.map((t) => Math.max(0, Math.min(t, Math.max(0, a.duration - 0.05))));
      for (let i = 0; i < list.length; i += 6) out.push(...(await this.frames(withClip.id, list.slice(i, i + 6), width)));
      return out;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  frames(id: string, times: number[], width = 540): Promise<Array<{ time: number; png: Buffer }>> {
    const p = this.get(id);
    const dur = projectDuration(p);
    const list = times.slice(0, 6).map((t) => Math.max(0, Math.min(t, Math.max(0, dur - 0.02))));
    return this.runJob<Array<{ time: number; pngBase64: string }>>({ kind: 'frames', projectId: id, times: list, width }, 120_000).then((r) => r.map((f) => ({ time: f.time, png: Buffer.from(f.pngBase64, 'base64') })));
  }

  // ---------------------------------------------------------------- sound, speech and captions

  /** The timeline's sound, mixed as the export will hear it, as 16 kHz mono (null: no sound). */
  async speech(id: string): Promise<{ rate: number; samples: Int16Array } | null> {
    this.get(id);
    const r = await this.runJob<{ wavBase64: string } | null>({ kind: 'audio', projectId: id, sampleRate: 16000 }, 15 * 60_000);
    return r ? readWav(Buffer.from(r.wavBase64, 'base64')) : null;
  }

  /** One media file's whole sound as 16 kHz mono (null: it has none). */
  async assetSound(id: string, assetId: string): Promise<{ rate: number; samples: Int16Array } | null> {
    const r = await this.runJob<{ wavBase64: string } | null>({ kind: 'asset_audio', projectId: id, assetId, sampleRate: 16000 }, 20 * 60_000);
    return r ? readWav(Buffer.from(r.wavBase64, 'base64')) : null;
  }

  /**
   * Saves what Keo learned about media (speech, words). It is not an edit: undo and redo keep it,
   * so the versions in their stacks get it too.
   */
  private learn(id: string, assetId: string, patch: Partial<Pick<Asset, 'speech' | 'words' | 'wordsExact' | 'beats' | 'bpm' | 'scenes' | 'reverseOf' | 'name'>>): Project {
    const fix = (p: Project): Project => ({ ...p, assets: p.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a)) });
    for (const stack of [this.undo.get(id), this.redo.get(id)]) if (stack) for (let i = 0; i < stack.length; i++) stack[i] = fix(stack[i]!);
    const next = Project.parse(fix(this.get(id)));
    this.save(next);
    return next;
  }

  /**
   * Where people speak in each media file of the timeline (on this PC; nothing is sent anywhere).
   * Media analysed before is skipped unless `force`.
   */
  async analyzeSpeech(id: string, o: { force?: boolean; signal?: AbortSignal } = {}): Promise<{ project: Project; analysed: number }> {
    let p = this.get(id);
    const todo = o.force ? p.assets.filter((a) => a.hasAudio && a.kind !== 'image' && p.tracks.some((t) => t.clips.some((c) => isAV(c) && c.assetId === a.id))) : needsAnalysis(p, 'speech');
    for (const a of todo) {
      if (o.signal?.aborted) throw new StudioError('Stopped.');
      const s = await this.assetSound(id, a.id);
      p = this.learn(id, a.id, { speech: s ? voicedSpans(s.samples, s.rate) : [] });
    }
    if (todo.length) this.d.log.info('studio.speech_analysed', { files: todo.length });
    return { project: p, analysed: todo.length };
  }

  /**
   * The spoken words of each media file of the timeline (speech-to-text: the sound goes to the
   * service `t` stands for). Exact word times when the service gives them; else each stretch of
   * speech is transcribed on its own and its words spread over it.
   */
  async transcribe(
    id: string,
    t: { words?: (wav: Buffer, signal: AbortSignal) => Promise<Word[]>; text?: (wav: Buffer, signal: AbortSignal) => Promise<string> },
    o: { force?: boolean; signal: AbortSignal; progress?: (done: number, total: number) => void },
  ): Promise<{ project: Project; transcribed: number; words: number; exact: boolean }> {
    let p = this.get(id);
    const exact = !!t.words;
    const todo = o.force ? p.assets.filter((a) => a.hasAudio && a.kind !== 'image' && p.tracks.some((tr) => tr.clips.some((c) => isAV(c) && c.assetId === a.id))) : needsAnalysis(p, 'words');
    let count = 0;
    for (const a of todo) {
      const sound = await this.assetSound(id, a.id);
      const spans = sound ? voicedSpans(sound.samples, sound.rate) : [];
      const words: Word[] = [];
      // Word times: pieces of up to 10 minutes (the service's file limit). Text only: short pieces.
      const groups = sound ? pieces(spans, exact ? 600 : 14) : [];
      let done = 0;
      for (const g of groups) {
        if (o.signal.aborted) throw new StudioError('Stopped.');
        const from = g[0]!.start;
        const to = g.at(-1)!.end;
        const wav = wavOf(sound!.samples, sound!.rate, from, to);
        if (t.words) {
          for (const w of await t.words(wav, o.signal)) if (w.text.trim()) words.push({ text: w.text.trim().slice(0, 80), start: round3(from + w.start), end: round3(from + Math.max(w.start, w.end)) });
        } else if (t.text) {
          const text = (await t.text(wav, o.signal)).trim();
          if (text) words.push(...spreadWords(text, g).map((w) => ({ ...w, text: w.text.slice(0, 80) })));
        }
        o.progress?.(++done, groups.length);
      }
      count += words.length;
      p = this.learn(id, a.id, { speech: spans, words, wordsExact: exact });
    }
    if (todo.length) this.d.log.info('studio.transcribed', { files: todo.length, words: count, exact });
    return { project: p, transcribed: todo.length, words: count, exact };
  }

  /**
   * Auto-captions: the timeline's speech (transcribed first where needed) laid out as caption lines
   * on the Captions track, in one edit (one undo).
   */
  async captions(
    id: string,
    t: { words?: (wav: Buffer, signal: AbortSignal) => Promise<Word[]>; text?: (wav: Buffer, signal: AbortSignal) => Promise<string> },
    o: { maxWords?: number; style?: Partial<TextStyle>; highlight?: string | null; signal: AbortSignal; progress?: (done: number, total: number) => void },
  ): Promise<{ project: Project; lines: CaptionLine[]; words: number; exact: boolean }> {
    if (projectDuration(this.get(id)) === 0) throw new StudioError('The timeline is empty: add a video with speech first.');
    await this.transcribe(id, t, { signal: o.signal, ...(o.progress ? { progress: o.progress } : {}) });
    const words = timelineWords(this.get(id));
    if (!words.length) throw new StudioError('No spoken words were found in the timeline’s sound.');
    const lines = captionLines(words, { maxWords: o.maxWords ?? 3 });
    const r = this.edit(id, [{ op: 'add_captions', lines, replace: true, ...(o.style ? { style: o.style } : {}), ...(o.highlight !== undefined ? { highlight: o.highlight } : {}) }]);
    this.d.log.info('studio.captions', { lines: lines.length, words: words.length });
    return { project: r.project, lines, words: words.length, exact: words.every((w) => w.exact) };
  }

  // ---------------------------------------------------------------- voice-over recordings

  /** A voice-over the user recorded in Studio: kept in Keo's folder and put on the Voice track at `at`. */
  async saveRecording(id: string, wav: Buffer, at: number): Promise<{ clip: string; seconds: number }> {
    this.get(id);
    let seconds: number;
    try {
      const w = readWav(wav);
      seconds = w.samples.length / w.rate;
    } catch {
      throw new StudioError('The recording could not be read.');
    }
    if (seconds < 0.2) throw new StudioError('The recording is too short.');
    const dir = path.join(this.d.dir, 'recordings');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `voice-over ${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
    fs.writeFileSync(file, wav);
    const imported = await this.importFiles(id, [file]);
    const asset = imported.added[0];
    if (!asset) throw new StudioError('Keo could not read the recording.');
    const r = this.edit(id, [{ op: 'add_audio', assetId: asset.id, trackName: 'Voice', start: at }]);
    const clip = r.project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio' && c.assetId === asset.id).at(-1)!;
    this.d.log.info('studio.recorded', { seconds: Math.round(seconds) });
    return { clip: clip.id, seconds: asset.duration };
  }

  // ---------------------------------------------------------------- reverse

  /**
   * Plays a video clip backwards: the part of the video it shows is made into a reversed copy once
   * (picture and sound, frame by frame, in Keo's own folder) and the clip uses that copy, so the
   * preview plays it smoothly. Reversing again goes back to the original. One edit (one undo).
   */
  async reverseClip(id: string, clipId: string): Promise<{ project: Project; seconds: number }> {
    const p = this.get(id);
    const f = findClip(p, clipId);
    if (!f || f.clip.type !== 'media') throw new StudioError('That is not a video clip of this project.');
    if (f.track.locked) throw new StudioError(`The track ${f.track.name} is locked: unlock it first.`);
    const c = f.clip;
    const a = p.assets.find((x) => x.id === c.assetId);
    if (!a || a.kind !== 'video') throw new StudioError('Only videos can play backwards (a picture looks the same).');
    if (c.freeze) throw new StudioError('A frozen frame looks the same backwards.');
    const span = Math.round(Math.min(a.duration - c.in, sourceSpan(c, c.duration)) * 1000) / 1000;
    if (span < 0.1) throw new StudioError('That clip is too short to reverse.');
    // Reversing a reversed copy: back to the part of the original it was made from.
    if (a.reverseOf) {
      const orig = p.assets.find((x) => x.id === a.reverseOf!.assetId);
      if (orig) {
        const back = Math.max(0, a.reverseOf.in + (a.duration - c.in - span));
        return { project: this.edit(id, [{ op: 'replace_media', clip: c.id, assetId: orig.id, in: Math.round(back * 1000) / 1000 }]).project, seconds: span };
      }
    }
    const file = path.join(this.d.dir, 'made', `reversed-${a.id}-${Math.round(c.in * 1000)}-${Math.round(span * 1000)}.mp4`);
    if (!fs.existsSync(file)) {
      // A short-lived project of just that part of the video, played backwards, exported at full quality.
      const width = Math.max(16, Math.round((a.width || 1080) / 2) * 2);
      const height = Math.max(16, Math.round((a.height || 1920) / 2) * 2);
      const tmp = Project.parse({ ...newProject({ name: `${a.name} reversed`, rand: () => crypto.randomBytes(6).toString('hex').slice(0, 10) }), width, height, fps: p.fps, background: '#000000', assets: [a] });
      const made = applyEdits(tmp, [{ op: 'add_media', assetId: a.id, start: 0, duration: span, in: c.in, fit: 'contain' }]).project;
      (made.tracks[0]!.clips[0] as MediaClip).reversed = true;
      fs.writeFileSync(this.file(made.id), JSON.stringify(made));
      const exportId = `ex_${crypto.randomBytes(6).toString('hex')}`;
      this.exportTargets.set(exportId, file);
      try {
        await this.runJob({ kind: 'export', projectId: made.id, exportId, size: { width, height, fps: p.fps, quality: 'best' } }, 2 * 60 * 60 * 1000);
      } catch (e) {
        fs.rmSync(file, { force: true });
        throw e;
      } finally {
        this.exportTargets.delete(exportId);
        fs.rmSync(this.file(made.id), { force: true });
      }
    }
    const known = this.get(id).assets.find((x) => path.resolve(x.path).toLowerCase() === path.resolve(file).toLowerCase());
    const copy = known ?? (await this.importFiles(id, [file])).added[0];
    if (!copy) throw new StudioError('Keo could not read the reversed copy.');
    if (!copy.reverseOf) this.learn(id, copy.id, { reverseOf: { assetId: a.id, in: c.in }, name: `${a.name} (reversed)` });
    const r = this.edit(id, [{ op: 'replace_media', clip: c.id, assetId: copy.id, in: 0 }]);
    this.d.log.info('studio.reversed', { seconds: span });
    return { project: r.project, seconds: span };
  }

  // ---------------------------------------------------------------- shots inside a video

  /** Where a video of the project changes shot (seconds into it): found on this PC once, then kept with the file. */
  async detectScenes(id: string, assetId: string): Promise<number[]> {
    const a = this.get(id).assets.find((x) => x.id === assetId);
    if (!a || a.kind !== 'video') throw new StudioError('That is not a video of this project.');
    if (a.scenes) return a.scenes;
    // A fingerprint every quarter second (fewer for long videos), then frame by frame around each change.
    const step = Math.max(0.25, a.duration / 4000);
    const times: number[] = [];
    for (let t = 0; t < a.duration - 0.02; t += step) times.push(Math.round(t * 1000) / 1000);
    const sigs: number[][] = [];
    for (let i = 0; i < times.length; i += 400) sigs.push(...(await this.runJob<number[][]>({ kind: 'signatures', projectId: id, assetId, times: times.slice(i, i + 400) }, 10 * 60_000)));
    const candidates = sceneCandidates(times, sigs);
    const scenes: number[] = [];
    for (let i = 0; i < candidates.length; i += 40) {
      const batch = candidates.slice(i, i + 40);
      const fine = batch.map((c) => {
        // Every frame from the last sample of the old shot up to the first of the new one (both included).
        const list: number[] = [];
        for (let k = 0; c.from + k / 30 < c.to - 1e-3; k++) list.push(Math.round((c.from + k / 30) * 1000) / 1000);
        list.push(c.to);
        return list;
      });
      const all = await this.runJob<number[][]>({ kind: 'signatures', projectId: id, assetId, times: fine.flat() }, 10 * 60_000);
      let at = 0;
      for (const list of fine) {
        scenes.push(refineCut(list, all.slice(at, at + list.length)));
        at += list.length;
      }
    }
    this.learn(id, assetId, { scenes });
    this.d.log.info('studio.scenes', { scenes: scenes.length });
    return scenes;
  }

  /**
   * Splits video clips where their shot changes (default: every video clip of the project), in one
   * edit (one undo).
   */
  async splitScenes(id: string, clipIds?: string[]): Promise<{ project: Project; splits: number; clips: number }> {
    const p = this.get(id);
    const clips = p.tracks
      .filter((t) => !t.locked)
      .flatMap((t) => t.clips)
      .filter((c): c is MediaClip => c.type === 'media' && (!clipIds || clipIds.includes(c.id)) && p.assets.find((a) => a.id === c.assetId)?.kind === 'video' && !c.freeze);
    if (!clips.length) throw new StudioError(clipIds ? 'Those are not video clips Keo can split.' : 'There are no video clips to split.');
    const ops: EditOp[] = [];
    for (const c of clips) {
      const cuts = await this.detectScenes(id, c.assetId);
      // From the end backwards, so the clip being split keeps its id.
      for (const at of sceneSplitTimes(c, cuts).sort((x, y) => y - x)) ops.push({ op: 'split', clip: c.id, at });
    }
    if (!ops.length) return { project: this.get(id), splits: 0, clips: clips.length };
    const r = this.edit(id, ops);
    this.d.log.info('studio.split_scenes', { splits: ops.length });
    return { project: r.project, splits: ops.length, clips: clips.length };
  }

  // ---------------------------------------------------------------- music: beats

  /** The music of a project: the sound clip named, else the first on a Music track, else the longest sound clip. */
  musicClip(p: Project, clipId?: string): AudioClip | null {
    const sounds = p.tracks.flatMap((t) => t.clips.filter((c): c is AudioClip => c.type === 'audio').map((c) => ({ c, music: /music/i.test(t.name) || c.duck !== null })));
    if (clipId) return sounds.find((x) => x.c.id === clipId)?.c ?? null;
    return sounds.find((x) => x.music)?.c ?? [...sounds].sort((a, b) => b.c.duration - a.c.duration)[0]?.c ?? null;
  }

  /** The beat of a sound file of the project (found on this PC once, then kept with the file). */
  async analyzeBeats(id: string, assetId: string): Promise<{ beats: number[]; bpm: number | null }> {
    const a = this.get(id).assets.find((x) => x.id === assetId);
    if (!a || !a.hasAudio) throw new StudioError('That is not a sound file of this project.');
    if (a.beats) return { beats: a.beats, bpm: a.bpm ?? null };
    const s = await this.assetSound(id, assetId);
    if (!s) throw new StudioError(`${a.name} has no sound.`);
    const r = detectBeats(s.samples, s.rate);
    // The steady beat when the music has one; else the hits (onsets).
    const beats = (r.beats.length >= 4 ? r.beats : r.onsets).map((b) => Math.round(b * 1000) / 1000);
    this.learn(id, assetId, { beats, bpm: r.bpm });
    this.d.log.info('studio.beats', { beats: beats.length, bpm: r.bpm });
    return { beats, bpm: r.bpm };
  }

  /**
   * Cut to the beat: the clips (default: the bottom video track's, in order) laid one after another
   * from the music's first beat, each lasting `every` beats. One edit (one undo).
   */
  async beatCut(id: string, o: { music?: string; every?: 1 | 2 | 4; clips?: string[] } = {}): Promise<{ project: Project; placed: number; bpm: number | null }> {
    const p = this.get(id);
    const m = this.musicClip(p, o.music);
    if (!m) throw new StudioError('There is no music on the timeline: add a song first.');
    const { beats, bpm } = await this.analyzeBeats(id, m.assetId);
    // The music's beats on the timeline, inside the music clip.
    const onTimeline = beats.map((b) => m.start + (b - m.in)).filter((t) => t >= m.start - 1e-6 && t <= m.start + m.duration + 1e-6);
    if (onTimeline.length < 2) throw new StudioError('No clear beat was found in the music.');
    const every = o.every ?? 2;
    const base = p.tracks.find((t) => t.kind === 'video');
    const clips = (o.clips ? o.clips.map((cid) => findClip(p, cid)?.clip) : (base?.clips ?? [])).filter((c): c is MediaClip => !!c && c.type === 'media').sort((a, b) => a.start - b.start);
    if (!clips.length) throw new StudioError('There are no videos or pictures to cut to the beat.');
    const ops: EditOp[] = [];
    let placed = 0;
    for (let i = 0; i < clips.length; i++) {
      const a = onTimeline[i * every];
      const b = onTimeline[(i + 1) * every];
      if (a === undefined || b === undefined) break;
      const c = clips[i]!;
      const asset = p.assets.find((x) => x.id === c.assetId);
      const room = asset?.kind === 'image' ? Infinity : ((asset?.duration ?? c.duration) - c.in) / c.speed;
      ops.push({ op: 'trim', clip: c.id, duration: Math.max(0.1, Math.min(b - a, room)) }, { op: 'move', clip: c.id, start: a });
      placed++;
    }
    if (!placed) throw new StudioError('The music is too short for these clips at this pace.');
    const r = this.edit(id, ops);
    this.d.log.info('studio.beat_cut', { placed, every });
    return { project: r.project, placed, bpm };
  }

  // ---------------------------------------------------------------- talking-head autopilot

  /** What a clean-up would cut (nothing changes). Speech is analysed first where needed (on this PC). */
  async planCleanup(id: string, o: { silences?: boolean; fillers?: boolean; retakes?: boolean; minSilence?: number; keep?: number; signal?: AbortSignal }): Promise<CleanupPlan> {
    if (o.silences) await this.analyzeSpeech(id, { ...(o.signal ? { signal: o.signal } : {}) });
    return planCleanup(this.get(id), o);
  }

  /** Cuts what the clean-up found, in one edit (one undo). */
  async cleanup(id: string, o: { silences?: boolean; fillers?: boolean; retakes?: boolean; minSilence?: number; keep?: number; signal?: AbortSignal }): Promise<{ project: Project; plan: CleanupPlan; changes: string[] }> {
    const plan = await this.planCleanup(id, o);
    if (!plan.cuts.length) return { project: this.get(id), plan, changes: [] };
    const r = this.edit(id, [{ op: 'cut_ranges', ranges: plan.cuts.map((c) => ({ from: c.from, to: c.to })) }]);
    this.d.log.info('studio.cleaned', { cuts: plan.cuts.length, seconds: plan.seconds });
    return { project: r.project, plan, changes: r.changes };
  }

  /** Punch-ins on the talking head at new phrases (one edit). */
  async punchIn(id: string, o: { scale?: number; x?: number; y?: number; minGap?: number; signal?: AbortSignal } = {}): Promise<{ project: Project; points: number }> {
    await this.analyzeSpeech(id, { ...(o.signal ? { signal: o.signal } : {}) });
    const { ops, points } = punchIns(this.get(id), o);
    if (!ops.length) throw new StudioError('There is no talking-head video with speech on the bottom video track to punch in on.');
    return { project: this.edit(id, ops).project, points };
  }

  /** One of Keo's own sound effects as media of the project (made once, in Keo's folder). */
  soundEffect(id: string, kind: SfxKind): { project: Project; asset: Asset } {
    const p = this.get(id);
    const dir = path.join(this.d.dir, 'sfx');
    const file = path.join(dir, `${kind}.wav`);
    const have = p.assets.find((a) => path.resolve(a.path).toLowerCase() === file.toLowerCase());
    if (have && fs.existsSync(file)) return { project: p, asset: have };
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, sfxWav(kind));
    if (have) return { project: p, asset: have };
    const asset: Asset = { id: `as_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, kind: 'audio', path: file, name: `${SFX[kind].label} (Keo sound effect)`, duration: SFX[kind].seconds, width: 0, height: 0, hasAudio: true };
    const stack = this.undo.get(id) ?? [];
    stack.push(p);
    this.undo.set(id, stack);
    this.label(id, 'Added media');
    const next = Project.parse({ ...p, assets: [...p.assets, asset], updatedAt: (this.d.now?.() ?? new Date()).toISOString() });
    this.save(next);
    return { project: next, asset };
  }

  /** The picture at `time`, full size, saved as a new PNG next to the exports (a cover or thumbnail). */
  async saveFrame(id: string, time: number): Promise<string> {
    const p = this.get(id);
    if (projectDuration(p) === 0) throw new StudioError('The timeline is empty.');
    const f = (await this.runJob<Array<{ time: number; pngBase64: string }>>({ kind: 'frames', projectId: id, times: [Math.max(0, Math.min(time, projectDuration(p) - 0.02))], width: p.width }, 120_000))[0];
    if (!f) throw new StudioError('The frame could not be drawn.');
    const dir = this.d.exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
    const base = `${p.name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim().slice(0, 70) || 'Keo video'} cover`;
    let file = path.join(dir, `${base}.png`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).png`);
    fs.writeFileSync(file, Buffer.from(f.pngBase64, 'base64'));
    return file;
  }

  // ---------------------------------------------------------------- exporting

  /** Renders the project into a new MP4 in Videos\Keo. */
  async exportVideo(id: string, opts: Partial<ExportOptions> = {}): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
    const p = this.get(id);
    if (projectDuration(p) < 0.1) throw new StudioError('The timeline is empty: add clips, pictures or text first.');
    const o = ExportOptions.parse(opts);
    const exportId = `ex_${crypto.randomBytes(6).toString('hex')}`;
    if (o.name) this.exportNames.set(exportId, o.name);
    this.running.set(id, exportId);
    const size = { ...exportSize(p, o), quality: o.quality };
    const r = await this.runJob<{ file: string; durationSec: number; frames: number; bytes: number }>({ kind: 'export', projectId: id, exportId, size }, 6 * 60 * 60 * 1000).finally(() => {
      this.exportNames.delete(exportId);
      if (this.running.get(id) === exportId) this.running.delete(id);
    });
    this.d.log.info('studio.exported', { seconds: r.durationSec, frames: r.frames });
    return r;
  }

  /** The render window starts writing the export (its encoder told it the video's avcC). */
  beginExport(exportId: string, projectId: string, video: WriterVideo, audio: WriterAudio | null): void {
    const p = this.get(projectId);
    const target = this.exportTargets.get(exportId);
    const dir = target ? path.dirname(target) : this.d.exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
    const base = (this.exportNames.get(exportId) ?? p.name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Keo video';
    let file = target ?? path.join(dir, `${base}.mp4`);
    for (let n = 2; !target && fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).mp4`);
    this.exports.set(exportId, { writer: new Mp4Writer(file, video, audio), file, projectId });
  }

  exportChunk(exportId: string, kind: 'video' | 'audio', data: Uint8Array, timeUs: number, durationUs: number, key: boolean): void {
    const e = this.exports.get(exportId);
    if (!e) throw new StudioError('That export is not running.');
    if (kind === 'video') e.writer.writeVideo(Buffer.from(data), timeUs, durationUs, key);
    else e.writer.writeAudio(Buffer.from(data), timeUs, durationUs);
  }

  /** Finishes the file and checks it reads back as a video of the right length. */
  endExport(exportId: string): { file: string; durationSec: number; frames: number; bytes: number } {
    const e = this.exports.get(exportId);
    if (!e) throw new StudioError('That export is not running.');
    this.exports.delete(exportId);
    const r = e.writer.finish();
    const check = Mp4Reader.open(e.file);
    const frames = check?.video()?.samples.length ?? 0;
    check?.close();
    if (!frames) throw new StudioError('The exported file could not be read back.');
    return { file: e.file, durationSec: r.durationSec, frames, bytes: r.bytes };
  }

  abortExport(exportId: string): void {
    this.exports.get(exportId)?.writer.abort();
    this.exports.delete(exportId);
  }

  close(): void {
    for (const r of this.readers.values()) r?.close();
    this.readers.clear();
    for (const e of this.exports.values()) e.writer.abort();
    this.exports.clear();
    for (const j of this.jobs.values()) {
      clearTimeout(j.timer);
      j.reject(new StudioError('Keo closed.'));
    }
    this.jobs.clear();
  }
}

/** A short name for an edit in the undo list. */
function describeChanges(changes: string[]): string {
  if (!changes.length) return 'A change';
  const first = changes[0]!.replace(/\s*\((cl|tr|as)_[A-Za-z0-9]+\)/g, '').replace(/\.$/, '');
  return changes.length > 1 ? `${first.slice(0, 50)} (+${changes.length - 1} more)` : first.slice(0, 70);
}
