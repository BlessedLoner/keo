import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stepStates, type SceneStyle, type VisualGuide, type VisualScene } from '@shared/scene';
import type { ViewerInfo } from '../../../../kits/scene/viewer';
import { Icon } from './Icon';
import { errText, invoke } from '../lib/api';
import { voice } from '../lib/voice';

type ViewerModule = typeof import('../../../../kits/scene/viewer');
/** The 3D viewer is loaded the first time an explanation is shown, never at start-up. */
let viewerModule: Promise<ViewerModule> | null = null;
const loadViewer = () => (viewerModule ??= import('../../../../kits/scene/viewer'));

/** How steps are read aloud (from the user's voice settings); null: silently. */
export type Speech = { engine: 'system' | 'openai' | 'keo' | 'none'; systemVoice: string } | null;

const toBytes = (b64: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
/** A realistic model Keo made, by name. */
const loadModel = (name: string) => invoke('visual:file', { kind: 'model', name }).then((r) => toBytes(r.dataBase64).buffer);

function useSpeech(speech: Speech) {
  const can = !!speech && speech.engine !== 'none';
  const [sound, setSound] = useState(can);
  const on = useRef(can);
  on.current = sound && can;
  const say = useCallback((text: string) => (on.current && speech ? voice.speak(text, speech.engine, speech.systemVoice) : undefined), [speech]);
  const toggle = () => {
    if (sound) voice.stopSpeaking();
    setSound(!sound);
  };
  return { can, sound, say, toggle };
}

/**
 * A visual explanation in the chat: a box with a picture of the scene, like a picture Keo made.
 * Clicking it opens the explanation large, where it plays step by step.
 */
export function VisualBox({ scene, speech, onStudio }: { scene: VisualScene; speech: Speech; onStudio?: (scene: VisualScene) => Promise<void> }) {
  const states = useMemo(() => stepStates(scene), [scene]);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    loadViewer()
      .then((m) => live && setThumb(m.sceneThumbnail(scene, states, 960, 540, { quality: 'fast' })))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [scene, states]);
  const seconds = Math.round(scene.steps.reduce((n, s) => n + s.seconds, 0));
  return (
    <figure className="visual-box">
      <button className="visual-thumb" onClick={() => setOpen(true)} aria-label={`Open the 3D explanation: ${scene.title}`}>
        {thumb ? <img src={thumb} alt="" /> : <span className="visual-wait">{failed ? 'This computer could not draw the 3D picture.' : <span className="spinner" />}</span>}
        <span className="visual-play">
          <Icon name="play" size={22} />
        </span>
        <span className="visual-chip">
          3D · {scene.steps.length} steps · {seconds}s
        </span>
      </button>
      <figcaption>
        <strong>{scene.title}</strong>
        {scene.about && <span className="muted"> — {scene.about}</span>}
      </figcaption>
      {open && <VisualPlayer scene={scene} speech={speech} onClose={() => setOpen(false)} onStudio={onStudio} />}
    </figure>
  );
}

export const STYLE_NAMES: Record<SceneStyle, string> = { reveal: 'Build reveal', clay: 'White model', real: 'Realistic' };

/** A photoreal picture of the finished result: asked, being made, or made. */
type RealPicture = { state: 'asking'; price: string } | { state: 'making' } | { state: 'made'; url: string; file: string } | null;

/** The explanation, large: it plays each step while its caption is shown and read aloud; drag to look around. */
export function VisualPlayer({ scene: given, speech, onClose, onStudio, inline = false }: { scene: VisualScene; speech: Speech; onClose?: () => void; onStudio?: (scene: VisualScene) => Promise<void>; inline?: boolean }) {
  // The look can be switched while watching; the explanation carries on from the same step.
  const [look, setLook] = useState<SceneStyle>(given.style ?? 'real');
  useEffect(() => setLook(given.style ?? 'real'), [given]);
  const scene = useMemo(() => ({ ...given, style: look }), [given, look]);
  const states = useMemo(() => stepStates(given), [given]);
  const atStep = useRef(0);
  const [real, setReal] = useState<RealPicture>(null);
  const holder = useRef<HTMLDivElement>(null);
  const viewer = useRef<InstanceType<ViewerModule['SceneViewer']> | null>(null);
  const sp = useSpeech(speech);
  const say = useRef(sp.say);
  say.current = sp.say;
  const [info, setInfo] = useState<ViewerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadViewer()
      .then((m) => {
        if (!live || !holder.current) return;
        const v = new m.SceneViewer(holder.current, scene, states, {
          onChange: (i) => {
            atStep.current = i.step;
            if (live) setInfo(i);
          },
          // The step waits for its sentence to be said, so words and movement stay together.
          onStep: (_i, step) => say.current(step.say),
          loadModel,
        });
        viewer.current = v;
        if (atStep.current) v.goTo(atStep.current);
        setInfo(v.info());
        v.play();
      })
      .catch((e: unknown) => live && setError(errText(e)));
    return () => {
      live = false;
      voice.stopSpeaking();
      viewer.current?.dispose();
      viewer.current = null;
    };
  }, [scene, states]);

  const toggle = () => {
    const v = viewer.current;
    if (!v) return;
    if (v.info().playing) {
      voice.stopSpeaking();
      v.pause();
    } else v.play();
  };
  const jump = (i: number) => {
    voice.stopSpeaking();
    viewer.current?.goTo(i);
  };
  const go = (by: number) => {
    const v = viewer.current;
    if (v) jump(v.info().step + by);
  };

  useEffect(() => {
    if (inline) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === ' ') {
        e.preventDefault();
        toggle();
      }
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const toStudio = async () => {
    if (!onStudio) return;
    setBusy(true);
    setNote(null);
    try {
      voice.stopSpeaking();
      viewer.current?.pause();
      await onStudio(scene);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // The photoreal picture: the user sees the price first; the finished scene, drawn plainly, is what is sent.
  const askReal = async () => {
    setNote(null);
    try {
      const i = await invoke('visual:renderInfo', {});
      if (!i.available) setNote(i.why);
      else setReal({ state: 'asking', price: i.price });
    } catch (e) {
      setNote(errText(e));
    }
  };
  const makeReal = async () => {
    setReal({ state: 'making' });
    try {
      const m = await loadViewer();
      const picture = m.sceneThumbnail({ ...given, style: 'real' }, states, 1536, 864);
      const r = await invoke('visual:render', { image: picture.slice(picture.indexOf(',') + 1), title: given.title, about: given.about });
      setReal({ state: 'made', url: `data:image/png;base64,${r.dataBase64}`, file: r.file });
      voice.stopSpeaking();
      viewer.current?.pause();
    } catch (e) {
      setReal(null);
      setNote(errText(e));
    }
  };

  const body = (
    <div className={`visual-player${inline ? ' inline' : ''}`} onClick={(e) => e.stopPropagation()}>
      <header>
        <strong>{scene.title}</strong>
        <span className="grow" />
        <select className="select sm visual-look" value={look} onChange={(e) => setLook(e.target.value as SceneStyle)} title="How the scene is drawn" aria-label="Look">
          {(Object.keys(STYLE_NAMES) as SceneStyle[]).map((k) => (
            <option key={k} value={k}>
              {STYLE_NAMES[k]}
            </option>
          ))}
        </select>
        <button className="btn ghost sm" onClick={() => void askReal()} disabled={real?.state === 'making'} title="A photoreal picture of the finished result, made by AI from this scene">
          {real?.state === 'making' ? 'Making the picture…' : 'Photoreal picture'}
        </button>
        {sp.can && (
          <button className="btn ghost sm" onClick={sp.toggle} title={sp.sound ? 'Stop reading the steps aloud' : 'Read the steps aloud'}>
            {sp.sound ? 'Voice on' : 'Voice off'}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => viewer.current?.resetView()} title="Go back to the explanation’s own view">
          Reset view
        </button>
        {onStudio && (
          <button className="btn ghost sm" onClick={() => void toStudio()} disabled={busy} title="Put this scene on a Keo Studio timeline, to change it and save it as a video">
            {busy ? 'Opening…' : 'Open in Studio'}
          </button>
        )}
        {onClose && (
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        )}
      </header>
      <div className="visual-stage" ref={holder}>
        {error && <div className="visual-wait">This computer could not draw the 3D picture: {error}</div>}
        {real?.state === 'made' && (
          <div className="visual-real">
            <img src={real.url} alt={`A photoreal picture of ${given.title}`} />
            <div className="visual-real-bar">
              <span className="small">Photoreal picture · saved in Documents\Keo\Visuals\Renders</span>
              <span className="grow" />
              <button className="btn sm" onClick={() => setReal(null)}>
                Back to 3D
              </button>
            </div>
          </div>
        )}
      </div>
      {real?.state === 'asking' && (
        <div className="visual-ask">
          <span>
            Make a photoreal picture of the finished result? It costs about {real.price}. AI keeps the design but may change small details.
          </span>
          <span className="grow" />
          <button className="btn primary sm" onClick={() => void makeReal()}>
            Make it
          </button>
          <button className="btn ghost sm" onClick={() => setReal(null)}>
            Cancel
          </button>
        </div>
      )}
      {real?.state === 'making' && <div className="visual-ask"><span className="spinner" /> Making a photoreal picture of the finished result — about a minute.</div>}
      {info && (
        <footer>
          <div className="visual-caption">
            <span className="visual-step">
              {info.step + 1} of {info.steps} · {info.title}
            </span>
            <p>{info.say}</p>
          </div>
          {note && <div className="small" style={{ color: 'var(--danger, #ff5d6c)' }}>{note}</div>}
          <Controls step={info.step} steps={scene.steps.map((s) => s.title)} playing={info.playing} done={info.done} onPrev={() => go(-1)} onNext={() => go(1)} onToggle={toggle} onJump={jump} hint="Drag to look around · scroll to zoom" />
        </footer>
      )}
    </div>
  );
  if (inline) return body;
  return (
    <div className="visual-lightbox" role="dialog" aria-label={scene.title} onClick={onClose}>
      {body}
    </div>
  );
}

function Controls(p: { step: number; steps: string[]; playing: boolean; done: boolean; onPrev(): void; onNext(): void; onToggle(): void; onJump(i: number): void; hint: string }) {
  return (
    <div className="visual-controls">
      <button className="btn sm" onClick={p.onPrev} disabled={p.step === 0} aria-label="Previous step">
        ‹
      </button>
      <button className="btn primary sm" onClick={p.onToggle}>
        {p.playing ? 'Pause' : p.done ? 'Play again' : 'Play'}
      </button>
      <button className="btn sm" onClick={p.onNext} disabled={p.step >= p.steps.length - 1} aria-label="Next step">
        ›
      </button>
      <div className="visual-dots">
        {p.steps.map((title, i) => (
          <button key={i} className={i === p.step ? 'on' : i < p.step ? 'past' : ''} onClick={() => p.onJump(i)} title={title} aria-label={`Step ${i + 1}: ${title}`} />
        ))}
      </div>
      <span className="muted small">{p.hint}</span>
    </div>
  );
}

/** A guide's page pictures, fetched once each (as object URLs, let go of when the guide closes). */
function useShots(guide: VisualGuide): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    for (const id of new Set(guide.steps.flatMap((s) => (s.shot ? [s.shot] : []))))
      invoke('visual:file', { kind: 'shot', name: id })
        .then((r) => {
          const url = URL.createObjectURL(new Blob([toBytes(r.dataBase64)], { type: r.mimeType }));
          made.push(url);
          if (live) setUrls((u) => ({ ...u, [id]: url }));
        })
        .catch(() => undefined);
    return () => {
      live = false;
      for (const u of made) URL.revokeObjectURL(u);
    };
  }, [guide]);
  return urls;
}

/** A how-to guide in the chat: a box with the first page picture; clicking it opens the guide large. */
export function GuideBox({ guide, speech }: { guide: VisualGuide; speech: Speech }) {
  const urls = useShots(guide);
  const [open, setOpen] = useState(false);
  const first = guide.steps.find((s) => s.shot)?.shot;
  return (
    <figure className="visual-box">
      <button className="visual-thumb" onClick={() => setOpen(true)} aria-label={`Open the guide: ${guide.title}`}>
        {first && urls[first] ? <img src={urls[first]} alt="" style={{ objectPosition: 'top' }} /> : <span className="visual-wait">{first ? <span className="spinner" /> : guide.title}</span>}
        <span className="visual-play">
          <Icon name="play" size={22} />
        </span>
        <span className="visual-chip">Guide · {guide.steps.length} steps</span>
      </button>
      <figcaption>
        <strong>{guide.title}</strong>
        {guide.about && <span className="muted"> — {guide.about}</span>}
      </figcaption>
      {open && <GuidePlayer guide={guide} speech={speech} onClose={() => setOpen(false)} />}
    </figure>
  );
}

/** The guide, large: each step shows the real page with the place to act outlined, while its sentence is shown and read aloud. */
export function GuidePlayer({ guide, speech, onClose, inline = false }: { guide: VisualGuide; speech: Speech; onClose?: () => void; inline?: boolean }) {
  const urls = useShots(guide);
  const sp = useSpeech(speech);
  const say = useRef(sp.say);
  say.current = sp.say;
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [done, setDone] = useState(false);
  const s = guide.steps[step]!;

  // A step stays long enough to be read, and at least until its sentence has been said.
  useEffect(() => {
    if (!playing) return;
    let live = true;
    const said = Promise.resolve(say.current(s.say)).catch(() => undefined);
    const shown = new Promise((r) => setTimeout(r, Math.max(3500, s.say.length * 55)));
    void Promise.all([said, shown]).then(() => {
      if (!live) return;
      if (step + 1 < guide.steps.length) setStep(step + 1);
      else {
        setPlaying(false);
        setDone(true);
      }
    });
    return () => {
      live = false;
    };
  }, [step, playing, guide, s.say]);
  useEffect(() => () => voice.stopSpeaking(), []);

  const jump = (i: number) => {
    voice.stopSpeaking();
    setDone(false);
    setStep(Math.max(0, Math.min(guide.steps.length - 1, i)));
  };
  const toggle = () => {
    if (playing) {
      voice.stopSpeaking();
      setPlaying(false);
    } else {
      if (done) jump(0);
      setPlaying(true);
    }
  };
  useEffect(() => {
    if (inline) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose?.();
      if (e.key === 'ArrowRight') jump(step + 1);
      if (e.key === 'ArrowLeft') jump(step - 1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const url = s.shot ? urls[s.shot] : undefined;
  const body = (
    <div className={`visual-player${inline ? ' inline' : ''}`} onClick={(e) => e.stopPropagation()}>
      <header>
        <strong>{guide.title}</strong>
        <span className="grow" />
        {sp.can && (
          <button className="btn ghost sm" onClick={sp.toggle}>
            {sp.sound ? 'Voice on' : 'Voice off'}
          </button>
        )}
        {guide.site && (
          <button className="btn ghost sm" onClick={() => void invoke('app:openUrl', { url: guide.site }).catch(() => undefined)} title={guide.site}>
            Open the site
          </button>
        )}
        {onClose && (
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        )}
      </header>
      <div className="visual-stage guide-stage">
        {url ? (
          <div className="guide-shot" key={step}>
            <img src={url} alt="" />
            {s.box && <span className="guide-mark" style={{ left: `${s.box.x * 100}%`, top: `${s.box.y * 100}%`, width: `${s.box.w * 100}%`, height: `${s.box.h * 100}%` }} />}
          </div>
        ) : (
          <div className="visual-wait">{s.shot ? <span className="spinner" /> : 'No picture for this step.'}</div>
        )}
      </div>
      <footer>
        <div className="visual-caption">
          <span className="visual-step">
            {step + 1} of {guide.steps.length} · {s.title}
          </span>
          <p>{s.say}</p>
        </div>
        <Controls step={step} steps={guide.steps.map((x) => x.title)} playing={playing} done={done} onPrev={() => jump(step - 1)} onNext={() => jump(step + 1)} onToggle={toggle} onJump={jump} hint="The outline shows where to click or type" />
      </footer>
    </div>
  );
  if (inline) return body;
  return (
    <div className="visual-lightbox" role="dialog" aria-label={guide.title} onClick={onClose}>
      {body}
    </div>
  );
}
