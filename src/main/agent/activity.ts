/**
 * The Activity view: Keo's audit trail in plain words ("You approved: Send an email", "Could not:
 * Open the file — not found"). Only what a person would want to know is kept: actions, approvals,
 * permissions, paid AI work and background jobs; routine bookkeeping is left out. Repeats of the
 * same thing in a row are counted, not listed.
 */
import type { AuditRecord } from '../../shared/domain';
import { usdToCredits } from '../../shared/aiPrices';

export interface ActivityItem {
  id: string;
  ts: string;
  text: string;
  /** done: Keo did it; failed: it did not work; you: the user decided; cost: paid AI work; info: anything else. */
  tone: 'done' | 'failed' | 'you' | 'cost' | 'info';
  /** How many times in a row. */
  times: number;
}

const PAID: Record<string, string> = {
  'studio.ai_shot': 'an AI video clip',
  'studio.character_picture': 'a character picture',
  'studio.character_swap': 'a character swap',
  'studio.talking_character': 'a talking character',
  'studio.character_voice': 'a character voice',
  'studio.ai_music': 'AI music',
  'studio.ai_sound': 'an AI sound effect',
  'studio.showcase_voice': 'a voice-over',
  'visual.render': 'a photoreal picture',
};

const short = (s: unknown, n = 140) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const words = (s: string) => s.replace(/[._:]+/g, ' ').replace(/\s+/g, ' ').trim();

function line(r: AuditRecord, title: (capabilityId: string) => string): Omit<ActivityItem, 'id' | 'ts' | 'times'> | null {
  const what = r.capabilityId ? title(r.capabilityId) : 'an action';
  const d = r.detail ?? {};
  switch (r.kind) {
    case 'capability.execution':
      return r.decision === 'succeeded' ? { text: `Did: ${what}`, tone: 'done' } : { text: `Could not: ${what}${d.error ? ` — ${short(d.error)}` : ''}`, tone: 'failed' };
    case 'permission.decision':
      if (r.decision === 'approved' || r.decision === 'approved_by_user_click') return { text: `You approved: ${what}`, tone: 'you' };
      if (r.decision === 'denied') return { text: `You declined: ${what}`, tone: 'you' };
      if (r.decision === 'approved_by_policy') return { text: `Approved by your approval level (Settings): ${what}`, tone: 'info' };
      if (r.decision === 'approved_by_grant') return { text: `Allowed by the time-limited control you gave: ${what}`, tone: 'info' };
      if (r.decision.startsWith('rejected')) return { text: `Stopped: ${what} changed after you approved it, so it did not run`, tone: 'failed' };
      if (r.decision.startsWith('user_initiated')) return { text: 'You asked Keo to look at a window', tone: 'you' };
      return null;
    case 'permission.grant':
      if (r.decision === 'created') return { text: `You gave Keo ${d.minutes ?? 'some'} minutes of control of ${short(d.processName, 60) || 'an app'}`, tone: 'you' };
      if (r.decision === 'expired') return { text: 'Keo’s time-limited control ended', tone: 'info' };
      return { text: 'You took back Keo’s control of an app', tone: 'you' };
    case 'permission.setting':
      return { text: `Setting changed: ${words(r.decision)}`, tone: 'you' };
    case 'jobs.finished':
      return { text: `Background job ${r.decision}${d.ending ? ` (${words(String(d.ending))})` : ''}`, tone: r.decision === 'completed' ? 'done' : r.decision === 'failed' ? 'failed' : 'info' };
    case 'jobs.cancelled':
      return { text: 'You stopped a background job', tone: 'you' };
    case 'user.stop_all':
      return { text: 'You stopped everything Keo was doing', tone: 'you' };
    case 'task.transition':
      return r.decision === 'proposed' && d.origin === 'plan' ? { text: `Keo proposed a plan of ${d.steps ?? 'several'} steps for you to approve`, tone: 'info' } : null;
  }
  const paid = PAID[r.kind];
  if (paid) {
    const usd = typeof d.costUsd === 'number' ? d.costUsd : 0;
    return { text: usd > 0 ? `Made ${paid} (about ${usdToCredits(usd)} Studio credits)` : `Made ${paid} (no charge: made before)`, tone: 'cost' };
  }
  return null;
}

export function describeActivity(records: AuditRecord[], title: (capabilityId: string) => string, limit = 200): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (const r of records) {
    const l = line(r, title);
    if (!l) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === l.text) {
      prev.times++;
      continue;
    }
    out.push({ id: r.id, ts: r.ts, times: 1, ...l });
    if (out.length >= limit) break;
  }
  return out;
}
