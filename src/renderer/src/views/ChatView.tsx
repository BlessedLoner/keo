import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentEvent, Briefing, BriefingSection, Conversation, Message, MessageAttachment, ToolActivity, WorkPlan } from '@shared/domain';
import type { AttachmentView } from '@shared/ipc';
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

/** What the briefing button sends (the same as saying it). */
const BRIEFING_PROMPT = 'Good morning, Keo — what matters today?';
let morningChecked = false;

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

  // "Show it when I first open Keo each morning": checked once per app start; main remembers the day.
  const providerReady = app.activeProvider?.status.kind === 'ready';
  useEffect(() => {
    if (!providerReady || morningChecked) return;
    morningChecked = true;
    void (async () => {
      if (!(await invoke('briefing:morningDue', {})).due) return;
      const c = await invoke('conversations:create', { projectId: null });
      setConversationId(c.id);
      await invoke('chat:send', { conversationId: c.id, text: BRIEFING_PROMPT });
    })().catch((e) => ui.error(errText(e)));
  }, [providerReady, setConversationId, ui]);

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
  const [livePlans, setLivePlans] = useState<Record<string, WorkPlan>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const turn = app.turns[conversation.id];
  const settings = app.settings.data;
  const voiceModeActive = useRef(false);
  voiceModeActive.current = !!app.presence?.voiceMode?.active;

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
        } else if (e.type === 'plan') {
          setLivePlans((p) => ({ ...p, [e.messageId]: e.plan }));
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
          setLivePlans((p) => {
            const n = { ...p };
            delete n[e.message.id];
            return n;
          });
          // In voice mode Keo's voice conversation speaks the reply (once); the chat does not as well.
          if (e.message.status === 'complete' && settings?.voice.speakResponses && settings.voice.ttsEngine !== 'none' && e.message.content && !voiceModeActive.current) {
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
    async (text: string, attachments?: string[]) => {
      stick.current = true;
      try {
        await invoke('chat:send', { conversationId: conversation.id, text, ...(attachments?.length ? { attachments } : {}) });
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
        <button className="btn ghost sm" title="Today’s calendar, new email, finished work and recent files" disabled={!!turn} onClick={() => void send(BRIEFING_PROMPT).catch(() => undefined)}>
          <Icon name="sparkle" size={14} /> Briefing
        </button>
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
            <MessageView key={m.id} m={m} liveText={live[m.id]} liveTools={liveTools[m.id]} livePlan={livePlans[m.id]} streaming={turn?.messageId === m.id} />
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
  const ideas = [BRIEFING_PROMPT, 'What can you do on this computer, and what needs my permission?', 'Remember that I prefer short, direct answers.', 'Help me plan the next steps for one of my projects.', 'What do you currently remember about me?'];
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

function MessageView({ m, liveText, liveTools, livePlan, streaming }: { m: Message; liveText?: string; liveTools?: ToolActivity[]; livePlan?: WorkPlan; streaming: boolean }) {
  const ui = useUi();
  const app = useApp();
  const text = liveText !== undefined && (m.status === 'streaming' || streaming) ? liveText : m.content;
  const tools = mergeTools(m.meta.tools ?? [], liveTools ?? []);
  const plan = livePlan ?? m.meta.plan;
  const copy = () => invoke('app:copyText', { text: m.content }).then((r) => (r.copied ? ui.toast('Copied') : ui.error('Copy failed')), () => ui.error('Copy failed'));

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
        {!!m.meta.attachments?.length && <SentAttachments list={m.meta.attachments} />}
        {m.content.trim() && <div className="bubble">{m.content}</div>}
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
        {m.meta.model && <span className="muted small">· {m.meta.providerId === 'test' ? 'test provider' : m.meta.model}{m.meta.route && ` (${m.meta.route})`}</span>}
      </div>
      {plan && plan.steps.length > 0 && <PlanChecklist plan={plan} />}
      {tools.length > 0 && (
        <div className="tool-list">
          {tools.map((t) => (
            <ToolCard key={t.callId} t={t} conversationId={m.conversationId} />
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

const STEP_MARK: Record<WorkPlan['steps'][number]['status'], { mark: string; label: string }> = {
  pending: { mark: '○', label: 'To do' },
  in_progress: { mark: '◐', label: 'In progress' },
  done: { mark: '✓', label: 'Done' },
  failed: { mark: '✗', label: 'Failed' },
  skipped: { mark: '–', label: 'Skipped' },
};

/** Keo's working checklist for a multi-step request, updated as the reply runs. */
function PlanChecklist({ plan }: { plan: WorkPlan }) {
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return (
    <div className="plan-checklist" role="list" aria-label={`Plan: ${done} of ${plan.steps.length} steps done`}>
      <div className="plan-head muted small">
        Plan · {done}/{plan.steps.length} done
      </div>
      {plan.steps.map((s, i) => (
        <div key={i} role="listitem" className={`plan-step ${s.status}`} title={STEP_MARK[s.status].label}>
          <span className="plan-mark" aria-label={STEP_MARK[s.status].label}>
            {STEP_MARK[s.status].mark}
          </span>
          <span className="grow">
            {s.title}
            {s.note && <span className="muted small"> — {s.note}</span>}
          </span>
        </div>
      ))}
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

function ToolCard({ t, conversationId }: { t: ToolActivity; conversationId: string }) {
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
  if (t.cards) return <ProductCards data={t.cards} />;
  if (t.briefing) return <BriefingCard data={t.briefing} conversationId={conversationId} />;
  return (
    <div className={`tool-card ${t.outcome}`}>
      <Icon name={task?.state === 'running' ? 'pulse' : 'shield'} size={15} />
      <div className="grow">
        <div>{t.summary}</div>
        <div className="cap">{t.capabilityId}</div>
        {detail && <div className="muted small">{detail}</div>}
        {t.choices && t.choices.length > 0 && (
          <div className="choices" role="group" aria-label="Choose one">
            {t.choices.map((c) => (
              <button key={c} className="btn sm" onClick={() => void invoke('chat:send', { conversationId, text: c }).catch(() => undefined)}>
                {c}
              </button>
            ))}
          </div>
        )}
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

/** Product comparison cards; every price/merchant/image comes from a page Keo fetched (shown with its source). */
function ProductCards({ data }: { data: NonNullable<ToolActivity['cards']> }) {
  return (
    <section className="product-cards" aria-label="Product comparison">
      {data.criteria.length > 0 && <div className="muted small">Compared on: {data.criteria.join(' · ')}</div>}
      <div className="product-grid">
        {data.cards.map((c) => (
          <article key={c.url} className="product-card">
            {c.image ? <img src={c.image} alt={c.name} /> : <div className="no-image" aria-hidden="true"><Icon name="camera" size={22} /></div>}
            <div className="product-body">
              <h4>{c.name}</h4>
              <div className="price">
                {c.price ? `${c.currency ? `${c.currency} ` : ''}${c.price}` : 'Price not stated on the page'}
                {c.merchant && <span className="muted"> · {c.merchant}</span>}
              </div>
              {c.availability && <div className="muted small">{c.availability}</div>}
              {c.fit && <p className="small">{c.fit}</p>}
              {c.specs.length > 0 && (
                <ul className="specs">
                  {c.specs.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
              {(c.pros.length > 0 || c.cons.length > 0) && (
                <div className="pros-cons small">
                  {c.pros.map((p) => (
                    <div key={`+${p}`} className="pro">+ {p}</div>
                  ))}
                  {c.cons.map((p) => (
                    <div key={`-${p}`} className="con">− {p}</div>
                  ))}
                </div>
              )}
              <button className="btn ghost sm link" title={c.url} onClick={() => void invoke('app:openUrl', { url: c.url }).catch(() => undefined)}>
                {c.pageTitle || new URL(c.url).hostname}
              </button>
              <div className="muted tiny">
                {c.priceFrom === 'page data' ? 'Price from the page’s product data' : c.priceFrom === 'page text' ? 'Price found in the page text' : 'No price on the page'} · read {new Date(c.fetchedAt).toLocaleString()}. Pros, cons and specs are Keo’s reading of the page.
              </div>
            </div>
          </article>
        ))}
      </div>
      {data.dropped.length > 0 && (
        <div className="muted small">Not shown (could not be traced to a page Keo read): {data.dropped.map((x) => x.name).join(', ')}</div>
      )}
    </section>
  );
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** One briefing section: its items, or the one-line reason it was skipped or failed. */
function BriefingPart<T>({ title, part, children }: { title: string; part: BriefingSection<T>; children: (items: T[]) => ReactNode }) {
  return (
    <div className="briefing-part">
      <h4>{title}</h4>
      {part.items.length > 0 && <ul>{children(part.items)}</ul>}
      {part.note && <div className={`small ${part.status === 'failed' ? 'danger-text' : 'muted'}`}>{part.status === 'failed' ? `Could not read it: ${part.note}` : part.note}</div>}
    </div>
  );
}

/** The morning briefing card. Everything in it was only read; each button starts a separate action that asks as usual. */
function BriefingCard({ data, conversationId }: { data: Briefing; conversationId: string }) {
  const ui = useUi();
  const ask = (text: string) => void invoke('chat:send', { conversationId, text }).catch((e) => ui.error(errText(e)));
  const openEvent = (url: string) => void invoke('briefing:openEvent', { url }).then((r) => !r.opened && ui.error('Keo could not open that event.'), (e) => ui.error(errText(e)));
  const openFile = (p: string) => void invoke('briefing:openFile', { path: p }).then((r) => !r.opened && ui.error(r.error ?? 'Keo could not open that file.'), (e) => ui.error(errText(e)));
  const day = new Date(`${data.date}T12:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <section className="briefing" aria-label="Morning briefing">
      <header>
        <Icon name="sparkle" size={15} /> <strong>Your briefing</strong> <span className="muted small">· {day}</span>
      </header>
      <BriefingPart title="Today" part={data.calendar}>
        {(items) =>
          items.map((e) => (
            <li key={e.id}>
              <span className="when">{e.allDay ? 'All day' : `${hhmm(e.start)}–${hhmm(e.end)}`}</span>
              <span className="grow">
                {e.title}
                {e.location && <span className="muted"> · {e.location}</span>}
              </span>
              {e.link && (
                <button className="btn ghost sm" onClick={() => openEvent(e.link!)}>
                  Open event
                </button>
              )}
            </li>
          ))
        }
      </BriefingPart>
      {data.calendar.gaps.length > 0 && <div className="muted small briefing-gaps">Free: {data.calendar.gaps.map((g) => `${hhmm(g.start)}–${hhmm(g.end)}`).join(', ')}</div>}
      <BriefingPart title={`New email${data.email.account ? ` · ${data.email.account}` : ''}`} part={data.email}>
        {(items) =>
          items.map((m) => (
            <li key={m.ref}>
              <span className="grow">
                <strong>{m.fromName || m.from}</strong> — {m.subject}
              </span>
              <button className="btn ghost sm" onClick={() => ask(`Help me reply to the email ${m.ref} from my briefing.`)}>
                Reply
              </button>
            </li>
          ))
        }
      </BriefingPart>
      <BriefingPart title="Background work" part={data.jobs}>
        {(items) =>
          items.map((j) => (
            <li key={j.id}>
              <span className={`chip ${j.needsYou ? 'warn' : j.state === 'completed' ? 'ok' : ''}`}>{j.needsYou ? 'Needs you' : humanize(j.state)}</span>
              <span className="grow">{j.title}</span>
            </li>
          ))
        }
      </BriefingPart>
      <BriefingPart title="Recently changed files" part={data.files}>
        {(items) =>
          items.map((f) => (
            <li key={f.path}>
              <span className="grow" title={f.path}>
                {f.name}
                {f.modified && <span className="muted"> · {timeAgo(f.modified)}</span>}
              </span>
              <button className="btn ghost sm" onClick={() => openFile(f.path)}>
                Open file
              </button>
            </li>
          ))
        }
      </BriefingPart>
      {(data.web.status !== 'skipped' || data.web.items.length > 0) && (
        <BriefingPart title="Weather and news" part={data.web}>
          {(items) =>
            items.map((w) => (
              <li key={`${w.topic}:${w.url}`}>
                <span className="when">{w.topic === 'weather' ? 'Weather' : 'News'}</span>
                <span className="grow">
                  {w.title}
                  {w.snippet && <span className="muted"> — {w.snippet}</span>}
                </span>
              </li>
            ))
          }
        </BriefingPart>
      )}
      <div className="muted tiny">Only read from your own connected sources; nothing was sent or changed. Email and event text comes from other people.</div>
    </section>
  );
}

/** What the user attached to a sent message: picture thumbnails and file chips. */
function SentAttachments({ list }: { list: MessageAttachment[] }) {
  return (
    <div className="sent-atts">
      {list.map((a) =>
        a.kind === 'image' && a.thumb ? (
          <img key={a.id} className="sent-thumb" src={a.thumb} alt={a.name} title={a.path ?? a.name} />
        ) : (
          <span key={a.id} className="att-chip sent" title={a.note ?? a.path ?? a.name}>
            <Icon name="file" size={14} />
            <span className="att-name">{a.name}</span>
            <span className="att-size">{fileSize(a.size)}</span>
          </span>
        ),
      )}
    </div>
  );
}

const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** One file's bytes as base64 (in chunks, so large files do not overflow the call stack). */
async function toBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Things to ask about attachments when nothing is typed yet. */
const QUICK = ['Summarize this', 'Explain this', 'Pull out the key points', 'Translate it to English', 'What do you see?'];

function Composer({ conversationId, busy, onSend }: { conversationId: string; busy: boolean; onSend: (t: string, attachments?: string[]) => Promise<void> }) {
  const app = useApp();
  const ui = useUi();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [atts, setAtts] = useState<AttachmentView[]>([]);
  const [adding, setAdding] = useState(0);
  const [menu, setMenu] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const addFiles = useCallback(
    async (files: File[]) => {
      const list = files.slice(0, 8);
      setAdding((n) => n + list.length);
      for (const f of list) {
        try {
          if (f.size > 25 * 1024 * 1024) throw new Error(`${f.name} is larger than 25 MB.`);
          const a = await invoke('chat:attachBytes', { name: f.name || 'Pasted picture.png', dataBase64: await toBase64(f) });
          setAtts((cur) => [...cur, a].slice(0, 8));
        } catch (e) {
          ui.error(errText(e));
        } finally {
          setAdding((n) => n - 1);
        }
      }
    },
    [ui],
  );
  const pick = async () => {
    setMenu(false);
    try {
      const got = await invoke('chat:pickAttachments', {});
      setAtts((cur) => [...cur, ...got].slice(0, 8));
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const screenshot = async () => {
    setMenu(false);
    setAdding((n) => n + 1);
    try {
      const a = await invoke('chat:attachScreenshot', {});
      setAtts((cur) => [...cur, a].slice(0, 8));
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setAdding((n) => n - 1);
    }
  };
  const removeAtt = (id: string) => {
    setAtts((cur) => cur.filter((a) => a.id !== id));
    void invoke('chat:discardAttachment', { id }).catch(() => undefined);
  };

  // Files dropped anywhere on the chat are attached.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragOver(true);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      void addFiles([...(e.dataTransfer?.files ?? [])]);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);
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

  const submit = async (override?: string) => {
    const t = (override ?? text).trim();
    if ((!t && !atts.length) || busy || sending || adding > 0) return;
    setSending(true);
    try {
      await onSend(t, atts.map((a) => a.id));
      setText('');
      setAtts([]);
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
      {dragOver && (
        <div className="drop-veil" aria-hidden="true">
          <div className="drop-card">
            <Icon name="attach" size={22} />
            Drop to attach
          </div>
        </div>
      )}
      {(atts.length > 0 || adding > 0) && (
        <div className="att-tray" aria-label="Attachments">
          {atts.map((a) => (
            <span key={a.id} className={`att-chip ${a.kind}`} title={a.note ?? a.path ?? a.name}>
              {a.kind === 'image' && a.thumb ? <img src={a.thumb} alt="" /> : <Icon name={a.kind === 'document' ? 'file' : 'attach'} size={14} />}
              <span className="att-name">{a.name}</span>
              <span className="att-size">{a.note && a.kind === 'file' ? 'name only' : fileSize(a.size)}</span>
              <button className="att-x" aria-label={`Remove ${a.name}`} onClick={() => removeAtt(a.id)}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {adding > 0 && (
            <span className="att-chip loading">
              <span className="spinner" /> Reading…
            </span>
          )}
        </div>
      )}
      {atts.length > 0 && !text.trim() && !busy && (
        <div className="quick-row" aria-label="Quick actions">
          {QUICK.filter((q) => q !== 'What do you see?' || atts.some((a) => a.kind === 'image')).map((q, i) => (
            <button key={q} className="quick-chip" style={{ animationDelay: `${i * 40}ms` }} onClick={() => void submit(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
      <div className="composer">
        <div className="attach-wrap">
          <button className={`btn icon attach ${menu ? 'on' : ''}`} aria-label="Attach photos or files" aria-expanded={menu} title="Attach photos or files (or drop them here, or paste)" onClick={() => setMenu((m) => !m)}>
            <Icon name="plus" size={18} />
          </button>
          {menu && (
            <div className="attach-menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" onClick={() => void pick()}>
                <Icon name="image" size={15} /> Photos or files…
              </button>
              <button role="menuitem" onClick={() => void screenshot()}>
                <Icon name="window" size={15} /> Screenshot of my screen
              </button>
              <div className="attach-hint">Drop files on the chat, or paste a picture (Ctrl+V)</div>
            </div>
          )}
        </div>
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
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
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
          <button className="btn icon primary" aria-label="Send message" title="Send (Enter)" disabled={(!text.trim() && !atts.length) || sending || adding > 0} onClick={() => void submit()}>
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
