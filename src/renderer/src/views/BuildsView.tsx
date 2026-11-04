import { useEffect, useRef, useState } from 'react';
import type { BuildSummary } from '@shared/ipc';
import { Icon } from '../components/Icon';
import { Empty, ErrorBanner, useUi } from '../components/ui';
import { errText, invoke } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useInvoke } from '../lib/hooks';
import { useApp } from '../state/AppState';

const KIND: Record<BuildSummary['kind'], { label: string; icon: string }> = {
  website: { label: 'Website', icon: 'window' },
  app: { label: 'Web app', icon: 'sparkle' },
  game: { label: 'Game', icon: 'play' },
};

/** Ideas to start from (each becomes a request to Keo in the chat). */
const IDEAS: Array<{ title: string; ask: string; icon: string }> = [
  { title: 'Business website with a shop', ask: 'a modern website for my business with a home page, about, services, a shop with cart and checkout, contact form, and an admin page to see orders', icon: 'window' },
  { title: 'Motion landing page', ask: 'a premium landing page with smooth scroll animations (pinned sections, text reveals, parallax) and a 3D object in the hero', icon: 'sparkle' },
  { title: '3D game', ask: 'a 3D game with real physics: a title screen, levels, score and best score, sound effects and music, keyboard and touch controls', icon: 'play' },
  { title: '2D platformer', ask: 'a 2D platformer game with a hero, enemies, coins, several levels, particles, sound and a best score', icon: 'play' },
  { title: 'Web app with accounts', ask: 'a web app where people sign up and log in, with a dashboard to add, edit and search their items, saved in a database', icon: 'sparkle' },
  { title: 'Portfolio', ask: 'a portfolio website with a striking animated intro, project gallery, about page and contact form', icon: 'window' },
];

/**
 * The websites, apps and games Keo built: open the preview, the folder, the user's to-do list for
 * going online, and ask Keo to build something new or change one.
 */
export function BuildsView() {
  const ui = useUi();
  const app = useApp();
  const builds = useInvoke('builds:list', {}, { refreshOn: ['builds:changed'] });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (builds.data?.length && (!selected || !builds.data.some((b) => b.id === selected))) setSelected(builds.data[0]!.id);
  }, [builds.data, selected]);

  /** A request to Keo in a new chat (where the user watches Keo build). */
  const askKeo = async (text: string) => {
    try {
      const c = await invoke('conversations:create', { projectId: null });
      app.setConversationId(c.id);
      app.setView('chat');
      await invoke('chat:send', { conversationId: c.id, text });
    } catch (e) {
      ui.error(errText(e));
    }
  };
  // The request box: what the user types is exactly what Keo is asked (starter ideas only fill it in).
  const [request, setRequest] = useState<null | { text: string; change?: { id: string; title: string } }>(null);
  const buildNew = (start = '') => setRequest({ text: start });

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h1>Builds</h1>
          <p>Websites (with their backend), web apps and games Keo builds for you: real projects you can preview, change and put online.</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => void buildNew()}>
            <Icon name="plus" size={15} /> Build something
          </button>
        </div>
      </header>
      <ErrorBanner error={builds.error} onRetry={() => void builds.refresh()} />
      {builds.data && builds.data.length === 0 ? (
        <div className="builds-empty">
          <Empty icon="rocket" title="Nothing built yet">
            Ask Keo for a website, an app or a game. It writes every page, the backend and the database, tests them in its preview, fixes what it finds, and tells you what only you can do to go online.
          </Empty>
          <Ideas onPick={(ask) => void buildNew(ask)} />
        </div>
      ) : (
        <div className="split">
          <div className="list" role="list">
            {(builds.data ?? []).map((b) => {
              const left = b.todo.filter((t) => t.who === 'you' && !t.done).length;
              return (
                <button key={b.id} role="listitem" className="list-item" aria-current={b.id === selected} onClick={() => setSelected(b.id)}>
                  <span className="row" style={{ gap: 6 }}>
                    <Icon name={KIND[b.kind].icon} size={14} />
                    <strong style={{ fontWeight: 600 }}>{b.title}</strong>
                  </span>
                  <span className="small muted">
                    {KIND[b.kind].label}
                    {b.backend ? ' · with backend' : ''} · {b.files} files · {timeAgo(b.updatedAt)}
                    {left ? ` · ${left} for you to do` : ''}
                  </span>
                </button>
              );
            })}
            <div className="builds-ideas-small">
              <span className="small muted">Start another:</span>
              {IDEAS.slice(0, 4).map((i) => (
                <button key={i.title} className="btn sm ghost" onClick={() => void buildNew(i.ask)}>
                  <Icon name={i.icon} size={12} /> {i.title}
                </button>
              ))}
            </div>
          </div>
          {selected && builds.data?.some((b) => b.id === selected) && <BuildDetail key={selected} id={selected} onChange={(b) => setRequest({ text: '', change: b })} onDeleted={() => { setSelected(null); void builds.refresh(); }} />}
        </div>
      )}
      {request && (
        <RequestBox
          initial={request.text}
          change={request.change ?? null}
          onCancel={() => setRequest(null)}
          onSend={(text) => {
            setRequest(null);
            void askKeo(request.change ? `In my build “${request.change.title}” (${request.change.id}): ${text}` : /^build\b/i.test(text) ? text : `Build ${text}`);
          }}
        />
      )}
    </div>
  );
}

/** What to build (or change), in the user's own words: several lines, sent exactly as typed. */
function RequestBox({ initial, change, onCancel, onSend }: { initial: string; change: { id: string; title: string } | null; onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const send = () => text.trim().length >= 5 && onSend(text.trim());
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()} onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="dialog build-request" role="dialog" aria-modal="true" aria-labelledby="br-title">
        <h2 id="br-title">{change ? `Change “${change.title}”` : 'What should Keo build?'}</h2>
        <p className="small muted">
          {change
            ? 'Say what to change or add. Keo edits the build, checks every page it touched, and shows you the result.'
            : 'Describe it like you would to a designer: what it is for, the pages or levels, the features, the look and feel, sites you like. Keo plans it, builds every part, tests it in its preview, fixes what it finds and shows it to you.'}
        </p>
        <textarea
          ref={ref}
          className="textarea"
          rows={8}
          maxLength={6000}
          value={text}
          placeholder={change ? 'Make the hero darker, add a testimonials section, and send me an email copy of every contact message.' : 'A motion website for my real estate agency (like Douglas Elliman): Buy, Rent and Sell sections with property listings, a property page, smooth scroll animations, and a contact form that saves messages.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send();
          }}
        />
        {!change && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <span className="small muted">Ideas:</span>
            {IDEAS.map((i) => (
              <button key={i.title} className="btn sm ghost" onClick={() => setText(i.ask)} title="Fills the box: change it as you like">
                {i.title}
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          <span className="small muted grow">{text.trim().length} / 6000 · Ctrl+Enter to send</span>
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={text.trim().length < 5} onClick={send}>
            <Icon name="send" size={14} /> {change ? 'Ask Keo' : 'Build it'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Ideas({ onPick }: { onPick: (ask: string) => void }) {
  return (
    <div className="builds-ideas">
      {IDEAS.map((i) => (
        <button key={i.title} className="build-idea" onClick={() => onPick(i.ask)}>
          <Icon name={i.icon} size={18} />
          <strong>{i.title}</strong>
          <span className="small muted">{i.ask}</span>
        </button>
      ))}
    </div>
  );
}

function BuildDetail({ id, onChange, onDeleted }: { id: string; onChange: (b: { id: string; title: string }) => void; onDeleted: () => void }) {
  const ui = useUi();
  const detail = useInvoke('builds:get', { id }, { refreshOn: ['builds:changed'] });
  const [opening, setOpening] = useState(false);
  const d = detail.data;
  if (detail.error) return /no such build/i.test(errText(detail.error)) ? null : <ErrorBanner error={detail.error} onRetry={() => void detail.refresh()} />;
  if (!d) return <div className="muted small" style={{ padding: 24 }}>Loading…</div>;
  const b = d.build;
  const yours = b.todo.map((t, index) => ({ ...t, index })).filter((t) => t.who === 'you');
  const left = yours.filter((t) => !t.done).length;

  const open = async (page?: string) => {
    setOpening(true);
    try {
      await invoke('builds:open', { id, ...(page ? { page } : {}) });
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setOpening(false);
    }
  };
  const change = () => onChange({ id: b.id, title: b.title });
  const remove = async () => {
    const ok = await ui.confirm({ title: `Delete “${b.title}”?`, body: 'Its folder goes to the Recycle Bin (you can restore it from there) and it leaves this list.', confirmLabel: 'Move to Recycle Bin' });
    if (!ok) return;
    try {
      await invoke('builds:delete', { id });
      ui.toast(`${b.title} is in the Recycle Bin.`, 'success');
      onDeleted();
    } catch (e) {
      ui.error(errText(e));
    }
  };
  const tick = async (index: number, done: boolean) => {
    try {
      await invoke('builds:todo', { id, index, done });
      void detail.refresh();
    } catch (e) {
      ui.error(errText(e));
    }
  };

  return (
    <div className="build-detail">
      <div className="build-head">
        <span className="build-kind">
          <Icon name={KIND[b.kind].icon} size={22} />
        </span>
        <div className="grow">
          <h2>{b.title}</h2>
          <p className="small muted">
            {KIND[b.kind].label}
            {b.backend ? ' with backend and database' : ''} · made {timeAgo(b.createdAt)} · changed {timeAgo(b.updatedAt)}
          </p>
        </div>
      </div>
      {b.brief && <p className="build-brief">{b.brief}</p>}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => void open()} disabled={opening || !d.pages.length} title={d.pages.length ? 'Opens it in Keo’s preview window' : 'Keo has not written a page yet'}>
          {opening ? <span className="spinner tiny" /> : <Icon name="play" size={14} />} {b.kind === 'game' ? 'Play' : 'Open preview'}
        </button>
        <button className="btn" onClick={change}>
          <Icon name="magic" size={14} /> Ask Keo to change it
        </button>
        <button className="btn" onClick={() => void invoke('builds:folder', { id }).catch((e: unknown) => ui.error(errText(e)))}>
          <Icon name="folder" size={14} /> Open folder
        </button>
        <span className="grow" />
        <button className="btn ghost danger" onClick={() => void remove()} title="Move to the Recycle Bin">
          <Icon name="trash" size={14} />
        </button>
      </div>

      {yours.length > 0 && (
        <section className="card">
          <div className="row">
            <h3 style={{ margin: 0 }}>What only you can do</h3>
            <span className={`chip ${left ? '' : 'ok'}`}>{left ? `${left} left` : 'All done'}</span>
          </div>
          <p className="small muted">Accounts, payments, keys and your own details: Keo never pretends these are done. Tick each when it is.</p>
          <ul className="build-todo">
            {yours.map((t) => (
              <li key={t.index} className={t.done ? 'done' : ''}>
                <input type="checkbox" checked={t.done} onChange={(e) => void tick(t.index, e.target.checked)} aria-label={t.what} />
                <div>
                  <strong>{t.what}</strong>
                  {t.how && <p className="small muted">{t.how}</p>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {d.pages.length > 1 && (
        <section className="card">
          <h3 style={{ margin: 0 }}>Pages</h3>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {d.pages.map((p) => (
              <button key={p} className="btn sm" onClick={() => void open(p)} title={`Open ${p} in the preview`}>
                {p === 'index.html' ? 'Home' : p.replace(/\.html$/i, '').replace(/\/index$/, '')}
              </button>
            ))}
          </div>
        </section>
      )}

      {d.guide && (
        <details className="card">
          <summary>
            <strong>Put it online</strong> <span className="small muted">· step by step, with your own Cloudflare account (free to start)</span>
          </summary>
          <pre className="build-guide">{d.guide}</pre>
        </details>
      )}

      <details className="card">
        <summary>
          <strong>Files</strong> <span className="small muted">· {d.files.length} of its own{b.libraries.length ? ` · libraries: ${b.libraries.join(', ')}` : ''}</span>
        </summary>
        <ul className="build-files">
          {d.files.map((f) => (
            <li key={f.path}>
              <button className="link-btn" onClick={() => void invoke('builds:folder', { id, file: f.path }).catch((e: unknown) => ui.error(errText(e)))} title="Show in File Explorer">
                {f.path}
              </button>
              <span className="small muted">{f.bytes < 1024 ? `${f.bytes} B` : `${Math.round(f.bytes / 1024)} kB`}</span>
            </li>
          ))}
        </ul>
        <p className="small muted">{d.folder}</p>
      </details>
    </div>
  );
}
