import { LUT_NAME, lutNameOf, parseCube } from '../../shared/studioLut';
import { cutawayOps, type CutawayMoment, type CutawayPerson } from '../../shared/studioCutaways';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Logger } from '../logging/logger';
import { detectBeats } from '../video/ffmpeg';
import { applyEdits, describeProject, EditError, ExportOptions, exportSize, exportVideoCodec, type ExportQuality, type ExportVideoCodec, clipEnd, findClip, isAV, keyValue, needsAnalysis, sourceSpan, type Clip, type Key, type AudioClip, type MediaClip, newProject, Project, projectDuration, replaceWords, timelineWords, type Asset, type AssetKind, type EditOp, type FormatId, type ProjectSummary, type RenderJob, type TextStyle, type StudioVersion, type Span } from '../../shared/studio';
import { refineCut, sceneCandidates, sceneSplitTimes } from '../../shared/studioScenes';
import { smooth, videoPlacement } from '../../shared/studioTrack';
import { actionOf, showSteps, type KeoAction } from '../../shared/studioLive';
import { SoundLibrary } from './soundLibrary';
import { Brand, patchBrand, respell, type BrandFileKind, type BrandPatch } from '../../shared/studioBrand';
import { Character, type CharacterPatch } from '../../shared/studioCharacters';
import { faceOf, fixIssues, issueKey, reviewEdit, reviewTimes, type ReviewIssue, type ReviewSample } from '../../shared/studioReview';
import { MomentNeeds, momentOps, placeMoments, type MomentId, type MomentOptions } from '../../shared/studioMoments';
import { guessEmphasis, StyleError, styleOps, type StyleId, type StyleOptions } from '../../shared/studioStyles';
import { viralPlan, type ViralId } from '../../shared/studioViral';
import { episodeName, Series } from '../../shared/studioSeries';
import { lookTimes, MotionEditError, motionEditOps, planBeats, type BeatKind, type MotionEditOptions } from '../../shared/studioMotionEdit';
import { guessShotKind, lookOf, recipeOps, shotsFrom, type Recipe, type ShotKind } from '../../shared/studioRecipe';

export type { ProjectSummary, RenderJob };
import { namesFor, type WordFix } from '../../shared/studioProofread';
import { captionLines, dropLoops, pieces, readWav, spreadWords, voicedSpans, wavOf, type CaptionLine, type Word } from './captions';
import { planCleanup, punchIns, type CleanupPlan } from './cleanup';
import { SFX, sfxWav, type SfxKind } from './sfx';
import { keyBefore, Mp4Reader, Mp4Writer, type Mp4Track, type WriterAudio, type WriterVideo } from './mp4';
import { readWebm, WebmWriter } from './webm';

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
  /**
   * Proofreads a fresh transcript (the user's AI model): words the speech service misheard, such
   * as names. Optional: without it the words stay as heard.
   */
  proofread?: (transcript: string, names: string[], signal: AbortSignal) => Promise<WordFix[]>;
  /** Wait before trying a failed piece of speech again (tests use 0). */
  retryDelayMs?: number;
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

/** A screen showcase's recipe: its scenes (assets of the showcase project itself) and choices. */
export interface ShowcaseRecord {
  title: string;
  scenes: Array<{ screen: string; headline: string; kicker?: string; narration: string; clip?: string }>;
  voice: 'female' | 'male' | 'none';
  look: 'dark' | 'light';
  captions: boolean;
}

/**
 * A showcase made before Keo kept its recipe, read back from its own tracks: the screens in order,
 * the headline over each, the clip floating beside it, and what the voice says (its captions).
 */
export function showcaseFromTimeline(p: Project): ShowcaseRecord | null {
  const track = (name: string) => p.tracks.find((t) => t.name === name);
  const screens = (track('Screens')?.clips ?? []).filter((c): c is MediaClip => c.type === 'media').sort((a, b) => a.start - b.start);
  if (!screens.length || !track('Showcase titles')) return null;
  const titles = track('Showcase titles')!.clips.filter((c) => c.type === 'motion');
  const floating = (track('Floating clips')?.clips ?? []).filter((c): c is MediaClip => c.type === 'media');
  const captions = (track('Captions')?.clips ?? []).filter((c) => c.type === 'text').sort((a, b) => a.start - b.start);
  const inside = (c: Clip, s: MediaClip) => c.start >= s.start - 0.05 && c.start < clipEnd(s) - 0.05;
  const scenes = screens.map((s) => {
    const title = titles.find((t) => inside(t, s));
    const clip = floating.find((f) => inside(f, s));
    const narration = captions
      .filter((c) => inside(c, s))
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join(' ')
      .trim();
    return { screen: s.assetId, headline: title?.type === 'motion' ? title.text : 'Feature', ...(title?.type === 'motion' && title.sub ? { kicker: title.sub } : {}), narration, ...(clip ? { clip: clip.assetId } : {}) };
  });
  const backdrop = track('Showcase backdrop')?.clips[0];
  const light = backdrop?.type === 'motion' && !!backdrop.background && /^#[EF]/i.test(backdrop.background);
  const voiced = (track('Voice')?.clips.length ?? 0) > 0;
  return { title: p.name, scenes, voice: voiced ? 'female' : 'none', look: light ? 'light' : 'dark', captions: captions.length > 0 };
}

/** A map whose entry for a project is read from disk the first time it is asked for. */
class LazyMap<V> extends Map<string, V> {
  constructor(private readonly load: (id: string) => void) {
    super();
  }
  override get(id: string): V | undefined {
    this.load(id);
    return super.get(id);
  }
}

/** The most undo history kept on disk per project (newest kept first). */
const HISTORY_BYTES = 24 * 1024 * 1024;

export class StudioService {
  // Undo and redo survive a restart: kept beside the project (history/<id>.json), read when first needed.
  private readonly undo = new LazyMap<Project[]>((id) => this.loadHistory(id));
  private readonly redo = new LazyMap<Project[]>((id) => this.loadHistory(id));
  private readonly historyLoaded = new Set<string>();
  private readonly historyTimers = new Map<string, NodeJS.Timeout>();
  private readonly readers = new Map<string, Mp4Reader | null>();
  private readonly jobs = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly exports = new Map<string, { writer: Mp4Writer | WebmWriter; file: string; projectId: string; webm?: boolean; part?: string }>();
  /** Exports the user asked to stop (their part file is thrown away, not kept to resume). */
  private readonly cancelled = new Set<string>();
  /** The user's own MP4 / MOV exports, which keep a journal so they can carry on if they stop. */
  private readonly resumablePlans = new Map<string, ResumeRecord>();
  /** The export running for each project (to stop it). */
  private readonly running = new Map<string, string>();

  /** Stops a project's running export (the render window stops at the next frame; nothing is saved). */
  cancelExport(id: string): boolean {
    const exportId = this.running.get(id);
    if (!exportId || !this.d.sendJob) return false;
    this.cancelled.add(exportId);
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
    const seriesOf = new Map<string, { id: string; name: string; episode: number }>();
    for (const se of this.seriesList()) se.projects.forEach((pid, i) => seriesOf.set(pid, { id: se.id, name: se.name, episode: i + 1 }));
    for (const f of fs.readdirSync(this.d.dir)) {
      if (!/^pr_[A-Za-z0-9]+\.json$/.test(f)) continue;
      try {
        const p = Project.parse(JSON.parse(fs.readFileSync(path.join(this.d.dir, f), 'utf8')));
        const first = p.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media').sort((x, y) => x.start - y.start)[0];
        const cover = (first?.type === 'media' ? p.assets.find((a) => a.id === first.assetId) : undefined) ?? p.assets.find((a) => a.kind !== 'audio') ?? null;
        const se = seriesOf.get(p.id);
        out.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, width: p.width, height: p.height, duration: projectDuration(p), ...(p.conversationId ? { conversationId: p.conversationId } : {}), ...(p.panelConversationId ? { panelConversationId: p.panelConversationId } : {}), clips: p.tracks.reduce((n, t) => n + t.clips.length, 0), cover: cover ? { ...cover, words: undefined, speech: undefined, beats: undefined, scenes: undefined } : null, ...(se ? { series: se } : {}) });
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
    this.keepHistory(p.id);
    if (notify) this.d.changed?.(p);
  }

  private historyFile(id: string): string {
    this.file(id);
    return path.join(this.d.dir, 'history', `${id}.json`);
  }

  /** Reads a project's undo and redo from disk once (a damaged file is ignored: the edit itself is safe). */
  private loadHistory(id: string): void {
    if (this.historyLoaded.has(id)) return;
    this.historyLoaded.add(id);
    try {
      const raw = JSON.parse(fs.readFileSync(this.historyFile(id), 'utf8')) as { undo?: unknown[]; redo?: unknown[]; undoLabels?: string[]; redoLabels?: string[] };
      const read = (list: unknown[] | undefined) => (list ?? []).flatMap((x) => {
        const r = Project.safeParse(x);
        return r.success ? [r.data] : [];
      });
      const undo = read(raw.undo);
      const redo = read(raw.redo);
      if (undo.length) Map.prototype.set.call(this.undo, id, undo);
      if (redo.length) Map.prototype.set.call(this.redo, id, redo);
      if (raw.undoLabels?.length) this.undoLabels.set(id, raw.undoLabels.slice(-undo.length));
      if (raw.redoLabels?.length) this.redoLabels.set(id, raw.redoLabels.slice(-redo.length));
    } catch {
      /* no history yet */
    }
  }

  /** Writes the undo and redo a moment after the last change. */
  private keepHistory(id: string): void {
    clearTimeout(this.historyTimers.get(id));
    const timer = setTimeout(() => {
      this.historyTimers.delete(id);
      this.writeHistory(id);
    }, 1500);
    timer.unref?.();
    this.historyTimers.set(id, timer);
  }

  /** Writes any undo history still waiting (on close, and in tests). */
  flushHistory(): void {
    for (const [id, t] of [...this.historyTimers]) {
      clearTimeout(t);
      this.historyTimers.delete(id);
      this.writeHistory(id);
    }
  }

  /** The undo and redo on disk: newest first, within a size limit. */
  private writeHistory(id: string): void {
    try {
      const take = (list: Project[], budget: number) => {
        const out: string[] = [];
        let used = 0;
        for (let i = list.length - 1; i >= 0; i--) {
          const s = JSON.stringify(list[i]);
          if (used + s.length > budget) break;
          used += s.length;
          out.unshift(s);
        }
        return { out, used };
      };
      const u = take((Map.prototype.get.call(this.undo, id) as Project[] | undefined) ?? [], HISTORY_BYTES);
      const r = take((Map.prototype.get.call(this.redo, id) as Project[] | undefined) ?? [], Math.max(0, HISTORY_BYTES - u.used));
      const ul = u.out.length ? (this.undoLabels.get(id) ?? []).slice(-u.out.length) : [];
      const rl = r.out.length ? (this.redoLabels.get(id) ?? []).slice(-r.out.length) : [];
      const f = this.historyFile(id);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(`${f}.tmp`, `{"undo":[${u.out.join(',')}],"redo":[${r.out.join(',')}],"undoLabels":${JSON.stringify(ul)},"redoLabels":${JSON.stringify(rl)}}`);
      fs.renameSync(`${f}.tmp`, f);
    } catch (e) {
      this.d.log.warn('studio.history_not_saved', { error: e instanceof Error ? e.message : String(e) });
    }
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

  // ---------------------------------------------------------------- series

  private get seriesFile(): string {
    return path.join(this.d.dir, 'library', 'series.json');
  }
  /** The user's series (episodes whose projects were deleted are left out). */
  seriesList(): Series[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.seriesFile, 'utf8')) as unknown[];
      return raw.flatMap((x) => {
        const r = Series.safeParse(x);
        return r.success ? [{ ...r.data, projects: r.data.projects.filter((pid) => fs.existsSync(path.join(this.d.dir, `${pid}.json`))) }] : [];
      });
    } catch {
      return [];
    }
  }
  private saveSeries(list: Series[]): void {
    fs.mkdirSync(path.dirname(this.seriesFile), { recursive: true });
    fs.writeFileSync(this.seriesFile, JSON.stringify(list, null, 2));
  }
  /** A new series, optionally starting from projects the user already made (in that order). */
  createSeries(name: string, o: { format?: FormatId; projects?: string[] } = {}): Series {
    const list = this.seriesList();
    if (list.some((x) => x.name.toLowerCase() === name.trim().toLowerCase())) throw new StudioError(`There is already a series called “${name.trim()}”.`);
    const projects = (o.projects ?? []).filter((pid) => { this.get(pid); return true; });
    const first = projects[0] ? this.get(projects[0]) : null;
    const format: FormatId = o.format ?? (first ? (first.width > first.height ? 'landscape' : first.width === first.height ? 'square' : 'vertical') : 'vertical');
    const se: Series = { id: `se_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, name: name.trim().slice(0, 80), projects, format: format === 'landscape' || format === 'square' ? format : 'vertical', createdAt: (this.d.now?.() ?? new Date()).toISOString() };
    // A project is an episode of one series at a time.
    this.saveSeries([...list.map((x) => ({ ...x, projects: x.projects.filter((pid) => !projects.includes(pid)) })), se]);
    return se;
  }
  /** Adds a project as the next episode (taking it out of any other series). */
  addToSeries(seriesId: string, projectId: string): Series {
    this.get(projectId);
    const list = this.seriesList().map((x) => ({ ...x, projects: x.projects.filter((pid) => pid !== projectId) }));
    const se = list.find((x) => x.id === seriesId);
    if (!se) throw new StudioError('There is no such series.');
    se.projects.push(projectId);
    this.saveSeries(list);
    return se;
  }
  removeFromSeries(projectId: string): void {
    this.saveSeries(this.seriesList().map((x) => ({ ...x, projects: x.projects.filter((pid) => pid !== projectId) })));
  }
  /**
   * The next episode: the last episode's edit made again with the new clips (same look, captions,
   * cards and timing), named and numbered for the series. The first episode starts empty.
   */
  async newEpisode(seriesId: string, files: string[], title?: string): Promise<{ project: Project; episode: number; filled: number; slots: number }> {
    const se = this.seriesList().find((x) => x.id === seriesId);
    if (!se) throw new StudioError('There is no such series.');
    const n = se.projects.length + 1;
    const name = episodeName(se.name, n, title);
    const last = se.projects.at(-1);
    let made: { project: Project; filled: number; slots: number };
    if (last && files.length && this.templateSlots(this.get(last)).length) made = await this.fromTemplate(last, files, name);
    else {
      const p = this.create(name, se.format);
      if (files.length) await this.importFiles(p.id, files);
      made = { project: this.get(p.id), filled: 0, slots: 0 };
    }
    this.addToSeries(se.id, made.project.id);
    return { ...made, episode: n };
  }

  create(name: string, format: FormatId = 'vertical'): Project {
    const p = newProject({ name, format, ...(this.d.now ? { now: this.d.now() } : {}), rand: () => crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10) });
    this.save(p);
    this.current = p.id;
    this.d.log.info('studio.created', { format });
    return p;
  }

  /** Remembers the chat a project was worked on from (and Studio's own panel chat); the edit history is not touched. */
  link(id: string, l: { conversationId?: string; panelConversationId?: string }): Project {
    const p = this.get(id);
    if ((!l.conversationId || p.conversationId === l.conversationId) && (!l.panelConversationId || p.panelConversationId === l.panelConversationId)) return p;
    const next = Project.parse({ ...p, ...l });
    this.save(next, false);
    return next;
  }

  /** Sets (or clears) the video's art direction. */
  setDirection(id: string, direction: string | undefined): Project {
    const p = this.get(id);
    const { direction: _old, ...rest } = p;
    const next = Project.parse(direction ? { ...rest, direction } : rest);
    this.save(next, false);
    return next;
  }

  open(id: string): Project {
    const p = this.get(id);
    this.current = id;
    this.queuePreviewCopies(id);
    return p;
  }

  /**
   * Whether a video is too heavy to play smoothly in the preview on an ordinary PC: bigger than full
   * HD, more than 30 frames a second, or a very high bitrate (phones often record 1440p at 50–60 fps
   * and 30–40 Mbit/s). Those get a light preview copy (see makePreviewCopies).
   */
  heavyVideo(a: Asset): boolean {
    if (a.kind !== 'video' || a.duration <= 0) return false;
    // A strong PC (8+ threads) plays 1440p and 60 fps itself: only very heavy videos need a copy there.
    const strong = this.strongPc();
    if (Math.max(a.width, a.height) > (strong ? 2560 : StudioService.BIG)) return true;
    let mbps: number;
    let fps = 0;
    try {
      mbps = (fs.statSync(a.path).size * 8) / a.duration / 1e6;
      if (MP4_EXT.has(path.extname(a.path).toLowerCase())) {
        const r = Mp4Reader.open(a.path);
        if (r) {
          try {
            const v = r.video();
            if (v && v.duration > 0) fps = v.samples.length / v.duration;
          } finally {
            r.close();
          }
        }
      }
    } catch {
      return false;
    }
    return strong ? mbps > 60 : fps > 32 || mbps > 20;
  }

  /** A preview copy that is there, readable, and as long as its video (not one cut short). */
  goodCopy(a: Asset): boolean {
    if (!a.proxy || !fs.existsSync(a.proxy)) return false;
    // Checked once per file version (the preview asks on every read of the video).
    const st = fs.statSync(a.proxy);
    const key = `${a.proxy}|${st.size}|${st.mtimeMs}|${a.duration}`;
    const known = this.copyChecked.get(key);
    if (known !== undefined) return known;
    const ok = this.readCopy(a);
    this.copyChecked.set(key, ok);
    return ok;
  }
  private readonly copyChecked = new Map<string, boolean>();

  private readCopy(a: Asset & { proxy?: string }): boolean {
    try {
      if (!a.proxy) return false;
      const r = Mp4Reader.open(a.proxy);
      if (!r) return false;
      try {
        const v = r.video();
        return !!v && v.samples.length > 0 && v.duration >= a.duration * 0.9 - 0.5;
      } finally {
        r.close();
      }
    } catch {
      return false;
    }
  }

  /** 8 or more processor threads: plays heavy video itself and makes copies fast. Tests may set it. */
  strongPc = (): boolean => os.cpus().length >= 8;

  private copyQueue: Promise<void> = Promise.resolve();
  private readonly copying = new Set<string>();

  /** Videos whose preview copy is being made now (shown in the preview). */
  previewCopying(id: string): string[] {
    return [...this.copying].filter((k) => k.startsWith(`${id}:`)).map((k) => k.slice(id.length + 1));
  }

  /**
   * In the background, one at a time: a preview copy for each heavy video of the project that has
   * none. The preview switches to the copy as soon as it is ready; the export keeps the original.
   */
  queuePreviewCopies(id: string): void {
    if (!this.d.sendJob) return;
    let p: Project;
    try {
      p = this.get(id);
    } catch {
      return;
    }
    for (const a of p.assets) {
      const key = `${id}:${a.id}`;
      if (this.copying.has(key) || this.goodCopy(a) || !this.heavyVideo(a)) continue;
      this.copying.add(key);
      this.d.changed?.(p);
      this.copyQueue = this.copyQueue.then(async () => {
        try {
          // A busy PC can starve the encoder: one more try after a short pause.
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              await this.makePreviewCopies(id, [a.id]);
              this.d.log.info('studio.preview_copy_auto', { asset: a.id, attempt });
              break;
            } catch (e) {
              this.d.log.warn('studio.preview_copy_failed', { attempt, error: e instanceof Error ? e.message.slice(0, 160) : String(e) });
              if (attempt < 2) await new Promise((res) => setTimeout(res, 5000));
            }
          }
        } finally {
          this.copying.delete(key);
          try {
            this.d.changed?.(this.get(id));
          } catch {
            /* project gone */
          }
        }
      });
    }
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
    fs.rmSync(path.join(this.d.dir, 'versions', id), { recursive: true, force: true });
    clearTimeout(this.historyTimers.get(id));
    this.historyTimers.delete(id);
    fs.rmSync(this.historyFile(id), { force: true });
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

  // ---------------------------------------------------------------- versions

  private versionsDir(id: string): string {
    this.file(id);
    return path.join(this.d.dir, 'versions', id);
  }
  /** The saved versions of a project, newest first. */
  versions(id: string): StudioVersion[] {
    const dir = this.versionsDir(id);
    const out: StudioVersion[] = [];
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (!/^vr_[A-Za-z0-9]+\.json$/.test(f)) continue;
      try {
        const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { id: string; name: string; at: string; project: Project };
        out.push({ id: v.id, name: v.name, at: v.at, seconds: Math.round(projectDuration(v.project) * 10) / 10 });
      } catch {
        // A damaged version file is skipped.
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }
  /** Keeps the edit as it is now under a name (up to 30 per project; the oldest go). */
  saveVersion(id: string, name: string): StudioVersion {
    const p = this.get(id);
    const dir = this.versionsDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const v = { id: `vr_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, name: name.trim().slice(0, 80) || 'Version', at: new Date().toISOString() };
    fs.writeFileSync(path.join(dir, `${v.id}.json`), JSON.stringify({ ...v, project: p }));
    for (const old of this.versions(id).slice(30)) fs.rmSync(path.join(dir, `${old.id}.json`), { force: true });
    this.d.log.info('studio.version_saved', {});
    return { ...v, seconds: Math.round(projectDuration(p) * 10) / 10 };
  }
  /** Back to a saved version (one step that can be undone; the media and what Keo learned about it stay). */
  restoreVersion(id: string, versionId: string): Project {
    if (!/^vr_[A-Za-z0-9]{4,24}$/.test(versionId)) throw new StudioError('That is not a version id.');
    const file = path.join(this.versionsDir(id), `${versionId}.json`);
    if (!fs.existsSync(file)) throw new StudioError('That version is not saved.');
    const v = JSON.parse(fs.readFileSync(file, 'utf8')) as { name: string; project: Project };
    const now = this.get(id);
    const assets = [...now.assets, ...v.project.assets.filter((a) => !now.assets.some((b) => b.id === a.id))];
    const restored: Project = { ...v.project, id, name: now.name, assets, updatedAt: new Date().toISOString() };
    this.skipShow(id);
    const stack = this.undo.get(id) ?? [];
    stack.push(now);
    if (stack.length > UNDO_DEPTH) stack.shift();
    this.undo.set(id, stack);
    this.redo.delete(id);
    this.label(id, `Back to version “${v.name}”`);
    this.save(restored);
    return restored;
  }
  deleteVersion(id: string, versionId: string): void {
    if (!/^vr_[A-Za-z0-9]{4,24}$/.test(versionId)) throw new StudioError('That is not a version id.');
    fs.rmSync(path.join(this.versionsDir(id), `${versionId}.json`), { force: true });
  }

  /** One more edit that undoes together with the edit just before it (one step in the undo list). */
  /** More edits that belong to the last step (one undo takes both back). */
  followUp(id: string, ops: EditOp[]): { project: Project; changes: string[] } {
    if (!ops.length) return { project: this.get(id), changes: [] };
    const r = this.edit(id, ops);
    this.undo.get(id)?.pop();
    this.undoLabels.get(id)?.pop();
    return r;
  }

  /** The last edit becomes part of the one before it (one undo takes both back). */
  joinLastStep(id: string): void {
    if ((this.undo.get(id)?.length ?? 0) < 2) return;
    this.undo.get(id)?.pop();
    this.undoLabels.get(id)?.pop();
  }

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
    // Heavy phone videos get a light copy for the preview, in the background.
    this.queuePreviewCopies(id);
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
      if (a && preview && this.goodCopy(a)) return a.proxy!;
      return a && fs.existsSync(a.path) ? a.path : null;
    } catch {
      return null;
    }
  }

  /** AI clips still being made for a project (set by the app): Keo is told, so it never guesses. */
  aiPending: ((projectId: string) => string[]) | null = null;

  describe(id?: string): string {
    const p = this.resolve(id);
    const waiting = this.aiPending?.(p.id) ?? [];
    const show = this.showcaseOf(p.id);
    const scenes = show
      ? `\nThis is a screen showcase (${show.voice} voice, ${show.look} look, captions ${show.captions ? 'on' : 'off'}). Its scenes: ${show.scenes.map((sc, i) => `${i + 1}. screen ${sc.screen}${sc.clip ? ` + clip ${sc.clip}` : ''}, headline ${JSON.stringify(sc.headline)}${sc.kicker ? `, kicker ${JSON.stringify(sc.kicker)}` : ''}, says ${JSON.stringify(sc.narration)}`).join(' ')}. To change what is said, the voice, the look, the order or the scenes, remake it in place with studio__showcase {projectId: "${p.id}", remake: true, …only what changes}; small looks (caption style, a headline's words or colour) are studio__edit.`
      : '';
    return describeProject(p) + scenes + (waiting.length ? `\nStill being made by AI (not on the timeline yet; each is added by itself when ready, do not ask for it again): ${waiting.join('; ')}.` : '');
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

  /** Every job waiting on the renderer fails now (it stopped). */
  failJobs(message: string): void {
    for (const [jobId, j] of this.jobs) {
      clearTimeout(j.timer);
      this.jobs.delete(jobId);
      j.reject(new StudioError(message));
    }
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

  /** Runs `fn` with a project that exists only for it (saved where the render window can read it, removed after). */
  async withTempProject<T>(p: Project, fn: (id: string) => Promise<T>): Promise<T> {
    const file = this.file(p.id);
    fs.writeFileSync(file, JSON.stringify(Project.parse(p)));
    try {
      return await fn(p.id);
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
  private learn(id: string, assetId: string, patch: Partial<Pick<Asset, 'speech' | 'words' | 'wordsExact' | 'beats' | 'bpm' | 'scenes' | 'reverseOf' | 'cleanOf' | 'proxy' | 'name' | 'about' | 'aiMade' | 'aiRecipe' | 'aiPlan'>>): Project {
    const fix = (p: Project): Project => ({ ...p, assets: p.assets.map((a) => (a.id === assetId ? { ...a, ...patch } : a)) });
    for (const stack of [this.undo.get(id), this.redo.get(id)]) if (stack) for (let i = 0; i < stack.length; i++) stack[i] = fix(stack[i]!);
    const next = Project.parse(fix(this.get(id)));
    this.save(next);
    return next;
  }

  /** Where people speak in these media files (measured on this PC once, then remembered; nothing is sent anywhere). */
  async speechOf(id: string, assetIds: string[], signal?: AbortSignal): Promise<Record<string, Span[]>> {
    const out: Record<string, Span[]> = {};
    for (const aid of assetIds) {
      if (signal?.aborted) throw new StudioError('Stopped.');
      const a = this.get(id).assets.find((x) => x.id === aid);
      if (!a || a.kind === 'image' || !a.hasAudio) continue;
      if (a.speech) {
        out[aid] = a.speech;
        continue;
      }
      const s = await this.assetSound(id, aid);
      out[aid] = this.learn(id, aid, { speech: s ? voicedSpans(s.samples, s.rate) : [] }).assets.find((x) => x.id === aid)?.speech ?? [];
    }
    return out;
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
  ): Promise<{ project: Project; transcribed: number; words: number; exact: boolean; skipped: number; fixed: WordFix[] }> {
    let p = this.get(id);
    const fixed: WordFix[] = [];
    const exact = !!t.words;
    const used = p.assets.filter((a) => a.hasAudio && a.kind !== 'image' && p.tracks.some((tr) => tr.clips.some((c) => isAV(c) && c.assetId === a.id)));
    // A transcript saved before loops were caught ("the um, the um…"): done again.
    const looped = used.filter((a) => a.words?.length && dropLoops(a.words, (w) => w.text).length < a.words.length * 0.9);
    const todo = o.force ? used : [...new Set([...needsAnalysis(p, 'words'), ...looped])];
    let count = 0;
    let skipped = 0;
    const failed: string[] = [];
    let lastError = '';
    /**
     * One piece of speech, tried up to three times (speech services fail now and then on a single
     * piece); a piece that still fails is skipped (a short gap in the words) instead of losing the file.
     */
    const piece = async <T>(f: () => Promise<T>, where: number): Promise<T | null> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await f();
        } catch (e) {
          if (o.signal.aborted) throw new StudioError('Stopped.');
          lastError = e instanceof Error ? e.message.slice(0, 160) : String(e);
          // The account itself is refused (no credit, wrong key): trying the same piece again cannot help.
          const hopeless = /quota|credit|billing|api key|unauthori[sz]ed|\b40[13]\b/i.test(lastError);
          if (attempt >= 3 || hopeless) {
            this.d.log.warn('studio.transcribe_piece_skipped', { at: Math.round(where), error: lastError });
            return null;
          }
          await new Promise((r) => setTimeout(r, this.d.retryDelayMs ?? 1000 * attempt * attempt));
        }
      }
    };
    for (const a of todo) {
      try {
      const sound = await this.assetSound(id, a.id);
      const spans = sound ? voicedSpans(sound.samples, sound.rate) : [];
      const words: Word[] = [];
      // Word times: pieces of up to 10 minutes (the service's file limit). Text only: short pieces.
      const groups = sound ? pieces(spans, exact ? 600 : 14) : [];
      let done = 0;
      let missed = 0;
      for (const g of groups) {
        if (o.signal.aborted) throw new StudioError('Stopped.');
        const from = g[0]!.start;
        const to = g.at(-1)!.end;
        const wav = wavOf(sound!.samples, sound!.rate, from, to);
        const voiced = g.reduce((n, s) => n + (s.end - s.start), 0);
        if (t.words) {
          const got = await piece(() => t.words!(wav, o.signal), from);
          if (!got) missed++;
          const said = (got ?? []).filter((w) => w.text.trim());
          for (const w of dropLoops(said, (x) => x.text, voiced)) words.push({ text: w.text.trim().slice(0, 80), start: round3(from + w.start), end: round3(from + Math.max(w.start, w.end)) });
        } else if (t.text) {
          const got = await piece(() => t.text!(wav, o.signal), from);
          if (got === null) missed++;
          // Repeated loops of the speech service are dropped before the words are spread out.
          const text = dropLoops((got ?? '').trim().split(/\s+/).filter(Boolean), (x) => x, voiced).join(' ');
          if (text) words.push(...spreadWords(text, g).map((w) => ({ ...w, text: w.text.slice(0, 80) })));
        }
        o.progress?.(++done, groups.length);
      }
      // Not one piece came back: this file did not work.
      if (groups.length && missed === groups.length) throw new StudioError(lastError ? `the speech service refused every part of it: ${lastError}` : 'the speech service did not answer for any part of it. Try again in a minute.');
      skipped += missed;
      count += words.length;
      p = this.learn(id, a.id, { speech: spans, words, wordsExact: exact });
      // Misheard names and words put right before anything uses them (captions, cuts, titles).
      if (this.d.proofread && words.length) {
        const fixes = await this.d.proofread(words.map((w) => w.text).join(' '), this.names(p), o.signal).catch((e: unknown) => {
          if (o.signal.aborted) throw e;
          this.d.log.warn('studio.proofread_failed', { reason: e instanceof Error ? e.message.slice(0, 160) : String(e) });
          return [] as WordFix[];
        });
        if (fixes.length) {
          p = this.learn(id, a.id, { words: respell(words, fixes.map((f) => ({ heard: f.heard, say: f.meant }))) });
          fixed.push(...fixes.filter((f) => !fixed.some((x) => x.heard === f.heard)));
        }
      }
      } catch (e) {
        // One file the speech service could not do: the others still get their words.
        if (o.signal.aborted) throw new StudioError('Stopped.');
        failed.push(`${a.name}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`);
        this.d.log.warn('studio.transcribe_failed', { kind: a.kind, seconds: Math.round(a.duration) });
      }
    }
    if (failed.length === todo.length && todo.length) throw new StudioError(`Speech-to-text did not work: ${failed.slice(0, 2).join('; ')}`);
    if (todo.length) this.d.log.info('studio.transcribed', { files: todo.length - failed.length, words: count, exact, failed: failed.length, skipped });
    return { project: p, transcribed: todo.length, words: count, exact, skipped, fixed };
  }

  /** A planned AI shot's frame: what it shows and how it will be filmed (kept with the picture). */
  setAiPlan(id: string, assetId: string, plan: NonNullable<Asset['aiPlan']>): Project {
    return this.learn(id, assetId, { aiPlan: plan });
  }

  /** Names the user's videos say (for proofreading): brand kit, handle, spellings, project name. */
  names(p: Project, extra: string[] = []): string[] {
    const b = this.brand();
    return namesFor({ ...(b.name ? { brandName: b.name } : {}), ...(b.handle ? { handle: b.handle } : {}), ...(b.spellings ? { spellings: b.spellings } : {}), project: p.name, extra });
  }

  /**
   * Misheard words put right everywhere at once: the saved transcripts (so later captions and
   * cuts are right) and every text, caption and graphic on the timeline that shows them (one edit).
   */
  fixWords(id: string, fixes: WordFix[]): { project: Project; fixed: WordFix[]; inText: number } {
    let p = this.get(id);
    const spellings = fixes.map((f) => ({ heard: f.heard, say: f.meant }));
    for (const a of p.assets) if (a.words?.length) p = this.learn(id, a.id, { words: respell(a.words, spellings) });
    const shows = (f: WordFix) =>
      p.tracks.some((t) => t.clips.some((c) => (c.type === 'text' && replaceWords(c.text, f.heard, f.meant)) || (c.type === 'motion' && [c.text ?? '', ...(c.items ?? [])].some((x) => replaceWords(x, f.heard, f.meant)))));
    const ops = fixes.filter(shows).map((f) => ({ op: 'replace_words' as const, find: f.heard, replace: f.meant }));
    if (ops.length) p = this.edit(id, ops).project;
    return { project: p, fixed: fixes, inText: ops.length };
  }

  /**
   * Auto-captions: the timeline's speech (transcribed first where needed) laid out as caption lines
   * on the Captions track, in one edit (one undo).
   */
  async captions(
    id: string,
    t: { words?: (wav: Buffer, signal: AbortSignal) => Promise<Word[]>; text?: (wav: Buffer, signal: AbortSignal) => Promise<string> },
    o: { maxWords?: number; style?: Partial<TextStyle>; highlight?: string | null; animIn?: Extract<EditOp, { op: 'add_captions' }>['animIn']; transform?: { x?: number; y?: number }; signal: AbortSignal; progress?: (done: number, total: number) => void },
  ): Promise<{ project: Project; lines: CaptionLine[]; words: number; exact: boolean; skipped: number; fixed: WordFix[] }> {
    if (projectDuration(this.get(id)) === 0) throw new StudioError('The timeline is empty: add a video with speech first.');
    const heard = await this.transcribe(id, t, { signal: o.signal, ...(o.progress ? { progress: o.progress } : {}) });
    const words = this.spokenWords(this.get(id));
    if (!words.length) throw new StudioError('No spoken words were found in the timeline’s sound.');
    const lines = captionLines(words, { maxWords: o.maxWords ?? 3 });
    const r = this.edit(id, [{ op: 'add_captions', lines, replace: true, ...(o.style ? { style: o.style } : {}), ...(o.highlight !== undefined ? { highlight: o.highlight } : {}), ...(o.animIn ? { animIn: o.animIn } : {}), ...(o.transform ? { transform: o.transform } : {}) }]);
    this.d.log.info('studio.captions', { lines: lines.length, words: words.length });
    return { project: r.project, lines, words: words.length, exact: words.every((w) => w.exact), skipped: heard.skipped, fixed: heard.fixed };
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
  /** A picture of a media file for Keo to look at (PNG): a video as three frames side by side. */
  async assetSheet(id: string, assetId: string): Promise<Buffer> {
    const a = this.get(id).assets.find((x) => x.id === assetId);
    if (!a || a.kind === 'audio') throw new StudioError('Choose a picture or video of this project.');
    return Buffer.from(await this.runJob<string>({ kind: 'asset_sheet', projectId: id, assetId }, 2 * 60_000), 'base64');
  }
  /** A clip an AI video model made: imported, marked as AI-made, and placed on the AI shots track at `at`. */
  /** AI clips arriving together are added one after another (each import and edit sees the last one). */
  private aiClipQueue: Promise<unknown> = Promise.resolve();
  addAiClip(
    id: string,
    file: string,
    o: AiClipPlace,
  ): Promise<{ project: Project; asset: Asset; clip: string }> {
    const next = this.aiClipQueue.then(() => this.addAiClipFull(id, file, o));
    this.aiClipQueue = next.catch(() => undefined);
    return next;
  }
  private async addAiClipFull(id: string, file: string, o: AiClipPlace): Promise<{ project: Project; asset: Asset; clip: string }> {
    if (o.removeFirst && findClip(this.get(id), o.removeFirst)) this.edit(id, [{ op: 'delete', clip: o.removeFirst }]);
    const r = await this.addAiClipNow(id, file, o);
    // A planned shot: its frame remembers how far it got (a test, or the full shot).
    if (o.frameAsset && o.filmed) {
      const frame = this.get(id).assets.find((a) => a.id === o.frameAsset);
      if (frame?.aiPlan) this.learn(id, frame.id, { aiPlan: { ...frame.aiPlan, filmed: frame.aiPlan.filmed === 'final' ? 'final' : o.filmed } });
    }
    // Filmed like a real camera: a hint of handheld movement and a slow push (free, on this PC).
    if (o.finish && r.asset.kind === 'video') {
      const c = findClip(this.get(id), r.clip)?.clip;
      if (c?.type === 'media') return { ...r, project: this.mergeLast(id, realCameraOps(c.id, c.duration)[0]!).project };
    }
    return r;
  }
  private async addAiClipNow(
    id: string,
    file: string,
    o: { at: number; seconds: number; about: string; in?: number; duration?: number; trackName?: string; muted?: boolean; volume?: number; duck?: number | null; recipe?: Asset['aiRecipe']; replace?: string },
  ): Promise<{ project: Project; asset: Asset; clip: string }> {
    // An AI video is checked before it goes in: long enough and big enough to be the clip that was asked for.
    const bad = await this.aiClipProblem(file, o.seconds);
    if (bad) {
      // Set aside, so the same broken file is never reused as "made before".
      try {
        fs.renameSync(file, `${file}.unusable`);
      } catch {
        /* already gone */
      }
      this.d.log.warn('studio.ai_clip_unusable', { problem: bad });
      throw new StudioError(`The AI clip came back unusable (${bad}), so it was not added. Ask Keo to make it again.`);
    }
    // A clip used again (made before) is already media of the project.
    const imported = await this.importFiles(id, [file]);
    const asset = imported.added[0] ?? imported.project.assets.find((a) => path.resolve(a.path).toLowerCase() === path.resolve(file).toLowerCase());
    if (!asset) throw new StudioError('Keo could not read the AI clip.');
    this.learn(id, asset.id, { aiMade: true, about: o.about.slice(0, 300), ...(o.recipe ? { aiRecipe: o.recipe } : {}) });
    const from = Math.min(o.in ?? 0, Math.max(0, asset.duration - 0.1));
    // A new take of a shot goes in the old one's place (its timing, effects and track kept).
    if (o.replace && asset.kind === 'video') {
      const old = findClip(this.get(id), o.replace)?.clip;
      if (old && old.type === 'media') {
        const r = this.edit(id, [{ op: 'replace_media', clip: old.id, assetId: asset.id, in: 0 }]);
        const done = o.muted ? this.mergeLast(id, { op: 'set', clip: old.id, volume: 0 }) : r;
        return { project: done.project, asset, clip: old.id };
      }
    }
    // AI music and sound effects go on an audio track (music under the speech).
    if (asset.kind === 'audio') {
      const r = this.edit(id, [{ op: 'add_audio', assetId: asset.id, trackName: o.trackName ?? 'Music', start: Math.max(0, o.at), in: from, duration: Math.min(o.duration ?? o.seconds, asset.duration - from), volume: o.volume ?? 1, ...(o.duck !== undefined ? { duck: o.duck } : {}) }]);
      const clip = r.project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'audio' && c.assetId === asset.id).at(-1)!;
      return { project: r.project, asset, clip: clip.id };
    }
    const r = this.edit(id, [{ op: 'add_media', assetId: asset.id, trackName: o.trackName ?? 'AI shots', start: Math.max(0, o.at), in: from, duration: Math.min(o.duration ?? o.seconds, asset.duration - from), fit: 'cover' }]);
    const clip = r.project.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media' && c.assetId === asset.id).at(-1)!;
    // A swapped video is silent over the original, whose sound carries on underneath (one undo).
    const done = o.muted ? this.mergeLast(id, { op: 'set', clip: clip.id, volume: 0 }) : r;
    return { project: done.project, asset, clip: clip.id };
  }

  /**
   * What is wrong with an AI video file, or null: it must be a video of at least half the length
   * asked for (models round to their own lengths) and at least 240 pixels on its short side.
   * Pictures, sounds and files Keo cannot measure here are left to the import.
   */
  async aiClipProblem(file: string, seconds: number): Promise<string | null> {
    if (!/\.(mp4|mov|webm)$/i.test(file) || !fs.existsSync(file)) return null;
    const p = await this.probeFile(file, 'video').catch(() => null);
    if (!p) return null;
    if (p.kind !== 'video' || !p.width || !p.height) return 'it has no picture';
    if (seconds > 0 && p.duration < Math.max(0.5, seconds * 0.5)) return `it lasts ${p.duration.toFixed(1)} s instead of about ${Math.round(seconds)} s`;
    if (Math.min(p.width, p.height) < 240) return `it is only ${p.width}×${p.height} pixels`;
    return null;
  }

  // ---------------------------------------------------------------- colour LUTs

  private lutDir(): string {
    return path.join(this.d.dir, 'luts');
  }

  /** The LUTs the user imported (their names), A to Z. */
  luts(): string[] {
    const dir = this.lutDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.cube'))
      .map((f) => f.slice(0, -5))
      .filter((n) => LUT_NAME.test(n))
      .sort();
  }

  /** Keeps a .cube LUT for all projects (checked first; a LUT of the same name is replaced). */
  importLut(file: string): { name: string; size: number } {
    if (!/\.cube$/i.test(file)) throw new StudioError('Choose a .cube file (the LUT format editors and cameras use).');
    let text: string;
    try {
      const st = fs.statSync(file);
      if (st.size > 40 * 1024 * 1024) throw new StudioError('That LUT file is too large (over 40 MB).');
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e instanceof StudioError) throw e;
      throw new StudioError('Keo could not read that file.');
    }
    let size: number;
    try {
      size = parseCube(text).size;
    } catch (e) {
      throw new StudioError(`That LUT cannot be used: ${e instanceof Error ? e.message : String(e)}`);
    }
    const name = lutNameOf(path.basename(file));
    fs.mkdirSync(this.lutDir(), { recursive: true });
    fs.writeFileSync(path.join(this.lutDir(), `${name}.cube`), text);
    this.d.log.info('studio.lut_imported', { size });
    return { name, size };
  }

  /** A LUT's text, by name (never a path from outside). */
  lutText(name: string): string {
    if (!LUT_NAME.test(name)) throw new StudioError('That is not a LUT name.');
    const f = path.join(this.lutDir(), `${name}.cube`);
    if (!fs.existsSync(f)) throw new StudioError(`There is no LUT called "${name}". Import it again in the Adjust tab.`);
    return fs.readFileSync(f, 'utf8');
  }

  /** What Keo saw in a media file, kept with it. */
  noteAsset(id: string, assetId: string, about: string): Project {
    if (!this.get(id).assets.some((a) => a.id === assetId)) throw new StudioError('That media is not in this project.');
    return this.learn(id, assetId, { about: about.trim().slice(0, 300) });
  }

  /** Keo's self-review: what is wrong with the edit (text over a face, cut off, overlapping, too fast). */
  async review(id: string): Promise<ReviewIssue[]> {
    const p = this.get(id);
    // The same edit checked a moment ago: the same answer, at once.
    const last = this.reviews.get(id);
    if (last && last.updatedAt === p.updatedAt) return last.issues;
    const times = reviewTimes(p);
    if (!times.length) return [];
    const samples = await this.runJob<ReviewSample[]>({ kind: 'review', projectId: id, times }, 5 * 60_000);
    const issues = reviewEdit(p, samples);
    this.reviews.set(id, { updatedAt: p.updatedAt, issues });
    this.d.log.info('studio.review', { samples: samples.length, issues: issues.length });
    return issues;
  }
  private reviews = new Map<string, { updatedAt: string; issues: ReviewIssue[] }>();

  /**
   * Fixes what the check found (all it can be sure of, or only the issues named by key) in ONE
   * edit (one undo, played live), then checks again. Issues without a sure fix stay listed.
   */
  async fixReview(id: string, keys?: string[]): Promise<{ fixed: number; issues: ReviewIssue[] }> {
    const issues = await this.review(id);
    const chosen = keys?.length ? issues.filter((i) => keys.includes(issueKey(i))) : issues;
    const r = fixIssues(this.get(id), chosen);
    const ops = r.fixed.flatMap((i) => i.ops ?? []);
    if (ops.length) this.edit(id, ops);
    this.d.log.info('studio.review_fixed', { fixed: r.fixed.length, left: r.skipped.length });
    return { fixed: r.fixed.length, issues: await this.review(id) };
  }

  /** A project's spoken words on its timeline (spelled the user's way). */
  wordsOf(id: string): ReturnType<typeof timelineWords> {
    return this.spokenWords(this.get(id));
  }

  /** The timeline's spoken words, spelled the way the user writes them (their brand kit's spellings). */
  private spokenWords(p: Project): ReturnType<typeof timelineWords> {
    return respell(timelineWords(p), this.brand().spellings);
  }

  // ---------------------------------------------------------------- characters

  private get charactersDir(): string {
    return path.join(this.d.dir, 'library', 'characters');
  }
  /** The user's characters (for every project), oldest first. */
  characters(): Character[] {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.charactersDir, 'characters.json'), 'utf8')) as unknown[];
      return raw.flatMap((c) => {
        const r = Character.safeParse(c);
        // Pictures that are gone (deleted outside Keo) drop out.
        return r.success ? [{ ...r.data, pictures: r.data.pictures.filter((f) => fs.existsSync(f)) }] : [];
      });
    } catch {
      return [];
    }
  }
  character(id: string): Character {
    const c = this.characters().find((x) => x.id === id);
    if (!c) throw new StudioError('That character is not saved.');
    return c;
  }
  private saveCharacters(list: Character[]): void {
    fs.mkdirSync(this.charactersDir, { recursive: true });
    const file = path.join(this.charactersDir, 'characters.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(list));
    fs.renameSync(`${file}.tmp`, file);
  }
  /** Adds a character (no id) or changes one. */
  saveCharacter(patch: CharacterPatch): Character {
    const list = this.characters();
    const name = patch.name?.trim();
    if (name && list.some((c) => c.id !== patch.id && c.name.toLowerCase() === name.toLowerCase())) throw new StudioError(`There is already a character called ${name}.`);
    let next: Character;
    if (patch.id) {
      const old = list.find((c) => c.id === patch.id);
      if (!old) throw new StudioError('That character is not saved.');
      next = Character.parse({ ...old, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    } else {
      if (!name) throw new StudioError('A new character needs a name.');
      if (list.length >= 50) throw new StudioError('Keo keeps up to 50 characters: remove one first.');
      next = Character.parse({ id: `ch_${crypto.randomBytes(6).toString('base64url').replace(/[-_]/g, 'x').slice(0, 10)}`, ...patch, name, createdAt: new Date().toISOString() });
    }
    if (next.voice === 'own' && !next.voiceSample) throw new StudioError(`Add ${next.name}’s own voice first (upload, record or design it), or choose another voice.`);
    this.saveCharacters([...list.filter((c) => c.id !== next.id), next].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    this.d.log.info('studio.character_saved', { pictures: next.pictures.length });
    return next;
  }
  deleteCharacter(id: string): void {
    const list = this.characters();
    if (!list.some((c) => c.id === id)) throw new StudioError('That character is not saved.');
    this.saveCharacters(list.filter((c) => c.id !== id));
    fs.rmSync(path.join(this.charactersDir, id), { recursive: true, force: true });
  }
  /** A picture of a character, copied into Keo's folder (so moving the original does not lose it). */
  addCharacterPicture(id: string, file: string): Character {
    const c = this.character(id);
    if (c.pictures.length >= 4) throw new StudioError('A character can have up to 4 pictures: remove one first.');
    const ext = path.extname(file).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new StudioError('Choose a picture (JPG, PNG or WebP).');
    if (!fs.existsSync(file)) throw new StudioError('That picture is not there any more.');
    const dir = path.join(this.charactersDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const copy = path.join(dir, `${Date.now().toString(36)}${ext}`);
    fs.copyFileSync(file, copy);
    const next = Character.parse({ ...c, pictures: [...c.pictures, copy] });
    this.saveCharacters(this.characters().map((x) => (x.id === id ? next : x)));
    return next;
  }
  removeCharacterPicture(id: string, picture: string): Character {
    const c = this.character(id);
    if (!c.pictures.includes(picture)) throw new StudioError('That picture is not one of this character’s.');
    const next = Character.parse({ ...c, pictures: c.pictures.filter((p) => p !== picture) });
    this.saveCharacters(this.characters().map((x) => (x.id === id ? next : x)));
    // Only Keo's own copy is deleted.
    if (path.resolve(picture).startsWith(path.resolve(this.charactersDir) + path.sep)) fs.rmSync(picture, { force: true });
    return next;
  }

  /**
   * A character's own voice: a recording (WAV or MP3) kept in Keo's folder, and their voice set to
   * it. A sample Keo kept before is removed.
   */
  setCharacterVoice(id: string, audio: Buffer, o: { ext: 'wav' | 'mp3'; about?: string }): Character {
    const c = this.character(id);
    if (audio.length < 4000) throw new StudioError('That recording is too short: 5 to 30 seconds of the voice talking works best.');
    if (audio.length > 15 * 1024 * 1024) throw new StudioError('That recording is too big: use 30 seconds or less.');
    const dir = path.join(this.charactersDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `voice-${Date.now().toString(36)}.${o.ext}`);
    fs.writeFileSync(file, audio);
    const next = Character.parse({ ...c, voice: 'own', voiceSample: file, ...(o.about ? { voiceAbout: o.about } : { voiceAbout: undefined }) });
    this.saveCharacters(this.characters().map((x) => (x.id === id ? next : x)));
    if (c.voiceSample && path.resolve(c.voiceSample).startsWith(path.resolve(this.charactersDir) + path.sep)) fs.rmSync(c.voiceSample, { force: true });
    this.d.log.info('studio.character_voice', { designed: !!o.about });
    return next;
  }
  /** Back to a ready-made voice: the sample is removed. */
  removeCharacterVoice(id: string): Character {
    const c = this.character(id);
    const { voiceSample, voiceAbout: _about, ...rest } = c;
    const next = Character.parse({ ...rest, voice: c.voice === 'own' ? 'female' : c.voice });
    this.saveCharacters(this.characters().map((x) => (x.id === id ? next : x)));
    if (voiceSample && path.resolve(voiceSample).startsWith(path.resolve(this.charactersDir) + path.sep)) fs.rmSync(voiceSample, { force: true });
    return next;
  }

  /** Keeps a logo, intro or outro in the brand kit (a copy in Studio's library; the old one is replaced). */
  setBrandFile(kind: BrandFileKind, file: string): Brand {
    const k = kindOfFile(file);
    if (kind === 'logo' ? k !== 'image' : k !== 'video' && k !== 'image') throw new StudioError(kind === 'logo' ? 'A logo is a picture: choose a PNG (best with a clear background), JPG or WebP.' : `An ${kind} is a short video or a picture.`);
    const lib = path.join(this.d.dir, 'library');
    fs.mkdirSync(lib, { recursive: true });
    for (const f of fs.readdirSync(lib)) if (f.startsWith(`brand-${kind}.`)) fs.rmSync(path.join(lib, f), { force: true });
    const name = `brand-${kind}${path.extname(file).toLowerCase()}`;
    fs.copyFileSync(file, path.join(lib, name));
    return this.setBrand({ [kind]: name });
  }

  /** Where a brand kit file is on this PC (null when none is saved). */
  brandFile(kind: BrandFileKind): string | null {
    const name = this.brand()[kind];
    const f = name ? path.join(this.d.dir, 'library', name) : null;
    return f && fs.existsSync(f) ? f : null;
  }

  /**
   * Puts the brand's logo, intro or outro into a project: the logo small in the top corner for the
   * whole video, the intro at the start (everything else moves later), the outro after the end.
   */
  async useBrand(id: string, kind: BrandFileKind): Promise<{ project: Project; changes: string[] }> {
    const file = this.brandFile(kind);
    if (!file) throw new StudioError(`There is no ${kind} in your brand kit yet: add one in Details → Brand kit.`);
    const imported = await this.importFiles(id, [file]);
    const asset = imported.added[0] ?? imported.project.assets.find((a) => path.resolve(a.path).toLowerCase() === path.resolve(file).toLowerCase());
    if (!asset) throw new StudioError(`Keo could not read the ${kind} file.`);
    const p = this.get(id);
    const length = asset.kind === 'image' ? (kind === 'logo' ? 0 : 2.5) : Math.max(0.5, asset.duration);
    if (kind === 'logo') {
      const total = Math.max(1, projectDuration(p));
      return this.edit(id, [{ op: 'add_media', assetId: asset.id, start: 0, duration: total, trackName: 'Logo', fit: 'contain', transform: { x: 0.88, y: 0.09, scale: 0.16, rotation: 0, opacity: 0.95 } }]);
    }
    if (kind === 'outro') return this.edit(id, [{ op: 'add_media', assetId: asset.id, start: projectDuration(p), duration: length }]);
    // The intro: every clip moves later by its length, then it goes first on the bottom video track.
    const later: EditOp[] = p.tracks.flatMap((t) => [...t.clips].sort((a, b) => b.start - a.start).map((c) => ({ op: 'move' as const, clip: c.id, start: c.start + length })));
    const base = p.tracks.find((t) => t.kind === 'video');
    return this.edit(id, [...later, { op: 'add_media', assetId: asset.id, start: 0, duration: length, ...(base ? { track: base.id } : {}) }]);
  }

  /** The user's brand kit (for every project). */
  brand(): Brand {
    try {
      return Brand.parse(JSON.parse(fs.readFileSync(path.join(this.d.dir, 'library', 'brand.json'), 'utf8')));
    } catch {
      return {};
    }
  }
  setBrand(patch: BrandPatch): Brand {
    let next: Brand;
    try {
      next = patchBrand(this.brand(), patch);
    } catch {
      throw new StudioError('That brand kit value is not valid.');
    }
    const file = path.join(this.d.dir, 'library', 'brand.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next));
    fs.renameSync(`${file}.tmp`, file);
    this.d.log.info('studio.brand_saved', { fields: Object.keys(next).length });
    return next;
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
  async learnTemplate(id: string, assetId: string, o: { name?: string; seen?: Partial<Pick<Recipe, 'captions' | 'look' | 'transition' | 'notes' | 'moments' | 'style'>> & { endCard?: Partial<Recipe['endCard']>; shotKinds?: ShotKind[] } } = {}): Promise<Recipe> {
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
      ...(o.seen?.moments?.length ? { moments: o.seen.moments.filter((m) => m.at >= 0 && m.at <= a.duration).slice(0, 60) } : {}),
      ...(o.seen?.style ? { style: o.seen.style } : {}),
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
  /**
   * One of Keo's editing styles on the talking video, in one edit (one undo). Uses the transcript
   * when there is one (pop words, captions); nothing leaves the PC.
   */
  applyStyle(id: string, style: StyleId, given: Omit<StyleOptions, 'words' | 'lines'> = {}): { project: Project; stressed: string[]; captions: number; needsWords: boolean } {
    const p = this.get(id);
    // What the user did not say comes from their brand kit.
    const b = this.brand();
    const o = { ...(b.handle ? { handle: b.handle } : {}), ...(b.endText ? { endText: b.endText } : {}), ...(b.accent ? { accent: b.accent } : {}), ...given };
    const words = this.spokenWords(p);
    // Stacked captions show two or three words at a time.
    const lines = words.length ? captionLines(words, { maxWords: style === 'bold-stack' ? 3 : 4 }) : [];
    const stressed = o.emphasis?.length ? o.emphasis : guessEmphasis(words);
    const make = (q: Project, sfx?: StyleOptions['sfx']) => {
      try {
        return styleOps(q, style, { ...o, emphasis: stressed, words, lines, ...(sfx ? { sfx } : {}) });
      } catch (e) {
        throw e instanceof StyleError ? new StudioError(e.message) : e;
      }
    };
    // Checked first (no talking video: nothing changes), then Keo's own pop and whoosh (made on this PC).
    make(p);
    const sfx = o.sfx ?? { pop: this.soundEffect(id, 'pop').asset.id, whoosh: this.soundEffect(id, 'whoosh').asset.id };
    const ops = make(this.get(id), sfx);
    const r = this.edit(id, ops);
    this.d.log.info('studio.style', { style, words: words.length, stressed: stressed.length });
    return { project: r.project, stressed, captions: style === 'podcast-frame' ? 0 : lines.length, needsWords: !words.length };
  }

  /**
   * The motion edit on the whole talking video, in one edit (one undo): camera moves on the
   * footage, full-screen keyword scenes, the speaker framed beside graphics, graphics off the face,
   * whooshes and pops. Keo's beats when given, else its own plan from the speech. Making it again
   * replaces it. Needs the transcript (the edit lands on the words).
   */
  async motionEdit(id: string, given: Omit<MotionEditOptions, 'words' | 'people' | 'sfx'> & { sounds?: boolean } = {}): Promise<{ project: Project; placed: Array<{ kind: BeatKind; at: number; text: string }>; missed: string[] }> {
    const p = this.get(id);
    const words = this.spokenWords(p);
    if (!words.length) throw new StudioError('The speech is not transcribed yet: transcribe it first (studio__transcript), then make the motion edit.');
    const b = this.brand();
    const { sounds, ...o } = given;
    const beats = o.beats?.length ? o.beats : planBeats(words, o.energy ?? 'normal');
    // Where the speaker is (found on this PC), so graphics keep off the face and punch-ins aim at it.
    let people: MotionEditOptions['people'] = [];
    try {
      const samples = await this.runJob<ReviewSample[]>({ kind: 'review', projectId: id, times: lookTimes(words, beats) }, 3 * 60_000);
      people = samples.map((x) => ({ t: x.t, box: x.person }));
    } catch (e) {
      this.d.log.warn('studio.motion_edit_people', { error: e instanceof Error ? e.message : String(e) });
    }
    const opts: MotionEditOptions = { ...(b.accent ? { accent: b.accent } : {}), ...o, beats, words, people };
    try {
      motionEditOps(p, opts);
    } catch (e) {
      throw e instanceof MotionEditError ? new StudioError(e.message) : e;
    }
    const sfx = sounds === false ? {} : { whoosh: this.soundEffect(id, 'whoosh').asset.id, pop: this.soundEffect(id, 'pop').asset.id };
    const built = motionEditOps(this.get(id), { ...opts, sfx });
    const r = this.edit(id, built.ops);
    this.d.log.info('studio.motion_edit', { beats: beats.length, placed: built.placed.length, missed: built.missed.length, people: people.filter((x) => x.box).length });
    return { project: r.project, placed: built.placed, missed: built.missed };
  }

  /** Black bars baked into a video's picture (shares of each edge), measured on this PC; none when it cannot be measured. */
  async videoBars(id: string, assetId: string): Promise<{ left: number; top: number; right: number; bottom: number }> {
    const a = this.get(id).assets.find((x) => x.id === assetId);
    const none = { left: 0, top: 0, right: 0, bottom: 0 };
    if (!a || a.kind !== 'video' || a.duration <= 0) return none;
    try {
      const times = [0.15, 0.35, 0.55, 0.75, 0.9].map((f) => Math.round(a.duration * f * 100) / 100);
      return await this.runJob<typeof none>({ kind: 'bars', projectId: id, assetId, times }, 60_000);
    } catch {
      return none;
    }
  }

  /**
   * The user's screenshots and clips as glass cards at the moments they talk about them: where the
   * speaker is at each moment is measured on this PC, so every card lands in the free space beside
   * (or above and below) them, clear of the captions. Made again each time, one undo.
   */
  async cutaways(id: string, moments: CutawayMoment[], o: { whoosh?: boolean } = {}): Promise<{ project: Project; placed: ReturnType<typeof cutawayOps>['placed']; measured: boolean }> {
    if (!moments.length) throw new StudioError('No moments to place.');
    let people: CutawayPerson[] = [];
    try {
      const times = moments.map((m) => Math.round((m.at + 0.8) * 100) / 100);
      const samples = await this.runJob<ReviewSample[]>({ kind: 'review', projectId: id, times }, 3 * 60_000);
      people = samples.map((x) => ({ t: x.t, box: x.person }));
    } catch (e) {
      this.d.log.warn('studio.cutaways_people', { error: e instanceof Error ? e.message : String(e) });
    }
    const whoosh = o.whoosh === false ? null : this.soundEffect(id, 'whoosh').asset.id;
    const plan = cutawayOps(this.get(id), moments, { whoosh, people });
    if (!plan.placed.length) throw new StudioError('None of those are pictures or videos of this project.');
    const r = this.edit(id, plan.ops);
    this.d.log.info('studio.cutaways', { placed: plan.placed.length, measured: people.filter((x) => x.box).length });
    return { project: r.project, placed: plan.placed, measured: people.some((x) => x.box) };
  }

  /**
   * Where the speaker's face is (top and bottom, fractions of the frame) across a few moments of
   * the timeline, measured on this PC; null when no one was found.
   */
  async faceBand(id: string, times: number[]): Promise<{ y0: number; y1: number } | null> {
    try {
      const samples = await this.runJob<ReviewSample[]>({ kind: 'review', projectId: id, times }, 2 * 60_000);
      const faces = samples.map((s) => (s.person ? faceOf(s.person) : null)).filter((f): f is NonNullable<typeof f> => !!f);
      if (!faces.length) return null;
      const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      return { y0: Math.round(mid(faces.map((f) => f.y0)) * 1000) / 1000, y1: Math.round(mid(faces.map((f) => f.y1)) * 1000) / 1000 };
    } catch {
      return null;
    }
  }

  /** Where the speaker is in the talking video at time t (null: no one found, or it could not be measured). */
  private async personAt(id: string, t: number): Promise<ReviewSample['person']> {
    try {
      const [sample] = await this.runJob<ReviewSample[]>({ kind: 'review', projectId: id, times: [t] }, 60_000);
      return sample?.person ?? null;
    } catch {
      return null;
    }
  }

  /** A moment (text behind the speaker, a word card, a split, a picture popping in), in one edit. */
  /**
   * A viral template on the user's talking video: its motion edit (from their own words), its hook,
   * and the brand end card when the video has none. Making it again replaces the last one.
   */
  async viral(id: string, template: ViralId, o: { hook?: string } = {}): Promise<{ project: Project; placed: Array<{ kind: BeatKind; at: number; text: string }>; missed: string[]; note: string | null; endCard: boolean }> {
    const words = this.spokenWords(this.get(id));
    if (!words.length) throw new StudioError('The speech is not transcribed yet: transcribe it first, then use a template.');
    const plan = viralPlan(template, words, o);
    const r = await this.motionEdit(id, { beats: plan.beats, look: plan.look, energy: plan.energy, ...(plan.hook ? { hook: plan.hook } : {}) });
    // The end card: the brand's @handle, right where the video ends (not twice).
    const b = this.brand();
    const p = this.get(id);
    const hasEnd = p.tracks.some((t) => t.name === 'Card words' && t.clips.length > 0);
    let endCard = false;
    if (!hasEnd && (b.handle || b.name)) {
      const end = projectDuration(p);
      await this.moment(id, 'follow-card', { at: end, duration: 2.5 }).then(() => (endCard = true)).catch(() => undefined);
    }
    this.d.log.info('studio.viral', { template, beats: plan.beats.length, placed: r.placed.length, endCard });
    return { project: this.get(id), placed: r.placed, missed: r.missed, note: plan.note ?? null, endCard };
  }

  async moment(id: string, moment: MomentId, given: MomentOptions): Promise<{ project: Project; changes: string[] }> {
    // The end card's name and colour come from the brand kit when not given.
    const b = this.brand();
    let o = moment === 'follow-card' ? { ...given, text: given.text ?? b.handle ?? b.name, ...(given.color || !b.accent ? {} : { color: b.accent }) } : given;
    if (moment === 'follow-card' && !o.text) throw new StudioError('The follow card needs the user’s @handle or name: ask them (and offer to remember it with studio__brand).');
    // A picture popping in keeps off the speaker's face: where they are then, found on this PC.
    if (moment === 'image-pop' && o.person === undefined) o = { ...o, person: await this.personAt(id, o.at + 0.3) };
    let ops: EditOp[];
    try {
      ops = momentOps(this.get(id), moment, o);
    } catch (e) {
      throw e instanceof MomentNeeds ? new StudioError(e.message) : e;
    }
    const r = this.edit(id, ops);
    this.d.log.info('studio.moment', { moment });
    return { project: r.project, changes: r.changes };
  }

  async applyTemplate(
    id: string,
    recipeId: string,
    o: { main?: string; cutaways?: string[]; endText?: string; music?: string | null; whooshes?: boolean } = {},
  ): Promise<{ project: Project; cutaways: number; captions: boolean; music: string | null; needsWords: boolean; moments: number; askFor: Array<{ moment: MomentId; at: number; needs: string }> }> {
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
    const words = this.spokenWords(p).filter((w) => w.start >= start - 0.05 && w.end <= end + 0.05);
    const built = recipeOps(r, { main: { clip: mainClips[0]!.id, start, duration: end - start }, cutaways, words, endText: o.endText ?? r.endCard.text });
    const hasMoments = !!r.moments?.length || !!r.style;
    if (!built.ops.length && !hasMoments) throw new StudioError('There is nothing in this project the template can use: add screen recordings or other clips to cut to.');
    // Using a template again replaces what it made before (its B-roll and end card).
    const before: EditOp[] = p.tracks.filter((t) => (t.name === 'B-roll' || t.name === 'End card') && !t.locked).flatMap((t) => t.clips.map((c) => ({ op: 'delete' as const, clip: c.id })));
    let res = built.ops.length || before.length ? this.edit(id, [...before, ...built.ops]) : { project: p, changes: [] as string[] };
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
    // The template's look as a Keo style, then its moments at the same points of the story.
    if (r.style) res = { project: this.applyStyle(id, r.style, o.endText ? { endText: o.endText } : {}).project, changes: [] };
    const tplSeconds = r.seconds - (r.endCard.on ? r.endCard.seconds : 0);
    const placed = r.moments?.length ? placeMoments(r.moments, tplSeconds, { start, duration: end - start }, words) : { place: [], ask: [], skipped: 0 };
    let moments = 0;
    const brand = this.brand();
    for (const m of placed.place) {
      if (m.moment === 'follow-card' && !brand.handle && !brand.name && !o.endText) {
        placed.ask.push({ moment: m.moment, at: m.at, needs: 'your @handle or name for the end card' });
        continue;
      }
      try {
        res = await this.moment(id, m.moment, { at: m.at, ...(m.text ? { text: m.text } : m.moment === 'follow-card' && o.endText && !brand.handle && !brand.name ? { text: o.endText } : {}) });
        moments++;
      } catch (e) {
        // One moment that does not fit (the video ends there) does not stop the others.
        if (!(e instanceof StudioError)) throw e;
      }
    }
    this.d.log.info('studio.template_used_recipe', { cutaways: built.cutawayStarts.length, music: !!music, moments, ask: placed.ask.length });
    return { project: res.project, cutaways: built.cutawayStarts.length, captions: r.captions.on && words.length > 0, music, needsWords: (r.captions.on || placed.skipped > 0) && words.length === 0, moments, askFor: placed.ask };
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
    const videos = p.assets.filter((a) => a.kind === 'video' && (assetIds ? assetIds.includes(a.id) : Math.max(a.width, a.height) > StudioService.BIG) && !this.goodCopy(a));
    let made = 0;
    for (const a of videos) {
      const file = path.join(this.d.dir, 'made', `preview-${a.id}.mp4`);
      // A copy cut short (Keo closed or restarted while making it) is made again.
      if (fs.existsSync(file) && !this.goodCopy({ ...a, proxy: file })) fs.rmSync(file, { force: true });
      if (!fs.existsSync(file)) {
        // 540p at 25 fps: cheap to make and to play even on a 2-core laptop, sharp enough to edit by.
        // A strong PC gets a sharper copy; a lighter one a copy it can make and play quickly.
        const short = this.strongPc() ? 720 : 540;
        const k = short / Math.max(1, Math.min(a.width || 1080, a.height || 1920));
        const width = Math.max(16, Math.round(((a.width || 1080) * Math.min(1, k)) / 2) * 2);
        const height = Math.max(16, Math.round(((a.height || 1920) * Math.min(1, k)) / 2) * 2);
        const fps = Math.min(this.strongPc() ? 30 : 25, p.fps);
        const tmp = Project.parse({ ...newProject({ name: `${a.name} preview`, rand: () => crypto.randomBytes(6).toString('hex').slice(0, 10) }), width, height, fps, background: '#000000', assets: [a] });
        const one = applyEdits(tmp, [{ op: 'add_media', assetId: a.id, start: 0, duration: Math.max(0.04, a.duration), fit: 'contain' }]).project;
        fs.writeFileSync(this.file(one.id), JSON.stringify(one));
        const exportId = `ex_${crypto.randomBytes(6).toString('hex')}`;
        // Written under another name and renamed only when complete: a half-made copy is never used.
        const part = `${file}.part.mp4`;
        fs.mkdirSync(path.dirname(part), { recursive: true });
        fs.rmSync(part, { force: true });
        this.exportTargets.set(exportId, part);
        try {
          await this.runJob({ kind: 'export', projectId: one.id, exportId, size: { width, height, fps, quality: 'standard', patient: true } }, 2 * 60 * 60 * 1000);
          if (fs.existsSync(part)) fs.renameSync(part, file);
          if (!this.goodCopy({ ...a, proxy: file })) {
            fs.rmSync(file, { force: true });
            throw new StudioError('The preview copy came out unreadable.');
          }
        } catch (e) {
          fs.rmSync(part, { force: true });
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

  /** The picture at `time` as PNG bytes, full size (for AI work on what the video shows). */
  async framePng(id: string, time: number): Promise<Buffer> {
    const p = this.get(id);
    if (projectDuration(p) === 0) throw new StudioError('The timeline is empty.');
    const f = (await this.runJob<Array<{ time: number; pngBase64: string }>>({ kind: 'frames', projectId: id, times: [Math.max(0, Math.min(time, projectDuration(p) - 0.02))], width: p.width }, 120_000))[0];
    if (!f) throw new StudioError('The frame could not be drawn.');
    return Buffer.from(f.pngBase64, 'base64');
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
    if (o.format === 'mov' || o.format === 'webm') this.exportContainer.set(exportId, o.format);
    this.running.set(id, exportId);
    if (o.format === 'gif' || o.format === 'wav') return await this.exportFileAs(id, exportId, o.format, o.name).finally(() => {
      if (this.running.get(id) === exportId) this.running.delete(id);
    });
    const size = { ...exportSize(p, o), quality: o.quality, video: exportVideoCodec(o) };
    // A new export replaces one that stopped part way.
    this.discardResume(id);
    if (o.format !== 'webm') this.resumablePlans.set(exportId, { exportId, projectId: id, file: '', part: '', journal: path.join(this.resumeDir, `${id}.journal`), size, fingerprint: projectFingerprint(p), stoppedAt: null });
    return await this.runExportJob(id, exportId, size);
  }

  /** Runs an export in the render window; if it stops part way (not by the user), what is made is kept to resume. */
  private async runExportJob(id: string, exportId: string, size: NonNullable<Extract<RenderJob, { kind: 'export' }>['size']>): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
    try {
      const r = await this.runJob<{ file: string; durationSec: number; frames: number; bytes: number }>({ kind: 'export', projectId: id, exportId, size }, 6 * 60 * 60 * 1000);
      this.d.log.info('studio.exported', { seconds: r.durationSec, frames: r.frames, resumed: Boolean(size.from) });
      this.rememberExport(id, r.file);
      return r;
    } catch (e) {
      // The renderer stopped answering or closed: the writer is still open here.
      if (this.exports.has(exportId)) this.abortExport(exportId);
      if (this.running.get(id) === exportId) this.running.delete(id);
      const kept = this.resumable(id);
      if (kept && !this.cancelled.has(exportId)) throw new StudioError(`${e instanceof Error ? e.message : 'The export stopped.'} What was made so far (${Math.round((kept.done / Math.max(1, kept.total)) * 100)}%) is kept: Resume carries on from there.`);
      throw e;
    } finally {
      this.exportNames.delete(exportId);
      this.exportContainer.delete(exportId);
      this.resumablePlans.delete(exportId);
      this.cancelled.delete(exportId);
      if (this.running.get(id) === exportId) this.running.delete(id);
    }
  }

  // ---------------------------------------------------------------- resuming a stopped export

  private get resumeDir(): string {
    return path.join(this.d.dir, 'resume');
  }
  private resumeFile(id: string): string {
    return path.join(this.resumeDir, `${id}.json`);
  }
  private readResume(id: string): ResumeRecord | null {
    try {
      return JSON.parse(fs.readFileSync(this.resumeFile(id), 'utf8')) as ResumeRecord;
    } catch {
      return null;
    }
  }
  private writeResume(r: ResumeRecord): void {
    fs.mkdirSync(this.resumeDir, { recursive: true });
    fs.writeFileSync(this.resumeFile(r.projectId), JSON.stringify(r));
  }

  /** An export of this project that stopped part way and can carry on (null: none). */
  resumable(id: string): { done: number; total: number; name: string; changed: boolean } | null {
    const r = this.readResume(id);
    if (!r || this.running.get(id)) return null;
    if (!fs.existsSync(r.part) || !fs.existsSync(r.journal)) {
      this.discardResume(id);
      return null;
    }
    const frames = countKept(r.journal);
    if (!frames) return null;
    let p: Project;
    try {
      p = this.get(id);
    } catch {
      this.discardResume(id);
      return null;
    }
    return { done: frames, total: Math.max(frames, Math.ceil(projectDuration(p) * r.size.fps - 1e-6)), name: path.basename(r.file), changed: projectFingerprint(p) !== r.fingerprint };
  }

  /** Carries on a stopped export from its last key frame (the frames before it are not made again). */
  async resumeExport(id: string): Promise<{ file: string; durationSec: number; frames: number; bytes: number }> {
    const r = this.readResume(id);
    const p = this.get(id);
    if (!r || this.running.get(id)) throw new StudioError('There is no stopped export of this video to carry on.');
    if (projectFingerprint(p) !== r.fingerprint) throw new StudioError('The video was changed after the export stopped, so the part made would not match: export it again.');
    const w = fs.existsSync(r.part) ? Mp4Writer.resume(r.part, r.journal) : null;
    if (!w) {
      this.discardResume(id);
      throw new StudioError('Too little of the stopped export was kept to carry on: export it again.');
    }
    const exportId = `ex_${crypto.randomBytes(6).toString('hex')}`;
    const rec: ResumeRecord = { ...r, exportId, stoppedAt: null };
    this.resumablePlans.set(exportId, rec);
    this.writeResume(rec);
    this.exports.set(exportId, { writer: w.writer, file: r.file, part: r.part, projectId: id });
    this.running.set(id, exportId);
    this.d.log.info('studio.export_resume', { from: w.point.frames, seconds: w.point.timeUs / 1e6 });
    return await this.runExportJob(id, exportId, { ...r.size, from: w.point.frames });
  }

  /** Throws away a stopped export's part file. */
  discardResume(id: string): void {
    const r = this.readResume(id);
    if (!r) return;
    if (this.running.get(id) === r.exportId) return;
    fs.rmSync(r.part, { force: true });
    fs.rmSync(r.journal, { force: true });
    fs.rmSync(this.resumeFile(id), { force: true });
  }

  private get showcasesFile(): string {
    return path.join(this.d.dir, 'library', 'showcases.json');
  }
  /** What a screen showcase was made from (so it can be remade in place: new words, voice or order). */
  rememberShowcase(id: string, rec: ShowcaseRecord): void {
    let all: Record<string, ShowcaseRecord>;
    try {
      all = JSON.parse(fs.readFileSync(this.showcasesFile, 'utf8')) as Record<string, ShowcaseRecord>;
    } catch {
      all = {};
    }
    all[id] = rec;
    fs.mkdirSync(path.dirname(this.showcasesFile), { recursive: true });
    fs.writeFileSync(this.showcasesFile, JSON.stringify(all));
  }
  /** The showcase this project is, or null (its screens and clips still in the project). */
  showcaseOf(id: string): ShowcaseRecord | null {
    try {
      const r = (JSON.parse(fs.readFileSync(this.showcasesFile, 'utf8')) as Record<string, ShowcaseRecord>)[id];
      const p = this.get(id);
      if (r && Array.isArray(r.scenes) && r.scenes.every((sc) => p.assets.some((a) => a.id === sc.screen))) return r;
    } catch {
      /* no record: read it from the timeline */
    }
    try {
      return showcaseFromTimeline(this.get(id));
    } catch {
      return null;
    }
  }

  private get exportsFile(): string {
    return path.join(this.d.dir, 'library', 'exports.json');
  }
  /** The last video exported from each project (to post it later). */
  private rememberExport(id: string, file: string): void {
    let all: Record<string, string>;
    try {
      all = JSON.parse(fs.readFileSync(this.exportsFile, 'utf8')) as Record<string, string>;
    } catch {
      all = {};
    }
    all[id] = file;
    fs.mkdirSync(path.dirname(this.exportsFile), { recursive: true });
    fs.writeFileSync(this.exportsFile, JSON.stringify(all));
  }
  /** The project's latest exported video still on disk, or null. */
  lastExport(id: string): string | null {
    try {
      const f = (JSON.parse(fs.readFileSync(this.exportsFile, 'utf8')) as Record<string, string>)[id];
      return f && fs.existsSync(f) ? f : null;
    } catch {
      return null;
    }
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

  /** Exports to be written as QuickTime .mov or WebM (the rest are MP4). */
  private readonly exportContainer = new Map<string, 'mov' | 'webm'>();

  /** The render window starts writing the export (its encoder told it the video's avcC). */
  beginExport(exportId: string, projectId: string, video: Omit<WriterVideo, 'codec'> & { codec?: 'h264' | 'h265' | 'vp9' }, audio: WriterAudio | null): void {
    const resumed = this.exports.get(exportId);
    if (resumed) {
      // Carrying on a stopped export: the file is open already; only the encoder's stream description may differ.
      if (resumed.writer instanceof Mp4Writer) resumed.writer.setVideoDescription(video.avcC);
      return;
    }
    const p = this.get(projectId);
    const target = this.exportTargets.get(exportId);
    const dir = target ? path.dirname(target) : this.d.exportsDir();
    fs.mkdirSync(dir, { recursive: true });
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in Windows file names
    const base = (this.exportNames.get(exportId) ?? p.name).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'Keo video';
    const container = this.exportContainer.get(exportId) ?? (video.codec === 'vp9' ? 'webm' : undefined);
    const ext = container ?? 'mp4';
    let file = target ?? path.join(dir, `${base}.${ext}`);
    for (let n = 2; !target && (fs.existsSync(file) || fs.existsSync(`${file}.part`)); n++) file = path.join(dir, `${base} (${n}).${ext}`);
    if (ext === 'webm') {
      if (video.codec !== 'vp9') throw new StudioError('A WebM export needs VP9 video.');
      if (audio && audio.codec !== 'opus') throw new StudioError('A WebM export needs Opus sound.');
      const writer = new WebmWriter(file, { width: video.width, height: video.height, codecId: 'V_VP9' }, audio ? { sampleRate: audio.sampleRate, channels: audio.channels, config: audio.config } : null);
      this.exports.set(exportId, { writer, file, projectId, webm: true });
      return;
    }
    if (video.codec === 'vp9') throw new StudioError('VP9 video can only be saved as WebM.');
    const plan = this.resumablePlans.get(exportId);
    if (plan) {
      // Written as "<name>.mp4.part" with a journal, renamed when it is finished: one that stops can carry on.
      const part = `${file}.part`;
      fs.mkdirSync(this.resumeDir, { recursive: true });
      const rec: ResumeRecord = { ...plan, file, part };
      this.resumablePlans.set(exportId, rec);
      this.writeResume(rec);
      this.exports.set(exportId, { writer: new Mp4Writer(part, { ...video, codec: video.codec ?? 'h264' }, audio, ext === 'mov', plan.journal), file, part, projectId });
      return;
    }
    this.exports.set(exportId, { writer: new Mp4Writer(file, { ...video, codec: video.codec ?? 'h264' }, audio, ext === 'mov'), file, projectId });
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
    if (e.part) {
      let file = e.file;
      const ext = path.extname(file);
      for (let n = 2; fs.existsSync(file); n++) file = `${e.file.slice(0, -ext.length)} (${n})${ext}`;
      fs.renameSync(e.part, file);
      e.file = file;
      fs.rmSync(this.resumeFile(e.projectId), { force: true });
    }
    const frames = e.webm ? (readWebm(e.file)?.blocks[1] ?? 0) : mp4Frames(e.file);
    if (!frames) throw new StudioError('The exported file could not be read back.');
    return { file: e.file, durationSec: r.durationSec, frames, bytes: r.bytes };
  }

  /** The export stopped: thrown away if the user stopped it, else kept to carry on when it can be (Resume). */
  abortExport(exportId: string): void {
    const e = this.exports.get(exportId);
    this.exports.delete(exportId);
    if (!e) return;
    if (e.part && e.writer instanceof Mp4Writer && !this.cancelled.has(exportId) && e.writer.resumable) {
      e.writer.suspend();
      const rec = this.readResume(e.projectId);
      if (rec) this.writeResume({ ...rec, stoppedAt: new Date().toISOString() });
      return;
    }
    e.writer.abort();
    if (e.part) fs.rmSync(this.resumeFile(e.projectId), { force: true });
  }

  close(): void {
    for (const r of this.readers.values()) r?.close();
    this.readers.clear();
    // Exports still running when Keo closes are kept to carry on next time (where they can be).
    for (const id of [...this.exports.keys()]) this.abortExport(id);
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

export { issueKey } from '../../shared/studioReview';

/**
 * Real-camera movement for an AI shot (AI footage is too steady): a little bigger so the edges
 * never show, a faint handheld drift, and a slow push in over the shot.
 */
/** Where an AI clip goes, and what follows once it is placed. */
export interface AiClipPlace {
  at: number;
  seconds: number;
  about: string;
  in?: number;
  duration?: number;
  trackName?: string;
  muted?: boolean;
  volume?: number;
  duck?: number | null;
  recipe?: Asset['aiRecipe'];
  replace?: string;
  /** The real-camera finish (handheld drift, slow push). */
  finish?: boolean;
  /** The planned shot's frame (its plan notes the test or full shot). */
  frameAsset?: string;
  filmed?: 'test' | 'final';
  /** A clip that goes first (the motion test the full shot takes over from). */
  removeFirst?: string;
}

export function realCameraOps(clip: string, duration: number): EditOp[] {
  return [{ op: 'set', clip, transform: { scale: 1.035 }, loop: { kind: 'shake', amount: 0.18, period: 2 }, zooms: [{ at: 0, scale: 1, x: 0.5, y: 0.5, ease: 'cut' }, { at: Math.max(0.5, Math.round(duration * 100) / 100), scale: 1.04, x: 0.5, y: 0.48, ease: 'ramp' }] }];
}

/** A stopped export that can carry on: where its part file and journal are, and what it was making. */
interface ResumeRecord {
  exportId: string;
  projectId: string;
  /** The finished file's name (the part is renamed to it). */
  file: string;
  part: string;
  journal: string;
  size: { width: number; height: number; fps: number; quality: ExportQuality; video?: ExportVideoCodec };
  /** The project as it was exported (a changed project cannot carry on). */
  fingerprint: string;
  stoppedAt: string | null;
}

/** What a project's picture and sound depend on (not its name, save time or chat). */
function projectFingerprint(p: Project): string {
  const { updatedAt: _u, panelConversationId: _c, name: _n, ...rest } = p as Project & { panelConversationId?: string };
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex');
}

/** Video frames kept up to a journal's last key frame (where an export carries on). */
function countKept(journal: string): number {
  let frames = 0;
  let kept = 0;
  for (const line of fs.readFileSync(journal, 'utf8').split('\n')) {
    if (line.startsWith('V ')) frames++;
    else if (line.startsWith('R ')) kept = frames;
  }
  return kept;
}

/** Video frames in an MP4 / MOV as read back (0: it does not read). */
function mp4Frames(file: string): number {
  const check = Mp4Reader.open(file);
  const n = check?.video()?.samples.length ?? 0;
  check?.close();
  return n;
}
