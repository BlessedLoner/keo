import { useState } from 'react';
import { Icon } from './Icon';
import { useUi } from './ui';
import { errText, invoke } from '../lib/api';

type Every = 'once' | 'day' | 'weekdays' | 'week' | 'hours';
const DAYS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
] as const;
type Day = (typeof DAYS)[number][0];

/** Routines worth having: one click fills the form (the user can change every word). */
const IDEAS: Array<{ title: string; text: string; every: Every; time: string; days?: Day[] }> = [
  { title: 'Video idea of the day', text: 'Look at what is trending in my niche today and give me one short video idea with a hook, three talking points and a title.', every: 'day', time: '08:00' },
  { title: 'Weekly content plan', text: 'Plan my videos for this week: five ideas with hooks, which day to post each, and the hashtags to use.', every: 'week', time: '09:00', days: ['mon'] },
  { title: 'Morning brief', text: 'Give me my morning brief: today’s calendar, important unread emails and anything waiting for me in Keo.', every: 'weekdays', time: '07:30' },
  { title: 'Inbox tidy-up', text: 'Check my email for anything that needs a reply today and draft replies for me to approve (do not send anything).', every: 'weekdays', time: '12:00' },
];

const pad = (n: number) => String(n).padStart(2, '0');
function nextLocal(time: string): string {
  const [h, m] = time.split(':').map(Number) as [number, number];
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${time}`;
}

/**
 * A new routine (an instruction Keo runs by itself at its time, as a background job) or a reminder.
 * A routine's actions still ask for approval as usual: it can read and prepare, never send or buy
 * on its own.
 */
export function NewRoutine({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const [kind, setKind] = useState<'routine' | 'reminder'>('routine');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [every, setEvery] = useState<Every>('day');
  const [time, setTime] = useState('09:00');
  const [date, setDate] = useState('');
  const [days, setDays] = useState<Day[]>(['mon']);
  const [hours, setHours] = useState(3);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const at = every === 'once' && date ? `${date}T${time}` : nextLocal(time);
      await invoke('schedule:create', {
        kind,
        title: title.trim() || text.trim().slice(0, 60),
        text: text.trim(),
        at,
        every: every === 'weekdays' ? 'week' : every,
        ...(every === 'weekdays' ? { days: ['mon', 'tue', 'wed', 'thu', 'fri'] as Day[] } : every === 'week' ? { days } : {}),
        ...(every === 'hours' ? { hours } : {}),
      });
      ui.toast(kind === 'routine' ? 'Routine saved: Keo runs it at its time.' : 'Reminder saved.', 'success');
      onClose();
    } catch (e) {
      ui.error(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" role="dialog" aria-modal="true" aria-label="New routine" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal routine-dialog">
        <div className="row">
          <h3>{kind === 'routine' ? 'New routine' : 'New reminder'}</h3>
          <span className="grow" />
          <button className="btn icon sm ghost" onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <button className={`chip-btn${kind === 'routine' ? ' on' : ''}`} onClick={() => setKind('routine')}>Routine (Keo does it)</button>
          <button className={`chip-btn${kind === 'reminder' ? ' on' : ''}`} onClick={() => setKind('reminder')}>Reminder (Keo tells me)</button>
        </div>
        {kind === 'routine' && (
          <div className="routine-ideas">
            {IDEAS.map((i) => (
              <button
                key={i.title}
                className="chip-btn"
                onClick={() => {
                  setTitle(i.title);
                  setText(i.text);
                  setEvery(i.every);
                  setTime(i.time);
                  if (i.days) setDays(i.days);
                }}
              >
                {i.title}
              </button>
            ))}
          </div>
        )}
        <div className="field">
          <label>{kind === 'routine' ? 'What Keo does' : 'What to remind you of'}</label>
          <textarea className="textarea" rows={3} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder={kind === 'routine' ? 'Give me one video idea from today’s trends…' : 'Post the new episode'} />
        </div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} placeholder="Video idea of the day" />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <select className="select" value={every} onChange={(e) => setEvery(e.target.value as Every)}>
            <option value="once">Once</option>
            <option value="day">Every day</option>
            <option value="weekdays">Every weekday</option>
            <option value="week">On chosen days</option>
            <option value="hours">Every few hours</option>
          </select>
          {every === 'hours' ? (
            <label className="row small" style={{ gap: 6 }}>
              every <input className="input" type="number" min={1} max={168} value={hours} style={{ width: 70 }} onChange={(e) => setHours(Math.max(1, Math.min(168, Number(e.target.value) || 1)))} /> hours, from
              <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </label>
          ) : (
            <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          )}
          {every === 'once' && <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </div>
        {every === 'week' && (
          <div className="row" style={{ gap: 4 }}>
            {DAYS.map(([d, label]) => (
              <button key={d} className={`chip-btn${days.includes(d) ? ' on' : ''}`} onClick={() => setDays((x) => (x.includes(d) ? (x.length > 1 ? x.filter((y) => y !== d) : x) : [...x, d]))}>
                {label}
              </button>
            ))}
          </div>
        )}
        {kind === 'routine' && <p className="small muted">Keo runs it in the background and reports in Tasks. Anything that sends, posts, buys or deletes still waits for your approval.</p>}
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={onClose}>Cancel</button>
          <button className="btn sm primary" disabled={busy || text.trim().length < 3} onClick={() => void save()}>
            {busy ? <span className="spinner tiny" /> : <Icon name="check" size={12} />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
