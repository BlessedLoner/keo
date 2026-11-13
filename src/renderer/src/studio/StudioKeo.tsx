import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, Task, ToolActivity } from '@shared/domain';
import { findClip, type Project, type StudioAsk, type StudioDirection } from '@shared/studio';
import { useFilmstrip } from './thumbs';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ApprovalCard } from '../components/TaskWidgets';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { explainReplyError } from '@shared/friendlyErrors';

/**
 * Ask Keo, inside Studio: the user says what they want and Keo edits this project while they
 * watch — its reply, what it is doing step by step, the approvals it needs, and a Stop button.
 * One conversation per project; Keo knows the playhead and the selection.
 */

const CHIPS: Array<{ label: string; text: string; needs?: 'media' | 'speech' }> = [
  { label: 'Edit this for TikTok', text: 'Edit this into a punchy vertical video for TikTok: cut the pauses, ums and retakes, clean the voice, add bold word-by-word captions, punch-ins and a colour look. Show me your steps.', needs: 'speech' },
  { label: 'Cut pauses & ums', text: 'Cut the long pauses, filler words and retakes.', needs: 'speech' },
  { label: 'Add captions', text: 'Add word-by-word captions in a bold short-form style.', needs: 'speech' },
  { label: 'Hook title', text: 'Add a strong hook title in the first 2 seconds that fits what this video is about.', needs: 'media' },
  { label: 'Make it pop', text: 'Make it more engaging: motion on the pictures, a few sound effects on the cuts, and a colour look that fits.', needs: 'media' },
  { label: 'Translate captions', text: 'Translate all the captions on screen into another language. Ask me which language first, then keep the same timing and style.', needs: 'media' },
  { label: 'Make shorts', text: 'This is a long video: read the transcript and find the 3 best moments for shorts (each 15–90 seconds, a complete thought with a strong hook). Tell me the moments and why, then make each into its own vertical short with a hook title.', needs: 'speech' },
  { label: 'Check my video', text: 'Look at my video carefully and tell me what to improve before I post it. Do not change anything yet.', needs: 'media' },
  { label: 'Swap in my character', text: 'Replace the person in the video clip I selected with one of my characters (ask me which one, and tell me the price before you start).', needs: 'media' },
];

const OUTCOME_ICON: Record<ToolActivity['outcome'], string> = {
  executed: '✓',
  failed: '!',
  awaiting_authorization: '⏸',
  denied: '✕',
  rejected: '✕',
  uncertain: '?',
  proposed: '…',
};

/** Keo's open question per project (kept while the user looks elsewhere in Studio). */
const asks = new Map<string, StudioAsk>();

/** What the user can ask about the clip they selected (sent with the clip's id). */
const CLIP_ACTIONS: Array<{ label: string; text: string; kinds: Array<'media' | 'text' | 'audio' | 'other'> }> = [
  { label: 'Trim tighter', text: 'Trim this clip tighter: cut the slow start and end so it gets to the point.', kinds: ['media', 'audio'] },
  { label: 'Add motion', text: 'Give this clip motion that fits it: a slow push, a punch-in on the key moment, or a gentle pan.', kinds: ['media'] },
  { label: 'Speed ramp', text: 'Give this clip a cinematic speed ramp (fast, then slow on the key moment).', kinds: ['media'] },
  { label: 'Cover with B-roll', text: 'Cover part of this clip with B-roll that matches what is said or shown here (from my media, or ask me).', kinds: ['media'] },
  { label: 'Colour it', text: 'Grade this clip so it looks cinematic and matches the rest of the video (use the pro colour tools).', kinds: ['media'] },
  { label: 'Remove background', text: 'Remove the background of this clip so only the person shows, and put a clean background behind it.', kinds: ['media'] },
  { label: 'Animate it', text: 'Make this text come in and go out with an animation that fits the video.', kinds: ['text', 'other'] },
  { label: 'Restyle', text: 'Restyle this text so it looks like a premium title for this video.', kinds: ['text'] },
  { label: 'Clean the sound', text: 'Clean the sound of this clip: remove the noise and make the voice clear.', kinds: ['audio'] },
];

/** A creative director's first move: the kind of video, as a brief Keo turns into directions. */
const STARTERS: Array<{ label: string; text: string }> = [
  { label: 'Luxury promo', text: 'Turn my clips into a luxury promotional video for my brand: cinematic, elegant transitions, suitable music and animated captions.' },
  { label: 'Cinematic travel', text: 'Make a cinematic travel film from my clips: beautiful colour, music-led pacing and smooth transitions.' },
  { label: 'Product showcase', text: 'Make a product showcase ad: hook in the first 2 seconds, clear benefits, close-ups, and a strong end card.' },
  { label: 'YouTube intro', text: 'Make a 6–10 second YouTube intro with my name, bold motion titles and a punchy sound.' },
  { label: 'Social reel', text: 'Make a fast, engaging vertical reel for TikTok and Instagram: cut on the beat, captions and a strong hook.' },
];

/** Keo's chat for this project (or, while Keo carries a task across projects, the chat it started in). */
export function StudioKeo({ project, conversation, selected = null }: { project: Project; conversation?: string | null; selected?: string | null }) {
  const ui = useUi();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<{ text: string; tools: ToolActivity[]; phase: string | null } | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState('');
  const [question, setQuestion] = useState<StudioAsk | null>(asks.get(project.id) ?? null);
  useEffect(() => setQuestion(asks.get(project.id) ?? null), [project.id]);
  useEffect(
    () =>
      subscribe('studio:ask', (a) => {
        asks.set(a.projectId, a);
        if (a.projectId === project.id) setQuestion(a);
      }),
    [project.id],
  );
  const [watchEdits, setWatchEdits] = useState(true);
  useEffect(() => {
    void invoke('studio:liveEdits', {})
      .then((r) => setWatchEdits(r.on))
      .catch(() => undefined);
  }, []);
  const list = useRef<HTMLDivElement>(null);
  const convRef = useRef<string | null>(null);
  convRef.current = conversationId;

  useEffect(() => {
    setConversationId(null);
    setMessages([]);
    setLive(null);
    if (conversation) {
      setConversationId(conversation);
      return;
    }
    void invoke('studio:conversation', { id: project.id })
      .then((r) => setConversationId(r.conversationId))
      .catch((e) => ui.error(errText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, conversation]);

  const loadMessages = useCallback(async () => {
    const id = convRef.current;
    if (!id) return;
    setMessages((await invoke('conversations:messages', { id }).catch(() => [])).filter((m) => m.role === 'user' || m.role === 'assistant').slice(-40));
  }, []);
  const loadTasks = useCallback(async () => {
    const id = convRef.current;
    if (!id) return;
    setTasks((await invoke('tasks:list', { limit: 60 }).catch(() => [])).filter((t) => t.conversationId === id && t.steps.some((s) => s.state === 'awaiting_authorization')));
  }, []);
  useEffect(() => {
    void loadMessages();
    void loadTasks();
    if (!conversationId) return;
    void invoke('chat:active', {})
      .then((ids) => (ids as string[]).includes(conversationId) && setLive((l) => l ?? { text: '', tools: [], phase: 'thinking' }))
      .catch(() => undefined);
  }, [conversationId, loadMessages, loadTasks]);

  useEffect(() => {
    const offs = [
      subscribe('agent:event', (e) => {
        if (e.conversationId !== convRef.current) return;
        if (e.type === 'turn_started') setLive({ text: '', tools: [], phase: 'thinking' });
        else if (e.type === 'text_delta') setLive((l) => ({ ...(l ?? { tools: [], phase: null }), text: (l?.text ?? '') + e.delta }));
        else if (e.type === 'tool_activity') setLive((l) => ({ ...(l ?? { text: '', phase: null }), tools: [...(l?.tools ?? []).filter((t) => t.callId !== e.activity.callId), e.activity] }));
        else if (e.type === 'phase') setLive((l) => ({ ...(l ?? { text: '', tools: [] }), phase: e.phase }));
        else if (e.type === 'turn_finished') {
          setLive(null);
          void loadMessages();
        }
      }),
      subscribe('conversations:changed', (c) => {
        if (!c.conversationId || c.conversationId === convRef.current) void loadMessages();
      }),
      subscribe('tasks:changed', () => void loadTasks()),
    ];
    return () => offs.forEach((o) => o());
  }, [loadMessages, loadTasks]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, live, tasks]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || !conversationId) return;
    setDraft('');
    // An answer (clicked or typed) closes Keo's question.
    asks.delete(project.id);
    setQuestion(null);
    setLive({ text: '', tools: [], phase: 'thinking' });
    try {
      await invoke('chat:send', { conversationId, text: t });
    } catch (e) {
      setLive(null);
      ui.error(errText(e));
    }
  };
  // A request from elsewhere in Studio (a library button): sent like a typed one.
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const ask = (e: Event) => void sendRef.current(String((e as CustomEvent).detail ?? ''));
    window.addEventListener('keo:ask', ask);
    return () => window.removeEventListener('keo:ask', ask);
  }, []);
  const busy = !!live;
  const stop = () => conversationId && void invoke('chat:cancel', { conversationId }).catch(() => undefined);

  const hasMedia = project.assets.some((a) => a.kind !== 'audio') || project.tracks.some((t) => t.clips.length);
  const hasSpeech = project.assets.some((a) => a.hasAudio);
  const chips = CHIPS.filter((c) => !c.needs || (c.needs === 'media' ? hasMedia : hasSpeech));
  const selClip = selected ? findClip(project, selected)?.clip : undefined;
  const selKind: 'media' | 'text' | 'audio' | 'other' = !selClip ? 'other' : selClip.type === 'media' ? 'media' : selClip.type === 'text' ? 'text' : selClip.type === 'audio' ? 'audio' : 'other';
  const toggleWatch = async (on: boolean) => {
    setWatchEdits(on);
    setWatchEdits((await invoke('studio:liveEdits', { on }).catch(() => ({ on }))).on);
  };

  return (
    <div className="studio-keo">
      <label className="keo-watch" title="On: Keo edits on the timeline step by step while you watch (the playhead moves to each cut, split and caption). Off: Keo works out of sight and the finished edit appears at once.">
        <input type="checkbox" checked={watchEdits} onChange={(e) => void toggleWatch(e.target.checked)} /> Watch Keo edit
      </label>
      <div className="keo-list" ref={list}>
        {messages.length === 0 && !live && (
          <div className="keo-hello">
            <p>
              <strong>Describe your vision.</strong> Keo is your creative director: it reads your clips, offers directions to choose from, shows the storyboard, then builds an edit you can change piece by piece.
            </p>
            <div className="keo-starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="keo-starter" onClick={() => setDraft(s.text)} title={s.text}>
                  {s.label}
                </button>
              ))}
            </div>
            <p className="small muted">Keo knows where your playhead is and what you selected: “make this part faster”, “put a title here”, “use a warmer look on the selected clips”.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`keo-msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content || (m.status === 'error' ? (({ what, todo }) => `${what} ${todo}`)(explainReplyError(m.meta.errorKind, m.meta.error)) : '')} /> : <p>{m.content}</p>}
            {m.role === 'assistant' && !!m.meta.tools?.length && <ToolLines tools={m.meta.tools} />}
          </div>
        ))}
        {live && (
          <div className="keo-msg assistant live">
            {live.text ? <Markdown text={live.text} /> : <p className="muted small">{live.phase === 'tool' ? 'Working on the video…' : live.phase === 'waiting_approval' ? 'Waiting for your OK…' : 'Thinking…'}</p>}
            {!!live.tools.length && <ToolLines tools={live.tools} />}
          </div>
        )}
        {question && (
          <div className="keo-ask">
            <p className="keo-ask-q">{question.question}</p>
            {!!question.directions?.length && <Directions list={question.directions} disabled={!conversationId || busy} onPick={(d) => void send(`Use the direction “${d.name}”.`)} />}
            {!!question.plan?.length && question.plan.some((x) => x.asset) && <Storyboard project={project} plan={question.plan} />}
            {!!question.plan?.length && !question.plan.some((x) => x.asset) && (
              <ol className="keo-plan">
                {question.plan.map((s, i) => (
                  <li key={i}>
                    <span className="keo-plan-at">{s.at}</span>
                    <span>{s.what}</span>
                  </li>
                ))}
              </ol>
            )}
            <div className="keo-ask-options">
              {question.options.map((o, i) => (
                <button key={o} className={`btn sm${i === 0 ? ' primary' : ''}`} onClick={() => void send(o)} disabled={!conversationId || busy}>
                  {o}
                </button>
              ))}
            </div>
            <p className="small muted">Or type your own answer below.</p>
          </div>
        )}
        {tasks.flatMap((t) =>
          t.steps
            .filter((s) => s.state === 'awaiting_authorization')
            .map((s) => (
              <div key={s.id} className="keo-approval">
                <ApprovalCard task={t} step={s} />
              </div>
            )),
        )}
      </div>
      {!busy && !question && selClip && (
        <div className="keo-clip-actions">
          <span className="small muted">This clip:</span>
          {CLIP_ACTIONS.filter((a) => a.kinds.includes(selKind)).map((a) => (
            <button key={a.label} className="btn sm" onClick={() => void send(`${a.text} (the selected clip ${selClip.id})`)} disabled={!conversationId}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {!busy && !question && chips.length > 0 && !selClip && (
        <div className="keo-chips">
          {chips.map((c) => (
            <button key={c.label} className="btn sm" onClick={() => void send(c.text)} disabled={!conversationId}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="keo-input"
        onSubmit={(e) => {
          e.preventDefault();
          void send(draft);
        }}
      >
        <textarea
          className="textarea"
          rows={2}
          value={draft}
          placeholder={busy ? 'Keo is working… you can still type' : 'Ask Keo to edit… e.g. “cut the boring parts and add captions”'}
          maxLength={4000}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(draft);
            }
          }}
          aria-label="Ask Keo"
        />
        {busy ? (
          <button type="button" className="btn sm danger" onClick={stop} title="Stop Keo">
            <Icon name="stop" size={13} /> Stop
          </button>
        ) : (
          <button type="submit" className="btn sm primary" disabled={!draft.trim() || !conversationId}>
            <Icon name="send" size={13} /> Ask
          </button>
        )}
      </form>
    </div>
  );
}

function ToolLines({ tools }: { tools: ToolActivity[] }) {
  return (
    <ul className="keo-tools">
      {tools.map((t) => (
        <li key={t.callId} className={t.outcome}>
          <span className="keo-tool-mark">{OUTCOME_ICON[t.outcome]}</span>
          <span>{t.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** Directions for a whole edit, as cards: how much it moves, how fast it is cut, how hard it hits. */
export function Directions({ list, disabled, onPick }: { list: StudioDirection[]; disabled: boolean; onPick: (d: StudioDirection) => void }) {
  const meter = (label: string, v: number) => (
    <div className="dir-meter">
      <span>{label}</span>
      <i>
        {[1, 2, 3, 4, 5].map((n) => (
          <b key={n} className={n <= v ? 'on' : ''} />
        ))}
      </i>
    </div>
  );
  return (
    <div className="dir-cards">
      {list.map((d, i) => (
        <button key={d.name} className={`dir-card${i === 0 ? ' pick' : ''}`} style={{ ['--dir' as string]: d.accent ?? '#7a8cff' }} disabled={disabled} onClick={() => onPick(d)}>
          {i === 0 && <span className="dir-badge">Keo’s pick</span>}
          <strong>{d.name}</strong>
          <span className="dir-about">{d.about}</span>
          {(d.look || d.music) && (
            <span className="dir-tags">
              {d.look && <em>{d.look}</em>}
              {d.music && <em>♪ {d.music}</em>}
            </span>
          )}
          {meter('Motion', d.motion)}
          {meter('Pace', d.pace)}
          {meter('Impact', d.impact)}
        </button>
      ))}
    </div>
  );
}

/** Keo's plan as a storyboard: a real frame of the media each moment shows, its time and what happens. */
function Storyboard({ project, plan }: { project: Project; plan: NonNullable<StudioAsk['plan']> }) {
  return (
    <div className="storyboard">
      {plan.map((s, i) => (
        <figure key={i} className="sb-shot">
          <ShotFrame project={project} assetId={s.asset} from={s.from ?? 0} />
          <figcaption>
            <span className="keo-plan-at">
              {i + 1} · {s.at}
            </span>
            <span>{s.what}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

function ShotFrame({ project, assetId, from }: { project: Project; assetId: string | undefined; from: number }) {
  const asset = assetId ? project.assets.find((a) => a.id === assetId) : undefined;
  const strip = useFilmstrip(project.id, asset);
  const src = strip?.frames.length ? strip.frames[strip.step === Infinity ? 0 : Math.min(strip.frames.length - 1, Math.max(0, Math.floor(from / strip.step)))] : undefined;
  return <div className="sb-frame">{src ? <img src={src} alt="" /> : <span className="muted small">{asset ? '…' : 'Title / graphic'}</span>}</div>;
}
