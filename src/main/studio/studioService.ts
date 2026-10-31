import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../logging/logger';
import { detectBeats } from '../video/ffmpeg';
import { applyEdits, describeProject, EditError, ExportOptions, exportSize, clipEnd, findClip, isAV, keyValue, needsAnalysis, sourceSpan, type Clip, type Key, type AudioClip, type MediaClip, newProject, Project, projectDuration, timelineWords, type Asset, type AssetKind, type EditOp, type FormatId, type ProjectSummary, type RenderJob, type TextStyle } from '../../shared/studio';
import { refineCut, sceneCandidates, sceneSplitTimes } from '../../shared/studioScenes';
import { smooth, videoPlacement } from '../../shared/studioTrack';
import { actionOf, showSteps, type KeoAction } from '../../shared/studioLive';
import { SoundLibrary } from './soundLibrary';
import { guessShotKind, lookOf, recipeOps, shotsFrom, type Recipe, type ShotKind } from '../../shared/studioRecipe';

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
  /** Phone videos: how far the frames turn to stand upright (width and height are then upright). */
  rotation?: 0 | 90 | 180 | 270;
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
  /** Watching Keo edit: the step Keo is about to make (the Studio moves the playhead there and points at it). */
  keoAction?: (a: KeoAction & { projectId: string; index: number; total: number } | { projectId: string; kind: 'done'; index: number; total: number }) => void;
  /** Brings a project on screen in Studio (Keo is about to work on it). */
  showProject?: (projectId: string) => void;
  /** Milliseconds before and after each shown step (tests use 0). */
  livePace?: { before: number; after: number };
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

  /** The user's music and sound effects (all projects). */
  readonly sounds: SoundLibrary;

  constructor(private readonly d: StudioDeps) {
    this.sounds = new SoundLibrary({ dir: path.join(d.dir, 'library'), measure: async (f) => (await this.probeFile(f, 'audio').catch(() => null))?.duration ?? null, ...(d.now ? { now: d.now } : {}) });
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

  /**
   * Projects made before Keo read the turn of phone videos: each MP4 video's turn is read once,
   * its size made upright, and the project saved (quietly).
   */
  private upright(p: Project): Project {
    const old = p.assets.filter((a) => a.kind === 'video' && a.rotation === undefined && MP4_EXT.has(path.extname(a.path).toLowerCase()));
    if (!old.length) return p;
    const assets = p.assets.map((a) => {
      if (!old.includes(a)) return a;
      let turn: 0 | 90 | 180 | 270;
      const r = fs.existsSync(a.path) ? Mp4Reader.open(a.path) : null;
      try {
        turn = r?.video()?.rotation ?? 0;
      } finally {
        r?.close();
      }
      // Older projects kept the size as stored in the file: a quarter turn swaps it.
      return { ...a, rotation: turn, ...(turn === 90 || turn === 270 ? { width: a.height, height: a.width } : {}) };
    });
    const next = Project.parse({ ...p, assets });
    const f = this.file(p.id);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, f);
    return next;
  }

  get(id: string): Project {
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new StudioError('That Studio project does not exist (any more).');
    try {
      return this.upright(Project.parse(JSON.parse(fs.readFileSync(f, 'utf8'))));
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

  private save(p: Project, notify = true): void {
    const f = this.file(p.id);
    this.backup(p.id, f);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p));
    fs.renameSync(tmp, f);
    if (notify) this.d.changed?.(p);
  }

  // ---------------------------------------------------------------- watching Keo edit

  /** Keo's edits are shown step by step while someone watches the project in Studio (a setting). */
  get liveEdits(): boolean {
    try {
      return (JSON.parse(fs.readFileSync(path.join(this.d.dir, 'prefs.json'), 'utf8')) as { liveEdits?: boolean }).liveEdits !== false;
    } catch {
      return true;
    }
  }
  set liveEdits(on: boolean) {
    fs.mkdirSync(this.d.dir, { recursive: true });
    fs.writeFileSync(path.join(this.d.dir, 'prefs.json'), JSON.stringify({ liveEdits: on }));
    if (!on) for (const id of this.shows.keys()) this.skipping.add(id);
  }
  /** Projects open on screen in Studio right now. */
  private readonly watching = new Set<string>();
  watch(id: string, on: boolean): void {
    if (on) this.watching.add(id);
    else {
      this.watching.delete(id);
      this.skipShow(id);
    }
  }
  /** Inside a Keo tool call (its edits are Keo's). */
  private keoDepth = 0;
  private readonly shows = new Map<string, Promise<void>>();
  private readonly skipping = new Set<string>();
  /** Runs one of Keo's tool calls: while it is watched, its edits play step by step, and the call ends when the last step is shown. */
  async asKeo<T>(fn: () => Promise<T> | T, projectId?: string): Promise<T> {
    this.keoDepth++;
    try {
      // Keo works where the user can see it: another project is brought on screen first.
      if (projectId && this.watching.size && !this.watching.has(projectId)) await this.bringOnScreen(projectId);
      const r = await fn();
      await Promise.all([...this.shows.values()]);
      return r;
    } finally {
      this.keoDepth--;
    }
  }
  /** Asks Studio to open a project and waits (up to 3 s) until it is on screen. */
  private async bringOnScreen(projectId: string): Promise<void> {
    if (!this.d.showProject || !fs.existsSync(this.file(projectId))) return;
    this.current = projectId;
    this.d.showProject(projectId);
    for (let i = 0; i < 30 && !this.watching.has(projectId); i++) await new Promise((r) => setTimeout(r, 100));
  }

  /** Shows the rest of Keo's steps at once. */
  skipShow(id: string): void {
    if (this.shows.has(id)) this.skipping.add(id);
  }
  /** Keo's edit, step by step: each step's real result is shown after the playhead moves to it. */
  private queueShow(id: string, before: Project, ops: EditOp[], rand: () => string): void {
    const steps: Array<{ action: KeoAction; state: Project }> = [];
    let cur = before;
    for (const op of showSteps(ops)) {
      try {
        const s = applyEdits(cur, [op], { rand, ...(this.d.now ? { now: this.d.now() } : {}) });
        steps.push({ action: actionOf(op, cur), state: s.project });
        cur = s.project;
      } catch {
        // A step that cannot stand on its own: the rest is shown as the final result.
        break;
      }
    }
    // At most 30 steps on screen: long edits are shown in groups.
    const per = Math.max(1, Math.ceil(steps.length / 30));
    const shown: Array<{ action: KeoAction; state: Project }> = [];
    for (let i = 0; i < steps.length; i += per) {
      const group = steps.slice(i, i + per);
      const first = group[0]!.action;
      shown.push({ action: group.length > 1 ? { ...first, label: `${first.label} (and ${group.length - 1} more)`, clips: group.flatMap((g) => g.action.clips) } : first, state: group.at(-1)!.state });
    }
    const pace = this.d.livePace ?? { before: 450, after: 300 };
    const wait = (ms: number) => (ms > 0 && !this.skipping.has(id) ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
    const run: Promise<void> = (this.shows.get(id) ?? Promise.resolve())
      .then(async () => {
        for (let i = 0; i < shown.length; i++) {
          if (this.skipping.has(id)) break;
          this.d.keoAction?.({ projectId: id, ...shown[i]!.action, index: i + 1, total: shown.length });
          await wait(pace.before);
          if (this.skipping.has(id)) break;
          this.d.changed?.(shown[i]!.state);
          await wait(pace.after);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.d.keoAction?.({ projectId: id, kind: 'done', index: shown.length, total: shown.length });
        // The project as it really is now (the end of Keo's edit, or anything after it).
        try {
          this.d.changed?.(this.get(id));
        } catch {
          /* deleted meanwhile */
        }
        if (this.shows.get(id) === run) {
          this.shows.delete(id);
          this.skipping.delete(id);
        }
      });
    this.shows.set(id, run);
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
    // Files the project's videos were read from are let go (they can be moved or deleted again).
    for (const [key, r] of this.readers)
      if (key.startsWith(`${id}/`)) {
        r?.close();
        this.readers.delete(key);
      }
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
    // Keo's edit while the user watches: shown step by step (with the same new ids as the result).
    const live = this.keoDepth > 0 && this.watching.has(id) && this.liveEdits;
    if (!live) this.skipShow(id);
    const made: string[] = [];
    const fresh = () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10);
    let r: { project: Project; changes: string[] };
    try {
      r = applyEdits(before, ops, {
        rand: () => {
          const v = fresh();
          made.push(v);
          return v;
        },
        ...(this.d.now ? { now: this.d.now() } : {}),
      });
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
    this.save(r.project, !live);
    if (live) {
      let k = 0;
      this.queueShow(id, before, ops, () => made[k++] ?? fresh());
    }
    return r;
  }

  /** One more edit that undoes together with the edit just before it (one step in the undo list). */
  private mergeLast(id: string, op: EditOp): { project: Project; changes: string[] } {
    const r = this.edit(id, [op]);
    this.undo.get(id)?.pop();
    this.undoLabels.get(id)?.pop();
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
    this.skipShow(id);
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
    this.skipShow(id);
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
      const asset: Asset = { id: `as_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, kind: info.kind, path: file, name: path.basename(file).slice(0, 260), duration: Math.round(info.duration * 1000) / 1000, width: info.width, height: info.height, hasAudio: info.hasAudio, ...(info.kind === 'video' && info.rotation !== undefined ? { rotation: info.rotation } : {}) };
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
          // A phone video lying down with a turn to play upright: its size as it plays.
          const side = v?.rotation === 90 || v?.rotation === 270;
          if (v) return { kind: 'video', duration: Math.max(v.duration, a?.duration ?? 0), width: side ? v.height : v.width, height: side ? v.width : v.height, hasAudio: !!a, rotation: v.rotation };
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
  assetFile(projectId: string, assetId: string, preview = false): string | null {
    try {
      const a = this.get(projectId).assets.find((x) => x.id === assetId);
      // The preview may play the light copy; everything else (export, frames) gets the original.
      if (a && preview && a.proxy && fs.existsSync(a.proxy)) return a.proxy;
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
  videoTrack(projectId: string, assetId: string): { codec: string; description: Uint8Array | null; width: number; height: number; rotation: number; samples: number; keyTimes: number[] } | null {
    const t = this.reader(projectId, assetId)?.video();
    if (!t?.codec) return null;
    return { codec: t.codec, description: t.description ? new Uint8Array(t.description) : null, width: t.width, height: t.height, rotation: t.rotation, samples: t.samples.length, keyTimes: t.samples.filter((s) => s.key).map((s) => s.time) };
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
  private learn(id: string, assetId: string, patch: Partial<Pick<Asset, 'speech' | 'words' | 'wordsExact' | 'beats' | 'bpm' | 'scenes' | 'reverseOf' | 'cleanOf' | 'proxy' | 'name'>>): Project {
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
    const failed: string[] = [];
    for (const a of todo) {
      try {
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
      } catch (e) {
        // One file the speech service could not do: the others still get their words.
        if (o.signal.aborted) throw new StudioError('Stopped.');
        failed.push(`${a.name}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
        this.d.log.warn('studio.transcribe_failed', { kind: a.kind, seconds: Math.round(a.duration) });
      }
    }
    if (failed.length === todo.length && todo.length) throw new StudioError(`Speech-to-text did not work: ${failed.slice(0, 2).join('; ')}`);
    if (todo.length) this.d.log.info('studio.transcribed', { files: todo.length - failed.length, words: count, exact, failed: failed.length });
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

  // ---------------------------------------------------------------- templates as recipes

  private get recipesFile(): string {
    return path.join(this.d.dir, 'library', 'recipes.json');
  }
  recipes(): Recipe[] {
    try {
      return JSON.parse(fs.readFileSync(this.recipesFile, 'utf8')) as Recipe[];
    } catch {
      return [];
    }
  }
  private saveRecipes(list: Recipe[]): void {
    fs.mkdirSync(path.dirname(this.recipesFile), { recursive: true });
    fs.writeFileSync(`${this.recipesFile}.tmp`, JSON.stringify(list));
    fs.renameSync(`${this.recipesFile}.tmp`, this.recipesFile);
  }
  deleteRecipe(recipeId: string): void {
    const list = this.recipes();
    if (!list.some((r) => r.id === recipeId)) throw new StudioError('That template is not saved.');
    this.saveRecipes(list.filter((r) => r.id !== recipeId));
  }

  /**
   * Learns a template video (media of the project) as a recipe, measured on this PC: its shots and
   * their rhythm, which are camera footage, screen recordings or an end card, whether it has a
   * voice, music (and its tempo) and whooshes on the cuts. What Keo saw in its frames (captions,
   * look, end card text) can be given to correct the measured guesses. Kept for every project.
   */
  async learnTemplate(id: string, assetId: string, o: { name?: string; seen?: Partial<Pick<Recipe, 'captions' | 'look' | 'transition' | 'notes'>> & { endCard?: Partial<Recipe['endCard']>; shotKinds?: ShotKind[] } } = {}): Promise<Recipe> {
    const p = this.get(id);
    const a = p.assets.find((x) => x.id === assetId);
    if (!a || a.kind !== 'video') throw new StudioError('Choose a video of this project as the template.');
    const cuts = await this.detectScenes(id, assetId);
    const edges = [0, ...cuts, a.duration];
    const mids = edges.slice(0, -1).map((t, i) => Math.round(((t + edges[i + 1]!) / 2) * 1000) / 1000);
    const sigs = mids.length ? await this.runJob<number[][]>({ kind: 'signatures', projectId: id, assetId, times: mids }, 5 * 60_000) : [];
    const kinds = o.seen?.shotKinds ?? sigs.map(guessShotKind);
    // Only the last shot can be the end card.
    const fixed = kinds.map((k, i) => (k === 'end-card' && i !== kinds.length - 1 ? 'camera' : k));
    const shots = shotsFrom(cuts, a.duration, fixed);
    // The sound: a voice (speech covering a good part), music (a steady beat), whooshes on the cuts.
    const sound = a.hasAudio ? await this.assetSound(id, assetId).catch(() => null) : null;
    const speech = sound ? voicedSpans(sound.samples, sound.rate) : [];
    const spoken = speech.reduce((n, s) => n + (s.end - s.start), 0);
    const beat = sound ? detectBeats(sound.samples, sound.rate) : { onsets: [], beats: [], bpm: null };
    const hits = cuts.filter((c) => beat.onsets.some((x) => Math.abs(x - c) < 0.15)).length;
    const voice = spoken > a.duration * 0.3;
    const last = shots.at(-1);
    const seenEnd = o.seen?.endCard ?? {};
    const recipe: Recipe = {
      id: `rc_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`,
      name: (o.name ?? a.name.replace(/\.[^.]+$/, '')).slice(0, 80),
      source: a.name,
      seconds: Math.round(a.duration * 100) / 100,
      aspect: a.height > a.width * 1.15 ? 'vertical' : a.width > a.height * 1.15 ? 'landscape' : 'square',
      shots,
      captions: { on: voice, style: 'phrase', wordsPerLine: 3, position: 'center', uppercase: false, ...(o.seen?.captions ?? {}) },
      look: o.seen?.look ?? null,
      transition: o.seen?.transition ?? 'cut',
      endCard: { on: last?.kind === 'end-card', seconds: last?.kind === 'end-card' ? Math.round((last.end - last.start) * 100) / 100 : 0, text: null, ...seenEnd },
      audio: { voice, music: beat.bpm !== null && beat.beats.length >= 8, bpm: beat.bpm, whooshOnCuts: cuts.length >= 3 && hits >= cuts.length * 0.5, musicGenre: null },
      notes: (o.seen?.notes ?? '').slice(0, 2000),
      learnedAt: (this.d.now?.() ?? new Date()).toISOString(),
    };
    this.saveRecipes([...this.recipes().filter((r) => r.name !== recipe.name), recipe]);
    this.d.log.info('studio.template_learned', { shots: shots.length, voice, music: recipe.audio.music });
    return recipe;
  }

  /**
   * Makes the template's edit with this project's clips: the talking clip (default: the longest
   * video with sound on the bottom track) carries the voice; the other videos and pictures cut in
   * over it at the template's rhythm and order; captions in its style (when the speech is
   * transcribed), its look on every clip, its end card, music from the library and a whoosh on each
   * cut when the template has them. Shown step by step while the user watches.
   */
  async applyTemplate(id: string, recipeId: string, o: { main?: string; cutaways?: string[]; endText?: string; music?: string | null; whooshes?: boolean } = {}): Promise<{ project: Project; cutaways: number; captions: boolean; music: string | null; needsWords: boolean }> {
    const r = this.recipes().find((x) => x.id === recipeId);
    if (!r) throw new StudioError('That template is not saved: learn it first.');
    const p = this.get(id);
    // The voice: the whole main (bottom) video track, all its pieces in order, or the clip named.
    const base = p.tracks.find((t) => t.kind === 'video' && t.name !== 'B-roll' && t.clips.some((c) => c.type === 'media'));
    const named = o.main ? (findClip(p, o.main)?.clip as MediaClip | undefined) : undefined;
    const mainClips = named ? [named] : (base?.clips.filter((c): c is MediaClip => c.type === 'media') ?? []);
    if (!mainClips.length) throw new StudioError('Put the talking video on the timeline first (the clip whose voice tells the story).');
    const start = Math.min(...mainClips.map((c) => c.start));
    const end = Math.max(...mainClips.map((c) => clipEnd(c)));
    const onMain = new Set(mainClips.map((c) => c.assetId));
    // Cutaways: what the user named, else videos and pictures without much talking (screen
    // recordings, B-roll) that are not on the main track and not the template itself.
    const talks = (a: Asset) => a.kind === 'video' && a.hasAudio && (a.speech ?? []).reduce((n, s) => n + (s.end - s.start), 0) > a.duration * 0.4;
    const candidates = o.cutaways
      ? p.assets.filter((a) => o.cutaways!.includes(a.id))
      : p.assets.filter((a) => a.kind !== 'audio' && !onMain.has(a.id) && a.name !== r.source && !a.reverseOf && !a.cleanOf && !talks(a));
    if (!candidates.length && r.shots.some((s) => s.kind === 'screen' || s.kind === 'graphic'))
      throw new StudioError('This template cuts to screen recordings or B-roll, but every other clip here is someone talking (or there are none). Import screen recordings or B-roll, or name the clips to cut to.');
    const cutaways = candidates.map((a) => ({ assetId: a.id, duration: a.duration, kind: a.kind === 'image' ? ('image' as const) : ('video' as const) }));
    const words = timelineWords(p).filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
    const built = recipeOps(r, { main: { clip: mainClips[0]!.id, start, duration: end - start }, cutaways, words, endText: o.endText ?? r.endCard.text });
    if (!built.ops.length) throw new StudioError('There is nothing in this project the template can use: add screen recordings or other clips to cut to.');
    // Using a template again replaces what it made before (its B-roll and end card).
    const before: EditOp[] = p.tracks.filter((t) => (t.name === 'B-roll' || t.name === 'End card') && !t.locked).flatMap((t) => t.clips.map((c) => ({ op: 'delete' as const, clip: c.id })));
    let res = this.edit(id, [...before, ...built.ops]);
    // The template's look on every video and picture (one more step of the same undo).
    const look = lookOf(r);
    if (look) {
      for (const c of res.project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media')) res = this.mergeLast(id, { op: 'set', clip: c.id, color: { ...look } });
    }
    // Sound: music from the library, and a whoosh into each cutaway.
    let music: string | null = null;
    const wantMusic = o.music !== null && (o.music !== undefined || r.audio.music);
    if (wantMusic) {
      const pick = o.music ? this.sounds.get(o.music) : (this.sounds.list({ kind: 'music', ...(r.audio.musicGenre ? { genre: r.audio.musicGenre } : {}) })[0] ?? this.sounds.list({ kind: 'music' })[0] ?? null);
      if (pick && !pick.builtIn) {
        res = { project: (await this.useSound(id, pick.id, { role: 'music', at: start })).project, changes: [] };
        music = pick.name;
      }
    }
    if (o.whooshes ?? r.audio.whooshOnCuts) for (const at of built.cutawayStarts) res = { project: (await this.useSound(id, 'sfx_whoosh', { at: Math.max(0, at - 0.15), volume: 0.5 })).project, changes: [] };
    this.d.log.info('studio.template_used_recipe', { cutaways: built.cutawayStarts.length, music: !!music });
    return { project: res.project, cutaways: built.cutawayStarts.length, captions: r.captions.on && words.length > 0, music, needsWords: r.captions.on && words.length === 0 };
  }

  // ---------------------------------------------------------------- long video to shorts

  /**
   * Shorts from a long video: for each moment (timeline seconds), a new project with just that part
   * of the edit — every track, caption, effect and the music — made vertical (9:16) when the long
   * video is not, with wide videos shown whole over a blurred copy (or reframed by Keo afterwards),
   * and an optional title at the top. The long video is not changed.
   */
  makeShorts(id: string, moments: Array<{ from: number; to: number; title?: string }>): Array<{ projectId: string; name: string; seconds: number }> {
    const p = this.get(id);
    const total = projectDuration(p);
    if (!moments.length) throw new StudioError('Name at least one moment to make into a short.');
    const out: Array<{ projectId: string; name: string; seconds: number }> = [];
    moments.forEach((m, i) => {
      const from = Math.max(0, Math.min(m.from, total));
      const to = Math.max(from, Math.min(m.to, total));
      if (to - from < 1) throw new StudioError(`Moment ${i + 1} (${m.from}–${m.to} s) is shorter than a second or outside the video.`);
      const copy = this.duplicate(id);
      const name = `${p.name} — short ${i + 1}${m.title ? `: ${m.title}` : ''}`.slice(0, 120);
      const cuts: Array<{ from: number; to: number }> = [];
      if (from > 0.01) cuts.push({ from: 0, to: from });
      if (to < total - 0.01) cuts.push({ from: to, to: total });
      const ops: EditOp[] = [{ op: 'set_project', name }];
      if (cuts.length) ops.push({ op: 'cut_ranges', ranges: cuts });
      // Locked tracks would refuse the cut: shorts are new projects, so they are unlocked here.
      for (const t of copy.tracks) if (t.locked) ops.unshift({ op: 'set_track', track: t.id, locked: false });
      let r = this.edit(copy.id, ops);
      if (r.project.width >= r.project.height) {
        const reshape: EditOp[] = [{ op: 'set_project', width: 1080, height: 1920 }];
        for (const t of r.project.tracks)
          for (const c of t.clips)
            if (c.type === 'media') {
              const a = r.project.assets.find((x) => x.id === c.assetId);
              if (a && a.width > a.height) reshape.push({ op: 'set', clip: c.id, fit: 'contain', backdrop: 'blur' });
            }
        r = this.edit(copy.id, reshape);
      }
      if (m.title) r = this.edit(copy.id, [{ op: 'add_text', text: m.title.slice(0, 120), start: 0, duration: Math.min(3, to - from), animIn: 'pop', transform: { y: 0.18 } }]);
      // A fresh project: nothing to undo into the long video's history.
      this.undo.delete(copy.id);
      this.redo.delete(copy.id);
      out.push({ projectId: copy.id, name, seconds: Math.round(projectDuration(r.project) * 100) / 100 });
    });
    this.d.log.info('studio.shorts', { made: out.length });
    // Made by Keo while the user watches: the first short comes on screen.
    if (this.keoDepth > 0 && this.watching.size && out[0]) {
      this.current = out[0].projectId;
      this.d.showProject?.(out[0].projectId);
    }
    return out;
  }

  // ---------------------------------------------------------------- motion tracking and stabilising

  /** Times across a stretch of a video clip (timeline seconds) and the matching seconds into its file. */
  private clipTimes(v: MediaClip, a: Asset, from: number, to: number): { times: number[]; source: number[] } {
    const step = Math.max(1 / 15, (to - from) / 290);
    const times: number[] = [];
    for (let t = from; t < to - 1e-6; t += step) times.push(Math.round(t * 1000) / 1000);
    const source = times.map((t) => Math.max(0, Math.min(a.duration - 0.01, v.in + sourceSpan(v, t - v.start))));
    return { times, source };
  }

  /**
   * Makes a text, element or picture follow something in the video under it: `box` is where that
   * thing is at the clip's start (fractions of the frame). Position keyframes follow it, keeping
   * the clip where it is relative to the thing. One edit (one undo).
   */
  async trackMotion(id: string, clipId: string, box: { x: number; y: number; w: number; h: number }, videoId?: string): Promise<{ project: Project; points: number; lost: number }> {
    const p = this.get(id);
    const f = findClip(p, clipId);
    if (!f || f.clip.type === 'audio' || f.clip.type === 'adjust') throw new StudioError('Choose a text, element, sticker or picture to follow something.');
    const o = f.clip;
    const under = (c: Clip): c is MediaClip => c.type === 'media' && c.id !== o.id && p.assets.find((x) => x.id === c.assetId)?.kind === 'video' && c.start < clipEnd(o) && clipEnd(c) > o.start;
    const v = (videoId ? [findClip(p, videoId)?.clip] : p.tracks.flatMap((t) => t.clips)).find((c): c is MediaClip => !!c && under(c));
    if (!v) throw new StudioError('There is no video under that clip to follow.');
    const a = p.assets.find((x) => x.id === v.assetId)!;
    const from = Math.max(o.start, v.start);
    const to = Math.min(clipEnd(o), clipEnd(v));
    if (to - from < 0.2) throw new StudioError('The clip and the video overlap for too short a time.');
    const place = videoPlacement(v, a, p.width, p.height);
    const tl = place.toVideo(box.x, box.y);
    const br = place.toVideo(box.x + box.w, box.y + box.h);
    const vb = { x: Math.max(0, tl.x), y: Math.max(0, tl.y), w: Math.min(1, br.x) - Math.max(0, tl.x), h: Math.min(1, br.y) - Math.max(0, tl.y) };
    if (vb.w <= 0.01 || vb.h <= 0.01) throw new StudioError('That box is not on the video.');
    const { times, source } = this.clipTimes(v, a, from, to);
    const path = await this.runJob<Array<{ x: number; y: number; lost?: boolean }>>({ kind: 'track', projectId: id, assetId: a.id, times: source, box: vb }, 30 * 60_000);
    // The clip keeps its place relative to the thing it follows.
    const start = place.toFrame(path[0]!.x, path[0]!.y);
    const rt0 = from - o.start;
    const baseX = o.keys?.x?.length ? keyValue(o.keys.x, rt0) : o.transform.x;
    const baseY = o.keys?.y?.length ? keyValue(o.keys.y, rt0) : o.transform.y;
    const keysX: Key[] = [];
    const keysY: Key[] = [];
    path.forEach((pt, i) => {
      const fpt = place.toFrame(pt.x, pt.y);
      const at = Math.round((times[i]! - o.start) * 1000) / 1000;
      keysX.push({ at, value: Math.round((baseX + fpt.x - start.x) * 10000) / 10000, ease: 'linear' });
      keysY.push({ at, value: Math.round((baseY + fpt.y - start.y) * 10000) / 10000, ease: 'linear' });
    });
    const r = this.edit(id, [{ op: 'set', clip: o.id, keys: { x: keysX, y: keysY } }]);
    const lost = path.filter((x) => x.lost).length;
    this.d.log.info('studio.tracked', { points: path.length, lost });
    return { project: r.project, points: path.length, lost };
  }

  /**
   * Steadies a shaky video clip: the camera's shake is measured on this PC, its smooth path kept,
   * and the clip moved against the shake (zoomed in a little so no edge shows). One edit.
   */
  async stabilize(id: string, clipId: string, strength = 0.7): Promise<{ project: Project; points: number; zoom: number }> {
    const p = this.get(id);
    const f = findClip(p, clipId);
    if (!f || f.clip.type !== 'media') throw new StudioError('Choose a video clip to steady.');
    const v = f.clip;
    const a = p.assets.find((x) => x.id === v.assetId);
    if (!a || a.kind !== 'video') throw new StudioError('Only videos can be steadied.');
    if (v.freeze) throw new StudioError('A frozen frame does not shake.');
    const { times, source } = this.clipTimes(v, a, v.start, clipEnd(v));
    if (times.length < 4) throw new StudioError('That clip is too short to steady.');
    const shifts = await this.runJob<Array<{ x: number; y: number }>>({ kind: 'track', projectId: id, assetId: a.id, times: source, box: null }, 30 * 60_000);
    // The camera's path, its smoothed path, and the move that takes one to the other.
    const px: number[] = [];
    const py: number[] = [];
    shifts.forEach((s, i) => {
      px.push((px[i - 1] ?? 0) + s.x);
      py.push((py[i - 1] ?? 0) + s.y);
    });
    const half = Math.max(2, Math.round(times.length / Math.max(0.1, clipEnd(v) - v.start) * (0.4 + strength)));
    const sx = smooth(px, half);
    const sy = smooth(py, half);
    const cx = px.map((x, i) => (sx[i]! - x) * strength);
    const cy = py.map((y, i) => (sy[i]! - y) * strength);
    const most = Math.max(0.001, ...cx.map(Math.abs), ...cy.map(Math.abs));
    const zoom = Math.min(1.25, 1 + most * 2.2);
    const scale = Math.round(v.transform.scale * zoom * 1000) / 1000;
    const placed = videoPlacement({ ...v, transform: { ...v.transform, scale } }, a, p.width, p.height);
    const fx = (a.width || p.width) * placed.scaleX;
    const fy = (a.height || p.height) * placed.scaleY;
    const keysX: Key[] = times.map((t, i) => ({ at: Math.round((t - v.start) * 1000) / 1000, value: Math.round((v.transform.x + cx[i]! * fx) * 10000) / 10000, ease: 'linear' }));
    const keysY: Key[] = times.map((t, i) => ({ at: Math.round((t - v.start) * 1000) / 1000, value: Math.round((v.transform.y + cy[i]! * fy) * 10000) / 10000, ease: 'linear' }));
    const r = this.edit(id, [{ op: 'set', clip: v.id, transform: { scale }, keys: { x: keysX, y: keysY } }]);
    this.d.log.info('studio.stabilized', { points: times.length, zoom: Math.round(zoom * 100) / 100 });
    return { project: r.project, points: times.length, zoom };
  }

  // ---------------------------------------------------------------- preview copies

  /** Videos bigger than this (either side, in pixels) play smoother in the preview from a light copy. */
  static readonly BIG = 1920;

  /**
   * A light copy (540p) of a big video for smooth editing, made once on this PC; the preview plays
   * it, the export and frames still use the original. Every big video of the project by default.
   */
  async makePreviewCopies(id: string, assetIds?: string[]): Promise<{ project: Project; made: number }> {
    const p = this.get(id);
    const videos = p.assets.filter((a) => a.kind === 'video' && (assetIds ? assetIds.includes(a.id) : Math.max(a.width, a.height) > StudioService.BIG) && !(a.proxy && fs.existsSync(a.proxy)));
    let made = 0;
    for (const a of videos) {
      const file = path.join(this.d.dir, 'made', `preview-${a.id}.mp4`);
      if (!fs.existsSync(file)) {
        const k = 540 / Math.max(1, Math.min(a.width || 1080, a.height || 1920));
        const width = Math.max(16, Math.round(((a.width || 1080) * Math.min(1, k)) / 2) * 2);
        const height = Math.max(16, Math.round(((a.height || 1920) * Math.min(1, k)) / 2) * 2);
        const fps = Math.min(30, p.fps);
        const tmp = Project.parse({ ...newProject({ name: `${a.name} preview`, rand: () => crypto.randomBytes(6).toString('hex').slice(0, 10) }), width, height, fps, background: '#000000', assets: [a] });
        const one = applyEdits(tmp, [{ op: 'add_media', assetId: a.id, start: 0, duration: Math.max(0.04, a.duration), fit: 'contain' }]).project;
        fs.writeFileSync(this.file(one.id), JSON.stringify(one));
        const exportId = `ex_${crypto.randomBytes(6).toString('hex')}`;
        this.exportTargets.set(exportId, file);
        try {
          await this.runJob({ kind: 'export', projectId: one.id, exportId, size: { width, height, fps, quality: 'standard' } }, 2 * 60 * 60 * 1000);
        } catch (e) {
          fs.rmSync(file, { force: true });
          throw e;
        } finally {
          this.exportTargets.delete(exportId);
          fs.rmSync(this.file(one.id), { force: true });
        }
      }
      this.learn(id, a.id, { proxy: file });
      made++;
    }
    this.d.log.info('studio.preview_copies', { made });
    return { project: this.get(id), made };
  }

  // ---------------------------------------------------------------- background noise

  /**
   * Takes the background noise (hum, hiss, fans, room tone) out of a clip's sound: a cleaned copy
   * of the whole file is made once on this PC and the clip uses it. A video keeps its picture and
   * its own sound is turned off; the clean sound goes on the Voice (clean) track at the same time.
   * One edit (one undo).
   */
  async cleanSound(id: string, clipId: string, strength = 0.8): Promise<{ project: Project; seconds: number }> {
    const p = this.get(id);
    const f = findClip(p, clipId);
    if (!f || (f.clip.type !== 'media' && f.clip.type !== 'audio')) throw new StudioError('That is not a clip with sound.');
    if (f.track.locked) throw new StudioError(`The track ${f.track.name} is locked: unlock it first.`);
    const c = f.clip;
    const a = p.assets.find((x) => x.id === c.assetId);
    if (!a || !a.hasAudio) throw new StudioError('That clip has no sound.');
    if (a.cleanOf) throw new StudioError('That sound is already cleaned.');
    if (c.type === 'media' && (c.speed !== 1 || c.speedCurve || c.reversed)) throw new StudioError('Set the clip to normal speed first (its sound is cleaned at normal speed).');
    if (a.duration > 45 * 60) throw new StudioError('That file is longer than 45 minutes: cut the part you need first.');
    const level = Math.round(Math.max(0.1, Math.min(1, strength)) * 100);
    const file = path.join(this.d.dir, 'made', `clean-${a.id}-${level}.wav`);
    if (!fs.existsSync(file)) {
      const r = await this.runJob<{ base64: string; seconds: number }>({ kind: 'denoise', projectId: id, assetId: a.id, strength: level / 100 }, 60 * 60_000);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, Buffer.from(r.base64, 'base64'));
      fs.renameSync(`${file}.tmp`, file);
    }
    const known = this.get(id).assets.find((x) => path.resolve(x.path).toLowerCase() === path.resolve(file).toLowerCase());
    const copy = known ?? (await this.importFiles(id, [file])).added[0];
    if (!copy) throw new StudioError('Keo could not read the cleaned sound.');
    if (!copy.cleanOf) this.learn(id, copy.id, { cleanOf: a.id, name: `${a.name} (clean sound)` });
    const ops: EditOp[] =
      c.type === 'audio'
        ? [{ op: 'replace_media', clip: c.id, assetId: copy.id, in: c.in }]
        : [
            { op: 'set', clip: c.id, volume: 0 },
            { op: 'add_audio', assetId: copy.id, trackName: 'Voice (clean)', start: c.start, in: c.in, duration: c.duration, volume: c.volume },
          ];
    let r = this.edit(id, ops);
    if (c.type === 'media') {
      // The clean sound keeps the video's sound settings (fades, voice, gate, changer, curve, EQ).
      const added = r.project.tracks.find((t) => t.name === 'Voice (clean)')!.clips.filter((x) => x.type === 'audio' && x.assetId === copy.id).at(-1)!;
      const keep: Extract<EditOp, { op: 'set' }> = { op: 'set', clip: added.id, fadeIn: c.fadeIn, fadeOut: c.fadeOut, voice: c.voice, ...(c.gate ? { gate: c.gate } : {}), ...(c.voiceFx ? { voiceFx: c.voiceFx } : {}), ...(c.eq ? { eq: c.eq } : {}), ...(c.volumeKeys ? { volumeKeys: c.volumeKeys } : {}) };
      r = this.mergeLast(id, keep);
    }
    this.d.log.info('studio.cleaned_sound', { seconds: Math.round(c.duration), level });
    return { project: r.project, seconds: c.duration };
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

  /**
   * A sound from the library on the timeline: music goes on the Music track from `at` (quieter,
   * lower still under speech, fading out at the end of the video), an effect on the Effects track
   * at `at`. One edit (one undo).
   */
  async useSound(id: string, soundId: string, o: { at?: number; role?: 'music' | 'effect'; volume?: number } = {}): Promise<{ project: Project; clip: string }> {
    const s = this.sounds.get(soundId);
    if (!s) throw new StudioError('That sound is not in the library.');
    const role = o.role ?? s.kind;
    let asset: Asset;
    if (s.builtIn) asset = this.soundEffect(id, s.id.slice(4) as SfxKind).asset;
    else {
      const file = this.sounds.file(soundId);
      if (!file) throw new StudioError(`The file of “${s.name}” is missing.`);
      const p0 = this.get(id);
      asset = p0.assets.find((a) => path.resolve(a.path).toLowerCase() === path.resolve(file).toLowerCase()) ?? (await this.importFiles(id, [file])).added[0]!;
      if (!asset) throw new StudioError(`Keo could not read “${s.name}”.`);
      if (asset.name !== s.name) this.learn(id, asset.id, { name: s.name });
    }
    const p = this.get(id);
    const total = projectDuration(p);
    const at = Math.max(0, o.at ?? (role === 'music' ? 0 : 0));
    const op: EditOp =
      role === 'music'
        ? { op: 'add_audio', assetId: asset.id, trackName: 'Music', start: at, volume: o.volume ?? 0.3, duck: -14, ...(total > at + 1 ? { duration: Math.min(asset.duration, total - at) } : {}) }
        : { op: 'add_audio', assetId: asset.id, trackName: 'Effects', start: at, volume: o.volume ?? 0.8 };
    let r = this.edit(id, [op]);
    const track = r.project.tracks.find((t) => t.name === (role === 'music' ? 'Music' : 'Effects'))!;
    const clip = track.clips.filter((c) => c.type === 'audio' && c.assetId === asset.id).sort((a, b) => Math.abs(a.start - at) - Math.abs(b.start - at))[0]!;
    // Music fades out with the end of the video.
    if (role === 'music' && clip.duration > 3) r = this.mergeLast(id, { op: 'set', clip: clip.id, fadeIn: 0.5, fadeOut: 1.5 });
    this.d.log.info('studio.sound_used', { role, builtIn: !!s.builtIn });
    return { project: r.project, clip: clip.id };
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
    if (o.format !== 'mp4') return await this.exportFileAs(id, exportId, o.format, o.name).finally(() => {
      if (this.running.get(id) === exportId) this.running.delete(id);
    });
    const size = { ...exportSize(p, o), quality: o.quality };
    const r = await this.runJob<{ file: string; durationSec: number; frames: number; bytes: number }>({ kind: 'export', projectId: id, exportId, size }, 6 * 60 * 60 * 1000).finally(() => {
      this.exportNames.delete(exportId);
      if (this.running.get(id) === exportId) this.running.delete(id);
    });
    this.d.log.info('studio.exported', { seconds: r.durationSec, frames: r.frames });
    return r;
  }

  /** A GIF or the sound alone (WAV), made in the render window and saved next to the videos (a new file). */
  private async exportFileAs(id: string, exportId: string, format: 'gif' | 'wav', name?: string): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
    const p = this.get(id);
    if (format === 'gif' && projectDuration(p) > 60) throw new StudioError('A GIF can be at most 60 seconds: trim the video or export an MP4.');
    const r = await this.runJob<{ base64: string; frames: number; durationSec: number }>({ kind: 'export_file', projectId: id, exportId, format }, 60 * 60_000);
    const data = Buffer.from(r.base64, 'base64');
    const dir = this.d.exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
    const base = (name ?? p.name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Keo video';
    let file = path.join(dir, `${base}.${format}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).${format}`);
    fs.writeFileSync(file, data, { flag: 'wx' });
    this.d.log.info('studio.exported', { format, seconds: r.durationSec, frames: r.frames });
    return { file, durationSec: r.durationSec, frames: r.frames, bytes: data.length };
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
