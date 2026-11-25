/**
 * Emails the owner Keo Cloud's alerts (spend near or at a daily safety limit), written to the alerts
 * table by the database. Runs every 10 minutes (wrangler.toml [triggers]); each alert is sent once.
 * Needs RESEND_API_KEY (a Resend key for heykeo.com) and ALERT_EMAIL (where to send them); without
 * them the alerts stay on the admin page only.
 */
import type { Env, Fetch, Supabase } from './gateway';

interface AlertRow {
  id: number;
  day: string;
  kind: string;
  message: string;
}

const RESEND = 'https://api.resend.com/emails';

/** What an alert is about, in a few words (the email's subject). */
export function alertSubject(kind: string): string {
  if (kind.startsWith('breaker_')) return `Keo Cloud stopped ${kind.includes('fal') ? 'Studio AI' : 'AI calls'} for today: safety limit reached`;
  if (kind.startsWith('near_')) return `Keo Cloud: ${kind.includes('fal') ? 'Studio AI' : 'AI'} spend is near today’s safety limit`;
  return `Keo Cloud alert: ${kind}`;
}

/** Sends the alerts not sent yet; returns how many were sent. */
export async function sendAlerts(env: Env, db: Supabase, fetch: Fetch): Promise<number> {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return 0;
  const rows = await db.rest<AlertRow[]>('alerts?sent=eq.false&select=id,day,kind,message&order=created_at&limit=20').catch(() => []);
  let sent = 0;
  for (const a of rows) {
    const r = await fetch(RESEND, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: env.ALERT_FROM ?? 'Keo Cloud <alerts@heykeo.com>',
        to: env.ALERT_EMAIL.split(/[,\s;]+/).filter((x) => x.includes('@')),
        subject: alertSubject(a.kind),
        text: `${a.message}\n\nDay (UTC): ${a.day}\n\nSee the Money tab of Keo's admin page for today's spend. The limits are in Supabase → Table Editor → keo_settings.`,
      }),
    }).catch(() => null);
    if (!r?.ok) {
      console.error(`alert email not sent (${r?.status ?? 'no answer'}): ${a.kind}`);
      continue;
    }
    await db.rest(`alerts?id=eq.${a.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ sent: true }) }).catch(() => undefined);
    sent++;
  }
  return sent;
}
