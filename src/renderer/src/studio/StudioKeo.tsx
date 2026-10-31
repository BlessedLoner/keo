import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, Task, ToolActivity } from '@shared/domain';
import type { Project, StudioAsk } from '@shared/studio';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ApprovalCard } from '../components/TaskWidgets';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';

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

/** Keo's chat for this project (or, while Keo carries a task across projects, the chat it started in). */
export function StudioKeo({ project, conversation }: { project: Project; conversation?: string | null }) {
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
              <strong>Tell Keo what you want.</strong> Keo edits this video while you watch — every change can be undone.
            </p>
            <p className="small muted">Keo knows where your playhead is and what you selected: “make this part faster”, “put a title here”, “use a warmer look on the selected clips”.</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`keo-msg ${m.role}`}>
            {m.role === 'assistant' ? <Markdown text={m.content || (m.meta.error ?? '')} /> : <p>{m.content}</p>}
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
            {!!question.plan?.length && (
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
      {!busy && !question && chips.length > 0 && (
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
