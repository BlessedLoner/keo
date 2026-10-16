import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent, Conversation, Message, ToolActivity } from '@shared/domain';
import { Icon } from '../components/Icon';
import { KeoEmblem, STATE_LABEL } from '../components/KeoEmblem';
import { Markdown } from '../components/Markdown';
import { ApprovalCard } from '../components/TaskWidgets';
import { useUi } from '../components/ui';
import { errText, invoke, subscribe } from '../lib/api';
import { clock, humanize, timeAgo } from '../lib/format';
import { useInvoke } from '../lib/hooks';
import { voice } from '../lib/voice';
import { useApp } from '../state/AppState';

export function ChatView() {
  const app = useApp();
  const ui = useUi();
  const [query, setQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState<string>('');
  const convs = useInvoke('conversations:list', { query: query || undefined, projectId: projectFilter || null }, { refreshOn: ['conversations:changed', 'agent:event'] });
  const projects = useInvoke('projects:list', {}, { refreshOn: ['projects:changed'] });
  const { conversationId, setConversationId } = app;

  // Select the most recent conversation when none is selected.
  useEffect(() => {
    if (!conversationId && convs.data && convs.data.length && !query && !projectFilter) setConversationId(convs.data[0]!.id);
  }, [conversationId, convs.data, query, projectFilter, setConversationId]);

  const newConversation = useCallback(async () => {
    try {
      const c = await invoke('conversations:create', { projectId: projectFilter || null });
      setConversationId(c.id);
    } catch (e) {
      ui.error(errText(e));
    }
  }, [projectFilter, setConversationId, ui]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void newConversation();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newConversation]);

  const current = convs.data?.find((c) => c.id === conversationId) ?? null;

  return (
    <div className="chat">
      <aside className="convs" aria-label="Conversations">
        <div className="convs-head">
          <button className="btn primary" onClick={() => void newConversation()} title="New conversation (Ctrl+N)">
            <Icon name="plus" size={16} /> New conversation
          </button>
          <div className="row">
            <input className="input" placeholder="Search conversations" aria-label="Search conversations" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select" aria-label="Filter by project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="">All conversations</option>
            {(projects.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="convs-list">
          {convs.error && <div className="banner danger small">{convs.error}</div>}
          {convs.data && convs.data.length === 0 && <p className="muted small" style={{ padding: 10 }}>{query ? 'No matches.' : 'No conversations yet.'}</p>}
          {(convs.data ?? []).map((c) => (
            <button key={c.id} className="conv-item" aria-current={c.id === conversationId} onClick={() => setConversationId(c.id)}>
              <span className="t">{c.title}</span>
              <span className="m">
                {app.turns[c.id] && <span className="spinner" style={{ width: 10, height: 10 }} aria-label="responding" />}
                {timeAgo(c.updatedAt)} · {c.messageCount} msg
                {c.projectId && <span className="chip" style={{ height: 17, fontSize: 10.5 }}>{projects.data?.find((p) => p.id === c.projectId)?.name ?? 'project'}</span>}
              </span>
            </button>
          ))}
        </div>
      </aside>
      {current ? <Thread key={current.id} conversation={current} projects={projects.data ?? []} /> : <NoConversation onNew={() => void newConversation()} />}
    </div>
  );
}

function NoConversation({ onNew }: { onNew: () => void }) {
  const app = useApp();
  return (
    <div className="thread-wrap">
      <div className="hero" style={{ marginTop: 40 }}>
        <KeoEmblem state={app.emblem} size={200} />
        <h2>Hello, I’m Keo.</h2>
        <p>Your personal agent for this computer. I remember what you confirm, track your projects, and act only with your permission.</p>
        <button className="btn primary" onClick={onNew}>
          <Icon name="plus" size={16} /> Start a conversation
        </button>
      </div>
    </div>
  );
}

function Thread({ conversation, projects }: { conversation: Conversation; projects: Array<{ id: string; name: string }> }) {
  const app = useApp();
  const ui = useUi();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, string>>({});
  const [liveTools, setLiveTools] = useState<Record<string, ToolActivity[]>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turn = app.turns[conversation.id];
  const settings = app.settings.data;

  const load = useCallback(async () => {
    try {
      setMessages(await invoke('conversations:messages', { id: conversation.id }));
      setLoadError(null);
    } catch (e) {
      setLoadError(errText(e));
    }
  }, [conversation.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => subscribe('conversations:changed', (p) => (p.conversationId === conversation.id || p.conversationId === null) && void load()), [conversation.id, load]);

  useEffect(
    () =>
      subscribe('agent:event', (e: AgentEvent) => {
        if (e.conversationId !== conversation.id) return;
        if (e.type === 'turn_started') {
          setLive((l) => ({ ...l, [e.messageId]: '' }));
          void load();
        } else if (e.type === 'text_delta') {
          setLive((l) => ({ ...l, [e.messageId]: (l[e.messageId] ?? '') + e.delta }));
        } else if (e.type === 'tool_activity') {
          setLiveTools((t) => {
            const list = [...(t[e.messageId] ?? [])];
            const i = list.findIndex((x) => x.callId === e.activity.callId);
            if (i >= 0) list[i] = e.activity;
            else list.push(e.activity);
            return { ...t, [e.messageId]: list };
          });
        } else if (e.type === 'turn_finished') {
          setMessages((ms) => {
            const i = ms.findIndex((m) => m.id === e.message.id);
            if (i < 0) return [...ms, e.message];
            const next = [...ms];
            next[i] = e.message;
            return next;
          });
          setLive((l) => {
            const n = { ...l };
            delete n[e.message.id];
            return n;
          });
          setLiveTools((t) => {
            const n = { ...t };
            delete n[e.message.id];
            return n;
          });
          if (e.message.status === 'complete' && settings?.voice.speakResponses && settings.voice.ttsEngine !== 'none' && e.message.content) {
            void voice.speak(e.message.content, settings.voice.ttsEngine, settings.voice.systemVoice);
          }
        }
      }),
    [conversation.id, load, settings],
  );

  // Auto-scroll while the user is at the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, live, liveTools]);

  const send = useCallback(
    async (text: string) => {
      stick.current = true;
      try {
        await invoke('chat:send', { conversationId: conversation.id, text });
        await load();
      } catch (e) {
        ui.error(errText(e));
        throw e;
      }
    },
    [conversation.id, load, ui],
  );

  const rename = async () => {
    const t = await ui.prompt({ title: 'Rename conversation', label: 'Title', initial: conversation.title });
    if (t) await invoke('conversations:rename', { id: conversation.id, title: t }).catch((e) => ui.error(errText(e)));
  };
  const remove = async () => {
    const ok = await ui.confirm({ title: 'Delete conversation?', body: 'Its messages are permanently deleted. Memories keep their text but lose the link to this conversation.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await invoke('conversations:delete', { id: conversation.id });
      app.setConversationId(null);
    } catch (e) {
      ui.error(errText(e));
    }
  };

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const canRetry = !turn && !!lastAssistant && ['error', 'cancelled', 'interrupted'].includes(lastAssistant.status);
  const emblemState = turn ? (turn.phase === 'tool' ? 'working' : turn.phase === 'waiting_approval' ? 'attention' : 'thinking') : app.emblem;

  return (
    <section className="thread-wrap" aria-label="Conversation">
      <div className="thread-head">
        <KeoEmblem state={emblemState} size={38} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="title">{conversation.title}</div>
          <div className="state" aria-live="polite">
            {turn ? phaseLabel(turn.phase) : STATE_LABEL[app.emblem]}
          </div>
        </div>
        <select
          className="select"
          style={{ width: 180 }}
          aria-label="Project for this conversation"
          value={conversation.projectId ?? ''}
          onChange={(e) => void invoke('conversations:setProject', { id: conversation.id, projectId: e.target.value || null }).catch((er) => ui.error(errText(er)))}
        >
          <option value="">No project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn ghost icon" aria-label="Rename conversation" title="Rename" onClick={() => void rename()}>
          <Icon name="edit" size={16} />
        </button>
        <button className="btn ghost icon" aria-label="Delete conversation" title="Delete" onClick={() => void remove()}>
          <Icon name="trash" size={16} />
        </button>
      </div>

      <div
        className="thread"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className="thread-inner">
          {loadError && <div className="banner danger">{loadError}</div>}
          {messages.length === 0 && !loadError && <Welcome onPick={(t) => void send(t).catch(() => undefined)} />}
          {messages.map((m) => (
            <MessageView key={m.id} m={m} liveText={live[m.id]} liveTools={liveTools[m.id]} streaming={turn?.messageId === m.id} />
          ))}
          {canRetry && (
            <div className="row">
              <button className="btn sm" onClick={() => void invoke('chat:retry', { conversationId: conversation.id }).catch((e) => ui.error(errText(e)))}>
                <Icon name="retry" size={14} /> Retry last reply
              </button>
            </div>
          )}
        </div>
      </div>
      <Composer conversationId={conversation.id} busy={!!turn} onSend={send} />
    </section>
  );
}

function phaseLabel(p: string): string {
  switch (p) {
    case 'thinking':
      return 'Thinking…';
    case 'generating':
      return 'Responding…';
    case 'tool':
      return 'Running a capability…';
    case 'waiting_approval':
      return 'Waiting for your approval';
    default:
      return humanize(p);
  }
}

function Welcome({ onPick }: { onPick: (t: string) => void }) {
  const app = useApp();
  const ready = app.activeProvider?.status.kind === 'ready';
  const ideas = ['What can you do on this computer, and what needs my permission?', 'Remember that I prefer short, direct answers.', 'Help me plan the next steps for one of my projects.', 'What do you currently remember about me?'];
  return (
    <div className="hero">
      <KeoEmblem state={app.emblem} size={170} />
      <h2>How can I help?</h2>
      {ready ? (
        <p>Ask anything. I’ll say when I’m inferring rather than knowing, and I’ll ask before touching anything on your computer.</p>
      ) : (
        <div className="banner warn" style={{ maxWidth: 560 }}>
          <Icon name="key" size={16} />
          <div className="grow">No model provider is ready, so I can’t answer yet. Configure Anthropic, OpenAI or a local model in Settings.</div>
          <button className="btn sm" onClick={() => app.setView('settings')}>
            Open settings
          </button>
        </div>
      )}
      <div className="suggestions">
        {ideas.map((t) => (
          <button key={t} onClick={() => onPick(t)} disabled={!ready}>
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageView({ m, liveText, liveTools, streaming }: { m: Message; liveText?: string; liveTools?: ToolActivity[]; streaming: boolean }) {
  const ui = useUi();
  const app = useApp();
  const text = liveText !== undefined && (m.status === 'streaming' || streaming) ? liveText : m.content;
  const tools = mergeTools(m.meta.tools ?? [], liveTools ?? []);
  const copy = () => navigator.clipboard.writeText(m.content).then(() => ui.toast('Copied'), () => ui.error('Copy failed'));

  if (m.role === 'note') {
    return (
      <div className="msg note">
        <div className="bubble">
          <Icon name="info" size={14} /> {m.content}
        </div>
      </div>
    );
  }
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.content}</div>
        <div className="meta">
          <span className="acts">
            <button className="btn ghost icon sm" aria-label="Copy message" title="Copy" onClick={() => void copy()}>
              <Icon name="copy" size={13} />
            </button>
            <button
              className="btn ghost icon sm"
              aria-label="Remember this message"
              title="Remember this (saved as written by you)"
              onClick={() => void invoke('memory:rememberMessage', { messageId: m.id }).then(() => ui.toast('Saved to memory', 'success'), (e) => ui.error(errText(e)))}
            >
              <Icon name="pin" size={13} />
            </button>
          </span>
          <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
            {clock(m.createdAt)}
          </time>
        </div>
      </div>
    );
  }
  const isStreaming = m.status === 'streaming' || streaming;
  return (
    <div className="msg assistant">
      <div className="msg-author">
        <KeoEmblem state={isStreaming ? 'thinking' : m.status === 'error' ? 'error' : 'idle'} size={20} live={false} />
        <span>Keo</span>
        {m.meta.model && <span className="muted small">· {m.meta.providerId === 'test' ? 'test provider' : m.meta.model}</span>}
      </div>
      {tools.length > 0 && (
        <div className="tool-list">
          {tools.map((t) => (
            <ToolCard key={t.callId} t={t} />
          ))}
        </div>
      )}
      <div className="bubble">
        {text ? <Markdown text={text} /> : isStreaming ? <span className="muted small">…</span> : null}
        {isStreaming && <span className="caret" aria-hidden="true" />}
      </div>
      {m.status === 'error' && (
        <div className="banner danger small" role="alert">
          <Icon name="warn" size={15} />
          <div className="grow">
            {m.meta.error ?? 'The request failed.'}
            {m.meta.errorKind === 'unconfigured' && (
              <>
                {' '}
                <button className="btn sm" onClick={() => app.setView('settings')}>
                  Configure provider
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {m.status === 'cancelled' && <div className="muted small">Stopped by you.</div>}
      {m.status === 'interrupted' && <div className="muted small">Interrupted — Keo closed before this reply finished.</div>}
      {!isStreaming && (
        <div className="meta">
          <time dateTime={m.createdAt} title={new Date(m.createdAt).toLocaleString()}>
            {clock(m.createdAt)}
          </time>
          {m.meta.usage && (
            <span title="Tokens reported by the provider">
              {m.meta.usage.inputTokens.toLocaleString()} in / {m.meta.usage.outputTokens.toLocaleString()} out
            </span>
          )}
          {!!m.meta.memoryIds?.length && <span title="Confirmed memories included as context">{m.meta.memoryIds.length} memories used</span>}
          <span className="acts">
            {m.content && (
              <>
                <button className="btn ghost icon sm" aria-label="Copy reply" title="Copy" onClick={() => void copy()}>
                  <Icon name="copy" size={13} />
                </button>
                <button
                  className="btn ghost icon sm"
                  aria-label="Read reply aloud"
                  title="Read aloud"
                  onClick={() => {
                    const s = app.settings.data?.voice;
                    if (!s || s.ttsEngine === 'none') ui.toast('Text-to-speech is off (Settings → Voice).');
                    else void voice.speak(m.content, s.ttsEngine, s.systemVoice);
                  }}
                >
                  <Icon name="speaker" size={13} />
                </button>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}

function mergeTools(stored: ToolActivity[], live: ToolActivity[]): ToolActivity[] {
  const out = [...stored];
  for (const l of live) {
    const i = out.findIndex((x) => x.callId === l.callId);
    if (i >= 0) out[i] = l;
    else out.push(l);
  }
  return out;
}

const OUTCOME: Record<ToolActivity['outcome'], { label: string; cls: string }> = {
  executed: { label: 'Done', cls: 'ok' },
  proposed: { label: 'Proposed', cls: 'violet' },
  rejected: { label: 'Rejected by Keo', cls: 'danger' },
  failed: { label: 'Failed', cls: 'danger' },
  denied: { label: 'Denied by you', cls: 'danger' },
  uncertain: { label: 'Outcome uncertain', cls: 'warn' },
  awaiting_authorization: { label: 'Needs approval', cls: 'warn' },
};

function ToolCard({ t }: { t: ToolActivity }) {
  const app = useApp();
  const task = useMemo(() => (t.taskId ? app.tasks.data?.find((x) => x.id === t.taskId) : undefined), [app.tasks.data, t.taskId]);
  const step = task?.steps[0];
  if (task && step && step.state === 'awaiting_authorization') return <ApprovalCard task={task} step={step} />;
  // Prefer the live task state over the snapshot taken when the turn ended.
  let o = OUTCOME[t.outcome];
  let detail = t.detail;
  if (task) {
    if (task.state === 'completed') {
      o = { label: step?.verification === 'verified' ? 'Done · verified' : 'Done · not verified', cls: 'ok' };
      detail = step?.verificationDetail ?? detail;
    } else if (task.state === 'running') o = { label: 'Running', cls: 'accent' };
    else if (task.state === 'outcome_uncertain') o = OUTCOME.uncertain;
    else if (task.state === 'failed') {
      o = OUTCOME.failed;
      detail = step?.error ?? detail;
    } else if (task.state === 'cancelled') o = step?.state === 'denied' ? OUTCOME.denied : { label: 'Cancelled', cls: 'danger' };
  }
  return (
    <div className={`tool-card ${t.outcome}`}>
      <Icon name={task?.state === 'running' ? 'pulse' : 'shield'} size={15} />
      <div className="grow">
        <div>{t.summary}</div>
        <div className="cap">{t.capabilityId}</div>
        {detail && <div className="muted small">{detail}</div>}
      </div>
      <span className={`chip ${o.cls}`}>{o.label}</span>
      {t.taskId && (
        <button className="btn ghost sm" onClick={() => app.setView('tasks')}>
          View task
        </button>
      )}
    </div>
  );
}

function Composer({ conversationId, busy, onSend }: { conversationId: string; busy: boolean; onSend: (t: string) => Promise<void> }) {
  const app = useApp();
  const ui = useUi();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pressStart = useRef(0);
  const v = app.voice;
  const s = app.settings.data;
  const sttReady = s?.voice.sttProvider === 'openai' && s.voice.audioExportConsent;

  useEffect(() => {
    ref.current?.focus();
  }, [conversationId]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);
  useEffect(() => {
    if (v.error) ui.error(v.error);
  }, [v.error, ui]);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy || sending) return;
    setSending(true);
    try {
      await onSend(t);
      setText('');
    } catch {
      /* error already shown; keep the draft */
    } finally {
      setSending(false);
    }
  };

  const startRec = async () => {
    if (!sttReady) {
      ui.toast('Voice input needs a speech-to-text provider and your consent in Settings → Voice.');
      return;
    }
    voice.stopSpeaking();
    pressStart.current = Date.now();
    const transcript = await voice.start();
    if (transcript) {
      setText((cur) => (cur ? `${cur} ${transcript}` : transcript));
      ref.current?.focus();
    }
  };
  const micDown = () => {
    if (v.recording) voice.stop();
    else void startRec();
  };
  const micUp = () => {
    // Hold-to-talk: releasing after a long press stops; a short click keeps recording until clicked again.
    if (v.recording && Date.now() - pressStart.current > 450) voice.stop();
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <label htmlFor="composer-input" className="sr-only">
          Message Keo
        </label>
        <textarea
          id="composer-input"
          ref={ref}
          rows={1}
          placeholder={busy ? 'Keo is responding… (Esc to stop)' : 'Message Keo — Enter to send, Shift+Enter for a new line'}
          value={text}
          maxLength={32000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape' && busy) {
              void invoke('chat:cancel', { conversationId });
            }
          }}
        />
        <button
          className={`btn icon mic ${v.recording ? 'recording' : ''}`}
          aria-label={v.recording ? 'Stop recording' : 'Start voice input'}
          aria-pressed={v.recording}
          title={sttReady ? (v.recording ? 'Recording — click (or release) to stop' : 'Hold to talk, or click to start/stop') : 'Voice input is not configured'}
          disabled={v.transcribing}
          onPointerDown={micDown}
          onPointerUp={micUp}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              micDown();
            }
          }}
        >
          {v.transcribing ? <span className="spinner" /> : <Icon name="mic" size={17} />}
        </button>
        {busy ? (
          <button className="btn icon danger" aria-label="Stop response" title="Stop (Esc)" onClick={() => void invoke('chat:cancel', { conversationId })}>
            <Icon name="stop" size={16} />
          </button>
        ) : (
          <button className="btn icon primary" aria-label="Send message" title="Send (Enter)" disabled={!text.trim() || sending} onClick={() => void submit()}>
            <Icon name="send" size={16} />
          </button>
        )}
      </div>
      <div className="composer-foot">
        {v.recording ? (
          <span className="rec-indicator" role="status">
            <span className="dot" /> Recording from your microphone — audio goes to OpenAI for transcription when you stop.
            <button className="btn ghost sm" onClick={() => voice.abort()}>
              Discard
            </button>
          </span>
        ) : v.transcribing ? (
          <span role="status">Transcribing…</span>
        ) : v.speaking ? (
          <span role="status">
            Speaking{v.speakingSync === 'word-boundaries' ? ' (animation follows word boundaries)' : v.speakingSync === 'amplitude' ? ' (animation follows audio level)' : '…'}
            <button className="btn ghost sm" onClick={() => voice.stopSpeaking()}>
              Stop
            </button>
          </span>
        ) : (
          <span>
            {app.activeProvider?.id === 'test' ? (
              <>Replies come from the offline test provider (scripted, not an AI model).</>
            ) : app.activeProvider ? (
              <>
                Replies from <strong>{app.activeProvider.selectedModel}</strong> via {app.activeProvider.destination}
              </>
            ) : (
              'No provider selected'
            )}
          </span>
        )}
        <span className="grow" />
        <span>Actions on your computer always ask first.</span>
      </div>
    </div>
  );
}
