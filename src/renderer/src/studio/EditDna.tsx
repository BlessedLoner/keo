import { useEffect, useMemo, useState } from 'react';
import { DNA_CATEGORIES, type Blueprint, type DnaJob, type DnaReportItem, type DnaVisionModel } from '@shared/editDna';
import type { Project } from '@shared/studio';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { dnaPreviewDraw, LiveCard } from './LiveGallery';

/**
 * EDIT DNA — Keo Studio's editing intelligence. Give Keo a reference video: it measures how the
 * video is edited (every shot, transition, camera path, speed ramp, beat, text, graphic, mask and
 * effect), rebuilds that as a blueprint, checks the rebuild against the reference, saves it
 * privately in this library, and applies it to your own footage as an ordinary, editable timeline
 * (you watch it being built). Previews play the structure on Keo's sample pictures, never the
 * reference's footage or music.
 */

const STATUS_LABEL: Record<DnaReportItem['status'], string> = { native: 'Rebuilt', approximated: 'Approximated', 'needs-asset': 'Needs your asset', unsupported: 'Not yet', 'low-confidence': 'Low confidence' };
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

type VisionChoice = DnaVisionModel & { current: boolean };
type SharedDna = Awaited<ReturnType<typeof listShared>>[number];
const listShared = (query: string, category: string) => invoke('dna:shared', { query, category });

/** The model the user chose to read frames with (kept on this PC). */
function readPick(): DnaVisionModel | null {
  try {
    const v = JSON.parse(localStorage.getItem('keo.dna.vision') ?? 'null') as DnaVisionModel | null;
    return v && typeof v.provider === 'string' && typeof v.model === 'string' ? v : null;
  } catch {
    return null;
  }
}
function writePick(v: DnaVisionModel | null): void {
  try {
    localStorage.setItem('keo.dna.vision', JSON.stringify(v));
  } catch {
    /* not kept */
  }
}

export function EditDnaPanel({ project, onAskKeo, onImport, onApplied }: { project: Project; onAskKeo: (text: string) => void; onImport?: () => void; onApplied?: (r: { clipIds: string[]; start: number }) => void }) {
  const ui = useUi();
  const [list, setList] = useState<Blueprint[]>([]);
  const [jobs, setJobs] = useState<DnaJob[]>([]);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('All');
  const [open, setOpen] = useState<Blueprint | null>(null);
  const [applying, setApplying] = useState<Blueprint | null>(null);
  const [pickRef, setPickRef] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [view, setView] = useState<'mine' | 'shared'>('mine');
  const [models, setModels] = useState<VisionChoice[]>([]);
  const [pick, setPick] = useState<DnaVisionModel | null>(readPick);
  const [download, setDownload] = useState<{ name: string; bytes: number; total: number | null } | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const [done, setDone] = useState<ApplyOutcome | null>(null);
  /** The dialog is already closed: the edit is built where the user can watch it, then the result shows here. */
  const applyNow = async (b: Blueprint, c: ApplyChoice) => {
    setApplying(null);
    setDone(null);
    setBuilding(b.name);
    try {
      const r = await invoke('dna:apply', { id: project.id, dnaId: b.id, assets: c.assets, length: c.length, replace: c.replace, ...(Object.keys(c.roles).length ? { roles: c.roles } : {}) });
      setDone({ name: b.name, clips: r.clips, seconds: r.seconds, notes: r.notes, track: r.track, mode: r.mode, captions: r.captions });
      onApplied?.({ clipIds: r.clipIds, start: r.start });
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBuilding(null);
    }
  };
  const load = () => {
    void invoke('dna:list', {}).then(setList, () => setList([]));
    void invoke('dna:jobs', {}).then(setJobs, () => setJobs([]));
    void invoke('dna:models', {}).then(setModels, () => setModels([]));
  };
  useEffect(() => {
    load();
    return subscribe('studio:dna', (e) => {
      if (e.job) setJobs((js) => [e.job!, ...js.filter((x) => x.id !== e.job!.id)].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
      if (e.library || e.job?.status === 'done') void invoke('dna:list', {}).then(setList, () => undefined);
      if (e.download) setDownload(e.download.done ? null : e.download);
    });
  }, []);
  useEffect(() => {
    if (open) setOpen(list.find((b) => b.id === open.id) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list]);
  // A remembered model that is no longer usable is forgotten.
  const usable = pick && models.some((m) => m.provider === pick.provider && m.model === pick.model) ? pick : null;
  const current = models.find((m) => m.current) ?? null;
  const visionModel = usable ?? null;
  const run = async <T,>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      ui.error(errText(e));
      return null;
    }
  };
  const analyse = async (assetId?: string) => {
    setPickRef(false);
    const j = await run(invoke('dna:analyze', { id: project.id, ...(assetId ? { assetId } : {}), visionModel }));
    if (j) ui.toast('Keo is reading the reference. You can keep editing: it saves itself to your Edit DNA when done.', 'info');
  };
  const choose = (m: DnaVisionModel | null) => {
    setPick(m);
    writePick(m);
  };
  const cats = useMemo(() => ['All', 'Favourites', ...new Set(list.map((b) => b.category))], [list]);
  const shown = list.filter((b) => (cat === 'All' || (cat === 'Favourites' ? b.favorite : b.category === cat)) && (!q.trim() || `${b.name} ${b.category} ${b.tags.join(' ')} ${b.description}`.toLowerCase().includes(q.toLowerCase())));
  const live = jobs.filter((j) => j.status === 'running' || j.status === 'interrupted' || j.status === 'cancelled' || j.status === 'failed').slice(0, 3);
  const videos = project.assets.filter((a) => a.kind === 'video');
  return (
    <div className="dna">
      <div className="dna-hero">
        <div className="dna-helix" aria-hidden>
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${i * -0.18}s` }} />
          ))}
        </div>
        <div>
          <strong>Edit DNA</strong>
          <span>Learn the editing of any video. Reuse it on your footage.</span>
        </div>
      </div>
      <div className="dna-actions">
        <button className="btn primary sm" onClick={() => void analyse()} title="Choose a reference video on your PC">
          <Icon name="plus" size={13} /> Reference from PC
        </button>
        <button className="btn sm" disabled={!videos.length} onClick={() => setPickRef((v) => !v)} title="Use a video already in this project's media">
          From Media
        </button>
        <button className="btn sm" onClick={() => setLinkOpen((v) => !v)} title="A direct link to a video file you may use">
          From a link
        </button>
        <button className="btn sm ghost" onClick={() => void run(invoke('dna:import', {})).then((b) => b && ui.toast(`Added “${b.name}” to your Edit DNA.`, 'success'))} title="Import a .keodna file someone gave you">
          Import file
        </button>
      </div>
      <ApplyStatus building={building} done={done} onClose={() => setDone(null)} />
      <VisionPicker models={models} current={current} value={usable} onChange={choose} />
      {pickRef && (
        <div className="dna-pick">
          {videos.map((a) => (
            <button key={a.id} onClick={() => void analyse(a.id)}>
              <Icon name="film" size={13} /> {a.name} <span className="muted">· {fmt(a.duration)}</span>
            </button>
          ))}
        </div>
      )}
      {linkOpen && <LinkImport project={project} visionModel={visionModel} onDone={() => setLinkOpen(false)} />}
      {download && (
        <div className="dna-job">
          <div className="dna-job-head">
            <strong>Downloading {download.name}</strong>
            <span className="grow" />
            <span className="small muted">
              {(download.bytes / 1e6).toFixed(0)} MB{download.total ? ` of ${(download.total / 1e6).toFixed(0)} MB` : ''}
            </span>
          </div>
          <div className="dna-bar">
            <i style={{ width: download.total ? `${Math.round((download.bytes / download.total) * 100)}%` : '35%' }} />
          </div>
        </div>
      )}
      {live.map((j) => (
        <JobCard key={j.id} job={j} models={models} visionModel={visionModel} onCancel={() => void run(invoke('dna:cancel', { jobId: j.id }))} onResume={(m) => void run(invoke('dna:resume', { jobId: j.id, ...(m !== undefined ? { visionModel: m } : {}) }))} />
      ))}
      <div className="lib-chiprow dna-views">
        <button className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>
          My Edit DNA
        </button>
        <button className={view === 'shared' ? 'on' : ''} onClick={() => setView('shared')}>
          Shared library
        </button>
      </div>
      {view === 'shared' ? (
        <SharedLibrary project={project} onSaved={load} />
      ) : (
        <>
          <div className="lib-bar">
            <input className="input font-search" placeholder="Search your Edit DNA" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="lib-chiprow sub">
            {cats.map((c) => (
              <button key={c} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
                {c}
              </button>
            ))}
          </div>
          {!list.length ? (
            <p className="lib-note small muted">No Edit DNA yet. Add a reference video you love: Keo measures how it is edited and keeps the blueprint here, private to you.</p>
          ) : (
            <div className="dna-grid">
              {shown.map((b) => (
                <DnaCard key={`${b.id}-${b.version}`} b={b} project={project} onOpen={() => setOpen(b)} onFav={() => void run(invoke('dna:update', { dnaId: b.id, favorite: !b.favorite }))} />
              ))}
            </div>
          )}
        </>
      )}
      {open && (
        <DnaDetails
          b={open}
          project={project}
          models={models}
          visionModel={visionModel}
          onChooseModel={choose}
          onClose={() => setOpen(null)}
          onApply={() => {
            setApplying(open);
            setOpen(null);
          }}
          onAskKeo={onAskKeo}
          reload={load}
        />
      )}
      {applying && <ApplyDialog b={applying} references={new Set([...list.map((x) => x.source.fileName), ...jobs.filter((j) => j.projectId === project.id).map((j) => project.assets.find((a) => a.id === j.assetId)?.name ?? '')].filter(Boolean))} project={project} onClose={() => setApplying(null)} onAskKeo={onAskKeo} {...(onImport ? { onImport } : {})} onApply={(c) => void applyNow(applying, c)} />}
    </div>
  );
}

/** Which AI model reads the frames: the current one when it sees pictures, or one the user picks. */
function VisionPicker({ models, current, value, onChange }: { models: VisionChoice[]; current: VisionChoice | null; value: DnaVisionModel | null; onChange: (m: DnaVisionModel | null) => void }) {
  const [open, setOpen] = useState(false);
  const shown = value ?? current;
  const blind = !shown;
  return (
    <div className={`dna-vision ${blind ? 'warn' : ''}`}>
      <Icon name="eye" size={13} />
      <span className="grow">
        {blind ? (
          <>
            <strong>Your current model cannot see pictures.</strong> Pick one that can, so Keo reads the text, graphics, effects and colour too.
          </>
        ) : (
          <>
            Reads frames with <strong>{shown.label ?? shown.model}</strong>
          </>
        )}
      </span>
      <button className="btn sm ghost" onClick={() => setOpen((v) => !v)} disabled={!models.length} title={models.length ? 'Choose the model that looks at the frames' : 'None of your models can see pictures (or showing pictures is off in Access)'}>
        {models.length ? 'Change' : 'None available'}
      </button>
      {open && (
        <div className="dna-pick dna-models">
          {current && (
            <button className={!value ? 'on' : ''} onClick={() => (onChange(null), setOpen(false))}>
              Current model · {current.label}
            </button>
          )}
          {models
            .filter((m) => !m.current)
            .map((m) => (
              <button key={`${m.provider}/${m.model}`} className={value?.provider === m.provider && value.model === m.model ? 'on' : ''} onClick={() => (onChange({ provider: m.provider, model: m.model, ...(m.label ? { label: m.label } : {}) }), setOpen(false))}>
                {m.label}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function LinkImport({ project, visionModel, onDone }: { project: Project; visionModel: DnaVisionModel | null; onDone: () => void }) {
  const ui = useUi();
  const [url, setUrl] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await invoke('dna:url', { id: project.id, url, rights: true, visionModel });
      ui.toast('Downloaded. Keo is reading the reference now.', 'info');
      onDone();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dna-link">
      <input className="input" placeholder="https://… a link to a video file (.mp4, .mov, .webm)" value={url} onChange={(e) => setUrl(e.target.value)} />
      <label className="small">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} /> I may use this video (I made it, have permission, or it is openly licensed).
      </label>
      <p className="small muted">Direct video files only. Pages on YouTube, TikTok, Instagram and similar sites are not downloaded: save the video with the site’s own button (if allowed) and use Reference from PC.</p>
      <button className="btn primary sm" disabled={!rights || !/^https:\/\/\S+$/.test(url.trim()) || busy} onClick={() => void go()}>
        {busy ? 'Downloading…' : 'Download and read'}
      </button>
    </div>
  );
}

function JobCard({ job, models, visionModel, onCancel, onResume }: { job: DnaJob; models: VisionChoice[]; visionModel: DnaVisionModel | null; onCancel: () => void; onResume: (m?: DnaVisionModel | null) => void }) {
  const cur = job.stages.find((s) => s.state === 'running') ?? job.stages.find((s) => s.state === 'failed');
  return (
    <div className={`dna-job ${job.status}`}>
      <div className="dna-job-head">
        <strong>{job.name}</strong>
        <span className="grow" />
        {job.status === 'running' ? (
          <button className="btn sm ghost" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button className="btn sm" onClick={() => onResume(visionModel ?? undefined)} title="Carries on from the last finished stage">
            Resume
          </button>
        )}
      </div>
      <div className="dna-bar">
        <i style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
      <ol className="dna-stages">
        {job.stages.map((s) => (
          <li key={s.id} className={s.state} title={s.detail}>
            <span className="dot" />
            <span className="grow">{s.label}</span>
            {s.detail && s.state !== 'waiting' && <em>{s.detail}</em>}
          </li>
        ))}
      </ol>
      {job.error && job.status !== 'running' && <p className="small muted">{job.error}</p>}
      {cur && job.status === 'running' && <p className="small muted">{cur.label}…</p>}
      {!models.length && job.stages.some((s) => s.id === 'vision' && s.state === 'skipped') && <p className="small muted">No model that sees pictures is available: add one in Settings → Providers.</p>}
    </div>
  );
}

function quality(b: Blueprint): { label: string; tone: 'good' | 'mid' | 'low' } {
  if (b.quality) return { label: `${pct(b.quality.score)} match`, tone: b.quality.score >= 0.75 ? 'good' : b.quality.score >= 0.5 ? 'mid' : 'low' };
  const items = b.report;
  const good = items.filter((x) => x.status === 'native').length;
  const weak = items.filter((x) => x.status === 'unsupported' || x.status === 'low-confidence').length;
  if (b.status === 'partial') return { label: 'Partly read', tone: 'low' };
  if (weak > good) return { label: 'Approximate', tone: 'mid' };
  return { label: 'Rebuilt', tone: 'good' };
}

function DnaCard({ b, project, onOpen, onFav }: { b: Blueprint; project: Project; onOpen: () => void; onFav: () => void }) {
  const draw = useMemo(() => dnaPreviewDraw(b, project), [b, project.width, project.height]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = quality(b);
  const aspect = project.width / project.height < 0.8 ? 0.8 : project.width / project.height > 1.3 ? 16 / 9 : 1;
  const complexity = b.shots.length + b.texts.length * 2 + b.graphics.length * 2 + b.effects.length;
  return (
    <div className="dna-card">
      <LiveCard draw={draw} still={Math.min(b.seconds * 0.3, 3)} play="hover" aspect={aspect} label={b.name} sub={`${b.category} · ${fmt(b.seconds)} · ${b.aspect}`} onClick={onOpen} title="Point to play its editing on sample pictures; click for details" />
      <button className={`dna-fav ${b.favorite ? 'on' : ''}`} onClick={onFav} aria-label={b.favorite ? 'Remove from favourites' : 'Add to favourites'}>
        ★
      </button>
      <span className={`dna-q ${q.tone}`}>{q.label}</span>
      <span className="dna-meta">
        {b.shots.length} shots · {complexity > 40 ? 'complex' : complexity > 15 ? 'rich' : 'simple'}
        {b.sharing.published ? ' · shared' : ''}
      </span>
    </div>
  );
}

function DnaDetails({
  b,
  project,
  models,
  visionModel,
  onChooseModel,
  onClose,
  onApply,
  onAskKeo,
  reload,
}: {
  b: Blueprint;
  project: Project;
  models: VisionChoice[];
  visionModel: DnaVisionModel | null;
  onChooseModel: (m: DnaVisionModel | null) => void;
  onClose: () => void;
  onApply: () => void;
  onAskKeo: (t: string) => void;
  reload: () => void;
}) {
  const ui = useUi();
  const [name, setName] = useState(b.name);
  const [busy, setBusy] = useState('');
  const projectAspect = project.width > project.height * 1.15 ? 'landscape' : project.height > project.width * 1.15 ? 'vertical' : 'square';
  const save = (patch: { name?: string; category?: string; sharing?: { state: Blueprint['sharing']['state']; rights: Blueprint['sharing']['rights'] } }) => void invoke('dna:update', { dnaId: b.id, ...patch }).catch((e) => ui.error(errText(e)));
  const act = async (label: string, p: () => Promise<unknown>, done: string) => {
    setBusy(label);
    try {
      await p();
      ui.toast(done, 'success');
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy('');
    }
  };
  const readable = visionModel ?? models.find((m) => m.current) ?? null;
  const unread = b.status === 'partial' || b.report.some((r) => r.status === 'low-confidence');
  return (
    <div className="dna-details" role="dialog" aria-label={b.name}>
      <div className="dna-details-head">
        <input className="dna-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== b.name && save({ name: name.trim() })} />
        <button className="btn icon sm ghost" onClick={onClose} aria-label="Close">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="dna-facts">
        <span>{b.shots.length} shots</span>
        <span>{fmt(b.seconds)}</span>
        <span>{b.aspect}</span>
        {b.audio.bpm && <span>{Math.round(b.audio.bpm)} bpm</span>}
        <span>v{b.version}</span>
        <span className={b.aspect === projectAspect ? 'ok' : 'warn'}>{b.aspect === projectAspect ? 'Fits this project' : `Made for ${b.aspect}: will be reframed`}</span>
      </div>
      {b.description && <p className="small">{b.description}</p>}
      {b.quality && (
        <div className="dna-quality" title={b.quality.note}>
          <strong className={b.quality.score >= 0.75 ? 'ok' : b.quality.score >= 0.5 ? 'warn' : 'bad'}>{pct(b.quality.score)}</strong>
          <span>
            measured match · pictures {pct(b.quality.frames)} · cuts {pct(b.quality.cuts)}
            {b.quality.camera !== undefined ? ` · camera ${pct(b.quality.camera)}` : ''}
          </span>
        </div>
      )}
      {unread && (
        <div className="dna-vision warn">
          <Icon name="eye" size={13} />
          <span className="grow">{readable ? `Read the text, graphics, effects, masks and colour with ${readable.label ?? readable.model}.` : 'None of your models can see pictures yet: add one in Settings → Providers, then read it again.'}</span>
          <button className="btn sm primary" disabled={!readable || !!busy} onClick={() => void act('reread', () => invoke('dna:reread', { dnaId: b.id, visionModel }), 'Reading it again: the stages show at the top of Edit DNA.').then(onClose)}>
            {busy === 'reread' ? 'Starting…' : 'Read again'}
          </button>
        </div>
      )}
      {unread && models.length > 1 && (
        <div className="chip-row">
          {models.map((m) => (
            <button key={`${m.provider}/${m.model}`} className={`chip-btn ${(visionModel ? visionModel.provider === m.provider && visionModel.model === m.model : m.current) ? 'on' : ''}`} onClick={() => onChooseModel(m.current ? null : { provider: m.provider, model: m.model, ...(m.label ? { label: m.label } : {}) })}>
              {m.label}
            </button>
          ))}
        </div>
      )}
      <h5 className="insp-sub">Category</h5>
      <div className="chip-row">
        {[...new Set([...DNA_CATEGORIES, b.category])].map((c) => (
          <button key={c} className={`chip-btn ${b.category === c ? 'on' : ''}`} onClick={() => save({ category: c })}>
            {c}
          </button>
        ))}
      </div>
      <div className="dna-timeline" aria-label="Shots">
        {b.shots.map((s) => (
          <i key={s.id} style={{ flex: Math.max(0.2, s.end - s.start) }} className={`r-${s.role} ${s.cutIn.kind !== 'cut' ? 'soft' : ''} ${s.onBeat ? 'beat' : ''}`} title={`${s.id} · ${s.role} · ${(s.end - s.start).toFixed(2)} s${s.cutIn.kind !== 'cut' ? ` · ${s.cutIn.kind} in` : ''}${s.onBeat ? ' · on the beat' : ''}${s.ramp ? ' · speed ramp' : ''}${s.path ? ' · camera path' : ''}${s.mask ? ` · ${s.mask.shape} mask` : ''}${s.about ? ` · ${s.about}` : ''}`} />
        ))}
      </div>
      <h5 className="insp-sub">What Keo rebuilt</h5>
      <ul className="dna-report">
        {b.report.map((r, i) => (
          <li key={i} className={r.status}>
            <span className="chip-s">{STATUS_LABEL[r.status]}</span>
            <span>
              <strong>{r.element}</strong> — {r.note}
            </span>
          </li>
        ))}
      </ul>
      <h5 className="insp-sub">Sharing</h5>
      <p className="small muted">Private to you. To share it, say why you may: the blueprint holds only the editing, never the reference’s footage, music or file name.</p>
      <div className="chip-row">
        {(
          [
            ['private', null, 'Private'],
            ['shareable', 'own', 'I made the reference'],
            ['shareable', 'licensed', 'I have a licence'],
            ['shareable', 'technique-only', 'Technique only'],
          ] as const
        ).map(([state, rights, label]) => (
          <button key={label} className={`chip-btn ${b.sharing.state === state && b.sharing.rights === rights ? 'on' : ''}`} onClick={() => save({ sharing: { state, rights } })} disabled={!!b.sharing.published && state === 'private'} title={b.sharing.published && state === 'private' ? 'Remove it from the shared library first' : undefined}>
            {label}
          </button>
        ))}
      </div>
      {b.sharing.state === 'shareable' && b.origin !== 'shared' && (
        <div className="dna-row">
          <span>{b.sharing.published ? 'In the shared library for all Keo users.' : 'Not in the shared library.'}</span>
          {b.sharing.published ? (
            <button className="btn sm" disabled={!!busy} onClick={() => void act('unpublish', () => invoke('dna:unpublish', { dnaId: b.id }), 'Removed from the shared library.')}>
              {busy === 'unpublish' ? 'Removing…' : 'Remove'}
            </button>
          ) : (
            <button
              className="btn sm primary"
              disabled={!!busy}
              onClick={() =>
                void ui.confirm({ title: `Publish “${b.name}”?`, body: 'Every Keo user can find it and save it to their own Edit DNA. Only the editing goes (shots, timing, transitions, camera, text styles and words, effects); no footage, music or file names. You can remove it at any time.', confirmLabel: 'Publish' }).then((ok) => ok && void act('publish', () => invoke('dna:publish', { dnaId: b.id }), 'Published to the shared library.'))
              }
            >
              {busy === 'publish' ? 'Publishing…' : 'Publish'}
            </button>
          )}
        </div>
      )}
      <div className="dna-foot">
        <button className="btn primary sm" onClick={onApply}>
          Apply to my clips
        </button>
        <button className="btn sm" onClick={() => onAskKeo(`Apply my Edit DNA “${b.name}” (${b.id}) to my clips: pick the best clip for each shot by what it shows, then put my own words in its text.`)}>
          Ask Keo to adapt it
        </button>
        <span className="grow" />
        <button className="btn sm ghost" disabled={b.sharing.state !== 'shareable'} title={b.sharing.state === 'shareable' ? 'Save it as a .keodna file to share' : 'Make it shareable first'} onClick={() => void invoke('dna:export', { dnaId: b.id }).then((r) => ui.toast(`Saved ${r.file.split(/[\\/]/).pop()}.`, 'success'), (e) => ui.error(errText(e)))}>
          Export
        </button>
        <button
          className="btn sm ghost"
          onClick={() =>
            void ui.confirm({ title: `Delete “${b.name}”?`, body: 'It is removed from your Edit DNA library. Projects made with it are not changed.', confirmLabel: 'Delete' }).then((ok) => {
              if (!ok) return;
              void invoke('dna:delete', { dnaId: b.id }).then(() => {
                onClose();
                reload();
              }, (e) => ui.error(errText(e)));
            })
          }
        >
          Delete
        </button>
      </div>
      {b.history.length > 0 && <p className="small muted">History: {b.history.map((h) => `v${h.version} ${h.note}`).join(' · ')}</p>}
    </div>
  );
}

/** Blueprints other Keo users published (Keo Cloud): find, save to your own library, report. */
function SharedLibrary({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const ui = useUi();
  const [items, setItems] = useState<SharedDna[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      setError('');
      void listShared(q, cat).then(
        (r) => live && setItems(r),
        (e) => {
          if (!live) return;
          setItems([]);
          setError(errText(e));
        },
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, cat]);
  const aspect = project.width / project.height < 0.8 ? 'vertical' : project.width / project.height > 1.3 ? 'landscape' : 'square';
  return (
    <>
      <div className="lib-bar">
        <input className="input font-search" placeholder="Search the shared library" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="lib-chiprow sub">
        {['', ...DNA_CATEGORIES].map((c) => (
          <button key={c || 'all'} className={cat === c ? 'on' : ''} onClick={() => setCat(c)}>
            {c || 'All'}
          </button>
        ))}
      </div>
      {error && <p className="lib-note small muted">{error}</p>}
      {items === null && <p className="lib-note small muted">Loading the shared library…</p>}
      {items && !items.length && !error && <p className="lib-note small muted">Nothing shared here yet. Make one of yours shareable and publish it from its details.</p>}
      <div className="dna-shared">
        {items?.map((s) => (
          <div key={s.id} className="dna-shared-item">
            <div className="grow">
              <strong>{s.name}</strong>
              <span className="small muted">
                {s.category} · {s.shots} shots · {fmt(s.seconds)} · {s.aspect}
                {s.aspect !== aspect ? ' (will be reframed)' : ''} · {s.rights === 'technique-only' ? 'technique only' : s.rights === 'own' ? 'by its maker' : 'licensed'} · saved {s.saves}×
              </span>
              {s.description && <span className="small">{s.description}</span>}
            </div>
            <button
              className="btn sm primary"
              disabled={!!busy || s.mine}
              title={s.mine ? 'This is yours' : 'Save it to your Edit DNA'}
              onClick={() => {
                setBusy(s.id);
                void invoke('dna:saveShared', { sharedId: s.id })
                  .then((b) => {
                    ui.toast(`Saved “${b.name}” to your Edit DNA.`, 'success');
                    onSaved();
                  }, (e) => ui.error(errText(e)))
                  .finally(() => setBusy(''));
              }}
            >
              {busy === s.id ? 'Saving…' : s.mine ? 'Yours' : 'Save'}
            </button>
            {!s.mine && (
              <button
                className="btn icon sm ghost"
                title="Report it (stolen work, offensive)"
                aria-label="Report"
                onClick={() =>
                  void ui.confirm({ title: `Report “${s.name}”?`, body: 'Keo’s team looks at it. Use this for stolen work or something offensive.', confirmLabel: 'Report' }).then((ok) => ok && void invoke('dna:reportShared', { sharedId: s.id, reason: 'Reported from the shared library.' }).then(() => ui.toast('Reported. Thank you.', 'success'), (e) => ui.error(errText(e))))
                }
              >
                <Icon name="flag" size={13} />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

interface ApplyChoice {
  assets: string[];
  roles: Record<string, string>;
  length: 'reference' | 'footage';
  replace: boolean;
}
type ApplyOutcome = { name: string; clips: number; seconds: number; notes: string[]; track: string; mode: 'talk' | 'montage'; captions: number };

/** While Keo builds the edit (the timeline stays in view), then what it made. Never covers the timeline. */
function ApplyStatus({ building, done, onClose }: { building: string | null; done: ApplyOutcome | null; onClose: () => void }) {
  if (building)
    return (
      <div className="dna-job dna-building" role="status">
        <div className="dna-job-head">
          <span className="dna-spin" aria-hidden />
          <strong>Keo is building “{building}” on your timeline</strong>
        </div>
        <p className="small muted">Watch the timeline: your clips go in shot by shot. Captions come last when the reference has them.</p>
      </div>
    );
  if (!done) return null;
  return (
    <div className="dna-job dna-done" role="status">
      <div className="dna-job-head">
        <Icon name="check" size={14} />
        <strong>“{done.name}” is on your timeline</strong>
        <span className="grow" />
        <button className="btn sm ghost" onClick={onClose} aria-label="Close">
          <Icon name="x" size={12} />
        </button>
      </div>
      <p className="small">
        {done.clips} clips, {fmt(done.seconds)}, from 0:00 on the track <strong>{done.track}</strong>
        {done.captions ? `, with ${done.captions} caption lines` : ''}. Press Space to watch. Everything is editable; one Undo takes it all back.
      </p>
      {done.notes.length > 0 && (
        <ul className="dna-report">
          {done.notes.map((n, i) => (
            <li key={i} className="approximated">
              <span className="chip-s">Note</span>
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ApplyDialog({ b, references, project, onClose, onAskKeo, onImport, onApply }: { b: Blueprint; references: Set<string>; project: Project; onClose: () => void; onAskKeo: (t: string) => void; onImport?: () => void; onApply: (c: ApplyChoice) => void }) {
  // Reference videos (this one's and any other read as a reference) are never offered as footage.
  const isReference = (a: { name: string }) => (!!b.source.fileName && a.name === b.source.fileName) || references.has(a.name);
  const all = project.assets.filter((a) => a.kind === 'video' || a.kind === 'image');
  const reference = all.filter(isReference);
  // The reference's own footage is never offered: the edit is rebuilt with the user's clips.
  const media = all.filter((a) => !isReference(a));
  const [chosen, setChosen] = useState<string[]>(() => media.map((a) => a.id));
  // New media imported while the dialog is open is ticked too.
  const known = useMemo(() => new Set(media.map((a) => a.id)), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const fresh = media.filter((a) => !known.has(a.id)).map((a) => a.id);
    if (fresh.length) setChosen((c) => [...new Set([...c, ...fresh])]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [media.length]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const picked = media.filter((a) => chosen.includes(a.id));
  const footage = picked.reduce((n, a) => n + (a.kind === 'video' ? a.duration : 3), 0);
  const talking = picked.some((a) => a.kind === 'video' && a.hasAudio);
  const [length, setLength] = useState<'reference' | 'footage' | null>(null);
  const len = length ?? (talking && footage > b.seconds * 1.3 ? 'footage' : 'reference');
  const [replace, setReplace] = useState(true);
  const short = picked.length > 0 && len === 'reference' && footage < b.seconds * 0.8;
  return (
    <div className="modal-back dna-modal" role="dialog" aria-modal="true" aria-label={`Apply ${b.name}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal dna-apply">
        <h3>Apply “{b.name}”</h3>
        <p className="small muted">
          Keo rebuilds this editing with <strong>your</strong> clips. Talking clips keep everything you say, in order — never cut mid-word — and your own words go on screen the way the reference shows words. This window closes so you can watch it being built.
        </p>
        {b.style ? (
          <p className="small">
            <strong>Its style:</strong> {b.report.find((r) => r.element.startsWith('Style'))?.note ?? 'layout, words on screen, cards and ending.'}
          </p>
        ) : (
          <p className="dna-warn small">This blueprint was read before Keo learned edit styles (words on screen, layout, text cards, ending), so only its cuts and camera moves can be used. Close this, open the blueprint and press Read again first.</p>
        )}
        <div className="dna-row">
          <h5 className="insp-sub">Your clips</h5>
          {onImport && (
            <button className="btn sm" onClick={onImport}>
              <Icon name="plus" size={12} /> Add clips from PC
            </button>
          )}
        </div>
        <div className="dna-clips">
          {media.map((a) => (
            <label key={a.id} className={chosen.includes(a.id) ? 'on' : ''}>
              <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, a.id] : c.filter((x) => x !== a.id)))} />
              <span>{a.name}</span>
              <em>{a.kind === 'image' ? 'picture' : fmt(a.duration)}</em>
            </label>
          ))}
          {!media.length && <p className="small muted">Import your own videos or pictures first (Add clips from PC).</p>}
        </div>
        {reference.length > 0 && (
          <p className="small muted">
            {reference.map((a) => a.name).join(', ')} {reference.length > 1 ? 'are reference videos' : 'is a reference video'}: never used as footage.
          </p>
        )}
        <h5 className="insp-sub">Length</h5>
        <div className="chip-row">
          <button className={`chip-btn ${len === 'reference' ? 'on' : ''}`} onClick={() => setLength('reference')}>
            Like the reference · {fmt(b.seconds)}
          </button>
          <button className={`chip-btn ${len === 'footage' ? 'on' : ''}`} onClick={() => setLength('footage')} disabled={!picked.length}>
            All my footage · {fmt(Math.max(b.seconds, footage))}
          </button>
        </div>
        <p className="small muted">
          {len === 'footage'
            ? talking
              ? 'Everything you say stays, in order; the reference’s shot rhythm repeats across it (long pauses cut as its pace does).'
              : 'The reference’s middle shots repeat in its rhythm until your clips are used up; the opening and ending stay first and last.'
            : talking
              ? 'Your speech is used from the start until about the reference’s length, stopping between sentences where it can.'
              : 'One of your moments in each of the reference’s shots, spread through your clips.'}
        </p>
        {short && <p className="dna-warn small">Your clips add up to {fmt(footage)} for a {fmt(b.seconds)} edit, so some moments will be used twice. Add more clips for a fresher result.</p>}
        <label className="dna-check small">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Replace my clips on the timeline and start at 0:00 (they stay in Media)
        </label>
        {b.shots.length > 1 && (
          <details>
            <summary className="small">Choose a clip for particular shots</summary>
            <div className="dna-roles">
              {b.shots.slice(0, 40).map((s) => (
                <div key={s.id} className="dna-role">
                  <span className="small">
                    {s.id} · {s.role} · {(s.end - s.start).toFixed(1)} s{s.about ? ` · ${s.about}` : ''}
                  </span>
                  <div className="chip-row">
                    <button className={`chip-btn ${!roles[s.id] ? 'on' : ''}`} onClick={() => setRoles((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== s.id)))}>
                      Keo chooses
                    </button>
                    {picked.map((a) => (
                      <button key={a.id} className={`chip-btn ${roles[s.id] === a.id ? 'on' : ''}`} onClick={() => setRoles((r) => ({ ...r, [s.id]: a.id }))}>
                        {a.name}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn" onClick={() => onAskKeo(`Apply my Edit DNA “${b.name}” (${b.id}) to my clips and adapt it to them.`)}>
            Ask Keo instead
          </button>
          <button className="btn primary" disabled={!chosen.length} onClick={() => onApply({ assets: chosen, roles, length: len, replace })}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
