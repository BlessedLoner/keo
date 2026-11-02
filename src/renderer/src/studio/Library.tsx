import { useCallback, useEffect, useRef, useState } from 'react';
import { CAPTIONS_TRACK, CAPTION_STYLE, findClip, LOOKS, TRANSITIONS, type Asset, type Clip, type EditOp, type LookId, type Project, type TextStyle } from '@shared/studio';
import { EFFECT_KINDS, GENRE_LABEL, MUSIC_GENRES, type Sound } from '@shared/studioSounds';
import { Icon } from '../components/Icon';
import { useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { Autopilot } from './Autopilot';
import { Templates } from './Templates';
import { Looks } from './Looks';
import { EMOJI, TEXT_STYLES, Tile } from './Bin';
import { ElementsPanel } from './MotionFields';
import { TRANSITION_LABEL } from './Timeline';
import { VoiceRecorder } from './VoiceTools';

/**
 * The Studio's library on the left, laid out like CapCut: a row of tabs (Media, Audio, Text,
 * Stickers, Effects, Transitions, Captions, Filters, Smart tools), each with its categories on the
 * left and its items beside them. Imported media waits here until it is dragged onto the
 * timeline or added with +.
 */

type Tab = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'captions' | 'filters' | 'smart';
const TABS: Array<[Tab, string, string]> = [
  ['media', 'Media', 'film'],
  ['audio', 'Audio', 'music'],
  ['text', 'Text', 'text'],
  ['stickers', 'Stickers', 'sticker'],
  ['effects', 'Effects', 'effects'],
  ['transitions', 'Transitions', 'transition'],
  ['captions', 'Captions', 'captions'],
  ['filters', 'Filters', 'filter'],
  ['smart', 'Smart tools', 'magic'],
];
const CATEGORIES: Record<Tab, Array<[string, string]>> = {
  media: [
    ['all', 'All'],
    ['video', 'Videos'],
    ['image', 'Pictures'],
  ],
  audio: [
    ['music', 'Music'],
    ['effect', 'Sound effects'],
    ['project', 'In this project'],
    ['record', 'Record voice'],
  ],
  text: [
    ['add', 'Add text'],
    ['styles', 'Text styles'],
    ['titles', 'Motion titles'],
  ],
  stickers: [
    ['emoji', 'Emoji'],
    ['shapes', 'Shapes'],
  ],
  effects: [['video', 'Video effects']],
  transitions: [['all', 'Transitions']],
  captions: [
    ['auto', 'Auto captions'],
    ['styles', 'Caption styles'],
  ],
  filters: [['looks', 'Looks']],
  smart: [
    ['looks', 'Keo looks'],
    ['templates', 'Templates'],
    ['tools', 'One-click tools'],
  ],
};

const EFFECTS: Array<['grain' | 'vhs' | 'glow' | 'rgbSplit' | 'lightLeak', string, string]> = [
  ['grain', 'Film grain', 'linear-gradient(135deg,#6b5b4a,#3a322a)'],
  ['vhs', 'VHS', 'repeating-linear-gradient(0deg,#2a3b5c 0 3px,#3d5786 3px 6px)'],
  ['glow', 'Glow', 'radial-gradient(circle,#fff6c9,#d08b2c 70%)'],
  ['rgbSplit', 'RGB split', 'linear-gradient(90deg,#ff2a55,#2ae5ff)'],
  ['lightLeak', 'Light leak', 'linear-gradient(120deg,#ff7a18,#ffd200 40%,#2b1055)'],
];
const LOOK_SWATCH: Record<LookId, string> = {
  natural: 'linear-gradient(135deg,#7fa7c9,#c9b68f)',
  warm: 'linear-gradient(135deg,#e8a15a,#7a4320)',
  cool: 'linear-gradient(135deg,#5ab3e8,#20437a)',
  punchy: 'linear-gradient(135deg,#ff3d7f,#ffd400)',
  cinematic: 'linear-gradient(135deg,#1f6f78,#e39b55)',
  'black-white': 'linear-gradient(135deg,#eee,#222)',
};
const LOOK_LABEL: Record<LookId, string> = { natural: 'Natural', warm: 'Warm', cool: 'Cool', punchy: 'Punchy', cinematic: 'Cinematic', 'black-white': 'Black & white' };
/** Caption looks applied to every line on the Captions track. */
const CAPTION_LOOKS: Array<{ id: string; label: string; style: Partial<TextStyle>; highlight?: string | null; y?: number; css: React.CSSProperties }> = [
  { id: 'bold', label: 'Bold pop', style: { ...CAPTION_STYLE }, highlight: '#FFD400', css: { fontWeight: 900, textTransform: 'uppercase', WebkitTextStroke: '1px #000', color: '#fff' } },
  { id: 'clean', label: 'Clean phrase', style: { sizePct: 6.5, weight: 'black', color: '#FFFFFF', outline: 0, shadow: 16, uppercase: false, maxWidth: 0.8, box: false }, highlight: null, y: 0.5, css: { fontWeight: 900, color: '#fff', textShadow: '0 2px 6px #000' } },
  { id: 'boxed', label: 'Boxed', style: { sizePct: 4.6, weight: 'bold', color: '#FFFFFF', outline: 0, shadow: 0, uppercase: false, box: true, boxColor: '#000000C0' }, highlight: null, y: 0.78, css: { fontWeight: 700, background: 'rgba(0,0,0,.75)', color: '#fff', padding: '0 6px', borderRadius: 3 } },
  { id: 'yellow', label: 'Yellow words', style: { ...CAPTION_STYLE, uppercase: false }, highlight: '#FFD400', css: { fontWeight: 900, color: '#ffd400', WebkitTextStroke: '1px #000' } },
  { id: 'subtitle', label: 'Subtitle', style: { sizePct: 3.8, weight: 'normal', color: '#FFFFFF', outline: 0, shadow: 14, uppercase: false, box: false }, highlight: null, y: 0.86, css: { color: '#fff', textShadow: '0 1px 3px #000' } },
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export function Library({
  project,
  time,
  selected,
  onImport,
  onAddAsset,
  onEdit,
  onCaptions,
  captioning,
  onAskKeo,
}: {
  project: Project;
  time: number;
  selected: string | null;
  onImport: () => void;
  onAddAsset: (a: Asset) => void;
  onEdit: (ops: EditOp[]) => Promise<void>;
  onCaptions: () => void;
  captioning: boolean;
  onAskKeo: (text: string) => void;
}) {
  const ui = useUi();
  const [tab, setTab] = useState<Tab>('media');
  const [cat, setCat] = useState<Record<Tab, string>>({ media: 'all', audio: 'music', text: 'add', stickers: 'emoji', effects: 'video', transitions: 'all', captions: 'auto', filters: 'looks', smart: 'looks' });
  const sel = selected ? (findClip(project, selected)?.clip ?? null) : null;
  const now = cat[tab];
  const run = (ops: EditOp[]) => void onEdit(ops).catch((e: unknown) => ui.error(errText(e)));
  return (
    <aside className="studio-bin lib">
      <div className="lib-tabs" role="tablist" aria-label="Library">
        {TABS.map(([id, label, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} title={label}>
            <Icon name={icon} size={17} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      <div className="lib-body">
        <nav className="lib-cats" aria-label="Categories">
          {CATEGORIES[tab].map(([id, label]) => (
            <button key={id} className={now === id ? 'on' : ''} onClick={() => setCat((c) => ({ ...c, [tab]: id }))}>
              {label}
            </button>
          ))}
        </nav>
        <div className="lib-items">
          {tab === 'media' && <MediaItems project={project} time={time} kind={now as 'all' | 'video' | 'image'} onImport={onImport} onAddAsset={onAddAsset} onEdit={onEdit} />}
          {tab === 'audio' && (now === 'music' || now === 'effect') && <SoundItems key={now} project={project} kind={now} time={time} />}
          {tab === 'audio' && now === 'project' && <ProjectSounds project={project} onAddAsset={onAddAsset} sel={sel} onEdit={run} />}
          {tab === 'audio' && now === 'record' && (
            <div className="lib-pad">
              <p className="small muted">Record a voice-over straight onto the Voice track at the playhead.</p>
              <VoiceRecorder projectId={project.id} time={time} />
            </div>
          )}
          {tab === 'text' && now === 'add' && (
            <div className="lib-grid">
              <button className="lib-card text-default" onClick={() => run([{ op: 'add_text', text: 'Your text', start: time, duration: 3 }])} title="Add plain text at the playhead">
                <span className="lib-card-art">Aa</span>
                <span>Default text</span>
              </button>
            </div>
          )}
          {tab === 'text' && now === 'styles' && (
            <div className="style-grid">
              {TEXT_STYLES.map((s) => (
                <button
                  key={s.id}
                  className="style-tile"
                  title={`Add “${s.label}” at the playhead`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/x-keo-text', s.id)}
                  onClick={() => run([{ op: 'add_text', text: s.id === 'quote' ? '“Your words here”' : s.id === 'caption' ? 'SAY IT LOUD' : s.label === 'Title' ? 'YOUR TITLE' : 'Your text', start: time, duration: s.duration ?? 3, style: s.style, animIn: s.animIn, animOut: s.animOut ?? 'fade', transform: s.y ? { y: s.y } : {} }])}
                >
                  <span className="style-sample" style={s.css}>
                    {s.sample}
                  </span>
                  <span className="style-label">{s.label}</span>
                </button>
              ))}
            </div>
          )}
          {tab === 'text' && now === 'titles' && <ElementsPanel project={project} time={time} onEdit={onEdit} />}
          {tab === 'stickers' && now === 'emoji' && (
            <div className="emoji-grid">
              {EMOJI.map((e) => (
                <button
                  key={e}
                  className="emoji"
                  title="Add this sticker at the playhead"
                  onClick={() =>
                    run([
                      {
                        op: 'add_text',
                        text: e,
                        start: time,
                        duration: 2.5,
                        animIn: 'pop',
                        animOut: 'pop',
                        animSeconds: 0.35,
                        style: { font: 'Segoe UI Emoji', sizePct: 14, weight: 'normal', shadow: 14 },
                        transform: { x: 0.72, y: 0.3, rotation: -8 },
                        loop: { kind: 'float', amount: 0.4, period: 2.4 },
                      },
                    ])
                  }
                >
                  {e}
                </button>
              ))}
            </div>
          )}
          {tab === 'stickers' && now === 'shapes' && <ElementsPanel project={project} time={time} onEdit={onEdit} />}
          {tab === 'effects' && (
            <>
              <p className="small muted lib-note">{sel?.type === 'media' || sel?.type === 'adjust' ? 'Click to put it on the selected clip (click again to take it off).' : 'Click to add it over everything at the playhead (an adjustment layer), or select a clip first.'}</p>
              <div className="lib-grid">
                {EFFECTS.map(([k, label, art]) => {
                  const on = (sel?.type === 'media' || sel?.type === 'adjust') && !!sel.effects?.[k];
                  return (
                    <button
                      key={k}
                      className={`lib-card ${on ? 'on' : ''}`}
                      onClick={() => {
                        if (sel?.type === 'media' || sel?.type === 'adjust') run([{ op: 'set', clip: sel.id, effects: { [k]: on ? null : 0.6 } }]);
                        else run([{ op: 'add_adjust', start: time, duration: 3, effects: { [k]: 0.6 } }]);
                      }}
                    >
                      <span className="lib-card-art" style={{ background: art }} />
                      <span>{label}</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {tab === 'transitions' && <TransitionItems project={project} sel={sel} time={time} onEdit={run} />}
          {tab === 'captions' && now === 'auto' && (
            <div className="lib-pad">
              <p className="small muted">Keo writes captions from the speech, word by word, on the Captions track.</p>
              <button className="btn sm primary" disabled={captioning || !project.assets.some((a) => a.hasAudio)} onClick={onCaptions}>
                {captioning ? <span className="spinner tiny" /> : <Icon name="captions" size={13} />} {captioning ? 'Writing captions…' : 'Auto captions'}
              </button>
              <button className="btn sm" style={{ marginTop: 8 }} onClick={() => onAskKeo('Translate all the captions on screen into another language. Ask me which language first, then keep the same timing and style.')}>
                Translate captions (ask Keo)
              </button>
            </div>
          )}
          {tab === 'captions' && now === 'styles' && <CaptionLooks project={project} onEdit={run} />}
          {tab === 'filters' && (
            <>
              <p className="small muted lib-note">{sel?.type === 'media' ? 'Click to colour the selected clip.' : 'Click to colour every video and picture (or select one clip first).'}</p>
              <div className="lib-grid">
                {(Object.keys(LOOKS) as LookId[]).map((k) => (
                  <button
                    key={k}
                    className="lib-card"
                    onClick={() => {
                      const clips = sel?.type === 'media' ? [sel] : project.tracks.flatMap((t) => t.clips).filter((c): c is Extract<Clip, { type: 'media' }> => c.type === 'media');
                      if (!clips.length) return ui.error('Add a video or picture first.');
                      run(clips.map((c) => ({ op: 'set', clip: c.id, color: { ...LOOKS[k] } })));
                    }}
                  >
                    <span className="lib-card-art" style={{ background: LOOK_SWATCH[k] }} />
                    <span>{LOOK_LABEL[k]}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {tab === 'smart' && now === 'looks' && <Looks onAskKeo={onAskKeo} />}
          {tab === 'smart' && now === 'templates' && <Templates project={project} onAskKeo={onAskKeo} />}
          {tab === 'smart' && now === 'tools' && <Autopilot project={project} time={time} onEdit={onEdit} onBusy={() => undefined} />}
        </div>
      </div>
    </aside>
  );
}

function MediaItems({ project, time, kind, onImport, onAddAsset, onEdit }: { project: Project; time: number; kind: 'all' | 'video' | 'image'; onImport: () => void; onAddAsset: (a: Asset) => void; onEdit: (ops: EditOp[]) => Promise<void> }) {
  const visual = project.assets.filter((a) => a.kind !== 'audio' && (kind === 'all' || a.kind === kind));
  return (
    <>
      {visual.length === 0 ? (
        <button className="lib-import" onClick={onImport}>
          <span className="lib-import-plus">
            <Icon name="plus" size={16} />
          </span>
          <strong>Import</strong>
          <span className="small muted">Drag and drop videos, photos and audio files here</span>
        </button>
      ) : (
        <>
          <div className="lib-bar">
            <button className="btn sm primary" onClick={onImport}>
              <Icon name="plus" size={13} /> Import
            </button>
            <span className="small muted">Drag to the timeline, + to add, or the overlay button for picture-in-picture</span>
          </div>
          <div className="bin-grid">
            {visual.map((a) => (
              <Tile
                key={a.id}
                projectId={project.id}
                asset={a}
                onAdd={() => onAddAsset(a)}
                onOverlay={() => void onEdit([{ op: 'add_media', assetId: a.id, start: time, trackName: 'Overlay', ...(a.kind === 'image' ? { duration: 3 } : {}), transform: { scale: 0.42, x: 0.72, y: 0.24 } }])}
              />
            ))}
          </div>
        </>
      )}
      <div className="bin-tools">
        <button className="btn sm" onClick={() => void onEdit([{ op: 'add_track', kind: 'video' }])}>
          <Icon name="film" size={13} /> Video track
        </button>
      </div>
    </>
  );
}

/** The user's music or sound effects: search, genre, listen, add, sort. */
function SoundItems({ project, kind, time }: { project: Project; kind: 'music' | 'effect'; time: number }) {
  const ui = useUi();
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState('');
  const [list, setList] = useState<Sound[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const load = useCallback(() => void invoke('studio:sounds', { kind, ...(query.trim() ? { query: query.trim() } : {}), ...(genre ? { genre } : {}) }).then(setList).catch(() => undefined), [kind, query, genre]);
  useEffect(load, [load]);
  useEffect(() => () => audio.current?.pause(), []);
  const genres = kind === 'music' ? MUSIC_GENRES : EFFECT_KINDS;
  const add = async () => {
    try {
      const r = await invoke('studio:soundsAdd', { kind });
      if (r.added.length) ui.toast(`Added ${r.added.length} sound${r.added.length === 1 ? '' : 's'} to your library.`, 'success');
      if (r.skipped.length) ui.toast(`Not added: ${r.skipped.slice(0, 3).join('; ')}`, 'error');
      load();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const listen = (s: Sound) => {
    audio.current?.pause();
    if (playing === s.id || s.builtIn) return setPlaying(null);
    const a = new Audio(`app://keo/sound/${s.id}`);
    a.onended = () => setPlaying(null);
    void a.play().catch(() => setPlaying(null));
    audio.current = a;
    setPlaying(s.id);
  };
  const use = async (s: Sound) => {
    try {
      await invoke('studio:soundUse', { id: project.id, sound: s.id, at: kind === 'music' ? 0 : time, role: kind });
      ui.toast(kind === 'music' ? `“${s.name}” is on the Music track, quieter under speech.` : `“${s.name}” added at the playhead.`, 'success');
    } catch (e) {
      ui.error(errText(e));
    }
  };
  return (
    <div className="lib-sounds">
      <div className="lib-bar">
        <div className="lib-search">
          <Icon name="search" size={13} />
          <input className="input" placeholder={kind === 'music' ? 'Search music' : 'Search sound effects'} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="btn sm primary" onClick={() => void add()} title={kind === 'music' ? 'Add songs from this PC to your library (for every project)' : 'Add sound effects from this PC to your library'}>
          <Icon name="plus" size={13} /> Add
        </button>
      </div>
      <div className="lib-chips">
        <button className={!genre ? 'on' : ''} onClick={() => setGenre('')}>
          All
        </button>
        {genres.map((g) => (
          <button key={g} className={genre === g ? 'on' : ''} onClick={() => setGenre(genre === g ? '' : g)}>
            {GENRE_LABEL[g]}
          </button>
        ))}
      </div>
      {list.length === 0 && <p className="small muted lib-note">{query || genre ? 'Nothing matches.' : kind === 'music' ? 'No music yet: click Add to bring in your songs (MP3, M4A, WAV…). Keo keeps them for every project and can choose from them.' : 'No sound effects yet.'}</p>}
      <div className="bin-list">
        {list.map((s) => (
          <div key={s.id} className="bin-item sound-row">
            <button className="btn icon sm ghost" onClick={() => listen(s)} disabled={!!s.builtIn} title={s.builtIn ? 'Keo makes this one when it is used' : playing === s.id ? 'Stop' : 'Listen'}>
              <Icon name={playing === s.id ? 'pause' : 'play'} size={13} />
            </button>
            <div className="bin-info">
              <span className="bin-name" title={s.name}>
                {s.name}
              </span>
              <span className="small muted">
                {GENRE_LABEL[s.genre]} · {fmt(s.duration)}
              </span>
            </div>
            {!s.builtIn && (
              <select
                className="select sound-genre"
                value={s.genre}
                title="What kind of sound this is (so you and Keo find it)"
                onChange={(e) => void invoke('studio:soundUpdate', { sound: s.id, genre: e.target.value }).then(load).catch((err) => ui.error(errText(err)))}
              >
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {GENRE_LABEL[g]}
                  </option>
                ))}
              </select>
            )}
            <button className="btn icon sm ghost" onClick={() => void use(s)} title={kind === 'music' ? 'Put it under the video' : 'Add at the playhead'}>
              <Icon name="plus" size={13} />
            </button>
            {!s.builtIn && (
              <button className="btn icon sm ghost" title="Take it out of your library" onClick={() => void invoke('studio:soundDelete', { sound: s.id }).then(load).catch((err) => ui.error(errText(err)))}>
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ProjectSounds({ project, onAddAsset, sel, onEdit }: { project: Project; onAddAsset: (a: Asset) => void; sel: Clip | null; onEdit: (ops: EditOp[]) => void }) {
  const sounds = project.assets.filter((a) => a.kind === 'audio');
  return (
    <div>
      {sel?.type === 'media' && project.assets.find((a) => a.id === sel.assetId)?.hasAudio && sel.volume > 0 && (
        <div className="lib-pad">
          <button className="btn sm" onClick={() => onEdit([{ op: 'detach_audio', clip: sel.id }])}>
            Extract the sound of the selected video
          </button>
        </div>
      )}
      {sounds.length === 0 && <p className="small muted lib-note">No sounds in this project yet.</p>}
      <div className="bin-list">
        {sounds.map((a) => (
          <div
            key={a.id}
            className="bin-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-keo-asset', a.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onDoubleClick={() => onAddAsset(a)}
          >
            <span className="bin-thumb audio">
              <Icon name="music" size={16} />
            </span>
            <div className="bin-info">
              <span className="bin-name">{a.name}</span>
              <span className="small muted">{fmt(a.duration)}</span>
            </div>
            <button className="btn icon sm ghost" onClick={() => onAddAsset(a)} title="Add at the playhead">
              <Icon name="plus" size={13} />
            </button>
          </div>
        ))}
      </div>
      <div className="bin-tools">
        <button className="btn sm" onClick={() => onEdit([{ op: 'add_track', kind: 'audio' }])}>
          <Icon name="music" size={13} /> Audio track
        </button>
      </div>
    </div>
  );
}

function TransitionItems({ project, sel, time, onEdit }: { project: Project; sel: Clip | null; time: number; onEdit: (ops: EditOp[]) => void }) {
  const ui = useUi();
  const cutClips = project.tracks.flatMap((t) => (t.kind === 'video' ? t.clips.filter((c) => c.type === 'media' && t.clips.some((o) => o.id !== c.id && o.type === 'media' && Math.abs(o.start + o.duration - c.start) < 0.05)) : []));
  const cuts = cutClips.map((c) => c.id);
  // The selected clip after a cut, else the cut nearest the playhead.
  const target = sel?.type === 'media' && cuts.includes(sel.id) ? sel : ([...cutClips].sort((a, b) => Math.abs(a.start - time) - Math.abs(b.start - time))[0] ?? null);
  const secondsOf = (k: (typeof TRANSITIONS)[number]) => (k === 'whip' || k === 'flash' ? 0.35 : 0.6);
  return (
    <>
      <p className="small muted lib-note">{!target ? 'Put two clips one after the other first.' : sel?.id === target.id ? 'Click to change into the selected clip with it.' : `Click to put it on the cut at ${target.start.toFixed(1)} s (nearest the playhead), or select the clip after another cut.`}</p>
      <div className="lib-grid">
        {TRANSITIONS.map((k) => (
          <button
            key={k}
            className={`lib-card ${target?.type === 'media' && target.transition?.kind === k ? 'on' : ''}`}
            onClick={() => (target ? onEdit([{ op: 'set', clip: target.id, transition: { kind: k, seconds: secondsOf(k) } }]) : ui.error(cuts.length ? 'Select the clip right after a cut first.' : 'There are no cuts yet.'))}
            onDoubleClick={() => cuts.length && onEdit(cuts.map((clip) => ({ op: 'set', clip, transition: { kind: k, seconds: secondsOf(k) } })))}
            title={`${TRANSITION_LABEL[k]} — double-click to put it on every cut`}
          >
            <span className={`lib-card-art tr-${k}`} />
            <span>{TRANSITION_LABEL[k]}</span>
          </button>
        ))}
      </div>
      {cuts.length > 0 && <p className="small muted lib-note">Double-click a transition to put it on all {cuts.length} cuts.</p>}
    </>
  );
}

function CaptionLooks({ project, onEdit }: { project: Project; onEdit: (ops: EditOp[]) => void }) {
  const ui = useUi();
  const lines = project.tracks.filter((t) => t.kind === 'text' && t.name === CAPTIONS_TRACK).flatMap((t) => t.clips);
  return (
    <>
      <p className="small muted lib-note">{lines.length ? `Click a look to give all ${lines.length} caption lines that style.` : 'Add captions first (Auto captions).'}</p>
      <div className="lib-grid">
        {CAPTION_LOOKS.map((l) => (
          <button
            key={l.id}
            className="lib-card"
            onClick={() => (lines.length ? onEdit(lines.map((c) => ({ op: 'set' as const, clip: c.id, style: l.style, highlight: l.highlight ?? null, ...(l.y !== undefined ? { transform: { y: l.y } } : {}) }))) : ui.error('There are no captions yet.'))}
          >
            <span className="lib-card-art caption-art">
              <span style={l.css}>Say it</span>
            </span>
            <span>{l.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
