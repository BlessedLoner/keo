import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentEvent, Message, Task } from '@shared/domain';
import { Icon } from '../components/Icon';
import { KeoEmblem, STATE_LABEL } from '../components/KeoEmblem';
import { Markdown } from '../components/Markdown';
import { ApprovalCard } from '../components/TaskWidgets';
import { errText, invoke, subscribe } from '../lib/api';
import { emblemFor, usePresence, useVoiceReporting } from '../lib/presence';
import { voice } from '../lib/voice';

/**
 * Mini-chat (Ctrl+Shift+K) / wake-word command bar. Commands go to the "Quick commands"
 * conversation through the normal agent pipeline; approvals for its actions
 * appear inline. Nothing here bypasses the main process's checks.
 */
export function CommandBarApp() {
  const p = usePresence();
  useVoiceReporting();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [live, setLive] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<Task[]>([]);
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const load = useCallback(async (id: string) => {
    try {
      const all = await invoke('conversations:messages', { id });
      setMessages(all.slice(-8));
      const ts = await invoke('tasks:list', { limit: 50 });
      setTasks(ts.filter((t) => t.conversationId === id));
    } catch (e) {
      setNote(errText(e));
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('command-root');
    void invoke('commandBar:conversation', { fresh: false }).then((r) => {
      setConversationId(r.conversationId);
      void load(r.conversationId);
    });
  }, [load]);

  useEffect(() => {
    if (!conversationId) return;
    const offA = subscribe('agent:event', (e: AgentEvent) => {
      if (e.conversationId !== conversationId) return;
      if (e.type === 'text_delta') setLive((l) => ({ ...l, [e.messageId]: (l[e.messageId] ?? '') + e.delta }));
      if (e.type === 'turn_started' || e.type === 'turn_finished' || e.type === 'tool_activity') void load(conversationId);
      if (e.type === 'turn_finished') setLive({});
    });
    const offT = subscribe('tasks:changed', () => void load(conversationId));
    const offC = subscribe('conversations:changed', (c) => c.conversationId === conversationId && void load(conversationId));
    return () => {
      offA();
      offT();
      offC();
    };
  }, [conversationId, load]);

  const send = useCallback(
    async (t: string) => {
      const value = t.trim();
      if (!value || !conversationId) return;
      setNote(null);
      try {
        await invoke('chat:send', { conversationId, text: value });
        setText('');
        void load(conversationId);
      } catch (e) {
        setNote(errText(e));
      }
    },
    [conversationId, load],
  );

  // Commands from the main process (wake word, focus requests).
  useEffect(
    () =>
      subscribe('presence:command', (c) => {
        if (c.type === 'focus_input') inputRef.current?.focus();
        if (c.type === 'transcript') {
          setListening(false);
          setNote(`Heard: “${c.text}”`);
          if (c.conversationId) setConversationId(c.conversationId);
        }
        if (c.type === 'listen_result') {
          setListening(false);
          setNote(c.reason === 'silence' ? 'I didn’t hear anything.' : c.reason === 'unclear' ? 'Sorry, I couldn’t make that out.' : c.reason === 'muted' ? 'The microphone is muted.' : c.reason === 'cancelled' ? null : `Listening stopped (${c.reason}).`);
        }
        if (c.type === 'record_command') {
          setListening(true);
          void voice.start({ autoStop: true }).then((transcript) => {
            setListening(false);
            if (transcript) void send(transcript);
          });
        }
      }),
    [send],
  );

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, live]);

  const listenNow = async () => {
    setListening(true);
    setNote(null);
    try {
      const r = await invoke('wake:listenNow');
      if (r.reason !== 'recording_in_command_bar') setListening(false);
    } catch (e) {
      setListening(false);
      setNote(errText(e));
    }
  };

  const state = emblemFor(p);
  const pending = tasks.flatMap((t) => t.steps.filter((s) => s.state === 'awaiting_authorization').map((s) => ({ t, s })));
  const busy = !!p && p.activeTurns > 0;

  return (
    <div
      className="command-shell"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          if (listening) void invoke('wake:cancelListen');
          void invoke('commandBar:hide');
        }
      }}
    >
      <div className="command-head">
        <KeoEmblem state={state} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="command-state">{listening ? 'Listening…' : STATE_LABEL[state]}</div>
          <div className="command-activity">{p?.activity ?? 'Ask Keo anything — Enter to send, Esc to close'}</div>
        </div>
        {busy && (
          <button className="btn danger sm" onClick={() => void invoke('presence:stopAll')}>
            <Icon name="stop" size={13} /> Stop
          </button>
        )}
        <button className="btn ghost sm" onClick={() => void invoke('presence:openMain', { view: 'chat' })} title="Open the full Keo window">
          <Icon name="window" size={13} /> Open Keo
        </button>
        <button className="btn ghost icon sm" aria-label="Close command bar" onClick={() => void invoke('commandBar:hide')}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="command-thread" ref={scroller}>
        {messages.length === 0 && <div className="muted small" style={{ padding: 10 }}>Try: “Summarize this page”, “Research this microphone and find the best value”, or “Open Notepad and write a note”.</div>}
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="cmd-user">
              {m.content}
            </div>
          ) : m.role === 'assistant' ? (
            <div key={m.id} className="cmd-assistant">
              <Markdown text={live[m.id] ?? m.content ?? ''} />
              {m.status === 'error' && <div className="small" style={{ color: 'var(--danger)' }}>{m.meta.error}</div>}
            </div>
          ) : (
            <div key={m.id} className="cmd-note small muted">
              {m.content}
            </div>
          ),
        )}
        {pending.map(({ t, s }) => (
          <ApprovalCard key={s.id} task={t} step={s} />
        ))}
      </div>
      {note && <div className="command-note">{note}</div>}
      <div className="command-input">
        <textarea
          ref={inputRef}
          autoFocus
          rows={1}
          aria-label="Command"
          placeholder={listening ? 'Listening… speak your command' : 'Ask or tell Keo what to do'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(text);
            }
          }}
        />
        <button className={`btn icon mic ${listening ? 'recording' : ''}`} aria-label={listening ? 'Stop listening' : 'Speak a command'} title="Speak a command" onClick={() => (listening ? void invoke('wake:cancelListen').then(() => voice.stop()) : void listenNow())}>
          <Icon name="mic" size={16} />
        </button>
        <button className="btn icon primary" aria-label="Send" disabled={!text.trim()} onClick={() => void send(text)}>
          <Icon name="send" size={15} />
        </button>
      </div>
    </div>
  );
}
