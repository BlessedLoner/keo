import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundJob, ScheduledItem } from '@shared/domain';
import { Icon } from '../components/Icon';
import { KeoEmblem, STATE_LABEL } from '../components/KeoEmblem';
import { invoke, subscribe } from '../lib/api';
import { emblemFor, listenRelayedLevel, relayedLevel, usePresence } from '../lib/presence';

/**
 * The Keo bar: a small glossy island docked to an edge of the screen (top by default). Collapsed
 * it shows Keo's face, a short status and one blinking dot per running task; on hover it opens
 * into Keo's controls (voice, pencil, mini chat, Keo mode…) and lists the tasks. It can be dragged
 * along its edge or to another one. Only the island takes the mouse; the rest of its window is
 * click-through. Activity text is content-free (capability + application), never message or page
 * contents.
 */
type Dock = 'top' | 'bottom' | 'left' | 'right';

/** What each task says (the real task state; no invented progress). */
const TASK_STATE: Record<string, string> = { running: 'Working', waiting: 'Queued', needs_you: 'Needs you', uncertain: 'Check result', queued: 'Queued', desktop: 'Waiting for the desktop' };
/** One colour per task, in the order they started. */
const DOT_COLORS = ['#5aa9ff', '#a98bff', '#38e0c2', '#ff8fd1', '#7ee06a', '#ffb86b'];

interface Item {
  id: string;
  title: string;
  state: string;
  kind: 'task' | 'job';
  step: string | null;
}

export function CompanionApp() {
  const p = usePresence();
  const [dock, setDock] = useState<Dock>('top');
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const island = useRef<HTMLDivElement>(null);
  const over = useRef(0);
  const moved = useRef(false);
  const colors = useRef(new Map<string, string>());
  const state = emblemFor(p);

  const setInteractive = useCallback((b: boolean) => {
    void invoke('companion:setInteractive', { interactive: b }).catch(() => undefined);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('companion-root');
    listenRelayedLevel();
    const load = () => void invoke('settings:get', {}).then((s) => setDock(s.companion.dock), () => undefined);
    load();
    const offS = subscribe('settings:changed', load);
    const loadJobs = () => void invoke('jobs:list', {}).then(setJobs, () => undefined);
    loadJobs();
    const offJ = subscribe('jobs:changed', loadJobs);
    const loadScheduled = () => void invoke('schedule:list', {}).then(setScheduled, () => undefined);
    loadScheduled();
    const offR = subscribe('schedule:changed', loadScheduled);
    return () => {
      offS();
      offJ();
      offR();
    };
  }, []);

  // Enter/leave across the island and its panel: the window takes the mouse only while over them.
  const enter = () => {
    over.current++;
    setInteractive(true);
    setOpen(true);
  };
  const leave = () => {
    over.current = Math.max(0, over.current - 1);
    window.setTimeout(() => {
      if (over.current === 0 && !dragging) {
        setOpen(false);
        setInteractive(false);
      }
    }, 120);
  };

  // A little depth: the island tilts toward the mouse and its sheen follows it.
  const tilt = (e: React.PointerEvent) => {
    const el = island.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
    el.style.setProperty('--rx', `${((0.5 - y) * 10).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${((x - 0.5) * 8).toFixed(2)}deg`);
  };
  const untilt = () => {
    const el = island.current;
    el?.style.setProperty('--rx', '0deg');
    el?.style.setProperty('--ry', '0deg');
  };

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    moved.current = false;
    const start = { x: e.screenX, y: e.screenY };
    const onMove = (ev: PointerEvent) => {
      if (!moved.current && Math.abs(ev.screenX - start.x) + Math.abs(ev.screenY - start.y) > 5) {
        moved.current = true;
        setDragging(true);
        void invoke('companion:drag', { phase: 'start' }).catch(() => undefined);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      if (moved.current) {
        void invoke('companion:drag', { phase: 'end' }).catch(() => undefined);
        window.setTimeout(() => setDragging(false), 250);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  const vm = p?.voiceMode;
  const wake = p?.wake;
  const busy = !!p && p.state !== 'idle' && p.state !== 'cancelled';

  // Tasks and background jobs, each with its own colour for as long as it runs.
  const items: Item[] = [
    ...(p?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, state: t.state, kind: 'task' as const, step: t.step })),
    ...jobs.filter((j) => j.state === 'queued' || j.state === 'running').map((j) => ({ id: j.id, title: j.title, state: j.waitingForDesktop ? 'desktop' : j.state, kind: 'job' as const, step: null })),
  ];
  for (const it of items) if (!colors.current.has(it.id)) colors.current.set(it.id, DOT_COLORS[colors.current.size % DOT_COLORS.length]!);
  const live = new Set(items.map((i) => i.id));
  for (const id of [...colors.current.keys()]) if (!live.has(id)) colors.current.delete(id);
  const dotColor = (it: Item) => (it.state === 'needs_you' ? '#ffbf47' : it.state === 'uncertain' ? '#ff5d6c' : colors.current.get(it.id)!);

  const voiceLine = !vm?.active
    ? null
    : vm.state === 'listening'
      ? vm.heard
        ? `“${vm.heard}”`
        : 'Listening…'
      : vm.state === 'speaking' && vm.said
        ? vm.said
        : vm.state === 'confirming'
          ? 'Say yes or no'
          : 'Thinking…';
  const status = voiceLine ?? (p?.pendingApprovals ? 'Needs your approval' : p?.activity ?? (busy ? STATE_LABEL[state] : null));
  const horizontal = dock === 'top' || dock === 'bottom';
  // Waiting reminders: a small clock, titled with the next one.
  const reminders = scheduled.filter((s) => s.kind === 'reminder' && s.state === 'active' && s.nextRunAt);
  const nextReminder = reminders[0];
  const clockTitle = nextReminder
    ? `${reminders.length} reminder${reminders.length > 1 ? 's' : ''} — next: ${nextReminder.title}, ${new Date(nextReminder.nextRunAt!).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    : '';

  const btn = (label: string, icon: Parameters<typeof Icon>[0]['name'], onClick: () => void, cls = '') => (
    <button key={label} className={`ib ${cls}`} aria-label={label} title={label} onClick={onClick}>
      <Icon name={icon} size={15} />
    </button>
  );

  return (
    <div className={`bar-stage dock-${dock}`}>
      <div
        ref={island}
        className={`island ${open ? 'open' : ''} ${vm?.active ? 'voice' : ''} ${dragging ? 'dragging' : ''} ${horizontal ? 'h' : 'v'} state-${state}`}
        onPointerEnter={enter}
        onPointerLeave={() => {
          untilt();
          leave();
        }}
        onPointerMove={tilt}
        onPointerDown={startDrag}
        role="status"
        aria-live="polite"
        aria-label={`Keo: ${STATE_LABEL[state]}${p?.activity ? `. ${p.activity}` : ''}`}
      >
        <span className="island-sheen" aria-hidden="true" />
        <button
          className="island-face"
          title="Open Keo (drag the bar to move it)"
          aria-label="Open Keo"
          onClick={() => {
            if (!moved.current) void invoke('presence:openMain', { view: p?.pendingApprovals ? 'tasks' : 'chat' });
          }}
        >
          <KeoEmblem state={state} size={30} level={relayedLevel} />
          {!!p?.pendingApprovals && <span className="island-badge">{p.pendingApprovals}</span>}
        </button>

        {vm?.active && <Wave />}

        {!open && horizontal && <span className="island-label">{status ?? 'Keo'}</span>}

        {open && (
          <div className="island-actions">
            {vm?.active ? btn('End voice conversation', 'stop', () => void invoke('voice:modeStop'), 'danger') : btn('Talk to Keo', 'mic', () => void invoke('voice:modeStart'), 'primary')}
            {btn('Pencil: mark the screen and ask', 'edit', () => void invoke('pencil:start'))}
            {btn('Mini chat', 'chat', () => void invoke('commandBar:show'))}
            {btn('Keo mode', 'sparkle', () => void invoke('keomode:open'))}
            {p?.liveChats.firstReady && btn(`Send the reply to ${p.liveChats.firstReady.contact} now`, 'send', () => void invoke('livechat:sendNow', { id: p.liveChats.firstReady!.id }), 'primary')}
            {busy && btn('Stop everything', 'stop', () => void invoke('presence:stopAll'), 'danger')}
            {wake?.enabled && btn(wake.muted ? 'Unmute the wake word' : 'Mute the wake word', 'mic', () => void invoke('wake:setMuted', { muted: !wake.muted }), wake.muted ? 'muted' : '')}
            {!!p?.grants && btn(`Revoke ${p.grants} navigation permission(s)`, 'shield', () => void invoke('grants:revokeAll'), 'warn')}
            {btn('Hide the Keo bar (turn it on again in Settings)', 'x', () => void invoke('companion:hide'), 'quiet')}
          </div>
        )}

        {!!items.length && (
          <span className="island-dots" aria-label={`${items.length} task(s) running`}>
            {items.slice(0, 6).map((it, i) => (
              <span key={it.id} className={`idot s-${it.state}`} style={{ '--c': dotColor(it), animationDelay: `${i * 0.35}s` } as React.CSSProperties} />
            ))}
          </span>
        )}
        {!!reminders.length && (
          <span className="island-clock" title={clockTitle} aria-label={clockTitle}>
            <Icon name="clock" size={12} />
            {reminders.length > 1 && <span>{reminders.length}</span>}
          </span>
        )}
        {!items.length && !open && wake?.enabled && !wake.muted && wake.status === 'listening' && <span className="island-ear" title={`Listening for “${wake.phrase ?? 'Hey Keo'}”`} />}
      </div>

      {open && (status || items.length > 0) && (
        <div className="island-panel" onPointerEnter={enter} onPointerLeave={leave}>
          {status && <div className="ip-status">{status}</div>}
          {items.length > 0 && (
            <ul className="ip-tasks" aria-label="Keo's tasks">
              {items.map((it) => (
                <li key={it.id}>
                  <span className={`idot s-${it.state}`} style={{ '--c': dotColor(it) } as React.CSSProperties} />
                  <button className="ip-title" title={it.step ? `${it.title} — ${it.step}` : it.title} onClick={() => void invoke('presence:openMain', { view: 'tasks' })}>
                    {it.title}
                    <span className="ip-state">{TASK_STATE[it.state] ?? it.state}</span>
                  </button>
                  <button
                    className="ib quiet sm"
                    aria-label={`Stop ${it.title}`}
                    title="Stop this task"
                    onClick={() => void (it.kind === 'job' ? invoke('jobs:cancel', { id: it.id }) : invoke('tasks:cancel', { id: it.id })).catch(() => undefined)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Five bars that move with the real voice level (relayed from the window that records and speaks). */
function Wave() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let s = 0;
    const tick = (t: number) => {
      s += (relayedLevel() - s) * 0.3;
      const el = ref.current;
      if (el)
        for (let i = 0; i < el.children.length; i++) {
          const wobble = 0.55 + 0.45 * Math.sin(t / 140 + i * 1.3);
          (el.children[i] as HTMLElement).style.transform = `scaleY(${(0.18 + Math.min(1, s * 2.2) * wobble).toFixed(3)})`;
        }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <span className="island-wave" ref={ref} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
